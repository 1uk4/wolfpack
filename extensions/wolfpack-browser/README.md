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
  maxTabs: 6               # live tabs at once (one per thread)
  tabIdleMs: 900000        # close a thread's tab after this idle time
```

## Install into a den
`wolfpack sandbox install-extensions <dev-root> --extensions browser` (dev sandbox), or `wolfpack sync` for a wolf whose
`extensions:` lists `browser`. Both use `buildDurableExtension`, which bundles playwright-core into
`<den>/extensions/wolfpack-browser/index.js` (+ package.json, browsers.json). No browser is downloaded: install one with
`npx playwright-core install chromium` or Google Chrome. Restart the wolf to pick it up.

## Tools
browser_goto, browser_click, browser_fill, browser_eval, browser_screenshot (returns a file path: the tool API is
text-only), browser_console, browser_network, browser_close.

## Tabs (one per thread)
One Chromium context (one profile, shared sign-in and cookies), one tab per thread (conversation), keyed by the tool
call's `conversationId` and created on that thread's first browser call. A call with no id uses the `default` tab.
- Each thread has its own queue: calls inside a thread run in order, threads run in parallel.
- Console, network log, blocked-request list and screenshots are per tab. `browser_close` closes only the calling
  thread's tab (and its screenshots); the browser exits with its last tab. A closed or crashed tab is recreated by the
  thread's next call.
- At most `maxTabs` (default 6) tabs are live. Opening one more closes the least recently used idle tab; if every tab
  is busy the call fails with "Too many browser tabs". A tab idle for `tabIdleMs` (default 900000 = 15 min) is closed.
- Popups are closed. Chromium flags and the request guard are context-wide and unchanged.

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
- `allowHosts` bypass: an EventSource (browser resource type `eventsource`, not the Accept header) to an allowlisted
  host that is also the page's own host is served by Chromium's own network stack, because the Node fetcher cannot
  stream. Redirects on that path are NOT vetted: Playwright does not show the hop to the guard, so an allowlisted host
  that redirects an EventSource to a private host is followed. Keep `allowHosts` to hosts you trust.
- The Chromium flag `--disable-features=LocalNetworkAccessChecks` is global to the browser: it lets WebSockets to
  allowlisted loopback hosts open. Non-allowlisted private hosts are still refused by the request/WebSocket policy.
- WebSockets go through `routeWebSocket` with the same policy (resolved before connecting; the browser then opens that
  socket itself, so a rebinding race remains for ws only). WebRTC is limited with
  `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`.
- Network log redacts any header matching auth|token|cookie|secret|api-key|session|csrf, URL userinfo, credential-like
  query values and fragments.
- eval/console/network output capped at `maxOutputChars`; logs keep the last 500 entries.
- Screenshots live in a per-session temp dir (`wolf-browser-<pid>-*`), removed when the browser closes; dirs of dead
  processes are swept at launch. Popups are closed.

## Limits (read this)
- An allowlisted host can redirect anywhere the policy allows, and anything it serves is trusted as far as the page
  goes: allowlist only hosts you control.
- Redaction is cosmetic against `browser_eval`: the model can run JS that reads cookies, storage or tokens from the page
  and return them. Do not treat the logs' redaction as a security boundary against a hostile or prompt-injected page.

## Fetch path details and residual risks
- Cookies: the Node path applies the browser's rules itself. Per request: `Sec-Fetch-Site` (or computed from the
  initiator); never SameSite=Strict across sites; Lax only on top-level GET navigations; no cookies at all on
  cross-site non-navigation requests (Playwright does not expose `credentials: "omit"`, so this is the default).
  Set-Cookie is validated (Domain must domain-match, no public-suffix/dotless Domain, `__Host-`/`__Secure-` rules,
  SameSite=None needs Secure) before it reaches the jar.
- Responses: capped at `maxResponseBytes` (default 25 MB, also after decompression); idle-based timeout (`timeoutMs`
  without any progress); gzip/br/deflate bodies are decoded; `text/event-stream` is refused; request bodies that
  Playwright cannot read (file/blob uploads) abort instead of being sent empty.
- Not covered: Node's TLS/CA store is used (not Chromium's, so private CAs the browser trusts may fail), HTTP/1.1
  only, no proxy support, no WebTransport or preconnect/prefetch coverage, and WebSockets are resolved by us and then
  connected by Chromium, leaving a DNS-rebinding race for ws only.
- `browser_eval` busy loops hit `timeoutMs`, after which the page is closed and the next call opens a fresh one;
  `browser_close` is not queued, so it works even when a call is stuck.
