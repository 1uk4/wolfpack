import { z } from "zod";
import {
  AttachmentSchema,
  BindThreadRequestSchema,
  BindThreadResponseSchema,
  AnswerCardRequestSchema,
  SaveCardPageBodySchema,
  SubmitCardBodySchema,
  CardNoteBodySchema,
  BindCardTextBodySchema,
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
  MemoryTreeSchema,
  MemoryTopicsSchema,
  KeepLocalBodySchema,
  KeepLocalResponseSchema,
  MemoryNodeObservationsSchema,
  PendingCardSchema,
  PromoteBodySchema,
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
  KbActivityResponseSchema,
} from "./schemas.js";
import { KbChangesResponseSchema, KbManifestResponseSchema, KbManifestDiffRequestSchema, KbManifestDiffResponseSchema } from "./kb-sync.js";

import * as R from "./registry.js";
import { HubSettingsSchema } from "./hub-settings.js";
import { CommandRequestSchema, CommandResponseSchema } from "./command.js";
import { InventoryEntrySchema, InventoryReportBodySchema, MachineKeyAckBodySchema } from "./inventory.js";
import { PutWolfSettingsBodySchema, RestartResponseSchema, RevealBodySchema, RevealResponseSchema, WolfSettingsViewSchema } from "./wolf-settings.js";
import { ListPromptsResponseSchema, PromptViewSchema, PutPromptBodySchema } from "./prompts.js";
import { DeviceListSchema, MintPairingCodeRequestSchema, MintPairingCodeResponseSchema, PairRequestSchema, PairResponseSchema, RevokeDeviceResponseSchema } from "./pairing.js";
import { KbCommitRequestSchema, KbCommitResponseSchema } from "./kb-commits.js";
import { RebuildApplyRequestSchema, RebuildApplyResponseSchema, RebuildListResponseSchema, RebuildPreviewRequestSchema, RebuildPreviewResponseSchema, RebuildRestoreRequestSchema, RebuildRestoreResponseSchema } from "./kb-rebuild.js";
import { CreateWorkRequestSchema, CreateWorkResponseSchema, DeleteWorkResponseSchema, PatchWorkRequestSchema, WorkItemResponseSchema } from "./work-writes.js";

export { ATTACHMENT_NAME_HEADER } from "./attachments.js";
/** Request header carrying the client's protocol version (single integer). */
export const PROTOCOL_VERSION_HEADER = "X-Protocol-Version";
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
export { SaveCardPageBodySchema, SubmitCardBodySchema, CardNoteBodySchema, BindCardTextBodySchema } from "./schemas.js";
// --- feature progress: bind ---
export const BindThreadBodySchema = BindThreadRequestSchema;
// --- end feature progress ---
export const ListCardsResponseSchema = z.object({ cards: z.array(PendingCardSchema) });

/**
 * Hub contribution submission body: the contribution's fields (the kb `ContributionSchema`: from, denTopicId, change, contentHash,
 * prevHash, domainHint, summary, submitted, body, + optional provenance) as JSON. The protocol only requires an object; hubd validates
 * it against the kb schema and quarantines a non-conforming one.
 */
/** Optional body of hubClaimWork / hubUnclaimWork: the wolf a worker token acts for (see the route docs). */
export const ClaimWorkBodySchema = z.object({ wolf: z.string().optional() });
export const SubmitContributionBodySchema = z.record(z.string(), z.unknown());
export const SubmitContributionResponseSchema = z.object({
  /** The stored file name, `<denTopicId>-<10 hex of contentHash>.md`. */
  id: z.string(),
  /** The submitting wolf's lane (`contributions/<wolf>/`). */
  wolf: z.string(),
  /** true: the same contribution (topic + content hash) was already stored; nothing was written. */
  duplicate: z.boolean(),
});

