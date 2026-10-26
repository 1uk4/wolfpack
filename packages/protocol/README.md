# @wolfpack/protocol

Versioned zod wire schemas for everything that crosses HTTP/SSE between wolfpack
consumers (console, CLI) and servers (workerd, hubd, the console proxy): actor,
error envelope, resources, the `ThreadEvent` vocabulary, and chat commands. It
is engine-agnostic: the harness maps engine events into this vocabulary and
nothing engine-shaped leaks here. **Zero wolfpack dependencies** (zod only).

## Version and growth rules

`PROTOCOL_VERSION` is a single integer (currently `1`), exchanged by client and server.

- **Additive (no bump):** new event types, new commands/routes, new *optional* fields, new error codes only if consumers already treat unknown codes as generic failures.
- **Breaking (bump):** renaming, removing, or retyping a field/type; making an optional field required; changing an event's meaning.
- **Ignore-unknown:** consumers MUST ignore event types they do not know. Use `parseThreadEvent(raw)`: it returns `{kind:"event"}`, `{kind:"unknown"}` (valid envelope, unrecognised type: skip it) or `{kind:"invalid"}` (malformed envelope, or a known type with a bad payload). It never throws.
- `whenBusy` on submit is required on the wire (missing -> `invalid_request`). SDKs may default it (to `reject`); the wire may not.

## Errors

`{code, message, retryable}` with a closed code enum; `ERROR_HTTP_STATUS` is the stable code -> HTTP status map. Clients derive typed errors from `code`, never from the status.

## Sequencing: two domains

Event `id`s are per-thread monotonic positive integers minted by the *serving process* (the bridge/daemon) and carried as the SSE `id:` frame for `Last-Event-ID` resume. The underlying engine has no event ids or replay of its own; there is no engine sequence to reconcile with. A `snapshot` event (baseline `ThreadDetail`, optional in-flight partial, and `upToId` = the last event id it supersedes) lets a server reset a stale consumer at any time.

## Memory events (wolf stream)

`MemoryEvent` is a wolf-scoped union, separate from `ThreadEvent` (added without a version bump: new type, new route). Delivered on `GET /v1/wolves/:name/events` (SSE, `data: <MemoryEvent json>`; live only, no ids/replay; stays open until the client disconnects). Every event carries `wolf`, optional `threadId`, `timestamp`, `domain` and `target` (`den` / `session` topic id, or a `work` item id + feature). Payloads are metadata only (ids, counts, a one-line summary), never observation text. Variants: `observation_captured`, `topic_consolidated`, `contribution_emitted`, `promote_started|finished|failed`. Use `parseMemoryEvent(raw)`; consumers MUST ignore unknown types (`{kind:"unknown"}`). The client SDK exposes `HttpConsoleClient.watchMemory(wolf)`.

## Layout

`src/schemas.ts` holds all schemas and inferred types; `src/index.ts` re-exports them.

## Routes, stub server, contract suite

`src/routes.ts` (exported from the main entry) is the declarative `/v1` route table: `ROUTES` maps a name to `{method, path, body?, response, status, error}` with zod schema bindings; `matchRoute(method, pathname)` and `buildPath(name, params)` are the only helpers (no framework). Path params are URL-encoded (thread ids contain `/`). Routes: `GET /v1/wolves`, `GET|POST /v1/wolves/:name/threads` (create is home-only and idempotent: 201 new, 200 existing), `GET /v1/threads/:id`, `POST /v1/threads/:id/submit|abort`, `GET /v1/threads/:id/stream` (SSE).

Normative serving semantics (implemented by the stub, asserted by the contract):

- Event ids are minted per thread by the server. The replay buffer is **per turn**: cleared at turn-start, so it holds only the current or most recent turn.
- Stream: `id: <eventId>` + `data: <ThreadEvent json>` frames; the stream **ends at the first turn-end** with `data: [DONE]` (same as the console bridge). No cursor = replay the current/most recent turn, then follow live. Resume via `Last-Event-ID` header or `?from=`: a cursor inside the buffer replays events after it then follows live; a stale (pre-turn) or future cursor gets a `snapshot` (`id` = last event id, `upToId` = last event id, `thread`, `inFlight` if a turn is running) then live events.
- Submit: `whenBusy` required (else 400 `invalid_request`). Idle: starts (`started`). Busy: `reject` -> 409 `busy`; `followUp` -> `queued`, runs after the turn; `steer` -> `steered`. Abort ends the turn with `turn-end` reason `aborted` and drops queued follow-ups.
- Every error is an `ErrorEnvelope` with the `ERROR_HTTP_STATUS` status. `X-Protocol-Version` differing from `PROTOCOL_VERSION` -> 426 `version_mismatch`; absent is accepted.

Testing entrypoints (subpath exports): `@wolfpack/protocol/stub` exports `StubServer` (`new StubServer({fixture?, delayMs?, port?})`, `await listen()` -> base URL on 127.0.0.1, `close()`), `DEFAULT_FIXTURE`; `@wolfpack/protocol/contract` exports `runContractSuite(() => baseUrl, {wolf?, turnTimeoutMs?})`, a set of vitest `describe`/`it` blocks to run against any `/v1` server (call it from a test file; start the server in `beforeAll`). The target needs a wolf, and its scripted turns must take long enough (~50ms+) for the busy-window tests to land mid-turn. Zero runtime deps beyond zod; the contract imports `vitest` (a dev dependency of the consumer).
