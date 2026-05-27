const RECEIVER_APP_ID = '3DC1FA84';

const form = document.getElementById('resolve-form');
const urlInput = document.getElementById('url-input');
const resolveBtn = document.getElementById('resolve-btn');
const statusEl = document.getElementById('status');
const resultEl = document.getElementById('result');
const thumbEl = document.getElementById('thumb');
const titleEl = document.getElementById('title');
const subtitleEl = document.getElementById('subtitle');
const castBtn = document.getElementById('cast-btn');
const previewBtn = document.getElementById('preview-btn');
const previewEl = document.getElementById('preview');

let currentStream = null;
let castReady = false;
let hls = null;

window['__onGCastApiAvailable'] = (isAvailable) => {
  if (!isAvailable) {
    setStatus('Chromecast not supported in this browser. Try Chrome or Edge.', 'error');
    return;
  }
  cast.framework.CastContext.getInstance().setOptions({
    receiverApplicationId: RECEIVER_APP_ID,
    autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
    androidReceiverCompatible: true,
  });
  castReady = true;
  updateCastButton();
};

function updateCastButton() {
  castBtn.disabled = !(castReady && currentStream);
}

async function castCurrent() {
  if (!currentStream) return;
  setStatus('Opening Chromecast picker…');
  try {
    const context = cast.framework.CastContext.getInstance();
    await context.requestSession();
    const session = context.getCurrentSession();
    if (!session) throw new Error('No cast session');

    const mediaInfo = new chrome.cast.media.MediaInfo(
      currentStream.streamUrl,
      currentStream.contentType || 'application/x-mpegurl'
    );
    mediaInfo.streamType = currentStream.isLive
      ? chrome.cast.media.StreamType.LIVE
      : chrome.cast.media.StreamType.BUFFERED;

    const metadata = new chrome.cast.media.GenericMediaMetadata();
    metadata.title = currentStream.title;
    if (currentStream.uploader) metadata.subtitle = '@' + currentStream.uploader;
    if (currentStream.thumbnail) {
      metadata.images = [{ url: currentStream.thumbnail }];
    }
    mediaInfo.metadata = metadata;

    const request = new chrome.cast.media.LoadRequest(mediaInfo);
    request.autoplay = true;
    request.currentTime = 0;
    await session.loadMedia(request);
    setStatus('Casting!', 'success');
  } catch (err) {
    if (err === 'cancel' || err?.code === 'cancel') {
      setStatus('');
      return;
    }
    console.error(err);
    const msg = err?.description || err?.code || err?.message || String(err);
    setStatus('Cast failed: ' + msg, 'error');
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = urlInput.value.trim();
  if (!url) return;
  resolveBtn.disabled = true;
  setStatus('Resolving broadcast…');
  resultEl.hidden = true;
  stopPreview();
  currentStream = null;
  updateCastButton();
  try {
    const res = await fetch(`/api/resolve?url=${encodeURIComponent(url)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || res.statusText);
    currentStream = data;
    titleEl.textContent = data.title;
    const bits = [];
    if (data.uploader) bits.push('@' + data.uploader);
    bits.push(data.isLive ? 'LIVE' : 'Replay');
    if (data.variants && data.variants.length) {
      bits.push(data.variants.map(v => v.height + 'p').join('/'));
    }
    subtitleEl.textContent = bits.join(' · ');
    if (data.thumbnail) {
      thumbEl.src = data.thumbnail;
      thumbEl.hidden = false;
    } else {
      thumbEl.hidden = true;
    }
    resultEl.hidden = false;
    setStatus('Resolved. Ready to cast.', 'success');
    updateCastButton();
  } catch (err) {
    setStatus('Error: ' + err.message, 'error');
  } finally {
    resolveBtn.disabled = false;
  }
});

previewBtn.addEventListener('click', () => {
  if (!currentStream) return;
  startPreview(currentStream.streamUrl);
});

castBtn.addEventListener('click', castCurrent);

function startPreview(streamUrl) {
  stopPreview();
  previewEl.hidden = false;
  if (previewEl.canPlayType('application/vnd.apple.mpegurl')) {
    previewEl.src = streamUrl;
    previewEl.play().catch(() => {});
  } else if (window.Hls && Hls.isSupported()) {
    hls = new Hls({ lowLatencyMode: true });
    hls.loadSource(streamUrl);
    hls.attachMedia(previewEl);
    hls.on(Hls.Events.MANIFEST_PARSED, () => previewEl.play().catch(() => {}));
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (data.fatal) setStatus('Preview error: ' + data.details, 'error');
    });
  } else {
    setStatus('HLS preview not supported in this browser.', 'error');
  }
}

function stopPreview() {
  if (hls) {
    hls.destroy();
    hls = null;
  }
  previewEl.pause();
  previewEl.removeAttribute('src');
  previewEl.load();
  previewEl.hidden = true;
}

function setStatus(message, kind = 'info') {
  statusEl.textContent = message;
  statusEl.className = 'status' + (message ? ' ' + kind : '');
}
