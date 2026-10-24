# Architecture

Current state only. Anything not yet built is under **Planned** and says so. Rationale and history live in [decisions/](decisions/) and the work items.

## Model

**Pack → host → wolf → thread.**

- A *pack* is the set of wolves (hal, dewey, 1uk4).
- A *host* is a machine running wolves. Hosts are attributes of a wolf, never URL path segments.
- A *wolf* is a long-lived agent, keyed by name.
- A *thread* is one conversation of a wolf. Kinds: `home`, `feature`, `subagent`, `process` (`ThreadKind` in `packages/client/src/types.ts`).

## Built

### Console app (`apps/console`)

Next.js App Router app, served in the browser and wrapped by `apps/desktop` (Electron spawns the console's standalone server on 127.0.0.1). It runs entirely on `MockConsoleClient`: one wolf, one home thread, one scripted streaming turn including a tool call. No daemon, hub or real wolf is involved.

Routes: `/` (home placeholder), `/wolf/[name]` and `/wolf/[name]/thread/[threadId]` (chat). `/work/*` is reserved. The thread URL segment is a slug derived by `threadSlug` in `src/core/thread-adapter.ts`, not the client's raw thread id.

The shell inherited from learnharness (sidebar, composer, settings, keyboard system, tool-card registry, event bus, jobs) is present. The graph canvas and plan DAG components are kept but inert (unrouted).

### The ConsoleClient seam (`packages/client`)

`ConsoleClient` is the single interface the console talks through:

`listWolves`, `listThreads(wolf)`, `getThread(id)`, `submit(id, input, {whenBusy})`, `abort(id)`, `watch(id, {from})`.

- `submit` acknowledges and returns; it does not wait for the turn. `whenBusy` is `steer | followUp | reject` (default reject; `BusyError` on conflict).
- `watch` replays events with id > `from`, then follows live until `turn-end`.
- Events (`ThreadEvent`): `turn-start`, `text-delta`, `thinking-delta`, `tool-start`, `tool-update`, `tool-end`, `turn-end`, `error`. Ids increase monotonically per thread.
- `MockConsoleClient` and the fixture are the only implementation. The types are provisional until the protocol feature finalizes them.

### Server routes and SSE

Next route files under `apps/console/app/api/wolves/[name]/threads/...` are one-line wrappers over handlers in `src/server/thread-api.ts`, which take a `ConsoleClient`. Commands are POSTs (submit, abort); the stream is SSE: one frame per event (`id: <event id>`, `data: <json>`), ending with `data: [DONE]`.

**Resume:** a reconnect sends `Last-Event-ID` (or `?from=`); the server replays events with id > that value, then follows live. A non-numeric value is ignored (full replay of the current/last turn).

Errors cross the Next bundle boundary by name (`NotFoundError` → 404, `BusyError` → 409), not `instanceof`.

### Thread adapter → session-core

`src/core/thread-adapter.ts` is pure (no React, no IO). It maps `ThreadEvent`s onto the wire events that `session-core`'s `SessionModel.applyWireEvent` folds into the chat view: one assistant message per model step, a tool call's end closes the step. It tolerates resuming mid-turn, and replaying a whole turn reproduces the uninterrupted result. The adapter is the only module that knows both dialects.

Note: the inherited `/api/chat` routes still run a plain assistant on `pi-ai` (BYOK). They are separate from the thread API and will be replaced when chat moves to real wolves.

### Import boundaries

- `apps/*` depend on `packages/client`; `packages/*` never import from `apps/*`.
- Within `apps/console` (enforced by eslint): the browser shell imports only the core barrel `@/src/core`; `app/` imports only the barrels `@/src/core` and `@/src/server`; core never imports IO layers (agent/server/store); the agent layer never imports server or store adapters. The composition root is `src/server/stores.ts`.
- Only `packages/harness` will import pi-durable (**planned**; nothing imports it yet). The console and `packages/client` must never depend on it.

### Legacy (on `main`, to be retired at cutover)

pi TUI, Telegram bridge (`extensions/wolfpack-telegram`), the vis-network dashboard, the Syncthing mesh, and `packages/agent` + `packages/cli` host management. They still exist in the tree and are unchanged by the rewrite so far.

## Planned

Nothing in this section exists yet. Feature numbers refer to the initiative `work-wolfpack-Lu9c0ij`; see [vision.md](vision.md) for the order.

- **Protocol and SDK** (feature 2, `packages/protocol`): versioned zod schemas, grown per feature; `packages/client` becomes the real typed SDK without moving the `ConsoleClient` interface.
- **workerd** (feature 3): runs wolves, one process each, behind a `ProcessRunner`; pi-durable behind an engine interface in `packages/harness`. Holds dens, workspaces and the KB copy. Wolves talk only to their own worker over a local socket and hold no hub credentials.
- **hubd** (feature 4): pack registry, Work API and ledger, KB authority (Dewey + sweep), contributions inbox, relay, and the claim operation (moving an item to in_build assigns the wolf and binds the feature thread atomically). A role, not a fixed machine: starts on the Mac, final home a VPS.
- **Worker link** (feature 5): workers dial out to the hub and keep the connection open (registration, presence, relay). The console talks to the hub, with an optional direct path to a local worker.
- **Security** (feature 5): tokens always required (per device and per worker); Tailscale for the personal pack, TLS for others, unix socket / 127.0.0.1 for Mac-only. Never publicly exposed by design.
- **KB distribution** (feature 5): workers pull the KB from the hub, which enforces domain access; replaces Syncthing.
- **Sequencing** (feature 2/5): conversation streams use the pi-durable event-log sequence; pack-wide streams (ledger, KB, presence) use hub-minted per-stream sequences. Same POST + SSE + `Last-Event-ID` transport.
- **Per-conversation binding** (feature 3): today binding is per session; a feature thread binds its own conversation.
- **Cards and structured output** (feature 7), **subagent child conversations with worktree isolation** (feature 8), **memory graph home** (feature 9), **planning and work views** (feature 10), **cutover** (feature 11).
