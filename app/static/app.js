import { CastSender, loadCastSdk } from './cast.js?v=3';

const form = document.getElementById('resolve-form');
const urlInput = document.getElementById('url-input');
const resolveBtn = document.getElementById('resolve-btn');
const statusEl = document.getElementById('status');
const resultEl = document.getElementById('result');
const thumbEl = document.getElementById('thumb');
const titleEl = document.getElementById('title');
const subtitleEl = document.getElementById('subtitle');
const castBtn = document.getElementById('cast-btn');
const castStatusEl = document.getElementById('cast-status');
const previewBtn = document.getElementById('preview-btn');
const previewEl = document.getElementById('preview');

let currentStream = null;
let resolving = false;
let hls = null;

const castSender = new CastSender({
  onChange(state) {
    castStatusEl.textContent = state.message;
    castStatusEl.className = 'status ' + state.kind;
    updateCastButton();
  },
});
loadCastSdk(castSender);

function updateCastButton() {
  const state = castSender.state;
  castBtn.disabled = !state.ready || !currentStream || state.busy;
  castBtn.textContent = state.busy
    ? (state.phase === 'media' ? 'Loading on Chromecast…' : 'Waiting for device selection…')
    : (state.castState === 'NO_DEVICES_AVAILABLE' ? 'Find Chromecast' : 'Cast to Chromecast');
  resolveBtn.disabled = resolving || state.busy;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (resolving || castSender.state.busy) return;
  const url = urlInput.value.trim();
  if (!url) return;
  resolving = true;
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
    setStatus('Video resolved. Cast it or preview in this browser.', 'success');
    updateCastButton();
  } catch (err) {
    setStatus('Error: ' + err.message, 'error');
  } finally {
    resolving = false;
    updateCastButton();
  }
});

previewBtn.addEventListener('click', () => {
  if (!currentStream) return;
  startPreview(currentStream.streamUrl);
});

castBtn.addEventListener('click', () => castSender.cast(currentStream));

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
