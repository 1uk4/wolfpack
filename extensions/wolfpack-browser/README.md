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
  maxResponseBytes: 26214400   # largest response body the page may receive
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
- URLs: http(s) only; blocks file/chrome/data/non-blank about, loopback, RFC1918, link-local, CGNAT/tailnet, *.ts.net,
  *.local, multicast/reserved, NAT64/6to4/Teredo/site-local IPv6 (embedded IPv4 is checked), and names resolving to
  those, unless in `allowHosts`.
- No check-then-connect gap: every http(s) request the page makes is performed in Node (`fetcher.ts`) with a
  connect-time `lookup` that rejects blocked addresses on the address actually connected to; resolver errors fail
  closed. Redirects are never followed by the network stack: each hop's `Location` is vetted, then the 3xx is handed to
  the browser. Responses are capped by size (`maxResponseBytes`) and time (`timeoutMs`). Cookies are bridged through
  the browser context's jar.
- WebSockets go through `routeWebSocket` with the same policy (resolved before connecting; the browser then opens that
  socket itself, so a rebinding race remains for ws only). WebRTC is limited with
  `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`.
- Network log redacts any header matching auth|token|cookie|secret|api-key|session|csrf, URL userinfo, credential-like
  query values and fragments.
- eval/console/network output capped at `maxOutputChars`; logs keep the last 500 entries.
- Screenshots live in a per-session temp dir (`wolf-browser-<pid>-*`), removed when the browser closes; dirs of dead
  processes are swept at launch. Popups are closed; there is one page.

## Limits (read this)
- An allowlisted host can redirect anywhere the policy allows, and anything it serves is trusted as far as the page
  goes: allowlist only hosts you control.
- Redaction is cosmetic against `browser_eval`: the model can run JS that reads cookies, storage or tokens from the page
  and return them. Do not treat the logs' redaction as a security boundary against a hostile or prompt-injected page.
