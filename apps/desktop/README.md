# @wolfpack/desktop

Electron shell for the Wolfpack Console.

## Remote console mode

By default the app starts its bundled local server. To open a console served
elsewhere (e.g. the VPS behind tailscale serve) instead, set the URL either way:

- env: `WOLFPACK_CONSOLE_URL=https://sfo-01.<tailnet>.ts.net` (wins over the file)
- file: `~/Library/Application Support/Wolfpack Console/console.json`
  `{ "consoleUrl": "https://sfo-01.<tailnet>.ts.net" }`

Clear it (delete the file / unset the env) to return to local mode. Restart the app after changing.

Rules: https only (plain http only for 127.0.0.1/localhost/[::1] and 100.64/10 tailnet IPs); no credentials in the URL; invalid values are logged and ignored (local mode). `WOLFPACK_DEV_URL` takes precedence over both.

In remote mode no server is spawned and `data/` + `auth.json` are untouched; permissions, notifications and navigation are pinned to the remote origin; other origins open in the browser. If the host is unreachable a local error page with a Retry button is shown.

Pairing (remote mode only): run `hubd pair --kind browser` on the hub to get a code, then in the app choose **Wolfpack Console → Pair this app…**. That opens hubd's pairing page (`<origin>/hub/pair`, same origin); enter the code and press Pair. hubd redirects to `<origin>/pair#token=…`, and the console stores the token in this app's localStorage and cookie. The hub must be configured with its console URL for that redirect; otherwise the token is only saved on the hub origin and the console won't see it.

## Local mode (default)

With no `WOLFPACK_CONSOLE_URL` and no `console.json`, the app spawns its bundled server and runs everything on this Mac (git graph, data, auth). A fresh install starts with an empty `~/Library/Application Support/Wolfpack Console` folder; nothing is imported from any other app. To confirm local mode, check that folder has no `console.json` with a `consoleUrl`.

## Building

From the repo root (`pnpm install && pnpm build` first):

- `pnpm desktop:dist` (same as `pnpm --filter @wolfpack/desktop dist`): unsigned dmg + zip in `apps/desktop/dist/`. No signing, no notarization. Gatekeeper blocks it on first open (right-click > Open, or `xattr -dr com.apple.quarantine "/Applications/Wolfpack Console.app"`).
- `pnpm desktop:dist:signed`: Developer ID signed, notarized and stapled. Needs a `Developer ID Application` identity in the keychain (`security find-identity -v -p codesigning`) and a notarytool profile: `xcrun notarytool store-credentials WOLFPACK_NOTARY`. It fails early with a clear message if either is missing; `node scripts/dist.mjs --signed --check` runs only that preflight.

Both need Xcode 26+ (`actool` compiles `build/icon.icon`). `scripts/dist.mjs` sets `DEVELOPER_DIR` to an Xcode 26+ under `/Applications` when the active one is older.

## Install and verify

1. Open the dmg, drag Wolfpack Console to Applications, launch it.
2. Local mode: no `console.json` in the app folder above; the git graph loads.
3. Signed builds only:
   - `codesign --verify --deep --strict --verbose=2 "/Applications/Wolfpack Console.app"`
   - `spctl --assess --type execute --verbose "/Applications/Wolfpack Console.app"` (expect `accepted`, source `Notarized Developer ID`)
   - `xcrun stapler validate "/Applications/Wolfpack Console.app"`
