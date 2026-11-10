# Linux tracer harness (H1)

One command proves, on Linux, that **hubd + a non-link-only workerd + wolfd** work end to end: a scripted client goes through
hubd's console relay, opens the home thread of wolf `hal2` (routing key = wolf **name**), posts a message and asserts the reply.

    infra/tracer/run-tracer.sh        # needs a running Docker daemon; exit code = the client's (0 = pass)

No secrets, no host mounts, no remote hosts. All state is under `/data` (tmpfs) and the container's `--rm` filesystem.

## Running it: `scripts/verify.sh` / `run-tracer.sh` (shared base, lock, fail-fast, result file)
**Never poll. Run it in the foreground (it is bounded) and read `infra/tracer/out/result.txt`.** The last stdout line is the same single `TRACER PASS|FAIL ...` summary.

    scripts/verify.sh <branch|sha> [--console|--kb|--ro-work|--max]     # owner: <=10 line summary + log path
    infra/tracer/run-tracer.sh [MODE] [--ref <branch|sha>] [--build-only]  # agents (default ref HEAD; modes as above, plain = stub)

- **Clean export**: the image is always built from `git archive <ref>` in a fresh temp dir, never the working tree (no macOS `node_modules`/`dist` leaking in). Uncommitted changes are NOT tested; commit first.
- **Shared base** `wolfpack-tracer-base:<12 hex of sha256(Dockerfile.base)>`: apt, claude CLI, users, Playwright + chromium; upstream `node:22-bookworm` pinned by digest; apt signature checks are never weakened (no `[trusted=yes]`/allow-insecure; do not retag node images). Built once, kept. The per-run image (`Dockerfile`) adds only the repo, with a BuildKit npm cache mount, and is removed on exit along with the run's container. Other images are never touched.
- **Preflight (<=60s)**: Docker reachable; Docker VM free space >= `TRACER_MIN_FREE_GB` (10); apt signature check (only when the base must be built); lock (`~/.wolfpack/run/tracer.lock`, mkdir-based, stale lock from a dead pid is taken over). A second run is refused within a second, exit 2.
- **Time limits** per step (`TRACER_TIMEOUT_PREFLIGHT` 60, `_BASE` 1800, `_BUILD` 900 (cold npm cache ~5 min, warm ~1 min), `_RUN` per mode 240-420). On timeout the container is killed and the result names the step.
- **Result**: `out/result.json` + one-line `out/result.txt` (PASS/FAIL, mode, ref, commit, failing step, duration, base/build seconds, log path); full log `out/run-<ts>.log`.
- Test seams: `TRACER_TEST_BREAK_APT=1` (broken keyring -> apt preflight fails), `TRACER_TIMEOUT_RUN=5` (tiny limit). If the Docker disk is full, prune only build cache and dangling images.

## Shape (a single container, on purpose)
Everything that talks is on loopback inside one container, so there is no compose networking or startup ordering to maintain, and
later slices can run the same image with `docker exec`/extra args. Pieces:

| file | role |
|---|---|
| `Dockerfile.base` / `Dockerfile` | shared base (digest-pinned node, apt, claude, chromium) / per-run: repo on the base, `npm ci` (the Linux lockfile check), `tsc --build`; users `hubd` and `wolf-hal2` |
| `entrypoint.sh` | starts hubd (user `hubd`), registers host `docker-01` + wolf `hal2`, pairs workerd, starts workerd (user `wolf-hal2`, **not** link-only, `--wolfd` = the stub), runs the client, prints RSS |
| `wolfd-max.sh`, `billing-proof.sh` | `--max` only: wolf launcher (loads `.env`, guards, execs the real wolfd bin); billing evidence |
| `stub-wolfd.mjs` | the real `startWolf` (sqlite, pi-durable, /v1) with pi-ai's faux provider as the model; replies `tracer-pong` (`TRACER_REPLY` overrides). Replace this with `wolfd` itself in later slices |
| `relay-client.sh` | curl client: hub wolf list, thread list, submit, stream until `turn-end`, assert text, assert persisted. Usage `relay-client.sh <hub> <console-token> <wolf> [msg]` |
| `run-tracer.sh` | host entry: `docker build` + `docker run`. `TRACER_IMAGE`, `TRACER_DOCKER_ARGS` tune it |

