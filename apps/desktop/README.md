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
- `pnpm desktop:dist:sign-only` (`node scripts/dist.mjs --sign-only`): a rehearsal before the first notarization. Developer ID signed with hardened runtime and `build/entitlements.mac.plist`, but never notarized: no notary profile probe, no `APPLE_*` env, `-c.mac.notarize=false`, nothing is uploaded to Apple (codesign's secure timestamp still contacts timestamp.apple.com). Needs only the keychain identity; `--sign-only --check` runs that preflight. Gatekeeper rejects the result ("Unnotarized Developer ID"), as expected.

`pnpm dist` builds everything in order: `pnpm -r --filter "./packages/*" build`, `scripts/build-runtime.mjs` (hubd, workerd, wolfd, memory extension into `runtime/`), `scripts/stage-runtime-assets.mjs` (darwin-arm64 onnxruntime-node natives, tokenizers, and the pinned fp32 embedding model, SHA-256 checked by `scripts/fetch-embed-model.mjs`), the console server, then electron-builder. `WOLFPACK_EMBED_MODEL_SRC=<dir>` reuses already-downloaded model files; `WOLFPACK_SKIP_RUNTIME=1` reuses `runtime/` as it is. Apple-silicon Mac only.

Inside the app (`Contents/Resources/`): `app.asar` (the shell only, ~2 MB), `server/` (console, ~134 MB), `runtime/` (bundles, `node_modules/` with the onnx natives, and `embed-model/`, ~600 MB), licences. The model is bundled rather than fetched on first run, so the app contacts no host besides the model provider, and the update feed. Result: about 985 MB installed, ~640 MB dmg/zip.

`dist.mjs` ends with `scripts/check-app.mjs <app>`: it checks the natives and the model are inside the app, that neither the Agent SDK nor the subscription bridge is in the runtime, and that every bare import of the runtime bundles (list in `scripts/runtime-externals.mjs`) resolves from inside `Resources/runtime`, using the app's own binary as Node. Signed builds also run `codesign --verify --deep --strict`, `spctl -a -vv` and `xcrun stapler validate`. `--sign-only` builds run `check-app.mjs --sign-only` instead: deep/strict verify, Developer ID Application authority, hardened runtime flag, embedded entitlements equal to `build/entitlements.mac.plist`, every nested helper, framework, `.node` and `.dylib` validly signed by the same team, and `spctl --assess` reported as information only (its rejection is expected); no stapler. `WOLFPACK_SKIP_RUNTIME=1` fails unless `runtime/` already has the onnx binding and `embed-model/model.onnx`.

CI: `.github/workflows/desktop.yml` has two jobs on a `macos-15` runner.
- `build` (pull requests and manual runs): unsigned, read-only token, no secrets; uploads the dmg, zip and `latest-mac.yml` as an artifact.
- `release` (manual runs only): runs in the protected environment `desktop-release` (the owner creates it and stores `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` there). It runs `node apps/desktop/scripts/dist.mjs --ci` (the same build chain, signing, notarising and stapling, credentials from env, the `.p8` written under `umask 077` and deleted afterwards) and uploads a DRAFT release.
- Releases come only from `stable` (the job's `if` checks the ref). Set a deployment-branch rule on the `desktop-release` environment restricting it to `stable`, so no other branch can reach the signing secrets.
- The app is API-key only: the Claude subscription bridge and the Agent SDK are not built in (`check-app.mjs` fails if either is in the runtime); a subscription can be added as a provider plug-in (`packages/harness/src/providers/README.md`).

Publishing the draft creates a `v<version>` tag on the default branch's HEAD. Bump the version in `apps/desktop/package.json` first and publish from the commit that was built.

Unsigned builds cannot self-update: Squirrel.Mac requires a signature. Applying an update to an unsigned app fails with `code has no resources but signature indicates they must be present`.

Both need Xcode 26+ (`actool` compiles `build/icon.icon`). `scripts/dist.mjs` sets `DEVELOPER_DIR` to an Xcode 26+ under `/Applications` when the active one is older.

## Install and verify

1. Open the dmg, drag Wolfpack Console to Applications, launch it.
2. Setup can finish without an API key ("Skip, add a key later in Pack → Keys" on the sign-in step). Chat then says to add one in Pack → Keys; saving it there makes the next chat work. Keys live in `keys.env` in the app data folder (the old `credentials.json` is no longer read, and is left untouched).
   - Settings → Change key restarts hubd (its memory curator) and the wolf, so both use the new key at once. A key saved in Pack → Keys is written by workerd: the wolf can use it after a wolf restart, but hubd's curator only sees it after the app restarts (hubd reads its key at launch).
3. Local mode: no `console.json` in the app folder above; the git graph loads.
4. Signed builds only:
   - `codesign --verify --deep --strict --verbose=2 "/Applications/Wolfpack Console.app"`
   - `spctl --assess --type execute --verbose "/Applications/Wolfpack Console.app"` (expect `accepted`, source `Notarized Developer ID`)
   - `xcrun stapler validate "/Applications/Wolfpack Console.app"`

## Upgrades and existing wolves

- There is no upgrade path from a pre-wizard build: the app has never been released, so nobody has one. Later layout changes go through the migrations in work-wolfpack-u6Z4dRY.
- Reusing an existing `~/Wolves/<id>` keeps its old domains.

## Updates and backups

- Where: on the first launch after an update, the app backs up into a folder named `<state folder> Backup` next to the state folder (for the packaged app, `~/Library/Application Support/Wolfpack Console Backup`). Only the last backup is kept (`last/`); the folder and its subfolders are mode 0700.
- Included: pack state (KB in `hub/`, credentials, `setup.json`, tokens) and, for each wolf, its `den/`, `agent/`, `session.sqlite` (with `-wal` and `-shm`, at the wolf root and in `den/`) and the other top-level files.
- Excluded: workspaces, logs (`logs/`, `*.log`, `den/logs`), `scratch` and Electron caches.
- A failed migration restores the backup and the app says so instead of starting. The half-migrated data is kept in a `failed-*` folder on purpose, for support; delete it by hand when done. An `in-progress.json` file in the backup folder means an update was interrupted: the next launch restores from `last/` and reports a failed update. `failed-*`, `old-*`, `superseded-*` and `in-progress.stale-*` items in the backup folder accumulate on purpose (nothing is hard-deleted); move them to the Trash by hand when you no longer need them.
- A downgrade (data newer than the app) runs nothing and changes nothing.
