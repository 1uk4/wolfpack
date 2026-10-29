import { z } from "zod";
import {
  AttachmentSchema,
  BindThreadRequestSchema,
  BindThreadResponseSchema,
  AnswerCardRequestSchema,
  ConsolidateResponseSchema,
  CreateThreadBodyVariantsSchema,
  CreateThreadResponseSchema,
  ErrorEnvelopeSchema,
  KbEntryDetailSchema,
  KbGraphSchema,
  LedgerEntrySchema,
  MemoryEventSchema,
  WolfEventSchema,
  HubEventSchema,
  MemoryStatusSchema,
  MemoryTopicSchema,
  MemoryObservationsSchema,
  PendingCardSchema,
  PromoteResponseSchema,
  SubmitAckSchema,
  SubmitRequestSchema,
  ThreadDetailSchema,
  ThreadSettingsPatchSchema,
  ThreadContextSchema,
  CompactBodySchema,
  CompactAckSchema,
  ThreadSettingsResponseSchema,
  ThreadEventSchema,
  ThreadSummarySchema,
  WolfSummarySchema,
  WorkspaceStatusSchema,
  WorkRecordResponseSchema,
  WorkListResponseSchema,
  GraduationConfirmBodySchema,
  GraduationJobSchema,
  GraduationObservationsSchema,
  GraduationStatusSchema,
  GraduationPreviewSchema,
  GraduationResultSchema,
  KbPipelineResponseSchema,
} from "./schemas.js";

import * as R from "./registry.js";
import { CreateWorkRequestSchema, CreateWorkResponseSchema, DeleteWorkResponseSchema, PatchWorkRequestSchema, WorkItemResponseSchema } from "./work-writes.js";

export { ATTACHMENT_NAME_HEADER } from "./attachments.js";
/** Request header carrying the client's protocol version (single integer). */
export const PROTOCOL_VERSION_HEADER = "X-Protocol-Version";
/**
 * `X-Wolfpack-Actor: {"id":"<id>","kind":"operator"|"wolf"}` (JSON): who a request to a HUB acts as. PROVISIONAL: the hub's shared
 * `X-API-Key` is the only authentication, so the actor is ASSERTED by the client, not proven; do not treat it as an identity
 * guarantee. Per-actor pairing (work-wolfpack-WRkevxL) replaces it. Rules (hubd): reads default to the `system` actor when it is
 * absent; mutating routes REQUIRE it (400 `invalid_request` when missing); owner-only operations require kind `operator`
 * (401 `unauthorized` otherwise); `system` is reserved for the hub's own jobs and a client asserting it is 400 `invalid_request`.
 */
export const ACTOR_HEADER = "X-Wolfpack-Actor";
/** SSE resume: standard header, or the `?from=` query fallback. */
export const LAST_EVENT_ID_HEADER = "Last-Event-ID";
/** Terminator frame payload (`data: [DONE]`) sent when a stream ends at turn-end. */
export const SSE_DONE = "[DONE]";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Wire bodies: the path carries the identifier, so it is dropped from the body. */
export const SubmitBodySchema = SubmitRequestSchema.omit({ threadId: true });
export type SubmitBody = z.infer<typeof SubmitBodySchema>;
export const CreateThreadBodySchema = CreateThreadBodyVariantsSchema;
export type CreateThreadBody = z.infer<typeof CreateThreadBodySchema>;

export const AnswerCardBodySchema = AnswerCardRequestSchema.omit({ threadId: true, callId: true });
export type AnswerCardBody = z.infer<typeof AnswerCardBodySchema>;
// --- feature progress: bind ---
export const BindThreadBodySchema = BindThreadRequestSchema;
// --- end feature progress ---
export const ListCardsResponseSchema = z.object({ cards: z.array(PendingCardSchema) });

/**
 * Hub contribution submission body: the contribution's fields (the kb `ContributionSchema`: from, denTopicId, change, contentHash,
 * prevHash, domainHint, summary, submitted, body, + optional provenance) as JSON. The protocol only requires an object; hubd validates
 * it against the kb schema and quarantines a non-conforming one.
 */
export const SubmitContributionBodySchema = z.record(z.string(), z.unknown());
export const SubmitContributionResponseSchema = z.object({
  /** The stored file name, `<denTopicId>-<10 hex of contentHash>.md`. */
  id: z.string(),
  /** The submitting wolf's lane (`contributions/<wolf>/`). */
  wolf: z.string(),
  /** true: the same contribution (topic + content hash) was already stored; nothing was written. */
  duplicate: z.boolean(),
});

