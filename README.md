# mars.gripe

Cast public x.com (Twitter) broadcasts - live or a replay - to a Chromecast device.

## Run

```bash
docker compose up -d --build
```

The app listens on port 8000.

## Deploy

The Cast SDK requires the receiver be served over HTTPS, so production needs a reverse proxy with TLS (Caddy, nginx, Traefik, etc.) in front of the container.

The sender uses Google's **Default Media Receiver** (`CC1AD845`). No Cast
Developer Console account, custom receiver registration, or device allowlist is
required. The old `receiver.html` remains available for existing deployments,
but the sender no longer uses it. Native Android TV Cast Connect is deliberately
disabled; that option does not mean support for Android phones.

## Cast troubleshooting

Use Chrome on Android or desktop and a device on the same local network.
iPhone/iPad browsers can preview videos but cannot use this Cast Web SDK.

The page reports SDK loading, device discovery, connection, and media loading
separately. It registers the SDK callback before downloading the SDK, and keeps
the Cast button usable when Chrome reports no devices, so a tap can trigger
active discovery. Existing sessions are reused and live streams start at the
receiver's default live position rather than being forced to time zero.

If Chrome's picker keeps searching, cancel it before retrying. Check local-network
permissions, VPN restrictions, and discovery in another ordinary Cast app. Same
Wi-Fi alone does not exclude client isolation or blocked multicast discovery.
The page cannot dismiss Chrome's native picker or override OS permissions. After
15 seconds it displays recovery guidance but does **not** pretend the pending
request was canceled or open a duplicate picker. Media loads get separate
guidance after 30 seconds.

## Tests

With Node.js 22 or newer (no npm dependencies required):

```bash
npm test
```

The tests use an explicit SDK double to exercise initialization races, device
state changes, user-activation timing, stalled/canceled requests, session reuse,
and live/replay media requests. They do not prove real-device playback; that
requires a Cast-enabled browser and a physical receiver on the same network.

Optional browser checks (requires installed Chrome and `uv`):

```bash
# Start the app in another terminal first:
uv run --no-project --with-requirements requirements.txt uvicorn app.main:app --port 18765
uv run --no-project --with playwright python tests/browser_smoke.py
# Or verify the deployed assets:
uv run --no-project --with playwright python tests/browser_smoke.py --base-url https://mars.gripe
```

The browser checks explicitly mock resolution and Cast selection, then separately
verify initialization with Google's real SDK. They never launch real-device playback.
The picker/media-flow regression runs with **native browser timers**, not only a
fake clock: browser timer functions require a Window receiver, unlike Node timers
and many clock mocks. CI runs these browser checks before deployment using
Playwright's Chromium (`--channel chromium`).

## License

mars.gripe is available under the MIT license. See the LICENSE file for more info.

\ ゜o゜)ノ
