const DISCOVERY_WAIT_MS = 15000;
const MEDIA_WAIT_MS = 30000;

const NO_DEVICES = 'Chrome has not found a Chromecast yet. After resolving a video, tap Find Chromecast to search. If the picker stays empty, cancel it and check Chrome’s local-network permissions or VPN settings.';

function errorMessage(error) {
  const code = error?.code || error?.name || error;
  switch (code) {
    case 'receiver_unavailable':
      return 'Chrome could not find a Chromecast. Check that another Cast app on this phone can see it, then try again.';
    case 'timeout':
    case 'session_error':
    case 'channel_error':
      return 'Chrome could not connect to the Chromecast. Close the picker, check local-network permissions or VPN settings, then try again.';
    case 'NotAllowedError':
      return 'Chrome did not allow the Cast request. Tap the Cast button again and allow any local-network permission prompt.';
    default:
      return 'Cast failed: ' + (error?.description || error?.message || String(code));
  }
}

// Keep SDK readiness separate from device discovery. In particular, Android
// Chrome may only begin active discovery when requestSession() is called from
// a user gesture, so NO_DEVICES_AVAILABLE must not disable the Cast button.
export class CastSender {
  constructor({
    getSdk = () => ({ framework: globalThis.cast?.framework, api: globalThis.chrome?.cast }),
    onChange = () => {},
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    this.getSdk = getSdk;
    this.onChange = onChange;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.context = null;
    this.state = {
      ready: false,
      busy: false,
      phase: 'sdk',
      castState: null,
      message: 'Loading Chromecast support…',
      kind: 'info',
    };
  }

  publish(message, kind = 'info') {
    if (message !== undefined) {
      this.state.message = message;
      this.state.kind = kind;
    }
    this.onChange({ ...this.state });
  }

  unavailable(message) {
    if (this.state.ready) return;
    this.state.phase = 'unavailable';
    this.publish(message, 'error');
  }

  initialize(isAvailable) {
    if (this.state.ready) return; // Cached SDKs can notify more than once.
    if (!isAvailable) {
      this.unavailable('Chromecast is unavailable in this browser. Use Chrome on Android or desktop. You can still preview the video here.');
      return;
    }
    try {
      const { framework, api } = this.getSdk();
      const context = framework.CastContext.getInstance();
      context.setOptions({
        // We use standard media LOAD messages, not a custom receiver protocol.
        receiverApplicationId: api.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
        autoJoinPolicy: api.AutoJoinPolicy.ORIGIN_SCOPED,
        // This means a native Android TV receiver app, NOT an Android phone.
        androidReceiverCompatible: false,
        resumeSavedSession: true,
      });
      this.context = context;
      context.addEventListener(framework.CastContextEventType.CAST_STATE_CHANGED, (event) => {
        this.state.castState = event.castState;
        if (!this.state.busy) this.showDiscovery();
      });
      context.addEventListener(framework.CastContextEventType.SESSION_STATE_CHANGED, () => {
        this.state.castState = context.getCastState();
        if (!this.state.busy) this.showDiscovery();
      });
      this.state.ready = true;
      this.state.phase = 'idle';
      this.state.castState = context.getCastState();
      this.showDiscovery();
    } catch (error) {
      this.unavailable(errorMessage(error));
    }
  }

  showDiscovery() {
    switch (this.state.castState) {
      case 'CONNECTED':
        this.publish('Chromecast connected. Choose a video to cast.', 'success');
        break;
      case 'CONNECTING':
        this.publish('Connecting to Chromecast…');
        break;
      case 'NO_DEVICES_AVAILABLE':
        this.publish(NO_DEVICES);
        break;
      default:
        this.publish('Chromecast available. Resolve a video, then tap Cast to Chromecast.', 'success');
    }
  }

  async waitWithGuidance(promise, delay, message) {
    const timer = this.setTimer(() => this.publish(message, 'error'), delay);
    try {
      return await promise;
    } finally {
      this.clearTimer(timer);
    }
  }

  async cast(stream) {
    if (!stream || !this.state.ready || this.state.busy) return;
    const selectedStream = { ...stream };
    this.state.busy = true;
    this.state.phase = 'picker';
    this.publish('Choose your Chromecast in Chrome’s device picker…');
    try {
      let session = this.context.getCurrentSession();
      if (!session) {
        // Invoke synchronously in the click handler, before any await, to retain
        // user activation on mobile Chrome. Never open a second picker while
        // this request is pending: JavaScript cannot dismiss Chrome's dialog.
        await this.waitWithGuidance(
          this.context.requestSession(),
          DISCOVERY_WAIT_MS,
          'Chrome’s device picker is still waiting. Cancel that dialog, then check local-network permissions, VPN settings, or restart Chrome before retrying.',
        );
        session = this.context.getCurrentSession();
      }
      if (!session) throw new Error('No Cast session was established. Please try again.');

      this.state.phase = 'media';
      this.publish('Connected. Loading the video on Chromecast…');
      const { api } = this.getSdk();
      const mediaInfo = new api.media.MediaInfo(
        selectedStream.streamUrl,
        selectedStream.contentType || 'application/vnd.apple.mpegurl',
      );
      mediaInfo.streamType = selectedStream.isLive
        ? api.media.StreamType.LIVE
        : api.media.StreamType.BUFFERED;
      const metadata = new api.media.GenericMediaMetadata();
      metadata.title = selectedStream.title;
      if (selectedStream.uploader) metadata.subtitle = '@' + selectedStream.uploader;
      if (selectedStream.thumbnail) metadata.images = [{ url: selectedStream.thumbnail }];
      mediaInfo.metadata = metadata;
      const request = new api.media.LoadRequest(mediaInfo);
      request.autoplay = true;
      // Leave LIVE start position unset so the receiver chooses the live edge.
      if (!selectedStream.isLive) request.currentTime = 0;
      await this.waitWithGuidance(
        session.loadMedia(request),
        MEDIA_WAIT_MS,
        'The Chromecast connected, but the video is taking too long to load. This is a playback issue, not device discovery. Wait for the request to finish or reload this page before retrying.',
      );
      this.publish('Casting!', 'success');
    } catch (error) {
      if (error === 'cancel' || error?.code === 'cancel') {
        this.publish('Cast canceled. You can try again or preview the video here.');
      } else {
        this.publish(errorMessage(error), 'error');
      }
    } finally {
      this.state.busy = false;
      this.state.phase = 'idle';
      this.publish();
    }
  }
}

// Register the callback BEFORE inserting Google's script. Loading another CDN
// (such as hls.js) between the SDK and the callback creates a fast-cache race.
export function loadCastSdk(sender, {
  win = window,
  doc = document,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let timer;
  win.__onGCastApiAvailable = (available) => {
    clearTimer(timer);
    sender.initialize(available);
  };
  if (win.cast?.framework && win.chrome?.cast?.isAvailable) {
    sender.initialize(true);
    return;
  }
  const script = doc.createElement('script');
  script.src = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
  script.async = true;
  script.onerror = () => {
    clearTimer(timer);
    sender.unavailable('Could not download Google Cast support. Check your connection or content blocker, then reload. Browser preview is still available.');
  };
  timer = setTimer(() => {
    sender.unavailable('Google Cast did not initialize. Reload this page in Chrome on Android or desktop, and check whether a content blocker is blocking Google’s Cast SDK.');
  }, DISCOVERY_WAIT_MS);
  doc.head.appendChild(script);
}