workerd spawns wolfd as its own uid, so workerd and wolfd both run as `wolf-hal2` (hubd is a different user). The wolf is
registered in hubd's registry by name `hal2` on host `docker-01`; the worker token is minted with `hubd pair --kind worker --host-id`.

## Modes
    infra/tracer/run-tracer.sh          # stub (default): scripted faux model, no secrets, CI-safe
    infra/tracer/run-tracer.sh --max    # REAL wolfd bin + claude bridge (claude-stateless), billed to the owner's Max subscription

`--max` reads the token from `$CLAUDE_CODE_OAUTH_TOKEN_FILE` (default `~/.wolfpack/secrets/claude-oauth-token`, mode 600), else `$CLAUDE_CODE_OAUTH_TOKEN`
(copied to a 0600 temp file, removed on exit). The file is bind-mounted **read-only** at `/run/secrets/claude-oauth-token`: never in the image, never in
`docker run` args or env. The entrypoint writes it to `/home/wolf-hal2/.env` (mode 600, `CLAUDE_CODE_OAUTH_TOKEN='…'`), the wolf-home `.env` the VPS keeps.
`wolfd-max.sh` is the wolf launcher: it loads that `.env` into its own process (what systemd `EnvironmentFile=` does on a VPS; **H4 should use EnvironmentFile
on the same path**), so only wolfd and its claude child get the token (workerd never sees it, it is not in any argv), then `exec`s `packages/harness/dist/bin/wolfd.js`.
Models: `models.json` beside `wolf.yaml`, transport `subscription`, all tiers `claude-stateless/claude-haiku-5-5`.

