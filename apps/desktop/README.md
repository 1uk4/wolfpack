# @wolfpack/desktop

Electron shell for the Wolfpack Console.

## Remote console mode

By default the app starts its bundled local server. To open a console served
elsewhere (e.g. the VPS behind tailscale serve) instead, set the URL either way:

- env: `WOLFPACK_CONSOLE_URL=https://sfo-01.<tailnet>.ts.net` (wins over the file)
- file: `~/Library/Application Support/LearnHarness/console.json`
  `{ "consoleUrl": "https://sfo-01.<tailnet>.ts.net" }`

Clear it (delete the file / unset the env) to return to local mode. Restart the app after changing.

Rules: https only (plain http only for 127.0.0.1/localhost/[::1] and 100.64/10 tailnet IPs); no credentials in the URL; invalid values are logged and ignored (local mode). `LH_DEV_URL` takes precedence over both.

In remote mode no server is spawned and `data/` + `auth.json` are untouched; permissions, notifications and navigation are pinned to the remote origin; other origins open in the browser. If the host is unreachable a local error page with a Retry button is shown.

Pairing (remote mode only): run `hubd pair --kind browser` on the hub to get a code, then in the app choose **Wolfpack Console → Pair this app…**. That opens hubd's pairing page (`<origin>/hub/pair`, same origin); enter the code and press Pair. hubd redirects to `<origin>/pair#token=…`, and the console stores the token in this app's localStorage and cookie. The hub must be configured with its console URL for that redirect; otherwise the token is only saved on the hub origin and the console won't see it.