export const ContributionReceiptsResponseSchema = z.object({ curated: z.array(z.string()) });
export const ContributionCheckBodySchema = z.object({
  items: z.array(z.object({ denTopicId: z.string().min(1).max(200), contentHash: z.string().max(200).optional() })).max(2000),
});
export const ContributionCheckResponseSchema = z.object({ unchanged: z.array(z.string()) });
export const KbMatchBodySchema = z.object({
  candidates: z.array(z.object({ title: z.string(), body: z.string(), domain: z.string().optional() })).min(1).max(50),
});
const KbMatchSchema = z.object({ domain: z.string(), id: z.string(), title: z.string(), score: z.number(), bodySimilarity: z.number() });
export const KbMatchResponseSchema = z.object({
  method: z.enum(["embeddings", "text"]),
  fallback: z.string().optional(),
  results: z.array(z.object({ title: z.string(), label: z.enum(["new", "update", "duplicate"]), matches: z.array(KbMatchSchema) })),
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
  /** `true`: no `Authorization: Bearer` needed (hub pairing only; every other hub route requires a token). */
  readonly public?: true;
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
   * `queued` while siblings wait (a held answer can be re-sent to change it). While a turn is running the answer is
   * steered into it like a chat message typed mid-turn: the ack is `steered` (the card is answered; the agent reads it at
   * the turn's next boundary or when it ends); it never fails as `busy`. A sibling card raised moments after this
   * answer, in the same round, is not waited for: its answer is delivered separately, each labelled with its card. A plain submit supersedes pending cards (they
   * become `dismissed`), and a server does so as soon as it accepts the message, even mid-turn (a card whose answer is
   * already being submitted stays answered). 404 `not_found` for an
   * unknown, superseded or already-answered card, 400 `invalid_request` when `answers` do not match the card's fields.
   * (Servers before this change answered 409 `busy` while a turn was running; clients treat that as a retryable error.)
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
   * card's resolution), or `steered` while a turn is running. Same errors as `answerCard`: 404 `not_found` for an
   * unknown, superseded, skipped or answered card.
   */
  skipCard: {
    method: "POST",
    path: "/v1/threads/:id/cards/:callId/skip",
    response: { kind: "json", schema: SubmitAckSchema },
    status: [200],
    error: err,
  },
  /**
   * Save one page of a paged (`ask`) card as a draft (Next / Back). Nothing reaches the agent. Body
   * `{answers, goto?, stepsKey?}`: the page's answers (shape-checked only: required answers are enforced at submit; a
   * `showIf`-hidden answer is dropped), `goto` the page now viewed (default min(page+1, last)), `stepsKey` the
   * `stepsKey` of the pages the client saw. Moving forward raises `PendingCard.reached`; it never goes down. Text
   * bound to the page's questions is folded into the saved answers. Answers `{accepted: true}`; `card-pending` then
   * carries the new `pageIndex`/`reached`/`pageAnswers`. 404 unknown/closed card, 400 not paged / page or goto out of
   * range / invalid answer, 409 a submit is in flight or `stepsKey` no longer matches (the pages were revised).
   */
  saveCardPage: {
    method: "PUT",
    path: "/v1/threads/:id/cards/:callId/pages/:page/draft",
    body: SaveCardPageBodySchema,
    response: { kind: "json", schema: z.object({ accepted: z.literal(true) }) },
    status: [200],
    error: err,
  },
  /**
   * Submit a paged card: ONE tool result with every page's saved answers (plus `answers`, the page on screen, when
   * given) and the note. Ack as `answerCard` (`started` | `steered`). Every page's required questions are checked:
   * a miss is one 400 naming them ("Q3 \"Name\", ..."). Body `{answers?, note?: {text?, attachments?}, stepsKey?}`
   * (`note` replaces the stored note when given). 404 unknown/closed card, 400 not paged / invalid, 409 a submit is
   * already in flight or `stepsKey` mismatch.
   */
  submitCard: {
    method: "POST",
    path: "/v1/threads/:id/cards/:callId/submit",
    body: SubmitCardBodySchema,
    response: { kind: "json", schema: SubmitAckSchema },
    status: [200],
    error: err,
  },
  /**
   * The owner's note on a paged card, stored on wolfd (shared by every client, survives a reload). Body
   * `{text?, attachments?: string[]}` (upload ids; counted with the images bound to questions against
   * ATTACHMENT_MAX_PER_SUBMIT, else 400; an id not an upload of this thread is 400); an empty note clears it.
   * Answers `{accepted: true}`; `card-pending` carries `note`. 404 unknown/closed card, 400 not paged, 409 submit in flight.
   */
  putCardNote: {
    method: "PUT",
    path: "/v1/threads/:id/cards/:callId/note",
    body: CardNoteBodySchema,
    response: { kind: "json", schema: z.object({ accepted: z.literal(true) }) },
    status: [200],
    error: err,
  },
  /**
   * "Answering Qn": hold typed text as the free-text / Other answer of question `:qid` of a paged
   * card (any page). Not a chat message: nothing is superseded and no turn starts. Answers `{accepted: true}`; the card's
   * `draft` (card-pending event) then shows it.
   * Body `{text?, attachments?: string[]}`: at least one is required (blank text with no attachments is 400).
   * Attachment ids come from `uploadAttachment` on this thread; an id that is not an upload of this thread is 400.
   * At most ATTACHMENT_MAX_PER_SUBMIT images across all drafts of the card (400 above that).
   * Draft per kind: free `{value: text, attachments?}`; single Other `{value: text, other: true, attachments?}`;
   * multi Other `{value: [text], other: [text], attachments?}`. With images only there is no text: free/single
   * `{value: "", attachments}`, multi `{value: [], attachments}` (no `other`, nothing counts toward `max`).
   * A later bind replaces the earlier draft of that question. Picking an option for the question when the page is
   * submitted keeps the draft's images. Direct answers to a page never carry attachments (400).
   * 400 for a slider/confirm question, one not on the card, or a single/multi with `noOther`; 404 for an
   * unknown card.
   */
  bindCardText: {
    method: "POST",
    path: "/v1/threads/:id/cards/:callId/questions/:qid/text",
    body: BindCardTextBodySchema,
    response: { kind: "json", schema: z.object({ accepted: z.literal(true) }) },
    status: [200],
    error: err,
  },
  /**
   * A diagram the wolf rendered (a diagram tool that persisted the PNG), by id: the value of a
   * card field's `diagram`. Use it as an `<img src>`. Served only from the wolf's own persisted viz directory; the id is
   * the file name `viz-<slug>-<ms>.png` and nothing else (a path, URL or `..` is 404 `not_found`, as is an unpublished
   * id). `Content-Type: image/png`, `X-Content-Type-Options: nosniff`.
   */
  getDiagram: { method: "GET", path: "/v1/threads/:id/diagrams/:diagramId", response: { kind: "bytes" }, status: [200], error: err },
  /**
   * The thread's composer settings: model tier (`main|smart|fast`) and auto-ship. `models` hints which model each tier
   * resolves to on this wolf. Defaults `{tier: "main", autoShip: false}`. 404 `not_found` for an unknown thread.
   */
  /**
   * The wolf's prompt registry, each with its effective text (`source` default|override), `etag` and `editable` flag. Overrides live in the
   * wolf's home (`agent/prompts/<id>.md`); an edit applies when the wolf's system prompt is next built (wolfd builds it at start-up).
   * 404 `not_found` for an unknown wolf or prompt.
   */
  listPrompts: { method: "GET", path: "/v1/wolves/:name/prompts", response: { kind: "json", schema: ListPromptsResponseSchema }, status: [200], error: err },
  getPrompt: { method: "GET", path: "/v1/wolves/:name/prompts/:id", response: { kind: "json", schema: PromptViewSchema }, status: [200], error: err },
  /**
   * Write the wolf's override (atomic). Header `If-Match: <etag>` is required (missing: 400 `invalid_request`): a stale etag is 409 `conflict`. 403 `forbidden` for a
   * prompt that is not wolf-editable, 413 `too_large` over 64 KB, 400 `invalid_request` for a bad body. Answers the new view.
   */
  putPrompt: { method: "PUT", path: "/v1/wolves/:name/prompts/:id", body: PutPromptBodySchema, response: { kind: "json", schema: PromptViewSchema }, status: [200], error: err },
  /** Remove the override (reset to the repo default); same required `If-Match` / 403 / 409 rules. Idempotent. Answers the default view. */
  resetPrompt: { method: "DELETE", path: "/v1/wolves/:name/prompts/:id", response: { kind: "json", schema: PromptViewSchema }, status: [200], error: err },
  /**
   * The wolf's settings: wolf.yaml as parsed now with secrets masked (`{set}`), the env var NAMES it reads (+ whether set), the editable keys,
   * `restartNeeded` and `restartable`. Never carries a secret value. 404 `not_found` for an unknown wolf.
   */
  getWolfSettings: { method: "GET", path: "/v1/wolves/:name/settings", response: { kind: "json", schema: WolfSettingsViewSchema }, status: [200], error: err },
  /**
   * Edit wolf.yaml (validated against the wolf.yaml schema, atomic). Body `{set: {"<dotted key>": value|null}}`; header `If-Match: <etag>` is required
   * (missing: 400 `invalid_request`; stale: 409 `conflict`). 400 `invalid_request` for an unknown/non-editable key or a value the schema refuses, 413 `too_large`.
   * Applies on restart: the answer has `restartNeeded: true`.
   */
  putWolfSettings: { method: "PUT", path: "/v1/wolves/:name/settings", body: PutWolfSettingsBodySchema, response: { kind: "json", schema: WolfSettingsViewSchema }, status: [200], error: err },
  /** Reveal ONE secret value (an env var listed in the view, or a wolf.yaml key the masked read masks). POST so it is never cached or logged as a read. 404 `not_found` for a name that is not listed. */
  revealWolfSetting: { method: "POST", path: "/v1/wolves/:name/settings/reveal", body: RevealBodySchema, response: { kind: "json", schema: RevealResponseSchema }, status: [200], error: err },
  /** Restart this wolfd (it exits and its supervisor starts it again). 409 `conflict` when nothing supervises it, 429 `rate_limited` (`details.retryAfterSeconds`, `Retry-After`) within the first 60s of the process. Answers before exiting. */
  restartWolf: { method: "POST", path: "/v1/wolves/:name/settings/restart", response: { kind: "json", schema: RestartResponseSchema }, status: [200], error: err },
  /**
   * Start the grilling -> spec -> tickets flow: the wolf resolves its own `new-work` prompt (its overrides of new-work, grilling, to-spec,
   * to-tickets) on its host and submits it, plus the optional idea, as the first message of its home thread. Answers the submit ack and
   * the thread id. 409 `busy` when the home thread is mid-turn.
   */
  getThreadSettings: { method: "GET", path: "/v1/threads/:id/settings", response: { kind: "json", schema: ThreadSettingsResponseSchema }, status: [200], error: err },
  /**
   * Change the thread's settings (body: `tier`, `autoShip` and/or `color` (a palette key; null = automatic); the rest is kept). Persisted: survives a wolf restart.
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
    body: PromoteBodySchema,
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
  /** Observation counts per feature → task (pending in the pool, archived in the last 7 days). 409 `memory_unavailable` when memory is inert or off. */
  getMemoryTree: { method: "GET", path: "/v1/wolves/:name/memory/tree", response: { kind: "json", schema: MemoryTreeSchema }, status: [200], error: err },
  /** Every session topic with size, sources, state and keep-local, plus the retired ones and the byte budget. 409 `memory_unavailable` when memory is inert or off. */
  getMemorySessionTopics: { method: "GET", path: "/v1/wolves/:name/memory/session-topics", response: { kind: "json", schema: MemoryTopicsSchema }, status: [200], error: err },
  /** Set or clear a session topic's `keep_local` flag (a keep-local topic is never auto-promoted). 404 `not_found` for an unknown topic. */
  putMemoryKeepLocal: { method: "PUT", path: "/v1/wolves/:name/memory/topics/:id/keep-local", body: KeepLocalBodySchema, response: { kind: "json", schema: KeepLocalResponseSchema }, status: [200], error: err },
  /** The observations behind one tree node (`:workId` a feature's own, a task, or `den`). `?limit=<n>` caps the archived list (default 100). */
  getMemoryNodeObservations: { method: "GET", path: "/v1/wolves/:name/memory/tree/:workId", response: { kind: "json", schema: MemoryNodeObservationsSchema }, status: [200], error: err },
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
   * Submit a wolf contribution to the hub (the hub-side librarian inbox). Body: the contribution fields as JSON. Needs a bearer token; the actor is the token's identity.
   * A wolf may only submit as itself (`from` must be the acting wolf; an operator token may submit for any wolf, a worker token for any active wolf on its host). 201 when stored,
   * 200 `duplicate: true` when the same topic + content hash is already stored (idempotent). 400 `invalid_request` for non-JSON or a contribution that fails the contribution schema (the latter is also quarantined under
   * `contributions/<wolf>/_bad/` with a `.reason.txt`). 403 `forbidden` when `from` is not the acting wolf: for a worker token, a wolf that is
   * not registered, not active or not on the token's host; for an operator token there is no such check.
   */
  submitContribution: { scope: "hub", method: "POST", path: "/v1/contributions", body: SubmitContributionBodySchema, response: { kind: "json", schema: SubmitContributionResponseSchema }, status: [200, 201], error: err },
  /**
   * Which den topic ids the curator has curated (files in `contributions/<wolf>/_processed/`) for the calling wolf. Query `wolf` names the wolf:
   * a worker token defaults to its host's only active wolf (several = 400) and may name only an active wolf of its host (403 otherwise); an operator token must name it (400).
   */
  hubContributionReceipts: { scope: "hub", method: "GET", path: "/v1/contributions/receipts", response: { kind: "json", schema: ContributionReceiptsResponseSchema }, status: [200], error: err },
  /**
   * Which `{denTopicId, contentHash}` items the hub already holds for the wolf (pending or curated) with exactly that hash: `{unchanged: denTopicId[]}`.
   * An item without contentHash is never unchanged. Max 2000 items. Same wolf resolution as receipts (query `wolf`). 400 `invalid_request` for a bad body.
   */
  hubContributionCheck: { scope: "hub", method: "POST", path: "/v1/contributions/check", body: ContributionCheckBodySchema, response: { kind: "json", schema: ContributionCheckResponseSchema }, status: [200], error: err },
  /**
   * Match candidate entries against the hub KB for the release review. Body `{candidates: [{title, body, domain?}]}` (1..50). Per candidate: `label`
   * new | update | duplicate and up to 5 `matches` (domain, id, title, score 0-1, bodySimilarity 0-1). `method` says "embeddings" (Ollama) or "text"
   * (fallback, with `fallback` giving the reason; also "text" when the KB scope is empty). Operator/console/browser identities see every domain; worker tokens only see/match domains their host's wolves subscribe to. The candidate limit (1..50) is this schema's. 400 `invalid_request`; 403 for an unsubscribed `domain`.
   */
  hubKbMatch: { scope: "hub", method: "POST", path: "/v1/kb/match", body: KbMatchBodySchema, response: { kind: "json", schema: KbMatchResponseSchema }, status: [200], error: err },
  /**
   * Hub work WRITES (hubd is the only ledger writer). Every one requires a bearer token; the actor is the token's identity.
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
   * Optional JSON body `{ wolf?: string }` (read for worker tokens only; operator/console tokens act as themselves): a worker token's actor is
   * its host, so it names the active wolf on its host that claims. With no body the host's single active wolf is used: 400 `invalid_request`
   * when the host has several, 403 `forbidden` when it has none. A named wolf that is unregistered, retired or on another host is 403.
   * A body that is not valid JSON is 400.
   * LEGACY: an old work.bound with no matching work.unbound reads as held (last writer wins, no origin filter); an operator clears it
   * with unclaim. task_bind outside the hub can displace a hub claim until wolves are repointed (JPhfaEL / cutover).
   * `hubUnclaimWork`: the holder or an operator appends work.unbound; the stage is left alone. Takes the same optional `{ wolf }` body and wolf resolution as claim.
   * 409 `conflict` for any other actor. No timeout or presence expiry.
   */
  hubClaimWork: { scope: "hub", method: "POST", path: "/v1/work/:id/claim", body: ClaimWorkBodySchema, response: { kind: "json", schema: WorkItemResponseSchema }, status: [200], error: err },
  hubUnclaimWork: { scope: "hub", method: "POST", path: "/v1/work/:id/unclaim", body: ClaimWorkBodySchema, response: { kind: "json", schema: WorkItemResponseSchema }, status: [200], error: err },
  hubGraduateWork: { scope: "hub", method: "POST", path: "/v1/work/:id/graduate", response: { kind: "json", schema: WorkItemResponseSchema }, status: [200], error: err },
  /**
   * KB commit (hubd): a batch of create/update/delete changes to entries/*.md, _registry.md, _digest.json and INDEX.md of declared
   * domains, each with contentHash and prevHash. All-or-nothing under the KB writer lock: entry schema, declared domain (domains.yaml),
   * path confinement, and prevHash compare-and-set (409 `conflict`, `details.path`, on a stale write). Then it writes the files,
   * appends the KB ledger (ledger/events.jsonl) and emits `kb.changed` per domain. 400 `invalid_request`, 403 `forbidden` for a wolf
   * actor. Body cap 8 MiB. Actor: operator token over HTTP; the curator (system) uses the in-process hub.commitKb.
   */
  hubKbCommit: { scope: "hub", method: "POST", path: "/v1/kb/commits", body: KbCommitRequestSchema, response: { kind: "json", schema: KbCommitResponseSchema }, status: [200], error: err },
  /**
   * KB sync: changes of one domain since revision N. Query `since` (integer >= 0, default 0), `epoch` (the epoch from the previous answer; REQUIRED when since > 0, a request without it is 400 `invalid_request`; may be omitted on the first call, since=0), `maxBytes` (page cap, default the KB commit body limit).
   * Answers `{status:"ok", domain, epoch, since, revision, truncated, files:[{path,contentHash,encoding:"utf8",content}], deletes:[{path}]}` (coalesced per path; `truncated` = ask again with since=revision), or `{status:"reset", reason}` with reason `below_floor` (the log no longer reaches `since`), `epoch_mismatch` or `ahead_of_hub`: fall back to the manifest diff.
   * Worker tokens may read only domains their host's wolves subscribe to (403 otherwise). 404 on a subscribed domain means "not scanned yet, retry shortly" (the hub creates a domain's revision log on its first scan or commit), NOT "deleted".
   */
  /**
   * KB activity from the hub curator's own ledger and receipts (no wolf relay): incoming contributions per wolf, the decision feed
   * (latest decision per contribution), recent entry changes per domain. Query `since` ("7d" | "30d" | "all" | ISO; default "30d"),
   * `before` (cursor), `limit` (1..200, default 50), `domain`. Console/browser tokens only.
   */
  hubKbActivity: { scope: "hub", method: "GET", path: "/v1/kb/activity", response: { kind: "json", schema: KbActivityResponseSchema }, status: [200], error: err },
  /**
   * KB section rebuild (operator token only; a worker or wolf token is 403). `preview` starts a background job (202 `{jobId}`) that plans the
   * domain (model calls happen here, no KB lock held) and writes a plan file; poll `plans` for the job and the plan. `apply` commits EXACTLY that
   * plan file under the hub's KB lock with the curator paused: no model call, hubd keeps answering. It refuses (409 `conflict`) if the domain's
   * entries changed since the plan or `expectFlags` differs from the plan's flags, backs the domain up first, and bumps the KB revision.
   * `restore` puts back the state before an apply (by its `stamp`). 404 for an unknown plan or stamp.
   */
  hubKbRebuildPreview: { scope: "hub", method: "POST", path: "/v1/admin/kb/rebuild/preview", body: RebuildPreviewRequestSchema, response: { kind: "json", schema: RebuildPreviewResponseSchema }, status: [202], error: err },
  hubKbRebuildApply: { scope: "hub", method: "POST", path: "/v1/admin/kb/rebuild/apply", body: RebuildApplyRequestSchema, response: { kind: "json", schema: RebuildApplyResponseSchema }, status: [200], error: err },
  hubKbRebuildRestore: { scope: "hub", method: "POST", path: "/v1/admin/kb/rebuild/restore", body: RebuildRestoreRequestSchema, response: { kind: "json", schema: RebuildRestoreResponseSchema }, status: [200], error: err },
  hubKbRebuildList: { scope: "hub", method: "GET", path: "/v1/admin/kb/rebuild/plans", response: { kind: "json", schema: RebuildListResponseSchema }, status: [200], error: err },
  hubKbChanges: { scope: "hub", method: "GET", path: "/v1/kb/domains/:domain/changes", response: { kind: "json", schema: KbChangesResponseSchema }, status: [200], error: err },
  /**
   * The hub's settings (read-only): `prompts` (every engine prompt hubd's KB sweep uses, `{id, group, label, text}`, raw text), `config`
   * (hubd's effective config; credentials come back as `{set: true}`, never the value) and `version`. Console/browser tokens only (a worker token gets 403).
   */
  /** The pack inventory (work-wolfpack-ZproKxi): every reporting service with its version, channel and age. Console/browser tokens only. */
  hubInventory: { scope: "hub", method: "GET", path: "/v1/inventory", response: { kind: "json", schema: z.object({ entries: z.array(InventoryEntrySchema.extend({ ageS: z.number() })), hubMachine: z.string() }) }, status: [200], error: err },
  /** A console's heartbeat `{entry}` (kind console only, body <= 4 KB). The row is bound to the token that wrote it (403 for another token). */
  hubInventoryReport: { scope: "hub", method: "POST", path: "/v1/inventory/report", body: InventoryReportBodySchema, response: { kind: "json", schema: z.object({ ok: z.literal(true) }) }, status: [200], error: err },
  /** Command channel (work-wolfpack-8jLJ4on): run one command on a connected machine and wait for its result. Console/browser tokens only. 200 = the machine answered (ok true/false), 409 = not sent (not_sent_offline / not_sent_unsupported), 504 = timeout (outcome unknown; never retry automatically). Nothing is stored; the body (key bytes) is never logged. */
  hubMachineCommand: { scope: "hub", method: "POST", path: "/v1/machines/:id/commands", body: CommandRequestSchema, response: { kind: "json", schema: CommandResponseSchema }, status: [200, 409, 504], error: err },
  /** Machine public keys (work-wolfpack-6EmU8pu): per host the hello pubkey, its fingerprint and the key-change flag. Console/browser tokens only. */
  hubMachineKeys: { scope: "hub", method: "GET", path: "/v1/machines/keys", response: { kind: "json", schema: z.object({ keys: z.record(z.string(), z.object({ pubkey: z.string(), fingerprint: z.string(), changed: z.boolean() })) }) }, status: [200], error: err },
  /** Accept a machine's changed key (clears the key-change flag). The body names the fingerprint being accepted: 409 when it is not the current one, 404 when the host never sent a key. */
  hubMachineKeyAck: { scope: "hub", method: "POST", path: "/v1/machines/:id/key/ack", body: MachineKeyAckBodySchema, response: { kind: "json", schema: z.object({ ok: z.literal(true) }) }, status: [200, 404, 409], error: err },
  hubSettings: { scope: "hub", method: "GET", path: "/v1/settings", response: { kind: "json", schema: HubSettingsSchema }, status: [200], error: err },
  /**
   * The KB graph built from the hub's own read-only KB copy, limited to the domains the caller may read (console/browser tokens: all; a worker
   * token: the domains its host's wolves subscribe to). Query `domain` (one domain; 403 when the token may not read it, 404 when unknown),
   * `archivedWork` (true/false). Never writes. Same shape as a wolf's kb/graph.
   */
  hubKbGraph: { scope: "hub", method: "GET", path: "/v1/kb/graph", response: { kind: "json", schema: KbGraphSchema }, status: [200], error: err },
  /**
   * One KB entry (body, wikilinks, backlinks; same shape as a wolf's kb/entries/:id) from the hub's read-only KB copy. Scoped like the graph:
   * console/browser tokens read every domain, a worker token only its host's subscribed domains (backlinks too). An entry in a domain the
   * token may not read answers 404, exactly like a missing one. A malformed id is 400.
   */
  hubKbEntry: { scope: "hub", method: "GET", path: "/v1/kb/entries/:id", response: { kind: "json", schema: KbEntryDetailSchema }, status: [200], error: err },
  /** KB sync: the hub's path -> contentHash manifest of one domain, with epoch, revision and the retention floor. Same domain filtering as changes. */
  hubKbManifest: { scope: "hub", method: "GET", path: "/v1/kb/domains/:domain/manifest", response: { kind: "json", schema: KbManifestResponseSchema }, status: [200], error: err },
  /** KB sync: send the worker's path -> hash manifest; get the differing files (up to maxBytes), the paths to delete, and `pending` paths that did not fit. */
  hubKbManifestDiff: { scope: "hub", method: "POST", path: "/v1/kb/domains/:domain/manifest-diff", body: KbManifestDiffRequestSchema, response: { kind: "json", schema: KbManifestDiffResponseSchema }, status: [200], error: err },
  /**
   * PUBLIC (no token): exchange a single-use pairing code (minted by `hubd pair`, valid ~10 minutes) for a per-device bearer token.
   * Body `{code, label, kind?, hostId?}`: the token's kind and hostId are fixed by the CODE (`hubd pair --kind worker|console|browser [--host-id]`); `kind`/`hostId` in the body are optional and must match the code (401 otherwise, the code is not consumed). Answers `{token, tokenId}`. The token is shown once; the hub keeps only its hash.
   * 401 `unauthorized` for an unknown, used, expired or mismatched code; 409 `busy` (retryable) while the token store is locked; 429 after 10 failed attempts a minute from one peer address; 400 `invalid_request` for a bad body. Every other hub route needs
   * `Authorization: Bearer <token>`; the identity comes from the token. `X-API-Key` and `X-Wolfpack-Actor` are not accepted or read.
   */
  hubPair: { scope: "hub", public: true, method: "POST", path: "/v1/pair", body: PairRequestSchema, response: { kind: "json", schema: PairResponseSchema }, status: [200], error: err },
  /** The hub's browser pairing page (static HTML + JS, public like hubPair): code + label form that POSTs hubPair with kind browser. `?code=` prefills. */
  /**
   * Device management. Callers: console/browser tokens (a worker token gets 403). `hubListDevices`: console/browser devices with
   * label, createdAt, lastUsedAt (about 5s stale) and `self`; never a token or hash. `hubRevokeDevice`: revokes one device (404 for an
   * unknown id or a worker token); a device MAY revoke itself (sign out; its own next request is 401). `?cascade=1` also revokes the devices it added (transitively). Refused with 409 `busy` when it would leave no console-kind token. `hubMintPairingCode`: a
   * single-use 10-minute code for a new BROWSER device (the same thing `hubd pair --kind browser --label` mints); at most 10 mints+revokes a minute per token (409 busy, retryable).
   * Revokes and mints are audit-logged (token id, never a secret).
   */
  hubListDevices: { scope: "hub", method: "GET", path: "/v1/tokens", response: { kind: "json", schema: DeviceListSchema }, status: [200], error: err },
  hubRevokeDevice: { scope: "hub", method: "DELETE", path: "/v1/tokens/:id", response: { kind: "json", schema: RevokeDeviceResponseSchema }, status: [200], error: err },
  hubMintPairingCode: { scope: "hub", method: "POST", path: "/v1/tokens/pairing-codes", body: MintPairingCodeRequestSchema, response: { kind: "json", schema: MintPairingCodeResponseSchema }, status: [200], error: err },
  hubPairPage: { scope: "hub", public: true, method: "GET", path: "/pair", response: { kind: "bytes" }, status: [200], error: err },
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
   * Retire order: the registry entry is written FIRST (status retired), the claims are released SECOND. If the release fails the
   * answer is an error saying the wolf is retired but claims remain; retrying retire is safe (it releases what is still held).
   * A retired wolf's `hubClaimWork` is 403 `forbidden`; a wolf with no registry entry is unaffected. Creating a wolf with a `status`
   * field is 400; deleting a wolf that holds claims is 409 `conflict` (retire it first).
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

/** Which wolf a wolf-scoped /v1 request belongs to (hub and workerd both use this, so both decode the thread id identically via matchRoute's decodeURIComponent): the name in `wolves/:name/*`, or the prefix of the thread id `<wolf>/<rest>`. */
export function wolfForRoute(params: Record<string, string>): string | undefined {
  if (params.name !== undefined) return params.name;
  if (params.id !== undefined) {
    const i = params.id.indexOf("/");
    return i > 0 ? params.id.slice(0, i) : undefined;
  }
  return undefined;
}