**No wolfd/workerd TypeScript changed.** wolfd and workerd load no `.env` themselves (they use `process.env`; the env file is the service manager's job), and
the stateless provider already strips `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` from the claude child and `createWolfHarness` already requires the token.

Guards (fail loudly, exit 78): `ANTHROPIC_API_KEY` set in the container env (entrypoint), both key and token set, or the key set at all, or no token (`wolfd-max.sh`).
Tested: `TRACER_DOCKER_ARGS="-e ANTHROPIC_API_KEY=x" run-tracer.sh --max` aborts before anything starts.

**claude CLI**: `@anthropic-ai/claude-code@2.1.316` (Dockerfile `ARG CLAUDE_CODE_VERSION`, global npm install, `claude --version` checked at build; `/usr/local/bin/claude`, on PATH for all users).
Note: the bridge/Agent SDK does *not* use PATH `claude`; it spawns the native binary shipped in `@anthropic-ai/claude-agent-sdk-linux-<arch>` (pass `pathToClaudeCodeExecutable` to change that).
The PATH CLI is what the billing probe and operators use; keep its version near the SDK's (lockfile SDK 0.3.310).

## Billing proof (`billing-proof.sh`, `--max` only; the script asserts it)
1. wolfd's environment (names only): has `CLAUDE_CODE_OAUTH_TOKEN`, has no `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`.
2. The token value is absent from `ps` args, `/data/log`, the wolf den and claude state.
3. `claude -p … --output-format stream-json --verbose` as `wolf-hal2` with the wolf's `.env`: the system `init` message must say `apiKeySource` = `none` (no API key; auth is the OAuth token) and the turn must succeed.
Observed: `claude CLI system init: apiKeySource=none` / `BILLING PROOF OK`. The bridge's own round-trip (a real `pong` through hubd relay → workerd → wolfd → claude) is the relayed turn; it ran with the same env and the key stripped. The relayed turn's own init message is not logged by the bridge, so (3) is a probe of the same CLI/env, not the relayed turn itself. Max usage shows in the account's usage page, not as API spend.

## Rotation
1. On the Mac: `claude setup-token` (interactive), save the output to `~/.wolfpack/secrets/claude-oauth-token` (chmod 600).
2. Tracer: nothing else, the next `run-tracer.sh --max` mounts the new file.
3. A real wolf: replace the `CLAUDE_CODE_OAUTH_TOKEN=` line in `<wolf home>/.env` (mode 600, owned by the wolf user) and restart wolfd (`systemctl restart wolfd@<name>` / the unit H4 defines). Nothing else holds the token. Revoke the old one in claude.ai settings.

## RSS (MiB; Docker Desktop, Apple-silicon Mac, linux/arm64, node 22)
Idle = 3s after the wolf is online. Peak = `VmHWM`. Stub numbers (2 runs): hubd 97/110 idle, workerd ~100, wolfd 103/184.
`--max` (5 runs, all within a few MiB): the wolfd process is the real bin with the bridge loaded; the claude subprocess appears only while a turn runs (sampled every 0.5s, tree = wolfd + children).

| process | idle | after turn | peak |
|---|---|---|---|
| hubd | 104-109 | 104-110 | 104-110 |
| workerd | 100-106 | 90-110 | 105-110 |
| wolfd (node only) | 184-189 | 187-192 | 187-192 |
| **wolfd tree during a turn (wolfd + claude)** | | | **435-443** (2 processes) |

So the claude child adds ~250 MiB while a turn runs (it exits afterwards: stateless). Trio + one concurrent turn is roughly 100+100+440 = **~650 MiB**; each *additional* concurrent turn adds ~250 MiB, so on 2 GB keep per-host concurrent claude children to about 3-4 (WOLFPACK_SUBAGENT_HOST_MAX exists for this).

## Dependency note
`pi-claude-bridge-stateless` is `git+https://github.com/1uk4/pi-claude-bridge.git#45eb3f3…` (branch `stateless-core` is pushed there), so `npm ci` works without Mac paths.

## Durability seam (H4): `infra/tracer/durability.sh` (stub mode, persistent volumes instead of tmpfs)
Two named volumes (`/data`, `/home/wolf-hal2`). Phase 1 submits a turn through hubd's relay; with `TRACER_SLOW_MS` (default 15000) the stub model's first request takes 15 s and then calls the `write` tool, the second request answers `tracer-pong`. After 4 s the script `kill -9`s workerd then wolfd, `docker kill`s and removes the container, and starts a NEW container on the same volumes (phase 2: fresh hubd/workerd/wolfd, the turn is NOT resubmitted). Pass = the thread (`GET /v1/threads/hal2%2Fhome`) ends with one user message and the assistant reply `working\n\ntracer-pong` with its tool result, `busy:false`.
"Resume" in the code: `startWolf` ends with `engine.resume()` (pi-durable `Harness.resume()`): the turn is a durable task in `<den>/session.sqlite`; unfinished tasks are rerun after a restart (the model request in flight is lost and re-issued, committed steps are not repeated; a task cut off too many times is parked, `restartLimit`). Subagents: `SubagentManager.recover()`. Observed: ~16 s after restart the turn completed, tool ran once.
Harness caveat: a restarted container reuses low PIDs, so the work-server lock (`<hubd data>/run/work-server.lock`, liveness by pid) of the killed hubd named a live unrelated pid and hubd refused to start; the entrypoint clears `*run*/*.lock` in durable mode (a real reboot has the same hazard only if pids collide).

## `--kb` mode (H6): memory + KB through the hub, graduation preview
    infra/tracer/run-tracer.sh --kb      # stub model, no secrets; exit 0 = `KB PROOF OK`
hubd holds a seeded KB (domain `tracerkb`, registry-granted to hal2, `domains: [tracerkb]` in wolf.yaml). hal2's `.env` (mode 600, loaded by `wolfd-kb.sh` like systemd `EnvironmentFile=`) carries `WOLFPACK_HUB_KB=1`, `WOLFPACK_HUB_URL`, `WOLFPACK_HUB_TOKEN` (a second worker token of the same host, minted with `hubd pair --kind worker --host-id`; workerd's `hub.json` is unreadable to the wolf) and `WORK_ENDPOINT`/`WORK_TOKEN` for the hub work proxy. wolfd then (code: `packages/harness/src/wolfd/hub-kb.ts`) runs `KbSync` (moved to `@wolfpack/kb/sync`, workerd re-exports it) into `<home>/kb-mirror` (KB_BASE) and feeds `<home>/ops/inbox/<wolf>/*.md` to hubd `POST /v1/contributions`. Without `WOLFPACK_HUB_KB=1` nothing changes (Syncthing wolves unaffected).
`kb-proof.sh` asserts: (1) KB read: the seed entry is readable via the wolf's `/kb/entries/<id>` and sits in hal2's home mirror; no syncthing process/paths; den is under the wolf home. (2) a turn -> observation -> consolidate -> promote lands `contributions/hal2/caching-*.md` in hubd's store (content `tracer-kb-contribution`, `from: hal2`) and the inbox file moves to `sent/`. (3) `graduate/preview` -> `preview_ready` with token and the distilled contribution, hub store unchanged, lane empty, item not graduated/archived. Memory engine is a scripted `Engine` (the existing test seam) with the REAL memory/tasks extension sources (`kb-ext-entry.ts` bundled in the image); no LLM needed. The Work API is hubd's own scoped proxy `<hub>/v1/workapi/work` (the wolf's hub token is its `WORK_TOKEN`, `WORK_ENDPOINT=<hub>/v1/workapi`); the items are created through it, and a worker token of another host is shown to get 404/403.

## `--ro-work` mode (H6b): preview with the hub work store read-only
    infra/tracer/run-tracer.sh --ro-work   # --kb, but after seeding, hubd's domains/*/work is a REAL read-only mount (bind + remount,ro; the container gets --cap-add SYS_ADMIN, only in this mode), so a write fails with EROFS like ProtectSystem=strict on sfo-01. The ledger stays writable.
The entrypoint checks the mount is `ro` and that a hubd write fails with "Read-only file system". Same three proofs as `--kb`, plus (4): the preview reached `preview_ready` with the store read-only; `find domains/*/work` (path, size, mtime, mode) and the ledger sha256 are identical before and after; a create through `/v1/workapi` answers **503** `{error:"work store is read-only…", code:"work_store_read_only"}`, hubd's log shows EROFS, and the ledger sha256 is unchanged. (chmod would give EACCES, which maps to a different error, `work_store_permission_denied`, so it is not used.)
Recon result: the preview only READS the Work API (GET list, GET item+body) and writes its token file in the wolf's own den (`<den>/tasks/graduation/<token>.json`); the one possible hub write is the pre-preview drain (PATCH Record) when the wolf's pool holds observations tagged to the item.
Ledger ordering: `createWork` appends the event and then writes the `.md`. hubd now runs a **pre-flight write probe** (create + remove a temp file in the target `domains/<d>/work`) before every op that appends and writes a `.md`; if it fails, the typed error is returned and nothing is appended (the ledger is never truncated). A failure after a passing probe (ENOSPC mid-op) can still leave a ledger-only orphan; `hubd work-orphans --data-dir <dir>` (hubd stopped, even for the dry run) lists lone-`work.created` items with no `.md` whose whole subtree is orphaned; `--apply` appends `work.deleted` events (aborts over max(3, 10% of items) without `--force`).
Write-path errno table: EROFS -> 503 `work_store_read_only` ("writes are turned off, don't retry"); EACCES/EPERM -> 500 `work_store_permission_denied` ("looks like a permission fault, owner should check"); ENOSPC/EDQUOT/EIO -> generic `engine_error`. Reads never get these codes.
Round-2 notes: claim/unclaim are ledger-first (one ledger append; the `.md` re-render is best effort and only logged on a filesystem error), so they take no probe and a disconnected wolf's claims are released even on a read-only store (`releaseWolfClaims` also continues per item). The probe file is `.probe-<hex>` (swept at hubd startup), the climb for a missing work dir stops at `<kb>/domains` and a domain name must be one plain segment. "nothing was changed" appears only on probe-time failures; a failure after the probe says the ledger may hold a partial change and to run `hubd work-orphans`.

## `--console` mode (P1): the console in RELAY mode + a real browser

`infra/tracer/run-tracer.sh --console` (stub model, no secrets, first run ~6 min: it builds the base image, then `Dockerfile.console` = standalone console + headless chromium via `playwright-core`; arm64-native, ~1.5 GB extra).

- `scripts/build-server.mjs` builds the console (`next build`, `output: "standalone"`) into a self-contained dir (`/opt/console`, ~110 MB) that runs with `node server.js`. Build inside the Linux image, never copy a Mac build (native deps).
- The entrypoint starts it as user `console` with `WOLFPACK_HUB_URL=http://127.0.0.1:3150` and **no** `WOLFPACK_API_URL` and no env token. Relay mode is then chosen by the per-request browser token (`createConsoleClient`).
- Pairing (P2) is the real QR flow: `HUBD_PUBLIC_URL=$HUB hubd pair --kind browser --label tracer-browser` prints a QR + link (code redacted in the log); hubd runs with `HUBD_CONSOLE_URL=http://127.0.0.1:3210`. The proof opens that link in chromium, clicks Pair on the hub's `/pair` page, and lands on `<console>/pair#token=...` (token stored in localStorage, stripped from the URL). A second visit to the same link is refused (single use). Once the thread round-trip and `lastUsed` check are done, the entrypoint runs `hubd tokens revoke <id>` and the proof asserts the revoked token gets 401 from the console and the browser is sent back to `/pair` (screenshot `console-proof-4-revoked-to-pair.png`).
- The console process holds no hub token at all. `WOLFPACK_HUB_TOKEN` is unused by the console server (`GET /api/health` probes hubd's unauthenticated `/healthz`); only resolver-less scripts and tests read it, never a user request.
- `console-proof.mjs` (playwright): (1) unpaired `GET /api/wolves` must be 401 + `X-Wolfpack-Hub-Auth: required` (the mock client would answer 200); (2) pair via `/pair#token=`; (3) `/wolf/hal2` lists its threads (the home thread); (4) open it, type `ping`, Enter, wait for `tracer-pong`; (5) reload and see it again. Then `hubd tokens list` must show the browser token used (hub-side proof the console went through the hub).
- Output: screenshots in `infra/tracer/out/` (gitignored): `console-proof-{1-thread-list,2-reply,3-reloaded}.png`, or `console-proof-FAIL.png` on failure. Success prints `CONSOLE RELAY PROOF OK`.
- The console cannot create threads yet (see `app/chat/new`), so the round-trip uses hal2's existing home thread.
- Server-rendered pages (`/wolf/<name>`, thread pages) are plain navigations with no Authorization header, so the paired token is also mirrored into a cookie (`wolfpack_hub_token`; `__Host-wolfpack_hub_token` on https; SameSite=Lax, 30 days, refreshed on load). `apps/console/proxy.ts` turns it into a bearer ONLY for GET/HEAD requests with no Authorization header and a Sec-Fetch-Site of same-origin/none (or a top-level navigation); every state-changing request needs the bearer. hubd never reads cookies.
- Not supported: serving the console under a path prefix (absolute `/api/...` URLs, no `basePath`); give it its own origin / the root of one. The `/pair` page help link and the devices panel pairing link read `HUBD_PUBLIC_URL` (or `WOLFPACK_HUB_PUBLIC_URL`) at runtime; nothing is baked in at build.

### Cookie name, framing, bundle scan (P1 round 2; P5 notes)
- **P5: set `WOLFPACK_CONSOLE_PUBLIC_ORIGIN=https://<console public origin>` in the console's unit/env.** Its scheme decides the cookie name (`__Host-wolfpack_hub_token` on https, `wolfpack_hub_token` on http). Only when unset does `proxy.ts` fall back to the RIGHTMOST `X-Forwarded-Proto` value (what `tailscale serve` appends), then the request URL, and it logs one warning at startup. Without the variable a client-sent header could pick the cookie name; with it, nothing can. The browser side uses `location.protocol`, so the public origin must match what the browser really uses.
- Every route sends `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY` (`next.config.ts`; checked by `tests/next-config.test.ts` and by the `--console` proof on a live server).
- The proof also sets a bogus token + cookie and loads `/wolf/hal2`: the server render fails on the hub's 401, `app/error.tsx` probes `/api/wolves` (skipped when there is neither token nor cookie), the fetch wrapper clears both and lands on `/pair`.
- `build-server.mjs` scans `.next/static` and `.next/server` for literal credentials (bearer, `sk-`/`sk-ant-`, `ghp_`, `github_pat_`, `AKIA`), `.next/static` also for the env names `WOLFPACK_HUB_TOKEN`/`OAUTH_TOKEN`, and fails on any prerendered route outside an allowlist (`/`, `/pair`, `/pipeline`, `/settings`, `/_not-found`, `/_global-error`).
