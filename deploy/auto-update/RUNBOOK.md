# Auto-update after a stable release (work-wolfpack-qrU6cCO)

**UNVERIFIED: none of this has run on a host yet.** Each host pulls the stable manifest itself; GitHub never connects to a host.

## How it works
- **Manifest**: `https://github.com/1uk4/wolfpack/releases/download/stable-manifest/stable.json` (scripts/stable-manifest.mjs).
- **Core**: `scripts/auto-update.mjs` `runAutoUpdate`. One pass reads each unit's running version, compares it with the manifest, and updates units **one at a time, in order**:
  verify -> install -> health check.
- **Only plain releases update**: the target must be exactly `X.Y.Z` (no `+build`, and the GitHub Release must not be a prerelease). A running `X.Y.Z+build` reads as `X.Y.Z`. A dev build (`-dev`) or an unreadable version (an old bare sha) is never touched and shows `idle` with code `dev-build` / `unreadable-version`.
- **Failure = stop**: an unhealthy result (or a refused or failed install) is recorded as `failed` with a code. The pass stops, and the host installs nothing more until either
  - a **newer** release of that component appears, or
  - a person runs `--clear-failed`.
  There is no new rollback: `deploy-release.sh` keeps its own swap-back (code `rolled-back` = it ran and the old release is live; `rollback-unhealthy` = needs a human).
  - The failure is held in the unit's `failedTarget`. A pause (kill switch or opt-in off) shows at the top of the status (`enabled: false`, `disabledReason`) and leaves a failed unit `failed`, so resuming never retries it.
  - A unit still `updating` when the next run starts (the earlier run died mid-install) is recorded as `failed` with code `interrupted`.
  - Code `config`: the unit's env file has no numeric `<PFX>_PORT`. No default exists (the units refuse to start without one), so nothing is installed.
- **Lock**: a file holding pid + random token (`/run/wolfpack-auto-update.lock` on sfo-01, `~/.wolfpack/auto-update/run.lock` on the Mac), linked into place atomically and taken before any status write. A second run while one is live does nothing and returns `locked`, paused runs included. A lock left by a dead pid is taken over only under a second short lock, `<lock>.takeover`: holding it, the run re-reads the lock and removes it only if its holder is still dead, then links its own. A live lock is never moved or removed, so any number of racing runs (timer plus manual) end with one holder. A run only removes a lock that still holds its own token. If a run dies inside that brief takeover step, `<lock>.takeover` is left behind: later runs return `locked`, write no status, and log its path with "remove it by hand". The guard is never broken automatically. Its paths: `/run/wolfpack-auto-update.lock.takeover` on sfo-01 (under `/run`, so a reboot clears it too) and `~/.wolfpack/auto-update/run.lock.takeover` on the Mac (`$WOLFPACK_HOME/auto-update/run.lock.takeover` when `WOLFPACK_HOME` is set). The only sign is a stale `lastCheck` (see Troubleshooting).
- **Opt-in**:
  - The timer installs nothing unless `WOLFPACK_AUTO_UPDATE=1`. `run --now` is a manual run that works without it.
  - **Kill switch**: the file `auto-update.disabled` in the state dir stops every run, manual ones too.
- **No alerts**: the result goes to a status file only.

## Asset verification (sfo-01)
Before `deploy-release.sh` runs, `createReleaseVerifier` checks all of this:
- the manifest tag is `<component>/v<version>`;
- the GitHub Release exists and is not a draft;
- the published `<asset>.sha256` names the asset;
- its hash equals the `sha256:` digest that GitHub computed for the asset on upload (release API `assets[].digest`).

The verified hash is passed to `deploy-release.sh --sha256 <hex>`, which requires both the downloaded `.sha256` and the downloaded tarball to equal it (then the tar member policy and the VERSION). Any mismatch gives code `checksum` and installs nothing. Without `--sha256`, `deploy-release.sh` behaves as before.

**Trust ceiling.** This catches corruption, a wrong or stale `.sha256`, and an asset swapped between the check and the download (CDN or mirror). It does **not** prove provenance: anyone with write access to the repo's releases can publish both an asset and a matching `.sha256`, and GitHub's digest would agree. Release signing is out of scope for now.

