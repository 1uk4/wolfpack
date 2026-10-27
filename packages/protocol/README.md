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

## Wolf activity (needs-you stream)

`GET /v1/wolves/:name/activity` (SSE) carries `WolfEvent`s: `thread-status`, `card-pending`, `card-settled`, `resync` (`parseWolfEvent`; ignore unknown types). Thread streams also carry `card-pending` / `card-settled` events so an open thread shows a card the moment it is raised.

- **Ids.** The SSE `id:` is `<boot>:<seq>`: `boot` is a per-process epoch, `seq` a per-wolf monotonic integer. The JSON `id` is the `seq`. Treat the SSE id as opaque and send it back as `Last-Event-ID` (or `?from=`).
- **Baseline.** A connection without a cursor starts with the current state: one `thread-status`, then one `card-pending` per pending card, all carrying the current cursor. `status` and the baseline agree: a thread is `busy` while a turn runs or an answer is being submitted, else `needs-you` iff cards are pending.
- **Replay.** With a cursor of the current boot the server replays the bounded buffer (256 events) after it, gap-free. A cursor from another boot (restart), beyond the head, older than the buffer, or malformed gets `resync` followed by the baseline: refetch, do not trust earlier state.
- The stream never ends with `[DONE]`; it stays open until the client disconnects.

## Memory events (wolf stream)

`MemoryEvent` is a wolf-scoped union, separate from `ThreadEvent` (added without a version bump: new type, new route). Delivered on `GET /v1/wolves/:name/events` (SSE, `data: <MemoryEvent json>`; live only, no ids/replay; stays open until the client disconnects). Every event carries `wolf`, optional `threadId` (only the conversation backing the home thread, `<wolf>/home`), optional integer `conversationId` (the durable conversation an observation came from; absent on pool-level events), `timestamp`, `domain` and `target` (`den` / `session` topic id, or a `work` item id + feature). Payloads are metadata plus a redacted one-line summary; never full observation text. Variants: `observation_captured`, `topic_consolidated`, `contribution_emitted`, `promote_started|finished|failed`, `record_written` (target = the work item holding the Record; `observationCount`, `chars?`), `topic_archived` (`topicId`, `absorbedInto?`: absent for a reject), and from the librarian `sweep_started` (`pending`), `sweep_item` (`from`, `denTopicId`, `outcome` create\|merge\|reject\|parked, `entryId?`; unclassified items get none) and `sweep_finished` (`processed`, `created`, `merged`, `rejected`, `parked`, `remaining`, `durationMs`, `error?`; always follows a `sweep_started`; sweep events carry `domain: "kb"`). Use `parseMemoryEvent(raw)`; consumers MUST ignore unknown types (`{kind:"unknown"}`). The client SDK exposes `HttpConsoleClient.watchMemory(wolf)`.

## Memory actions

`POST /v1/wolves/:name/memory/consolidate` -> 200 `ConsolidateResponse` (counts + `topicIds`, no text). `POST /v1/wolves/:name/memory/promote` -> 202 `PromoteResponse {jobId, status:"started"}`; the job's outcome arrives as `promote_finished|failed` MemoryEvents with that `jobId` (the routes emit nothing themselves).

| Case | Status | Body |
|---|---|---|
| consolidate ok | 200 | `ConsolidateResponse` |
| promote started | 202 | `{jobId, status:"started"}` |
| promote while one runs | 202 | `{jobId, status:"already_running"}` (the running job; nothing started) |
| consolidate while a promote runs | 409 | envelope `memory_busy` (retryable; not queued) |
| memory inert / not loaded | 409 | envelope `memory_unavailable` |
| no KB roots (promote only) | 409 | envelope `promote_unavailable` |
| unknown wolf | 404 | envelope `not_found` |
| KB route on a wolf that is not the librarian / has no KB roots | 409 | envelope `kb_unavailable` (non-retryable) |

The new codes (`memory_unavailable`, `promote_unavailable`, `memory_busy`, `kb_unavailable`) are in `ERROR_HTTP_STATUS` (409). Client: `consolidateMemory(wolf)` / `promoteMemory(wolf)` (optional on `ConsoleClient`; `promoteMemory` resolves `already_running` (a 202), rejects with `ProtocolError` for the envelopes). No job-status route: events are the source of truth.

## Memory read resources

