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
| `stub-wolfd.mjs` | the real `startWolf` (sqlite, pi-durable, /v1) with pi-ai's faux provider as the model; replies `tracer-pong` (`TRACER_REPLY` overrides). Replace this with `wolfd` itself in later slices |
| `relay-client.sh` | curl client: hub wolf list, thread list, submit, stream until `turn-end`, assert text, assert persisted. Usage `relay-client.sh <hub> <console-token> <wolf> [msg]` |
| `run-tracer.sh` | host entry: `docker build` + `docker run`. `TRACER_IMAGE`, `TRACER_DOCKER_ARGS` tune it |

workerd spawns wolfd as its own uid, so workerd and wolfd both run as `wolf-hal2` (hubd is a different user). The wolf is
registered in hubd's registry by name `hal2` on host `docker-01`; the worker token is minted with `hubd pair --kind worker --host-id`.

## LLM path
Deterministic stub: the existing `createScriptedModel` (pi-ai faux provider) via the `models` seam of `startWolf` (`stub-wolfd.mjs`).
No API key, no network at run time. Real claude CLI / Max auth is the next ticket: swap `--wolfd` to the real `wolfd` bin and mount credentials.

## RSS (MiB; Docker Desktop on an Apple-silicon Mac, linux/arm64, node 22; 2 runs shown)
Idle = 3s after the wolf is online. After-turn = after the ping turn. Peak = `VmHWM` (includes the turn; the faux turn takes ms, so no separate steady in-turn number exists).

| process | idle | after turn | peak |
|---|---|---|---|
| hubd | 97 / 110 | 97 / 111 | 113 / 111 |
| workerd | 103 / 101 | 107 / 105 | 107 / 105 |
| wolfd | 103 / 184 | 107 / 185 | 107 / 185 |

wolfd varied between runs (103 vs 184 MiB idle); treat it as ~100–190 MiB, workerd ~100, hubd ~100: roughly 300–400 MiB for the trio, against sfo-01's 2 GB.
A real model provider (claude bridge) adds its own memory; measure again in H2.

## Dependency note
`pi-claude-bridge-stateless` is `git+https://github.com/1uk4/pi-claude-bridge.git#45eb3f3…` (branch `stateless-core` is pushed there), so `npm ci` works without Mac paths.
