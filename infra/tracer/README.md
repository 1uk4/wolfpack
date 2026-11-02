# Linux tracer harness (H1)

One command proves, on Linux, that **hubd + a non-link-only workerd + wolfd** work end to end: a scripted client goes through
hubd's console relay, opens the home thread of wolf `hal2` (routing key = wolf **name**), posts a message and asserts the reply.

    infra/tracer/run-tracer.sh        # needs a running Docker daemon; exit code = the client's (0 = pass)

No secrets, no host mounts, no remote hosts. All state is under `/data` (tmpfs) and the container's `--rm` filesystem.

## Shape (a single container, on purpose)
Everything that talks is on loopback inside one container, so there is no compose networking or startup ordering to maintain, and
later slices can run the same image with `docker exec`/extra args. Pieces:

| file | role |
|---|---|
| `Dockerfile` | `node:22-bookworm`, `npm ci` (the Linux lockfile check), `tsc --build`; users `hubd` and `wolf-hal2` |
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
