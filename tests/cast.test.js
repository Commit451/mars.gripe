import assert from 'node:assert/strict';
import test from 'node:test';
import { CastSender, loadCastSdk } from '../app/static/cast.js';

const stream = { streamUrl: 'https://example.test/live.m3u8', title: 'Test video', isLive: true, uploader: 'test', thumbnail: 'https://example.test/thumb.jpg' };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function clock() {
  let id = 0;
  const timers = new Map();
  return {
    timers,
    setTimer(fn, delay) { timers.set(++id, { fn, delay }); return id; },
    clearTimer(key) { timers.delete(key); },
    fire() { for (const [key, timer] of [...timers]) { timers.delete(key); timer.fn(); } },
  };
}
function harness() {
  const time = clock();
  const listeners = new Map();
  const changes = [];
  const loads = [];
  const session = { loadMedia(request) { loads.push(request); return Promise.resolve(); } };
  const context = {
    castState: 'NO_DEVICES_AVAILABLE', session: null, requests: 0, options: [],
    setOptions(options) { this.options.push(options); },
    addEventListener(type, callback) { listeners.set(type, callback); },
    getCastState() { return this.castState; },
    getCurrentSession() { return this.session; },
    requestSession() { this.requests++; this.session = session; return Promise.resolve(); },
  };
  const api = {
    isAvailable: true,
    AutoJoinPolicy: { ORIGIN_SCOPED: 'origin_scoped' },
    media: {
      DEFAULT_MEDIA_RECEIVER_APP_ID: 'CC1AD845',
      StreamType: { LIVE: 'LIVE', BUFFERED: 'BUFFERED' },
      MediaInfo: class { constructor(url, type) { this.contentId = url; this.contentType = type; } },
      GenericMediaMetadata: class {},
      LoadRequest: class { constructor(media) { this.media = media; } },
    },
  };
  const framework = {
    CastContext: { getInstance: () => context },
    CastContextEventType: { CAST_STATE_CHANGED: 'cast', SESSION_STATE_CHANGED: 'session' },
  };
  const sender = new CastSender({ getSdk: () => ({ framework, api }), onChange: (state) => changes.push(state), ...time });
  return { sender, context, session, api, framework, changes, loads, listeners, time };
}

test('initializes once with default web receiver, not Android TV Cast Connect', () => {
  const h = harness();
  h.sender.initialize(true);
  h.sender.initialize(true);
  assert.deepEqual(h.context.options, [{ receiverApplicationId: 'CC1AD845', autoJoinPolicy: 'origin_scoped', androidReceiverCompatible: false, resumeSavedSession: true }]);
  assert.equal(h.listeners.size, 2);
  assert.equal(h.sender.state.ready, true);
});

test('NO_DEVICES_AVAILABLE is discoverable, not an unsupported browser', async () => {
  const h = harness(); h.sender.initialize(true);
  assert.match(h.sender.state.message, /not found a Chromecast/);
  await h.sender.cast(stream);
  assert.equal(h.context.requests, 1);
  assert.equal(h.loads.length, 1);
});

test('Cast state changes and disconnection update guidance without autoplay', () => {
  const h = harness(); h.sender.initialize(true);
  h.listeners.get('cast')({ castState: 'NOT_CONNECTED' });
  assert.match(h.sender.state.message, /Chromecast available/);
  h.context.castState = 'CONNECTED';
  h.listeners.get('session')({ sessionState: 'SESSION_RESUMED' });
  assert.match(h.sender.state.message, /connected/);
  h.context.castState = 'NO_DEVICES_AVAILABLE';
  h.listeners.get('session')({ sessionState: 'SESSION_ENDED' });
  assert.match(h.sender.state.message, /not found/);
  assert.equal(h.loads.length, 0);
});

test('requestSession executes synchronously before yielding user activation', async () => {
  const h = harness(); h.sender.initialize(true);
  const casting = h.sender.cast(stream);
  assert.equal(h.context.requests, 1);
  await casting;
});

test('existing sessions are reused without opening another picker', async () => {
  const h = harness(); h.sender.initialize(true); h.context.session = h.session;
  await h.sender.cast(stream);
  assert.equal(h.context.requests, 0);
  assert.equal(h.loads.length, 1);
  assert.equal(h.sender.state.message, 'Casting!');
});

test('live HLS load preserves metadata and does not force playback to time zero', async () => {
  const h = harness(); h.sender.initialize(true);
  await h.sender.cast(stream);
  const request = h.loads[0];
  assert.equal(request.media.contentId, stream.streamUrl);
  assert.equal(request.media.contentType, 'application/vnd.apple.mpegurl');
  assert.equal(request.media.streamType, 'LIVE');
  assert.equal(request.media.metadata.title, stream.title);
  assert.equal(request.media.metadata.subtitle, '@test');
  assert.deepEqual(request.media.metadata.images, [{ url: stream.thumbnail }]);
  assert.equal(request.autoplay, true);
  assert.equal(Object.hasOwn(request, 'currentTime'), false);
  assert.equal(h.time.timers.size, 0);
});

test('replays start at zero and honor explicit content type', async () => {
  const h = harness(); h.sender.initialize(true);
  await h.sender.cast({ ...stream, isLive: false, contentType: 'video/mp4' });
  assert.equal(h.loads[0].currentTime, 0);
  assert.equal(h.loads[0].media.streamType, 'BUFFERED');
  assert.equal(h.loads[0].media.contentType, 'video/mp4');
});

test('unready or empty requests cannot open a picker', async () => {
  const h = harness();
  await h.sender.cast(stream);
  h.sender.initialize(true);
  await h.sender.cast(null);
  assert.equal(h.context.requests, 0);
});