## Status file (schema 1)
```
{ schema: 1, host, enabled, disabledReason?, lastCheck, result: ok|updated|failed|disabled|manifest-error, error?,
  units: { <id>: { component, current, target, state: idle|updating|updated|failed|disabled, code?, message?, failedTarget?, startedAt?, finishedAt? } } }
```
- sfo-01: `/var/lib/wolfpack-auto-update/status.json` (0644).
- The console on sfo-01 reads it on every `GET /api/updates`. Set `WOLFPACK_AUTO_UPDATE_STATUS` to override the path. Each component's `updateStatus` comes from its worst unit: `workerd` covers workerd and workerd-wolves, `wolfd` covers each `wolfd@<name>`.
- Mac: `~/.wolfpack/auto-update/status.json`, shown by `pnpm stack status` (`updates:` line). The sfo-01 console cannot read Mac files, so the Mac status is not in `/api/updates`.

## sfo-01: turn it on (owner)
1. Copy the repo (at the release commit) to the host, then run `bash deploy/auto-update/setup.sh --dry-run install`, then the same without `--dry-run`.
   This writes `/opt/wolfpack-auto-update/{auto-update.mjs,deploy-release.sh,release-components.json,RUNBOOK.md}`, the units and `/etc/wolfpack/auto-update.env` (opt-in `0`).
2. Edit `/etc/wolfpack/auto-update.env`:
   - set `WOLFPACK_AUTO_UPDATE=1`;
   - check the `WOLFPACK_AUTO_UPDATE_WOLVES` list;
   - check `WOLFPACK_AUTO_UPDATE_UNITS`, which by default includes `workerd-wolves`. That unit restarts with `deploy-release.sh --unit wolves` and its supervised-wolf survival checks.
3. Do a first manual pass and read the result:
   `node /opt/wolfpack-auto-update/auto-update.mjs run --now; node /opt/wolfpack-auto-update/auto-update.mjs status`
4. Run `systemctl enable --now wolfpack-auto-update.timer` (every 30 min, randomised). Check with `systemctl list-timers wolfpack-auto-update.timer` and `journalctl -u wolfpack-auto-update`.

- **First press on a host.** The code default for `WOLFPACK_AUTO_UPDATE_UNITS` still includes the link `workerd`, so on sfo-01 set the env explicitly. Checklist:
  1. `bash deploy/auto-update/setup.sh install`.
  2. Re-run `deploy/console/setup.sh` to install the polkit rule (start-only for `wolfpack-auto-update-now.service`).
  3. In `/etc/wolfpack/auto-update.env` set `WOLFPACK_AUTO_UPDATE_UNITS="hubd workerd-wolves wolfd console"` and `WOLFPACK_AUTO_UPDATE_WOLVES="hal"`.
  4. Check that `/etc/wolfpack/workerd-wolves.env` has `WORKERD_PORT` (the health probe has no default port).
  5. Run `node /opt/wolfpack-auto-update/auto-update.mjs run --now` once under supervision, before using the button.
  6. Leave `wolfpack-auto-update.timer` disabled.
  With `--now` the script exits 3 when the kill switch is set and 4 when another run holds the lock, so the button shows those instead of "Updated".
- **Button only (no timer).** `setup.sh install` also writes `wolfpack-auto-update-now.service`, a root oneshot running `auto-update.mjs run --now` with no timer. The console's pack health page starts it with its **Update** button (`POST /api/health/update`; polkit allows the console user to start exactly that unit, `deploy/console/50-console-restart.rules`). Leave `wolfpack-auto-update.timer` disabled and nothing runs unless the button is pressed. The kill switch file and a recorded failure still stop it (the button never passes `--clear-failed`). Check a press with `journalctl -u wolfpack-auto-update-now`.
- Pause: `touch /var/lib/wolfpack-auto-update/auto-update.disabled`. Resume: `rm` the file. A failure recorded before the pause still holds after it.
- The service runs as root with `NoNewPrivileges`, `PrivateTmp`, `UMask=0022`, `ProtectKernelTunables`, `ProtectKernelModules`, `ProtectControlGroups`, `RestrictSUIDSGID` and `LockPersonality`. `ProtectSystem`/`ProtectHome` are not set, because the deploy writes `/opt`, `/etc/systemd`, `/home/wolf-*` and `/var/log`. UNVERIFIED on the host: check the first manual `systemctl start wolfpack-auto-update` run.
- After a failure:
  1. Fix the host.
  2. Run `node /opt/wolfpack-auto-update/auto-update.mjs run --now --clear-failed`.
- The updater keeps its own copy of `deploy-release.sh`. Re-run `setup.sh install` from a newer repo copy to refresh it, because a release never updates the updater.

## Mac: turn it on (owner)
The live stack runs from `~/wolves/local/runtime/wolfpack`, a worktree of `stable` (`RUNTIME_BRANCH`). The Mac installs no release assets. Each pass:
1. compares the running workerd `/healthz` version with stable;
2. when behind, runs `pnpm runtime:update` (fast-forward only; it refuses a dirty or diverged tree);
3. checks the restamped `packages/workerd/VERSION`;
4. runs `pnpm stack restart`;
5. waits for `/healthz` to report the new version.

