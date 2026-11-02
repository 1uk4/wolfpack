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

<!-- ci proof: docs-only -->