test('a stalled picker shows bounded guidance but stays locked until it settles', async () => {
  const h = harness(); h.sender.initialize(true);
  const picker = deferred();
  h.context.requestSession = () => { h.context.requests++; return picker.promise; };
  const casting = h.sender.cast(stream);
  assert.equal([...h.time.timers.values()][0].delay, 15000);
  h.time.fire();
  assert.match(h.sender.state.message, /Cancel that dialog/);
  assert.equal(h.sender.state.busy, true);
  await h.sender.cast(stream);
  assert.equal(h.context.requests, 1);
  h.listeners.get('cast')({ castState: 'CONNECTED' });
  assert.match(h.sender.state.message, /Cancel that dialog/);
  h.context.session = h.session;
  picker.resolve();
  await casting;
  assert.equal(h.loads.length, 1);
  assert.equal(h.sender.state.busy, false);
  assert.equal(h.time.timers.size, 0);
});

for (const cancellation of ['cancel', { code: 'cancel' }]) {
  test(`cancellation (${typeof cancellation}) unlocks retry without loading media`, async () => {
    const h = harness(); h.sender.initialize(true);
    h.context.requestSession = () => Promise.reject(cancellation);
    await h.sender.cast(stream);
    assert.equal(h.sender.state.busy, false);
    assert.match(h.sender.state.message, /canceled/);
    assert.equal(h.loads.length, 0);
    assert.equal(h.time.timers.size, 0);
    h.context.session = h.session;
    await h.sender.cast(stream);
    assert.equal(h.loads.length, 1);
  });
}

test('synchronous picker failure unlocks controls and retains actionable error', async () => {
  const h = harness(); h.sender.initialize(true);
  h.context.requestSession = () => { throw { name: 'NotAllowedError' }; };
  await h.sender.cast(stream);
  assert.equal(h.sender.state.busy, false);
  assert.match(h.sender.state.message, /permission/);
});

test('session resolution without an actual session is not reported as Casting', async () => {
  const h = harness(); h.sender.initialize(true);
  h.context.requestSession = () => Promise.resolve();
  await h.sender.cast(stream);
  assert.match(h.sender.state.message, /No Cast session/);
  assert.equal(h.loads.length, 0);
});

test('slow media load has playback-specific guidance and cannot be duplicated', async () => {
  const h = harness(); h.sender.initialize(true); h.context.session = h.session;
  const load = deferred();
  h.session.loadMedia = (request) => { h.loads.push(request); return load.promise; };
  const casting = h.sender.cast(stream);
  assert.equal([...h.time.timers.values()][0].delay, 30000);
  h.time.fire();
  assert.match(h.sender.state.message, /playback issue, not device discovery/);
  await h.sender.cast(stream);
  assert.equal(h.loads.length, 1);
  load.reject(new Error('Receiver rejected media'));
  await casting;
  assert.match(h.sender.state.message, /Receiver rejected media/);
  assert.equal(h.sender.state.busy, false);
});

test('stream selection is snapshotted while the picker is open', async () => {
  const h = harness(); h.sender.initialize(true);
  const picker = deferred();
  h.context.requestSession = () => picker.promise;
  const selected = { ...stream };
  const casting = h.sender.cast(selected);
  selected.streamUrl = 'https://example.test/other.m3u8';
  h.context.session = h.session; picker.resolve(); await casting;
  assert.equal(h.loads[0].media.contentId, stream.streamUrl);
});

test('failed SDK initialization does not leave a false ready state', () => {
  const h = harness();
  h.context.setOptions = () => { throw new Error('initialization failed'); };
  h.sender.initialize(true);
  assert.equal(h.sender.state.ready, false);
  assert.match(h.sender.state.message, /initialization failed/);
});

function loaderHarness(onAppend = () => {}) {
  const h = harness();
  const win = {};
  const scripts = [];
  const doc = { createElement: () => ({}), head: { appendChild(script) { scripts.push(script); onAppend(win, script); } } };
  return { ...h, win, doc, scripts, run() { loadCastSdk(h.sender, { win, doc, ...h.time }); } };
}

test('fast SDK callback is registered before script insertion', () => {
  const h = loaderHarness((win) => {
    assert.equal(typeof win.__onGCastApiAvailable, 'function');
    win.__onGCastApiAvailable(true);
  });
  h.run();
  assert.equal(h.sender.state.ready, true);
  assert.equal(h.scripts.length, 1);
  assert.equal(h.scripts[0].async, true);
  assert.match(h.scripts[0].src, /loadCastFramework=1/);
  assert.equal(h.time.timers.size, 0);
});

test('already-loaded SDK initializes without waiting for another callback', () => {
  const h = loaderHarness();
  h.win.cast = { framework: h.framework };
  h.win.chrome = { cast: h.api };
  h.run();
  assert.equal(h.sender.state.ready, true);
  assert.equal(h.scripts.length, 0);
});

test('SDK download failure is distinct from unsupported browser', () => {
  const h = loaderHarness(); h.run(); h.scripts[0].onerror();
  assert.match(h.sender.state.message, /Could not download/);
  assert.equal(h.sender.state.ready, false);
  assert.equal(h.time.timers.size, 0);
});

test('missing SDK callback has a deadline and a late successful callback recovers', () => {
  const h = loaderHarness(); h.run(); h.time.fire();
  assert.match(h.sender.state.message, /did not initialize/);
  h.win.__onGCastApiAvailable(true);
  assert.equal(h.sender.state.ready, true);
  assert.equal(h.sender.state.phase, 'idle');
});

test('unsupported browser has actionable guidance without blocking preview', () => {
  const h = loaderHarness(); h.run(); h.win.__onGCastApiAvailable(false);
  assert.equal(h.sender.state.ready, false);
  assert.match(h.sender.state.message, /still preview/);
  assert.equal(h.time.timers.size, 0);
});