If the checkout still stamps an older version (a working branch with stable not merged back), the pass fails with `behind-stable` and the message "Mac behind stable: merge stable back". Nothing is merged or pulled for you.

To turn it on:
1. In the runtime checkout, run `node scripts/auto-update-mac.mjs install`. This writes `~/Library/LaunchAgents/com.wolfpack.auto-update.plist` (`StartInterval` 1800, `WOLFPACK_AUTO_UPDATE=1`) and loads nothing.
   - It resolves `node` and `pnpm` with `command -v` and puts both directories on the plist's `PATH`; with no `pnpm` it writes nothing. A run that still cannot find `pnpm` fails with code `no-pnpm` (rather than `runtime:update` falling back to npm).
   - When `node` is a versioned path (nvm, fnm, asdf, volta), the plist uses `/opt/homebrew/bin/node` or `/usr/local/bin/node` instead if that one has the same major version. Otherwise it keeps the versioned path and prints a note: **run `install` again after every node upgrade or removal**, or the job stops starting.
2. Run `node scripts/auto-update-mac.mjs run --now` once, then `pnpm stack status`.
3. Load the job: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.wolfpack.auto-update.plist`.

- Pause: `touch ~/.wolfpack/auto-update.disabled`.
- Remove: `node scripts/auto-update-mac.mjs uninstall`.
- Log: `~/wolves/local/logs/auto-update.log`.

## Troubleshooting
- **Stale `lastCheck`.** Readers mark the updater stale when `lastCheck` is older than two timer intervals (70 min: 30 min plus up to 5 min randomised delay, twice). `/api/updates` sets `updateStatus.stale: true`, the sidebar shows "Auto-update hasn't run since <age>", and `pnpm stack status` shows `updates: stale (last check <age>)`. With no status file at all, auto-update was never set up; that is not stale. Steps:
  1. Check that the job runs: `systemctl list-timers wolfpack-auto-update.timer` and `journalctl -u wolfpack-auto-update` on sfo-01; `launchctl print gui/$(id -u)/com.wolfpack.auto-update` and the log on the Mac.
  2. If the log says `another run holds ...` or `... .takeover was left by a run that died mid-takeover`, check for a leftover `.takeover`: `cat /run/wolfpack-auto-update.lock.takeover` (sfo-01) or `cat ~/.wolfpack/auto-update/run.lock.takeover` (Mac). Its first field is a pid.
  3. If that pid is dead (`kill -0 <pid>` fails, or `ps -p <pid>` shows nothing), remove the file by hand: `rm /run/wolfpack-auto-update.lock.takeover` or `rm ~/.wolfpack/auto-update/run.lock.takeover`. Never remove it while the pid is alive. The next run takes over the dead lock and writes a fresh `lastCheck`.
  4. To check at once, run a manual pass (`auto-update.mjs run --now` on sfo-01, `node scripts/auto-update-mac.mjs run --now` on the Mac) and read the status again.

## Release channel and owner steps (work-wolfpack-pr6t1Y9)
- The channel and mode live in `/var/lib/wolfpack-subscription/subscription.json` (root:console 0775 directory, apart from the root-only updater state dir; Mac: `~/.wolfpack/release-channel.json`); see docs/releases.md. The pack panel edits it.
- After deploying this change, once on sfo-01: re-run `deploy/auto-update/setup.sh` (installs `wolfpack-auto-update-now@.service` and creates `/var/lib/wolfpack-subscription`; run it after `deploy/console/setup.sh` so the `console` group exists) and `deploy/console/setup.sh` (polkit rule, rollback unit with the baked node path, console.service write access to the new directory). Then `systemctl daemon-reload && systemctl restart console`.
- If an earlier build made `/var/lib/wolfpack-auto-update` group-writable: `chmod 0755 /var/lib/wolfpack-auto-update && chgrp root /var/lib/wolfpack-auto-update`, and move any `subscription.json` from there to the new directory.
- A corrupt subscription file is logged and ignored (stable, `WOLFPACK_AUTO_UPDATE=1` decides), never silently turning auto off.
- Clear an old failure hold if one is set: `node scripts/auto-update.mjs run --clear-failed`.
- Mac: `node scripts/auto-update-mac.mjs install`, then reload the launchd job.
- First `wolfpack release publish`: check the `release-main` run is green, `main-manifest` has `main.json`, and the panel (channel main) shows the prerelease as latest.
