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

`pnpm dist` builds everything in order: `pnpm -r --filter "./packages/*" build`, `scripts/build-runtime.mjs` (hubd, workerd, wolfd, memory extension into `runtime/`), `scripts/stage-runtime-assets.mjs` (darwin-arm64 onnxruntime-node natives, tokenizers, and the pinned fp32 embedding model, SHA-256 checked by `scripts/fetch-embed-model.mjs`), the console server, then electron-builder. `WOLFPACK_EMBED_MODEL_SRC=<dir>` reuses already-downloaded model files; `WOLFPACK_SKIP_RUNTIME=1` reuses `runtime/` as it is. Apple-silicon Mac only.

Inside the app (`Contents/Resources/`): `app.asar` (the shell only, ~2 MB), `server/` (console, ~134 MB), `runtime/` (bundles, `node_modules/` with the onnx natives, and `embed-model/`, ~600 MB), licences. The model is bundled rather than fetched on first run, so the app contacts no host besides the model provider, the update feed and the subscription login. Result: about 985 MB installed, ~640 MB dmg/zip.

`dist.mjs` ends with `scripts/check-app.mjs <app>`: it checks the natives, the model and the Agent SDK are inside the app, and that every bare import of the runtime bundles (list in `scripts/runtime-externals.mjs`) resolves from inside `Resources/runtime`, using the app's own binary as Node. Signed builds also run `codesign --verify --deep --strict`, `spctl -a -vv` and `xcrun stapler validate`. `WOLFPACK_SKIP_RUNTIME=1` fails unless `runtime/` already has the onnx binding, `embed-model/model.onnx` and the Agent SDK.

CI: `.github/workflows/desktop.yml` has two jobs on a `macos-15` runner.
- `build` (pull requests and manual runs): unsigned, read-only token, no secrets; uploads the dmg, zip and `latest-mac.yml` as an artifact.
- `release` (manual runs only): runs in the protected environment `desktop-release` (the owner creates it and stores `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` there). It runs `node apps/desktop/scripts/dist.mjs --ci` (the same build chain, signing, notarising and stapling, credentials from env, the `.p8` written under `umask 077` and deleted afterwards) and uploads a DRAFT release.
- Releases come only from `stable` (the job's `if` checks the ref). Set a deployment-branch rule on the `desktop-release` environment restricting it to `stable`, so no other branch can reach the signing secrets.
- The subscription option (ticket work-wolfpack-66JSDus) needs the Agent SDK's per-platform CLI shipped, or `pathToClaudeCodeExecutable` set, before its build switch is turned on. Today only the SDK's JS is shipped, which is enough for API-key chat.

Publishing the draft creates a `v<version>` tag on the default branch's HEAD. Bump the version in `apps/desktop/package.json` first and publish from the commit that was built.

Unsigned builds cannot self-update: Squirrel.Mac requires a signature. Applying an update to an unsigned app fails with `code has no resources but signature indicates they must be present`.

Both need Xcode 26+ (`actool` compiles `build/icon.icon`). `scripts/dist.mjs` sets `DEVELOPER_DIR` to an Xcode 26+ under `/Applications` when the active one is older.

## Install and verify

1. Open the dmg, drag Wolfpack Console to Applications, launch it.
2. Local mode: no `console.json` in the app folder above; the git graph loads.
3. Signed builds only:
   - `codesign --verify --deep --strict --verbose=2 "/Applications/Wolfpack Console.app"`
   - `spctl --assess --type execute --verbose "/Applications/Wolfpack Console.app"` (expect `accepted`, source `Notarized Developer ID`)
   - `xcrun stapler validate "/Applications/Wolfpack Console.app"`

## Upgrades and existing wolves

- There is no upgrade path from a pre-wizard build: the app has never been released, so nobody has one. Later layout changes go through the migrations in work-wolfpack-u6Z4dRY.
- Reusing an existing `~/Wolves/<id>` keeps its old domains.