Additive and read-only, served by any wolf for its own den (a wolf never serves another's); no version bump.

| Route | Response | Notes |
| --- | --- | --- |
| `GET /v1/wolves/:name/memory[?thread=<id>]` | `MemoryStatus` | `state` live\|sandbox\|inert\|off + `reason`; `pool` (count, tokens, `consolidateAtTokens`, `poolTarget`, `trigger`) is null unless running; `sessionTopics` / `denTopics` (`MemoryTopicRef`); `lastPromote` (tracked in memory, null after a restart); `bound` (`BoundWork`, the thread's or the home thread's bound item, null if unbound). Always 200 when the wolf exists; unknown `thread` is 404 |
| `GET /v1/wolves/:name/memory/topics/:id[?scope=den\|session]` | `MemoryTopic` | body + metadata. 400 malformed id/scope, 404 unknown, 409 `memory_unavailable` when inert/off |
| `GET /v1/wolves/:name/work/:id/record` | `WorkRecordResponse` | title, kind, stage, domain, partOf, dependsOn, `plan`, `record`, `updated`, via the wolf's Work API client. 404 unknown, 409 `memory_unavailable` (no Work API), 502 `engine_error` |

`WolfSummary.librarian?: boolean` marks the wolf that serves the KB (`memory.librarian` in wolf.yaml); absent when unknown (offline wolf, older server). Client: `getMemoryStatus(wolf, {thread?})`, `getMemoryTopic(wolf, id, {scope?})`, `getWorkRecord(wolf, id)` (optional on `ConsoleClient`).

## KB resources

Additive and read-only, served by the librarian wolf only (`WolfSummary.librarian`); any other wolf, or a librarian without KB roots, answers 409 `kb_unavailable`.

| Route | Response | Notes |
| --- | --- | --- |
| `GET /v1/wolves/:name/kb/graph[?domain=&archivedWork=&wikilinks=&denTopics=]` | `KbGraph` | `nodes` (domain/section/entry/work/den-topic; ids `dom:`/`sec:`/`ent:`/`work:`/`den:<wolf>:<topic>`, `depth` 0-4), `edges` (`hierarchy` parent→child, `partOf` child→parent, `dependsOn`, `related` with `relation`, `wikilink`), the applied `layers` and `domain`, all `domains` (`name`, `label`, optional `color`), `generated`. No positions. Flags are `true`\|`false` (default false; else 400); unknown `domain` is 404. `denTopics` adds the serving wolf's own den topics only |
| `GET /v1/wolves/:name/kb/entries/:id` | `KbEntryDetail` | `frontmatter`, `body`, `wikilinks` (`target`, `exists`), `backlinks` (`id`, `title`, `via` wikilink\|related, `relation`). 400 malformed id, 404 unknown |
| `GET /v1/wolves/:name/kb/pipeline` | `KbPipelineResponse` | `lanes` (`wolf`, `pending`, `oldestAgeMs?`), `receipts` (newest 50: `wolf`, `denTopicId`, `outcome` create\|merge\|reject\|parked\|unclassified, `entryId?`, `processed`, `detail?`), `parked` (`wolf`, `file`, `denTopicId?`, `reason?`), `sweep` (`current?` item in progress, `last?` persisted last run with counts, `durationMs`, `error?`) |

Client: `getKbGraph(wolf, {domain?, archivedWork?, wikilinks?, denTopics?})`, `getKbEntry(wolf, id)`, `getKbPipeline(wolf)` (optional on `ConsoleClient`).

## Tool calls in history

**Attachments** (additive, no version bump). `POST /v1/threads/:id/attachments` uploads one file to the thread's wolf: the body is the raw bytes, `Content-Type` is the mime type, optional `X-Attachment-Name` is the URL-encoded file name. It answers `201 Attachment {id, name, mimeType, size}`. The route is type-agnostic; the wolf accepts images only for now (`ATTACHMENT_IMAGE_TYPES`: png, jpeg, gif, webp; content-sniffed; at most `ATTACHMENT_MAX_BYTES` = 5 MiB) and answers anything else 400 `invalid_request`. Files live at `<den>/attachments/<threadId>/<id>.<ext>`. `SubmitRequest.attachments?: {id}[]` references uploads; `input` may then be empty. At submit the wolf inlines each file as an image part of the user message and appends `[Attached image: <path>]` lines to the text, so history `text` carries the path (the image bytes stay in the engine entry, not in `ThreadMessage`). An unknown or malformed id is 400 `invalid_request`; so is more than `ATTACHMENT_MAX_PER_SUBMIT` (8) refs, and an upload with no `Content-Type` ("missing Content-Type"). wolfd answers an oversize upload 400 `invalid_request` (it is a protocol error envelope); the console's relay route, which is not the protocol, answers 413. Browser code can import the constants from the dependency-free `@wolfpack/protocol/attachments`. SDK: `uploadAttachment(threadId, bytes, {mimeType, name?})` and `submit(..., {attachments})`.

Attachments in history and bytes. `ThreadMessage.attachments?: Attachment[]` (additive, user messages only) lists the attachments a message was sent with; `text` is unchanged and still ends with the `[Attached image: <path>]` lines (model-facing), which a UI may strip from what it displays. `GET /v1/threads/:id/attachments/:attachmentId` (`getAttachment`, response kind `bytes`) serves the stored bytes with the stored mime as `Content-Type` and `X-Content-Type-Options: nosniff`; an id that is malformed, unknown or another thread's is 404 `not_found`. SDK: `getAttachment(threadId, attachmentId) -> {bytes, mimeType}`. A steer may carry attachments too (`whenBusy:"steer"` with `attachments`). History entries are derived from the engine entries (the `[Attached image: <path>]` lines); the original file name is not kept, so a reloaded attachment's `name` is its stored file name.

Cleanup seam. When a wolf deletes a thread, it must call `removeThreadAttachments(den, threadId)` (exported from `@wolfpack/harness/wolfd`, defined in `wolfd/attachments.ts`), which removes `<den>/attachments/<threadId>/` recursively and is a no-op when none exists. Thread deletion does not exist yet; nothing calls the hook today.

`ThreadMessage.tools?` (additive, optional, no version bump; old servers omit it, clients must tolerate absence) lists an assistant message's tool calls in call order: `{callId, name, args, result?, isError?, resultTruncated?, textOffset?}`. `text` is unchanged (text blocks only); `textOffset` is the length of `text` when the call happened, so a consumer can interleave tool rows with the merged rounds' text. `args` stays an OBJECT: each string value (nested included) is cut to 1 KB, then the largest strings are shortened until the JSON fits ~4 KB, and any cut sets `_truncated: true` at the top level of `args` (consumers must not assume truncated args are complete). `result` is capped at ~4 KB (`resultTruncated: true` when cut). A pure tool round yields an assistant message with `text: ""`. Thinking is never in history. Id note: because a tool-only round now yields a message, a turn that starts with a tool-only round gets that entry's id (`entry-<id>`) instead of the id of its first text round; consumers must reseed from `getThread` rather than cache ids across the upgrade.

**Structured objects** (additive, no version bump). A wolf shows a typed object (`decision` now; checklist and graph later) through a dedicated tool (`show_decision`) whose parameter schema is the protocol schema plus a wolf-chosen `objectId`; calling it again with the same `objectId` revises the object. The thread event is `object-upsert {turnId, objectId, objectType, rev, data, textOffset?}`: the field is `objectType` because `type` is the event discriminator. `rev` is the number of successful completed calls with that `objectId` so far (1 for the first; failed, aborted or invalid calls count for nothing), `textOffset` the length of the turn's merged assistant text when it appeared (absent for a mid-turn joiner). The event is emitted just before the call's `tool-end`. History carries the same: `ThreadMessage.objects?: {objectId, type, rev, data, textOffset?}[]` on the assistant message of an object's first call, ONE entry per `objectId` holding the latest rev's full `data` (not capped, unlike `tools[].args`), so `getThread` and snapshots return the latest revision at its first position. A consumer folds by `objectId`, highest `rev` wins, shown at the first position, and validates `data` per type with `parseObjectData` (dependency-free subpath `@wolfpack/protocol/objects`, which also checks `chosen` names an option); an unknown `type` is skipped.

## Layout

`src/schemas.ts` holds all schemas and inferred types; `src/index.ts` re-exports them.

## Routes, stub server, contract suite

`src/routes.ts` (exported from the main entry) is the declarative `/v1` route table: `ROUTES` maps a name to `{method, path, body?, response, status, error}` with zod schema bindings; `matchRoute(method, pathname)` and `buildPath(name, params)` are the only helpers (no framework). Path params are URL-encoded (thread ids contain `/`). Routes: `GET /v1/wolves`, `GET|POST /v1/wolves/:name/threads` (create is home-only and idempotent: 201 new, 200 existing), `GET /v1/threads/:id`, `POST /v1/threads/:id/submit|abort`, `GET /v1/threads/:id/stream` (SSE).

Normative serving semantics (implemented by the stub, asserted by the contract):

- Event ids are minted per thread by the server. The replay buffer is **per turn**: cleared at turn-start, so it holds only the current or most recent turn.
- Stream: `id: <eventId>` + `data: <ThreadEvent json>` frames; the stream **ends at the first turn-end** with `data: [DONE]` (same as the console bridge). No cursor = replay the current/most recent turn, then follow live. Resume via `Last-Event-ID` header or `?from=`: a cursor inside the buffer replays events after it then follows live; a stale (pre-turn) or future cursor gets a `snapshot` (`id` = last event id, `upToId` = last event id, `thread`, `inFlight` if a turn is running) then live events.
- Submit: `whenBusy` required (else 400 `invalid_request`). Idle: starts (`started`). Busy: `reject` -> 409 `busy`; `followUp` -> `queued`, runs after the turn; `steer` -> `steered`. Abort ends the turn with `turn-end` reason `aborted` and drops queued follow-ups.
- Submit body: `POST /v1/threads/:id/submit` takes JSON `{ "input": string, "whenBusy": "reject" | "followUp" | "steer" }` (the thread id is in the path, not the body) and answers `200 { "messageId": string, "disposition": "started" | "steered" | "queued" }`:

  ```sh
  curl -s -X POST -H 'X-Protocol-Version: 1' -H 'Content-Type: application/json' \
    -d '{"input":"hello","whenBusy":"reject"}' \
    "http://127.0.0.1:PORT/v1/threads/$(node -p 'encodeURIComponent("haldev/home")')/submit"
  # {"messageId":"…","disposition":"started"}
  ```
- Every error is an `ErrorEnvelope` with the `ERROR_HTTP_STATUS` status. `X-Protocol-Version` differing from `PROTOCOL_VERSION` -> 426 `version_mismatch`; absent is accepted.

Testing entrypoints (subpath exports): `@wolfpack/protocol/stub` exports `StubServer` (`new StubServer({fixture?, delayMs?, port?})`, `await listen()` -> base URL on 127.0.0.1, `close()`), `DEFAULT_FIXTURE`; `@wolfpack/protocol/contract` exports `runContractSuite(() => baseUrl, {wolf?, turnTimeoutMs?})`, a set of vitest `describe`/`it` blocks to run against any `/v1` server (call it from a test file; start the server in `beforeAll`). The target needs a wolf, and its scripted turns must take long enough (~50ms+) for the busy-window tests to land mid-turn. Zero runtime deps beyond zod; the contract imports `vitest` (a dev dependency of the consumer).

## Stepped and conditional cards

A card may carry `steps` (`[{ title?, fields: ids[] }]`, partitioning `fields` in card order) and a field may carry
`showIf` (`{ field, equals }` or `{ field, oneOf }`; the controller must be an earlier `single` field with option values,
or a `confirm` with a boolean `equals`). Both are optional; consoles that ignore them render a plain form.

**Hidden answers are dropped, not rejected.** wolfd requires an answer for every *visible* field only, and silently drops
(with a debug log) any answer sent for a field its `showIf` hides, so an older console that renders every field still
works. The model sees only visible fields' answers; the stored answer holds only those too.

## Optional fields

A field may set `optional: true` (additive; absent = required). The operator can leave it blank and still submit.
A skipped optional field is submitted **empty**, by kind:

| kind | skipped answer |
| --- | --- |
| `free-text`, `single` | `{ "value": "" }` |
| `multi` | `{ "value": [] }` (the multi's `min` does not apply to a blank one; once something is picked, `min`/`max` apply) |
| `confirm` | no entry for the field (there is no empty boolean); `answers[id]` is absent. The model still sees `- <label>: (skipped)` |

wolfd accepts all of these for an optional visible field (a missing answer too, for any kind) and validates a non-empty
answer normally. The model-facing answer text reads `- <label>: (skipped)` for a skipped optional field. A required
field is unchanged (missing/blank single, multi below `min`, or missing confirm is still rejected). A field hidden by
`showIf` is never required, optional or not. `ask_user_question` takes `optional` per question (and on a single `question`).
