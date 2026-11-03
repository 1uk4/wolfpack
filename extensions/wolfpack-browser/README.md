# wolfpack-browser

Guarded headless Chromium for wolfd wolves (pi-durable only), via `playwright-core`. Written from scratch.

## Enable (per wolf, default OFF)
wolf.yaml:

```yaml
extensions: [memory, browser]
browser:
  enabled: true            # without this the extension registers no tools
  headed: false            # true = visible window
  allowHosts: []           # loopback/private/tailnet hosts to permit: exact host/IP or "*.suffix"
  executablePath: ""       # optional; else Playwright cache (~/Library/Caches/ms-playwright), then system Chrome
  timeoutMs: 30000
  maxOutputChars: 20000
```

## Install into a den
`wolfpack sandbox install-extensions <dev-root> --extensions browser` (dev sandbox), or `wolfpack sync` for a wolf whose
`extensions:` lists `browser`. Both use `buildDurableExtension`, which bundles playwright-core into
`<den>/extensions/wolfpack-browser/index.js` (+ package.json, browsers.json). No browser is downloaded: install one with
`npx playwright-core install chromium` or Google Chrome. Restart the wolf to pick it up.

## Tools
browser_goto, browser_click, browser_fill, browser_eval, browser_screenshot (returns a file path: the tool API is
text-only), browser_console, browser_network, browser_close. One page, calls serialized.

## Guards
- Profile: `<den>/state/browser-profile` (0700), never the user's Chrome profile.
- URLs: http(s) only; blocks file/chrome/data/non-blank about, loopback, RFC1918, link-local, 100.64/10, *.ts.net,
  *.local, and names resolving to those, unless in `allowHosts`. Enforced on goto, on every request the page makes, and
  on each redirect hop (resolved manually via route.fetch).
- Network log redacts authorization, cookie, set-cookie, proxy-authorization, x-api-key, apikey, and URL userinfo.
- eval/console/network output capped at `maxOutputChars`; logs keep the last 500 entries.
- Screenshots live in a per-session temp dir removed when the browser closes (browser_close, wolf shutdown).