export const ListWolvesResponseSchema = z.object({ wolves: z.array(WolfSummarySchema) });
export const ListThreadsResponseSchema = z.object({ threads: z.array(ThreadSummarySchema) });
export const ListChildrenResponseSchema = z.object({ threads: z.array(ThreadSummarySchema) });
export const LedgerResponseSchema = z.object({ entries: z.array(LedgerEntrySchema) });
export const AbortResponseSchema = z.object({ ok: z.literal(true) });

export interface RouteDef {
  readonly method: HttpMethod;
  /** Path pattern; `:name` segments are URL-encoded path params (thread ids contain `/`). */
  readonly path: string;
  /** `"hub"`: served by hubd (the pack authority), not by a wolf host. Absent = a wolf-host route. */
  readonly scope?: "hub";
  /** JSON request body schema, if any. */
  readonly body?: z.ZodType;
  /** Success response: a JSON body schema, or an SSE stream of events. */
  readonly response:
    | { readonly kind: "json"; readonly schema: z.ZodType }
    | { readonly kind: "sse"; readonly event: z.ZodType }
    /** Raw bytes; `Content-Type` is the stored mime type. */
    | { readonly kind: "bytes" };
  /** Success status(es). */
  readonly status: readonly number[];
  /** Every non-2xx response is an ErrorEnvelope. */
  readonly error: z.ZodType;
}

const err = ErrorEnvelopeSchema;

