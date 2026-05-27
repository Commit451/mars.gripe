import asyncio
import re
import time
from pathlib import Path
from threading import Lock
from urllib.parse import quote, urljoin, urlparse

import httpx
import yt_dlp
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles

PSCP_HOST_SUFFIX = ".video.pscp.tv"

app = FastAPI(title="mars.gripe", docs_url=None, redoc_url=None)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
    allow_headers=["*"],
)

STATIC_DIR = Path(__file__).parent / "static"

BROADCAST_URL_RE = re.compile(
    r"^https?://(?:www\.|mobile\.)?(?:x|twitter)\.com/i/broadcasts/([A-Za-z0-9_-]+)/?(?:\?.*)?$"
)
BROADCAST_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")

_cache: dict[str, tuple[float, dict]] = {}
_cache_lock = Lock()
CACHE_TTL_SECONDS = 60


def _extract_info(broadcast_url: str) -> dict:
    opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        return ydl.extract_info(broadcast_url, download=False)


def _cached_extract(broadcast_url: str) -> dict:
    now = time.time()
    with _cache_lock:
        cached = _cache.get(broadcast_url)
        if cached and (now - cached[0]) < CACHE_TTL_SECONDS:
            return cached[1]
    info = _extract_info(broadcast_url)
    with _cache_lock:
        _cache[broadcast_url] = (now, info)
        for k in [k for k, v in _cache.items() if now - v[0] > CACHE_TTL_SECONDS * 4]:
            _cache.pop(k, None)
    return info


CAST_MAX_HEIGHT = 1080


def _hls_formats(info: dict) -> list[dict]:
    formats = [
        f for f in info.get("formats", [])
        if f.get("protocol", "").startswith("m3u8")
        and f.get("url")
        and (f.get("height") or 0) > 0
    ]
    castable = [f for f in formats if (f.get("height") or 0) <= CAST_MAX_HEIGHT]
    return castable or formats


def _build_master_playlist(formats: list[dict]) -> str:
    sorted_fmts = sorted(formats, key=lambda f: -(f.get("tbr") or 0))
    lines = ["#EXTM3U", "#EXT-X-VERSION:3"]
    for f in sorted_fmts:
        height = f.get("height") or 0
        tbr = f.get("tbr") or 0
        if not (height and tbr):
            continue
        vcodec = f.get("vcodec") or "avc1.42E01E"
        acodec = f.get("acodec")
        if acodec and acodec != "none":
            codecs = f"{vcodec},{acodec}"
        else:
            codecs = f"{vcodec},mp4a.40.2"
        width = int(round(height * 16 / 9))
        bandwidth = int(tbr * 1000)
        lines.append(
            f'#EXT-X-STREAM-INF:BANDWIDTH={bandwidth},'
            f'RESOLUTION={width}x{height},'
            f'CODECS="{codecs}"'
        )
        lines.append(f"/api/proxy?url={quote(f['url'], safe='')}")
    lines.append("")
    return "\n".join(lines)


@app.get("/api/proxy")
async def proxy(url: str = Query(..., min_length=10, max_length=2000)):
    parsed = urlparse(url)
    if parsed.scheme != "https" or not (parsed.hostname or "").endswith(PSCP_HOST_SUFFIX):
        raise HTTPException(status_code=403, detail="Only pscp.tv URLs allowed")

    try:
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            upstream = await client.get(url)
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Upstream fetch failed: {e}")

    if upstream.status_code >= 400:
        raise HTTPException(
            status_code=upstream.status_code,
            detail=f"Upstream returned {upstream.status_code}",
        )

    body = upstream.content
    content_type = upstream.headers.get("content-type", "application/octet-stream")

    if ".m3u8" in parsed.path:
        text = body.decode("utf-8", errors="replace")
        rewritten = []
        for raw in text.split("\n"):
            line = raw.rstrip("\r")
            stripped = line.strip()
            if stripped and not stripped.startswith("#"):
                abs_url = urljoin(url, stripped)
                rewritten.append(f"/api/proxy?url={quote(abs_url, safe='')}")
            else:
                rewritten.append(line)
        body = "\n".join(rewritten).encode("utf-8")
        content_type = "application/vnd.apple.mpegurl"

    return Response(
        content=body,
        media_type=content_type,
        headers={"Cache-Control": "no-cache"},
    )


@app.get("/api/resolve")
async def resolve(request: Request, url: str = Query(..., min_length=10, max_length=500)):
    m = BROADCAST_URL_RE.match(url)
    if not m:
        raise HTTPException(
            status_code=400,
            detail="URL must look like https://x.com/i/broadcasts/<id>",
        )
    broadcast_id = m.group(1)
    try:
        info = await asyncio.to_thread(_cached_extract, url)
    except yt_dlp.utils.DownloadError as e:
        raise HTTPException(status_code=404, detail=f"Could not resolve broadcast: {e}")

    formats = _hls_formats(info)
    if not formats:
        raise HTTPException(status_code=502, detail="No HLS variants found")

    base = str(request.base_url).rstrip("/")
    master_url = f"{base}/api/master/{broadcast_id}.m3u8"
    variants = sorted(
        [
            {"height": f.get("height"), "tbr": f.get("tbr"), "vcodec": f.get("vcodec")}
            for f in formats
        ],
        key=lambda v: -(v.get("height") or 0),
    )

    def _maybe_proxy(media_url: str | None) -> str | None:
        if not media_url:
            return None
        parsed = urlparse(media_url)
        if (parsed.hostname or "").endswith(PSCP_HOST_SUFFIX):
            return f"{base}/api/proxy?url={quote(media_url, safe='')}"
        return media_url

    return {
        "streamUrl": master_url,
        "title": info.get("title") or "X Broadcast",
        "thumbnail": _maybe_proxy(info.get("thumbnail")),
        "isLive": bool(info.get("is_live")),
        "uploader": info.get("uploader") or info.get("uploader_id"),
        "duration": info.get("duration"),
        "variants": variants,
    }


@app.get("/api/master/{broadcast_id}.m3u8")
async def master(broadcast_id: str):
    if not BROADCAST_ID_RE.match(broadcast_id):
        raise HTTPException(status_code=400, detail="Invalid broadcast id")
    url = f"https://x.com/i/broadcasts/{broadcast_id}"
    try:
        info = await asyncio.to_thread(_cached_extract, url)
    except yt_dlp.utils.DownloadError as e:
        raise HTTPException(status_code=404, detail=f"Could not resolve broadcast: {e}")

    formats = _hls_formats(info)
    if not formats:
        raise HTTPException(status_code=502, detail="No HLS variants found")

    body = _build_master_playlist(formats)
    return Response(
        content=body,
        media_type="application/vnd.apple.mpegurl",
        headers={"Cache-Control": "no-cache"},
    )


@app.get("/healthz")
async def healthz():
    return {"ok": True}


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
