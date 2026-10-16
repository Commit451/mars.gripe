"""Browser regression checks using explicit Cast/resolve doubles, never a real TV.

Start the FastAPI app, then run:
  uv run --no-project --with playwright python tests/browser_smoke.py
Requires an installed Chrome browser. --base-url can also smoke-test a deployment.
"""
import argparse
import json
from playwright.sync_api import sync_playwright, expect

SDK_URL = "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1"
STREAM = {
    "streamUrl": "https://example.test/test.m3u8",
    "title": "Browser regression fixture",
    "uploader": "test",
    "isLive": True,
    "variants": [{"height": 1080}],
}
SDK_DOUBLE = """
(() => {
  const t = window.testCast = {requests: 0, loads: [], state: 'NO_DEVICES_AVAILABLE', session: null, listeners: {}};
  window.chrome ||= {};
  window.chrome.cast = {
    isAvailable: true,
    AutoJoinPolicy: {ORIGIN_SCOPED: 'origin_scoped'},
    media: {
      DEFAULT_MEDIA_RECEIVER_APP_ID: 'CC1AD845',
      StreamType: {LIVE: 'LIVE', BUFFERED: 'BUFFERED'},
      MediaInfo: class { constructor(contentId, contentType) { Object.assign(this, {contentId, contentType}); } },
      GenericMediaMetadata: class {},
      LoadRequest: class { constructor(media) { this.media = media; } },
    },
  };
  const context = {
    setOptions(options) { t.options = options; },
    addEventListener(type, callback) { t.listeners[type] = callback; },
    getCastState() { return t.state; },
    getCurrentSession() { return t.session; },
    requestSession() {
      t.requests++;
      t.userActivation = navigator.userActivation.isActive;
      return new Promise((resolve, reject) => {
        t.cancelPicker = () => reject('cancel');
        t.selectDevice = () => {
          t.state = 'CONNECTED';
          t.session = { loadMedia(request) { t.loads.push(request); return Promise.resolve(); } };
          t.listeners.cast({castState: t.state});
          t.listeners.session({sessionState: 'SESSION_STARTED'});
          resolve();
        };
      });
    },
  };
  window.cast = {framework: {
    CastContext: {getInstance: () => context},
    CastContextEventType: {CAST_STATE_CHANGED: 'cast', SESSION_STATE_CHANGED: 'session'},
  }};
  t.callbackRegisteredBeforeSdk = typeof window.__onGCastApiAvailable === 'function';
  window.__onGCastApiAvailable(true);
})();
"""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:18765")
    parser.add_argument("--channel", choices=["chrome", "chromium"], default="chrome")
    args = parser.parse_args()
    base = args.base_url.rstrip("/")
    results = []
    with sync_playwright() as p:
        browser = p.chromium.launch(channel=args.channel, headless=True)

        def new_page(sdk="mock", mobile=False):
            options = {"viewport": {"width": 412, "height": 915}, "is_mobile": True, "has_touch": True} if mobile else {}
            context = browser.new_context(**options)
            errors = []
            page = context.new_page()
            page.on("pageerror", lambda error: errors.append(str(error)))
            if sdk == "mock":
                context.route(SDK_URL, lambda route: route.fulfill(content_type="text/javascript", body=SDK_DOUBLE))
            elif sdk == "blocked":
                context.route(SDK_URL, lambda route: route.abort())
            elif sdk == "silent":
                context.route(SDK_URL, lambda route: route.fulfill(content_type="text/javascript", body="/* intentionally silent SDK test double */"))
            context.route(base + "/api/resolve?*", lambda route: route.fulfill(json=STREAM))
            return context, page, errors

        def resolve(page):
            page.locator("#url-input").fill("https://x.com/i/broadcasts/testfixture")
            page.locator("#resolve-btn").click()
            expect(page.locator("#result")).to_be_visible()
            expect(page.locator("#status")).to_contain_text("Video resolved")

        # Do not install Playwright's fake clock here: it does not enforce the
        # Window receiver required by native setTimeout/clearTimeout. The fake
        # clock previously masked a real "Illegal invocation" after picker open.
        context, page, errors = new_page(mobile=True)
        page.goto(base + "/")
        expect(page.locator("#cast-status")).to_contain_text("not found a Chromecast")
        resolve(page)
        page.locator("#cast-btn").click()
        expect(page.locator("#cast-status")).to_contain_text("Choose your Chromecast")
        expect(page.locator("#cast-btn")).to_be_disabled()
        assert page.evaluate("testCast.userActivation")
        page.evaluate("testCast.cancelPicker()")
        expect(page.locator("#cast-status")).to_contain_text("Cast canceled")
        expect(page.locator("#cast-btn")).to_be_enabled()
        page.locator("#cast-btn").click()
        page.evaluate("testCast.selectDevice()")
        expect(page.locator("#cast-status")).to_have_text("Casting!")
        assert page.evaluate("testCast.loads.length") == 1
        page.locator("#cast-btn").click()
        expect(page.locator("#cast-status")).to_have_text("Casting!")
        assert page.evaluate("testCast.loads.length") == 2
        native_timers = page.evaluate("""async () => {
          const {CastSender} = await import('/cast.js?native-timer-regression');
          const notices = [];
          const sender = new CastSender({onChange: state => notices.push(state.message)});
          const value = await sender.waitWithGuidance(
            new Promise(resolve => window.setTimeout(() => resolve('settled'), 50)),
            1, 'native watchdog fired');
          await sender.waitWithGuidance(Promise.resolve(), 10, 'must be cleared');
          await new Promise(resolve => window.setTimeout(resolve, 30));
          return {value, notices};
        }""")
        assert native_timers == {"value": "settled", "notices": ["native watchdog fired"]}
        assert not errors, errors
        results.append({"scenario": "native browser timers: picker / cancel / retry / media load / watchdog cleanup", "passed": True, "sdk": "test double; timers are real Chrome APIs"})
        context.close()

        context, page, errors = new_page(mobile=True)
        page.clock.install()
        page.goto(base + "/")
        expect(page.locator("#cast-status")).to_contain_text("not found a Chromecast")
        assert page.evaluate("testCast.callbackRegisteredBeforeSdk")
        assert page.evaluate("testCast.options.receiverApplicationId") == "CC1AD845"
        assert page.evaluate("testCast.options.androidReceiverCompatible") is False
        resolve(page)
        expect(page.locator("#cast-btn")).to_be_enabled()
        page.locator("#cast-btn").click()
        assert page.evaluate("testCast.userActivation")
        expect(page.locator("#cast-btn")).to_be_disabled()
        expect(page.locator("#resolve-btn")).to_be_disabled()
        page.clock.fast_forward(15001)
        expect(page.locator("#cast-status")).to_contain_text("Cancel that dialog")
        assert page.evaluate("testCast.requests") == 1
        assert page.evaluate("testCast.loads.length") == 0
        page.evaluate("testCast.cancelPicker()")
        expect(page.locator("#cast-btn")).to_be_enabled()
        expect(page.locator("#resolve-btn")).to_be_enabled()
        page.locator("#cast-btn").click()
        page.evaluate("testCast.selectDevice()")
        expect(page.locator("#cast-status")).to_have_text("Casting!")
        assert page.evaluate("testCast.loads.length") == 1
        assert page.evaluate("Object.hasOwn(testCast.loads[0], 'currentTime')") is False
        page.locator("#cast-btn").click()
        expect(page.locator("#cast-status")).to_have_text("Casting!")
        assert page.evaluate("testCast.requests") == 2
        assert page.evaluate("testCast.loads.length") == 2
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
        assert not errors, errors
        results.append({"scenario": "mobile resolve / user gesture / stalled picker / cancel / retry / session reuse", "passed": True, "sdk": "test double"})
        context.close()

        context, page, errors = new_page(sdk="blocked")
        page.goto(base + "/")
        expect(page.locator("#cast-status")).to_contain_text("Could not download")
        resolve(page)
        expect(page.locator("#cast-btn")).to_be_disabled()
        expect(page.locator("#preview-btn")).to_be_enabled()
        assert not errors, errors
        results.append({"scenario": "blocked SDK leaves resolve and preview usable", "passed": True, "sdk": "blocked intentionally"})
        context.close()

        context, page, errors = new_page(sdk="silent")
        page.clock.install()
        page.goto(base + "/")
        page.clock.fast_forward(15001)
        expect(page.locator("#cast-status")).to_contain_text("did not initialize")
        page.evaluate(SDK_DOUBLE)
        expect(page.locator("#cast-status")).to_contain_text("not found a Chromecast")
        resolve(page)
        expect(page.locator("#cast-btn")).to_be_enabled()
        assert not errors, errors
        results.append({"scenario": "SDK initialization deadline and late recovery", "passed": True, "sdk": "test double"})
        context.close()

        context, page, errors = new_page(sdk="real")
        page.goto(base + "/")
        page.wait_for_function("!!window.chrome?.cast?.isAvailable && !!window.cast?.framework", timeout=30000)
        expect(page.locator("#cast-status")).not_to_have_text("Loading Chromecast support…")
        assert "did not initialize" not in page.locator("#cast-status").inner_text()
        assert not errors, errors
        results.append({"scenario": "real Google SDK initializes without a JavaScript error", "passed": True, "sdk": "real; no session or playback requested"})
        context.close()
        browser.close()
    print(json.dumps({"base_url": base, "passed": len(results), "results": results}, indent=2))


if __name__ == "__main__":
    main()