export const ROUTES = {
  listWolves: { method: "GET", path: "/v1/wolves", response: { kind: "json", schema: ListWolvesResponseSchema }, status: [200], error: err },
  listThreads: { method: "GET", path: "/v1/wolves/:name/threads", response: { kind: "json", schema: ListThreadsResponseSchema }, status: [200], error: err },
  /** Home-only and idempotent: 201 when created, 200 when the existing home thread is returned. */
  createThread: {
    method: "POST",
    path: "/v1/wolves/:name/threads",
    body: CreateThreadBodySchema,
    response: { kind: "json", schema: CreateThreadResponseSchema },
    status: [200, 201],
    error: err,
  },
  /**
   * The subagent threads a thread spawned (any state), oldest first; empty for a thread that spawned none. 404
   * `not_found` for an unknown thread.
   */
  listChildren: { method: "GET", path: "/v1/threads/:id/children", response: { kind: "json", schema: ListChildrenResponseSchema }, status: [200], error: err },
  /**
   * A subagent thread's ledger: every message between its parent, the child and the operator (brief, steers, questions,
   * results), oldest first, each with sender, recipient and time. 404 `not_found` for an unknown thread or one that is
   * not a subagent.
   */
  getLedger: { method: "GET", path: "/v1/threads/:id/ledger", response: { kind: "json", schema: LedgerResponseSchema }, status: [200], error: err },
  // ---- header git tree ----
  /**
   * Live git state of a thread's workspace (branch, ahead/behind its base, dirty files, last 5 commits, running
   * subagents' worktrees). Read-only, cached a few seconds. 404 `not_found` for an unknown thread or one without a git workspace.
   */
  getWorkspaceStatus: { method: "GET", path: "/v1/threads/:id/workspace/status", response: { kind: "json", schema: WorkspaceStatusSchema }, status: [200], error: err },
  // ---- /header git tree ----
  /**
   * Optional query `limit` (positive integer, at most 500; 0, fractions and non-numbers are 400 `invalid_request`, larger
   * values are clamped to 500) and `before` (a `cursor` from an earlier response; `before` without `limit` is 400). No
   * `limit` = the whole transcript (unchanged for old clients). `limit` alone = the newest page: the last `limit` messages,
   * widened back to include any message holding a pending card. `limit`+`before` = exactly the `limit` messages before
   * that message (unknown cursor = empty page). The response carries `hasMore` and `cursor`; only the page is serialised.
   */
  getThread: { method: "GET", path: "/v1/threads/:id", response: { kind: "json", schema: ThreadDetailSchema }, status: [200], error: err },
  submit: { method: "POST", path: "/v1/threads/:id/submit", body: SubmitBodySchema, response: { kind: "json", schema: SubmitAckSchema }, status: [200], error: err },
  /**
   * Upload one attachment to the thread's wolf. The body is the RAW BYTES (not JSON); `Content-Type` carries the mime
   * type and the optional `X-Attachment-Name` header the URL-encoded file name. Type-agnostic route; the wolf accepts
   * images only for now (png, jpeg, gif, webp, up to `ATTACHMENT_MAX_BYTES`, content sniffed) and answers anything else
   * 400 `invalid_request`. Returns the stored attachment; reference it from `submit`.
   */
  uploadAttachment: { method: "POST", path: "/v1/threads/:id/attachments", response: { kind: "json", schema: AttachmentSchema }, status: [201], error: err },
  /**
   * Fetch one uploaded attachment's raw bytes. `:attachmentId` must be an id returned by `uploadAttachment` for THIS
   * thread; anything else (malformed, traversal, another thread's) is 404 `not_found`. Answers with the stored mime
   * type as `Content-Type`, plus `X-Content-Type-Options: nosniff`.
   */
  getAttachment: { method: "GET", path: "/v1/threads/:id/attachments/:attachmentId", response: { kind: "bytes" }, status: [200], error: err },
  /**
   * Answer a pending card (`:callId` = the tool call that raised it). The answer resolves that call and, once no
   * sibling card of the turn is pending, starts the next turn: the ack is the next turn's SubmitAck, or disposition
   * `queued` while siblings wait (a held answer can be re-sent to change it). A plain submit supersedes pending cards (they
   * become `dismissed`). 404 `not_found` for an unknown, superseded or already-answered card, 400
   * `invalid_request` when `answers` do not match the card's fields, 409 `busy` while a turn is running.
   */
  answerCard: {
    method: "POST",
    path: "/v1/threads/:id/cards/:callId/answer",
    body: AnswerCardBodySchema,
    response: { kind: "json", schema: SubmitAckSchema },
    status: [200],
    error: err,
  },
  /**
   * Skip a pending card (`:callId` = the tool call that raised it) without answering. No body. The card closes as
   * `skipped` (`ThreadToolCall.closed`, `dismissed: true` for older clients), the agent is told, and the ack is as for
   * `answerCard` (the next turn's SubmitAck, or `queued` while a sibling card still waits: a skip counts as that
   * card's resolution). Same errors as `answerCard`: 404 `not_found` for an unknown, superseded, skipped or answered
   * card, 409 `busy` while a turn is running.
   */
  skipCard: {
    method: "POST",
    path: "/v1/threads/:id/cards/:callId/skip",
    response: { kind: "json", schema: SubmitAckSchema },
    status: [200],
    error: err,
  },
  /**
   * The thread's composer settings: model tier (`main|smart|fast`) and auto-ship. `models` hints which model each tier
   * resolves to on this wolf. Defaults `{tier: "main", autoShip: false}`. 404 `not_found` for an unknown thread.
   */
  getThreadSettings: { method: "GET", path: "/v1/threads/:id/settings", response: { kind: "json", schema: ThreadSettingsResponseSchema }, status: [200], error: err },
  /**
   * Change the thread's settings (body: `tier` and/or `autoShip`; the rest is kept). Persisted: survives a wolf restart.
   * A tier change applies from the next turn (a running turn finishes on its model). Answers the new settings.
   * 400 `invalid_request` for a bad body or a subagent thread (its model comes from its profile), 404 `not_found` for an unknown thread.
   */
  putThreadSettings: { method: "PUT", path: "/v1/threads/:id/settings", body: ThreadSettingsPatchSchema, response: { kind: "json", schema: ThreadSettingsResponseSchema }, status: [200], error: err },
  /** The thread's context size against its model window, thresholds and compaction history. Works for every thread kind. 404 `not_found`. */
  getThreadContext: { method: "GET", path: "/v1/threads/:id/context", response: { kind: "json", schema: ThreadContextSchema }, status: [200], error: err },
  /**
   * Compact the thread's context now (manual compaction; extension beforeCompact hooks run first). Allowed while a turn runs.
   * Answers once admitted; the wolf then announces `thread-updated` when the compaction starts and again when it finishes
   * (re-read the context route). Body `{instructions?}`. 400 `invalid_request`, 404 `not_found`.
   */
  compactThread: { method: "POST", path: "/v1/threads/:id/compact", body: CompactBodySchema, response: { kind: "json", schema: CompactAckSchema }, status: [200], error: err },
  // --- feature progress: bind ---
  /**
   * Bind the thread's conversation to a work item (task, issue or spike), the way the agent's `task_bind` does: same
   * binding file, and the agent learns of it from its next prompt. A feature thread accepts the items of its own feature
   * (or the feature itself). 400 `invalid_request` for an item that cannot be bound (a feature/initiative, archived, another
   * feature's, malformed) or one another conversation holds (the message names it); 404 `not_found` for an unknown thread or
   * item; 409 `thread_closed` on a closed (graduated) thread; 409 `memory_unavailable` when the wolf has no den or Work API;
   * 502 `engine_error` when the Work API cannot be reached.
   */
  bindThread: {
    method: "POST",
    path: "/v1/threads/:id/bind",
    body: BindThreadRequestSchema,
    response: { kind: "json", schema: BindThreadResponseSchema },
    status: [200],
    error: err,
  },
  // --- end feature progress ---
  /** Cards waiting for the operator across this wolf's threads (the needs-you list). */
  listCards: { method: "GET", path: "/v1/wolves/:name/cards", response: { kind: "json", schema: ListCardsResponseSchema }, status: [200], error: err },
  abort: { method: "POST", path: "/v1/threads/:id/abort", response: { kind: "json", schema: AbortResponseSchema }, status: [200], error: err },
  /** SSE: `id: <eventId>` + `data: <ThreadEvent json>`; ends with `data: [DONE]` at the first turn-end. */
  streamThread: { method: "GET", path: "/v1/threads/:id/stream", response: { kind: "sse", event: ThreadEventSchema }, status: [200], error: err },
  /**
   * SSE: wolf-scoped MemoryEvents, `data: <MemoryEvent json>` frames. Live only (no replay, no `id:`, no Last-Event-ID);
   * unlike a thread stream it never ends with `[DONE]`, it stays open until the client disconnects.
   */
  streamWolfEvents: { method: "GET", path: "/v1/wolves/:name/events", response: { kind: "sse", event: MemoryEventSchema }, status: [200], error: err },
  /**
   * SSE: wolf-scoped WolfEvents (`thread-status`, `card-pending`, `card-settled`, `resync`) with `id: <eventId>` per
   * frame. A fresh connection (no cursor) starts with a baseline: a `thread-status` per thread and a `card-pending`
   * per pending card. `Last-Event-ID` / `?from=` replays what was missed from a bounded buffer, or answers `resync`
   * (then the baseline) when the cursor is stale. Never ends with `[DONE]`: open until the client disconnects.
   */
  streamWolfActivity: { method: "GET", path: "/v1/wolves/:name/activity", response: { kind: "sse", event: WolfEventSchema }, status: [200], error: err },
  /**
   * Fold the observation pool into session topics; answers with the counts. 409 `memory_unavailable` when the wolf's
   * memory is inert or not loaded; 409 `memory_busy` (retryable) while a promote runs.
   */
  consolidateMemory: {
    method: "POST",
    path: "/v1/wolves/:name/memory/consolidate",
    response: { kind: "json", schema: ConsolidateResponseSchema },
    status: [200],
    error: err,
  },
  /**
   * Start promote as a background job: 202 `{jobId, status:"started"}` immediately; completion is reported as
   * `promote_finished` / `promote_failed` MemoryEvents with that jobId. While one runs: also 202, with
   * `{jobId: <running job>, status:"already_running"}` (nothing started). Failures are envelopes: 409
   * `memory_unavailable` (memory inert / not loaded) and 409 `promote_unavailable` (no KB roots).
   */
  promoteMemory: {
    method: "POST",
    path: "/v1/wolves/:name/memory/promote",
    response: { kind: "json", schema: PromoteResponseSchema },
    status: [202],
    error: err,
  },
  /**
   * Read-only memory status: state (live|sandbox|inert|off) with the reason, pool count/tokens against the
   * consolidate thresholds, session- and den-topic lists, last promote. Answers 200 even when memory is inert or off
   * (that is the state being reported). A wolf serves only its own den. `?thread=<id>` adds that thread's bound work
   * item (`bound`); an unknown thread is 404 `not_found`.
   */
  getMemoryStatus: { method: "GET", path: "/v1/wolves/:name/memory", response: { kind: "json", schema: MemoryStatusSchema }, status: [200], error: err },
  /**
   * One den or session topic with its body. `?scope=den|session` picks the store (default: den, then session).
   * 400 `invalid_request` for a malformed id or scope, 404 `not_found` for an unknown topic,
   * 409 `memory_unavailable` when memory is inert or off.
   */
  getMemoryTopic: { method: "GET", path: "/v1/wolves/:name/memory/topics/:id", response: { kind: "json", schema: MemoryTopicSchema }, status: [200], error: err },
  /**
   * The wolf's current observation pool (what the status pool count counts), newest first, each with its `work` /
   * `feature` tags. `?limit=<n>` keeps the newest n (`total` is the whole pool). Persisted: survives a restart.
   * 400 `invalid_request` for a bad limit, 409 `memory_unavailable` when memory is inert or off.
   */
  getMemoryObservations: { method: "GET", path: "/v1/wolves/:name/memory/observations", response: { kind: "json", schema: MemoryObservationsSchema }, status: [200], error: err },
  /**
   * A work item's page data (plan + Record + links), fetched through the wolf's Work API client. 404 `not_found` for an unknown item or wolf,
   * 409 `memory_unavailable` when the wolf has no Work API configured, 502 `engine_error` when it cannot be reached.
   */
  /**
   * The work items of one domain (`?domain=`, required), via the wolf's Work API client; graduated and archived ones only with `?graduated=true`.
   * 400 `invalid_request` for a missing domain or a bad flag, 404 `not_found` for an unknown wolf, 409 `memory_unavailable` when the wolf has no
   * Work API configured, 502 `engine_error` when it cannot be reached.
   */
  listWork: { method: "GET", path: "/v1/wolves/:name/work", response: { kind: "json", schema: WorkListResponseSchema }, status: [200], error: err },
  getWorkRecord: { method: "GET", path: "/v1/wolves/:name/work/:id/record", response: { kind: "json", schema: WorkRecordResponseSchema }, status: [200], error: err },
  /**
   * Hub-scoped work reads (served by hubd, the pack authority; no wolf in the path). Same response shapes as the wolf-scoped
   * `listWork` / `getWorkRecord`. `?domain=` and `?graduated=` behave as for `listWork`; a missing domain is 400 `invalid_request`,
   * an unknown item is 404 `not_found`. Wolves keep serving the wolf-scoped routes.
   */
  hubListWork: { scope: "hub", method: "GET", path: "/v1/work", response: { kind: "json", schema: WorkListResponseSchema }, status: [200], error: err },
  hubGetWorkRecord: { scope: "hub", method: "GET", path: "/v1/work/:id/record", response: { kind: "json", schema: WorkRecordResponseSchema }, status: [200], error: err },
  /**
   * Submit a wolf contribution to the hub (the hub-side librarian inbox). Body: the contribution fields as JSON. Needs `X-Wolfpack-Actor`;
   * a wolf actor may only submit as itself (`from` must equal the actor id; an operator may submit for any wolf). 201 when stored,
   * 200 `duplicate: true` when the same topic + content hash is already stored (idempotent). 400 `invalid_request` for non-JSON, a
   * `from`/actor mismatch, or a contribution that fails the contribution schema (the latter is also quarantined under
   * `contributions/<wolf>/_bad/` with a `.reason.txt`).
   */
  submitContribution: { scope: "hub", method: "POST", path: "/v1/contributions", body: SubmitContributionBodySchema, response: { kind: "json", schema: SubmitContributionResponseSchema }, status: [200, 201], error: err },
  /**
   * Hub work WRITES (hubd is the only ledger writer). Every one requires `X-Wolfpack-Actor` (400 `invalid_request` without).
   * Errors: 400 `invalid_request` (bad body, placement/scope/cycle guard, unknown parent), 404 `not_found` (unknown item),
   * 409 `not_ready` (stage not advanceable), 403 `forbidden` (`body` / `assignee` PATCH by a non-operator).
   * `hubCreateWork`: create an item (a parentless task/issue/spike is filed in the domain Inbox). 201.
   * `hubPatchWork`: STRICT body (unknown key = `invalid_request`): one single-field op, or a batch `{ops:[...]}` (1..50 ops,
   * all-or-nothing: staged in a scratch copy, then appended to the ledger in one write; nothing is appended if any op fails).
   * Fields: stage, note, title, successCriteria, moveTo, link, unlink, standing, schedule, section ({name: "plan"|"notes",
   * text}; the generated Record/Log is rejected, as is text holding an H1/H2 outside a code fence or an unclosed fence, and a
   * body with two of the same heading); operator-only: body, assignee. Empty stage/note/title/assignee and `moveTo: ""` are
   * rejected; `moveTo: null` un-parents (hierarchy rules still apply); `successCriteria: ""` clears it.
   * A batch must be ALL ledger ops or ALL `body`/`section` ops: a mix is `invalid_request` ("section/body ops can't be combined
   * with ledger ops in one batch; send them separately"). A ledger batch copies the ledger and the domain's work/ dir under the
   * write queue; a content-only batch is one atomic .md write.
   * KNOWN GAP: `body` and `section` ops rewrite the .md only and append NO ledger event, so they do not bump `updated` and
   * emit no work.changed (follow-up; no new event type here).
   * `hubDeleteWork`: delete the item and its descendants; answers the deleted ids.
   * `hubGraduateWork`: mark the item graduated on the ledger (the agent route's behaviour; no distill step).
   */
  hubCreateWork: { scope: "hub", method: "POST", path: "/v1/work", body: CreateWorkRequestSchema, response: { kind: "json", schema: CreateWorkResponseSchema }, status: [201], error: err },
  hubPatchWork: { scope: "hub", method: "PATCH", path: "/v1/work/:id", body: PatchWorkRequestSchema, response: { kind: "json", schema: WorkItemResponseSchema }, status: [200], error: err },
  hubDeleteWork: { scope: "hub", method: "DELETE", path: "/v1/work/:id", response: { kind: "json", schema: DeleteWorkResponseSchema }, status: [200], error: err },
  /**
   * `hubClaimWork`: compare-and-set under the writer queue. The actor (a wolf, or the operator) becomes the holder: appends
   * work.assigned + work.bound (and work.staged approved -> in_build in the same append). Idempotent for the same holder.
   * Targets: features and bindable tasks/issues/spikes (loose Inbox items or feature children). 409 `conflict` (`details.holder`)
   * when held by another wolf, or when the item's feature is; 400 `invalid_request` for idea/initiative/container items or items
   * not in stage approved or in_build (idea, plan, feasibility and the terminal stages are refused). Inheritance runs both ways: a
   * child of a held feature, and a feature with a held child, are 409. An actor id that is not a valid wolf id is 400.
   * LEGACY: an old work.bound with no matching work.unbound reads as held (last writer wins, no origin filter); an operator clears it
   * with unclaim. task_bind outside the hub can displace a hub claim until wolves are repointed (JPhfaEL / cutover).
   * `hubUnclaimWork`: the holder or an operator appends work.unbound; the stage is left alone.
   * 409 `conflict` for any other actor. No timeout or presence expiry.
   */
  hubClaimWork: { scope: "hub", method: "POST", path: "/v1/work/:id/claim", response: { kind: "json", schema: WorkItemResponseSchema }, status: [200], error: err },
  hubUnclaimWork: { scope: "hub", method: "POST", path: "/v1/work/:id/unclaim", response: { kind: "json", schema: WorkItemResponseSchema }, status: [200], error: err },
  hubGraduateWork: { scope: "hub", method: "POST", path: "/v1/work/:id/graduate", response: { kind: "json", schema: WorkItemResponseSchema }, status: [200], error: err },
  /**
   * SSE (hubd): pack events, `id: <boot>:<seq>` + `data: <HubEvent json>`. `work.changed {itemId, event}` for every hub ledger
   * write (event = ledger event type), `kb.changed {entryIds}`, `wolf.presence`. Live from connect; `Last-Event-ID` / `?from=`
   * replays from a bounded buffer, or answers `resync` when the cursor is older than the buffer (or from another hub boot).
   * Keepalive comments; never ends with `[DONE]`.
   */
  hubEvents: { scope: "hub", method: "GET", path: "/v1/events", response: { kind: "sse", event: HubEventSchema }, status: [200], error: err },
  /**
   * Graduation, step 1: start a background job that distills the work item into KB contribution entries and leaves a
   * preview with a confirmation token. Answers at once with the job `{jobId, kind, state: "running", startedAt}`; a start
   * while a preview for the item is running returns that job (409 `busy` while a confirm runs). Nothing is sent or archived (the wolf folds the item's pending
   * tagged observations into its Record first, on its own model and pool). No body. Poll `graduationStatus`.
   * 404 `not_found` for an unknown wolf, 400 `invalid_request` for a malformed id, 409 `memory_unavailable` when the wolf has no
   * Work API / KB / graduation support. A not-ready item, a failed drain or distill is reported by the status as an error.
   */
  previewGraduation: { method: "POST", path: "/v1/wolves/:name/work/:id/graduate/preview", response: { kind: "json", schema: GraduationJobSchema }, status: [200], error: err },
  /**
   * Graduation, step 2: start a background job that sends a previewed graduation. All or nothing: the contributions go
   * to the librarian's inbox, then the item is marked graduated and archived with its tasks, every conversation bound
   * to it unbinds and its feature thread closes. Answers at once with the job (the running one when a confirm for the item
   * runs; 409 `busy` while a preview of it runs). 400 `invalid_request` for a bad body. A stale token, a not-ready item or a failed write shows in the status as an error
   * (`preview_stale`, `not_ready`, `engine_error`) with nothing archived.
   */
  confirmGraduation: { method: "POST", path: "/v1/wolves/:name/work/:id/graduate/confirm", body: GraduationConfirmBodySchema, response: { kind: "json", schema: GraduationJobSchema }, status: [200], error: err },
  /**
   * The state of the item's graduation job on this wolf (see GraduationStatus). After a wolfd restart a finished preview
   * is recovered from its token file (`preview_ready`) while it has not expired.
   */
  graduationStatus: { method: "GET", path: "/v1/wolves/:name/work/:id/graduate/status", response: { kind: "json", schema: GraduationStatusSchema }, status: [200], error: err },
  /**
   * How many pending observations in this wolf's pool a graduation of the item would fold (tagged with the item or its descendant
   * tasks), split per work item. Only this wolf's pool is read: a work item has a single assignee.
   */
  graduationObservations: { method: "GET", path: "/v1/wolves/:name/work/:id/graduate/observations", response: { kind: "json", schema: GraduationObservationsSchema }, status: [200], error: err },
  /**
   * Dewey's pipeline: inbox lanes per wolf, the newest 50 receipts, parked items, the sweep in progress and the last
   * sweep. Librarian only: 409 `kb_unavailable` on any other wolf (or one without KB roots).
   */
  kbPipeline: { method: "GET", path: "/v1/wolves/:name/kb/pipeline", response: { kind: "json", schema: KbPipelineResponseSchema }, status: [200], error: err },
  /**
   * The KB graph, served by any wolf with KB roots (read-only; 409 `kb_unavailable` without them). Query: `domain` (one domain; unknown = 404 `not_found`),
   * and the layer flags `archivedWork`, `denTopics` (`true`|`false`, default false; anything else is 400 `invalid_request`).
   * `denTopics` adds the serving wolf's own den topics only. Work items hang off one `fac:<domain>` Factory node per domain (sourced from the Work API, else the KB work files); there are no cross-entry relation edges.
   */
  getKbGraph: { method: "GET", path: "/v1/wolves/:name/kb/graph", response: { kind: "json", schema: KbGraphSchema }, status: [200], error: err },
  /** One KB entry (frontmatter, body, wikilinks, backlinks). Any wolf with KB roots. 400 malformed id, 404 unknown, 409 `kb_unavailable`. */
  getKbEntry: { method: "GET", path: "/v1/wolves/:name/kb/entries/:id", response: { kind: "json", schema: KbEntryDetailSchema }, status: [200], error: err },
  /**
   * The hub registry: hosts, wolves, domains, subscriptions (subscription id = `<wolf>:<domain>`). Reads: any actor. Writes
   * (create/update/delete/retire) need an operator actor, else 403 `forbidden`. Creating a wolf writes ONLY the entry (no provisioning).
   * `registryRetireWolf` sets status retired and releases every claim the wolf holds (work.unbound); `released` lists the item ids.
   * Every write regenerates domains.yaml in the hub data dir. 404 unknown name, 409 `conflict` on a duplicate create.
   */
  registryListHosts: { scope: "hub", method: "GET", path: "/v1/registry/hosts", response: { kind: "json", schema: R.RegistryHostsResponseSchema }, status: [200], error: err },
  registryGetHost: { scope: "hub", method: "GET", path: "/v1/registry/hosts/:name", response: { kind: "json", schema: R.RegistryHostResponseSchema }, status: [200], error: err },
  registryCreateHost: { scope: "hub", method: "POST", path: "/v1/registry/hosts", body: R.RegistryHostSchema, response: { kind: "json", schema: R.RegistryHostResponseSchema }, status: [200,201], error: err },
  registryUpdateHost: { scope: "hub", method: "PATCH", path: "/v1/registry/hosts/:name", body: R.UpdateRegistryHostRequestSchema, response: { kind: "json", schema: R.RegistryHostResponseSchema }, status: [200], error: err },
  registryDeleteHost: { scope: "hub", method: "DELETE", path: "/v1/registry/hosts/:name", response: { kind: "json", schema: R.RegistryDeleteResponseSchema }, status: [200], error: err },
  registryListWolves: { scope: "hub", method: "GET", path: "/v1/registry/wolves", response: { kind: "json", schema: R.RegistryWolvesResponseSchema }, status: [200], error: err },
  registryGetWolf: { scope: "hub", method: "GET", path: "/v1/registry/wolves/:name", response: { kind: "json", schema: R.RegistryWolfResponseSchema }, status: [200], error: err },
  registryCreateWolf: { scope: "hub", method: "POST", path: "/v1/registry/wolves", body: R.RegistryWolfSchema, response: { kind: "json", schema: R.RegistryWolfResponseSchema }, status: [200,201], error: err },
  registryUpdateWolf: { scope: "hub", method: "PATCH", path: "/v1/registry/wolves/:name", body: R.UpdateRegistryWolfRequestSchema, response: { kind: "json", schema: R.RegistryWolfResponseSchema }, status: [200], error: err },
  registryDeleteWolf: { scope: "hub", method: "DELETE", path: "/v1/registry/wolves/:name", response: { kind: "json", schema: R.RegistryDeleteResponseSchema }, status: [200], error: err },
  registryRetireWolf: { scope: "hub", method: "POST", path: "/v1/registry/wolves/:name/retire", response: { kind: "json", schema: R.RetireWolfResponseSchema }, status: [200], error: err },
  registryListDomains: { scope: "hub", method: "GET", path: "/v1/registry/domains", response: { kind: "json", schema: R.RegistryDomainsResponseSchema }, status: [200], error: err },
  registryGetDomain: { scope: "hub", method: "GET", path: "/v1/registry/domains/:name", response: { kind: "json", schema: R.RegistryDomainResponseSchema }, status: [200], error: err },
  registryCreateDomain: { scope: "hub", method: "POST", path: "/v1/registry/domains", body: R.RegistryDomainSchema, response: { kind: "json", schema: R.RegistryDomainResponseSchema }, status: [200,201], error: err },
  registryUpdateDomain: { scope: "hub", method: "PATCH", path: "/v1/registry/domains/:name", body: R.UpdateRegistryDomainRequestSchema, response: { kind: "json", schema: R.RegistryDomainResponseSchema }, status: [200], error: err },
  registryDeleteDomain: { scope: "hub", method: "DELETE", path: "/v1/registry/domains/:name", response: { kind: "json", schema: R.RegistryDeleteResponseSchema }, status: [200], error: err },
  registryListSubscriptions: { scope: "hub", method: "GET", path: "/v1/registry/subscriptions", response: { kind: "json", schema: R.RegistrySubscriptionsResponseSchema }, status: [200], error: err },
  registryGetSubscription: { scope: "hub", method: "GET", path: "/v1/registry/subscriptions/:name", response: { kind: "json", schema: R.RegistrySubscriptionResponseSchema }, status: [200], error: err },
  registryCreateSubscription: { scope: "hub", method: "POST", path: "/v1/registry/subscriptions", body: R.RegistrySubscriptionSchema, response: { kind: "json", schema: R.RegistrySubscriptionResponseSchema }, status: [200, 201], error: err },
  registryDeleteSubscription: { scope: "hub", method: "DELETE", path: "/v1/registry/subscriptions/:name", response: { kind: "json", schema: R.RegistryDeleteResponseSchema }, status: [200], error: err },
} as const satisfies Record<string, RouteDef>;

