# @wolfpack/desktop

Electron shell for the Wolfpack Console.

## Remote console mode

By default the app starts its bundled local server. To open a console served
elsewhere (e.g. the VPS behind tailscale serve) instead, set the URL either way:

- env: `LH_CONSOLE_URL=https://sfo-01.<tailnet>.ts.net` (wins over the file)
- file: `~/Library/Application Support/LearnHarness/console.json`
  `{ "consoleUrl": "https://sfo-01.<tailnet>.ts.net" }`

Clear it (delete the file / unset the env) to return to local mode. Restart the app after changing.

Rules: https only (plain http only for 127.0.0.1/localhost/[::1] and 100.64/10 tailnet IPs); no credentials in the URL; invalid values are logged and ignored (local mode). `LH_DEV_URL` takes precedence over both.

In remote mode no server is spawned and `data/` + `auth.json` are untouched; permissions, notifications and navigation are pinned to the remote origin; other origins open in the browser. If the host is unreachable a local error page with a Retry button is shown.

Pairing: open `https://<host>/hub/pair?code=…` in the app's browser? No — paste it into a normal browser only for the phone; for the desktop, pair in-app by navigating the app to that URL (same origin; the token lands in this app's localStorage/cookie).
