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

## Layout

`src/schemas.ts` holds all schemas and inferred types; `src/index.ts` re-exports them.