export type RouteName = keyof typeof ROUTES;

export interface RouteMatch {
  name: RouteName;
  route: RouteDef;
  params: Record<string, string>;
}

const compiled = (Object.entries(ROUTES) as [RouteName, RouteDef][]).map(([name, route]) => ({
  name,
  route,
  segments: route.path.split("/").filter(Boolean),
}));

/** Match a request to a route. `undefined` = no such path; `"method"` = path exists, wrong method. */
export function matchRoute(method: string, pathname: string): RouteMatch | "method" | undefined {
  const parts = pathname.split("/").filter(Boolean);
  let pathHit = false;
  for (const c of compiled) {
    if (c.segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < parts.length && ok; i++) {
      const seg = c.segments[i];
      if (seg.startsWith(":")) {
        try {
          params[seg.slice(1)] = decodeURIComponent(parts[i]);
        } catch {
          ok = false;
        }
      } else ok = seg === parts[i];
    }
    if (!ok) continue;
    pathHit = true;
    if (c.route.method === method) return { name: c.name, route: c.route, params };
  }
  return pathHit ? "method" : undefined;
}

/** Build a concrete path from a route pattern, URL-encoding params. */
export function buildPath(name: RouteName, params: Record<string, string> = {}): string {
  return ROUTES[name].path.replace(/:(\w+)/g, (_, k: string) => encodeURIComponent(params[k] ?? ""));
}
