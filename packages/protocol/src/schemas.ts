import { z } from "zod";

/** Single integer protocol version. Additive changes do not bump it; see README. */
export const PROTOCOL_VERSION = 1 as const;
export const ProtocolVersionSchema = z.literal(PROTOCOL_VERSION);

// ---------------------------------------------------------------- actor

export const ActorKindSchema = z.enum(["operator", "wolf", "system"]);
export const ActorSchema = z.object({ id: z.string().min(1), kind: ActorKindSchema });
export type Actor = z.infer<typeof ActorSchema>;

// --------------------------------------------------------------- errors

export const ErrorCodeSchema = z.enum([
  "busy",
  "not_found",
  "unauthorized",
  "version_mismatch",
  "engine_error",
  "invalid_request",
  /** The wolf's memory is inert or not loaded (fail-closed gate): memory actions have nothing to run. */
  "memory_unavailable",
  /** Promote needs KB roots and this wolf has none; consolidate still works. */
  "promote_unavailable",
  /** A promote is running; consolidate would queue behind it, so it is refused. Retry later. */
  "memory_busy",
  /** The KB routes (graph, entries, pipeline) are served by the librarian wolf: this one is not, or has no KB roots. */
  "kb_unavailable",
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ErrorEnvelopeSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean(),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

/** Stable HTTP status per error code. Clients map errors from `code`, never from status. */
export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  busy: 409,
  not_found: 404,
  unauthorized: 401,
  version_mismatch: 426,
  engine_error: 502,
  invalid_request: 400,
  memory_unavailable: 409,
  promote_unavailable: 409,
  memory_busy: 409,
  kb_unavailable: 409,
};

// ------------------------------------------------------------ resources

export const WolfStatusSchema = z.enum(["online", "offline", "busy"]);
export const WolfSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  host: z.string(),
  status: WolfStatusSchema,
  /** Additive: this wolf is the pack's librarian (serves the KB). Absent = false / not known (offline, older server). */
  librarian: z.boolean().optional(),
});
export type WolfSummary = z.infer<typeof WolfSummarySchema>;

export const ThreadKindSchema = z.enum(["home", "feature", "subagent", "process"]);
export const ThreadSummarySchema = z.object({
  id: z.string(),
  wolf: z.string(),
  kind: ThreadKindSchema,
  title: z.string(),
  boundWorkItem: z.string().optional(),
});
export type ThreadSummary = z.infer<typeof ThreadSummarySchema>;

const IsoSchema = z.iso.datetime({ offset: true });

/**
 * One tool call of an assistant message (history only; live turns carry tool-start/tool-end). Additive and optional
 * (no version bump). `args` and `result` are capped by the server (result ~4 KB, `resultTruncated` set when cut).
 */
export const ThreadToolCallSchema = z.object({
  callId: z.string(),
  name: z.string(),
  args: z.unknown(),
  /** Absent while the call has no result yet (running, or interrupted). */
  result: z.string().optional(),
  isError: z.boolean().optional(),
  resultTruncated: z.boolean().optional(),
  /** Length of the message's `text` when the call happened: interleaves tool rows with the merged text. */
  textOffset: z.number().int().nonnegative().optional(),
});
export type ThreadToolCall = z.infer<typeof ThreadToolCallSchema>;

export const ThreadMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  /** ISO timestamp. */
  at: IsoSchema,
  /** Assistant messages only: the tool calls of the (merged) rounds, in call order. Optional: old servers omit it. */
  tools: z.array(ThreadToolCallSchema).optional(),
});
export type ThreadMessage = z.infer<typeof ThreadMessageSchema>;

export const ThreadDetailSchema = ThreadSummarySchema.extend({
  messages: z.array(ThreadMessageSchema),
  /** True while a turn is streaming. */
  busy: z.boolean(),
  /** Id of the latest event emitted on this thread (0 if none). */
  lastEventId: z.number().int().nonnegative(),
});
export type ThreadDetail = z.infer<typeof ThreadDetailSchema>;

// --------------------------------------------------------------- events

/** Per-thread monotonic positive integer, minted by the serving process (the engine has none). */
export const EventIdSchema = z.number().int().positive();

/** Envelope fields every event carries, whatever its type. */
export const EventEnvelopeSchema = z.object({
  id: EventIdSchema,
  threadId: z.string(),
  at: IsoSchema,
  /** The actor that caused the event. */
  actor: ActorSchema,
  type: z.string(),
});
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

const base = EventEnvelopeSchema.omit({ type: true });
const turnId = z.string();

/** A turn in flight, as of the snapshot. */
export const InFlightPartialSchema = z.object({
  turnId: z.string(),
  text: z.string(),
  thinking: z.string().optional(),
});
export type InFlightPartial = z.infer<typeof InFlightPartialSchema>;

export const TurnStartEventSchema = base.extend({ type: z.literal("turn-start"), turnId });
export const TextDeltaEventSchema = base.extend({ type: z.literal("text-delta"), turnId, text: z.string() });
export const ThinkingDeltaEventSchema = base.extend({ type: z.literal("thinking-delta"), turnId, text: z.string() });
export const ToolStartEventSchema = base.extend({
  type: z.literal("tool-start"),
  turnId,
  callId: z.string(),
  name: z.string(),
  args: z.unknown(),
});
export const ToolUpdateEventSchema = base.extend({
  type: z.literal("tool-update"),
  turnId,
  callId: z.string(),
  output: z.string(),
});
export const ToolEndEventSchema = base.extend({
  type: z.literal("tool-end"),
  turnId,
  callId: z.string(),
  result: z.string(),
  isError: z.boolean(),
});
export const TurnEndReasonSchema = z.enum(["complete", "aborted", "error"]);
export const TurnEndEventSchema = base.extend({
  type: z.literal("turn-end"),
  turnId,
  reason: TurnEndReasonSchema,
});
export const ErrorEventSchema = base.extend({
  type: z.literal("error"),
  turnId: turnId.optional(),
  message: z.string(),
});
/**
 * Baseline thread state. A consumer that receives one discards everything it
 * holds for the thread and rebuilds from `thread` (+ `inFlight`); events with
 * id <= upToId are superseded. Servers may send one at any time (stale resume).
 */
export const SnapshotEventSchema = base.extend({
  type: z.literal("snapshot"),
  upToId: z.number().int().nonnegative(),
  thread: ThreadDetailSchema,
  inFlight: InFlightPartialSchema.optional(),
});

export const ThreadEventSchema = z.discriminatedUnion("type", [
  TurnStartEventSchema,
  TextDeltaEventSchema,
  ThinkingDeltaEventSchema,
  ToolStartEventSchema,
  ToolUpdateEventSchema,
  ToolEndEventSchema,
  TurnEndEventSchema,
  ErrorEventSchema,
  SnapshotEventSchema,
]);
export type ThreadEvent = z.infer<typeof ThreadEventSchema>;
export type ThreadEventType = ThreadEvent["type"];

/** An envelope-valid event of a type this version does not know. Ignore it. */
export interface UnknownThreadEvent {
  envelope: EventEnvelope;
  raw: unknown;
}

export type ParsedThreadEvent =
  | { kind: "event"; event: ThreadEvent }
  | { kind: "unknown"; event: UnknownThreadEvent }
  | { kind: "invalid"; error: z.ZodError };

const KNOWN_TYPES: ReadonlySet<string> = new Set(ThreadEventSchema.options.map((o) => o.shape.type.value));

/**
 * The ignore-unknown contract. Known type -> fully validated event. Unknown
 * type with a valid envelope -> `unknown` (consumers skip it, never throw).
 * Malformed envelope, or a known type with a bad payload -> `invalid`.
 */
export function parseThreadEvent(input: unknown): ParsedThreadEvent {
  const env = EventEnvelopeSchema.safeParse(input);
  if (!env.success) return { kind: "invalid", error: env.error };
  if (!KNOWN_TYPES.has(env.data.type)) return { kind: "unknown", event: { envelope: env.data, raw: input } };
  const ev = ThreadEventSchema.safeParse(input);
  return ev.success ? { kind: "event", event: ev.data } : { kind: "invalid", error: ev.error };
}

// ------------------------------------------------------- memory events

/**
 * What a memory event is about: a den topic, a session topic (consolidated, not yet promoted), or a work item
 * (+ feature) whose Record the observations feed. `topicId` is absent while it is not known yet (an observation
 * only lands in a pool).
 */
export const MemoryTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("den"), topicId: z.string().optional() }),
  z.object({ kind: z.literal("session"), topicId: z.string().optional() }),
  z.object({ kind: z.literal("work"), workId: z.string(), featureId: z.string().optional() }),
]);
export type MemoryTarget = z.infer<typeof MemoryTargetSchema>;

/**
 * Fields every MemoryEvent carries. Wolf-scoped, so it is NOT a ThreadEvent (no per-thread `id`); `threadId` is
 * present only when the event came out of a conversation. Payloads are metadata only: ids, counts and a one-line
 * summary, never the observation text itself.
 */
const memoryBase = z.object({
  wolf: z.string(),
  threadId: z.string().optional(),
  /** The durable conversation the event came out of (observations); absent for pool-level steps (consolidate, promote). */
  conversationId: z.number().int().optional(),
  timestamp: IsoSchema,
  domain: z.string(),
  target: MemoryTargetSchema,
});

export const ObservationCapturedEventSchema = memoryBase.extend({
  type: z.literal("observation_captured"),
  count: z.number().int().nonnegative(),
  /** One line (first line of the first observation, capped at 120 chars). */
  summary: z.string(),
});
export const TopicConsolidatedEventSchema = memoryBase.extend({
  type: z.literal("topic_consolidated"),
  topicId: z.string(),
  /** Observations in the consolidation batch this topic came out of. */
  observationCount: z.number().int().nonnegative(),
  change: z.enum(["create", "merge"]),
});
export const ContributionEmittedEventSchema = memoryBase.extend({
  type: z.literal("contribution_emitted"),
  contributionId: z.string(),
  /** The KB inbox lane the contribution was written to, e.g. `inbox/<wolf>`. */
  lane: z.string(),
});
export const PromoteStartedEventSchema = memoryBase.extend({ type: z.literal("promote_started"), jobId: z.string() });
export const PromoteFinishedEventSchema = memoryBase.extend({
  type: z.literal("promote_finished"),
  jobId: z.string(),
  consolidated: z.number().int().nonnegative(),
  contributions: z.number().int().nonnegative(),
  /** Topics whose distill failed and stay pending for the next promote (absent = 0). */
  pending: z.number().int().positive().optional(),
});
export const PromoteFailedEventSchema = memoryBase.extend({
  type: z.literal("promote_failed"),
  jobId: z.string(),
  /** One line, capped. */
  message: z.string(),
});

/** A bound consolidate folded observations into the work item's Record (target = the work item). */
export const RecordWrittenEventSchema = memoryBase.extend({
  type: z.literal("record_written"),
  /** Observations folded into the Record by this write. */
  observationCount: z.number().int().nonnegative(),
  /** Size of the Record body after the write, when known. */
  chars: z.number().int().nonnegative().optional(),
});
/** A den topic left the den: absorbed into a KB entry's lane or rejected (target = the den topic). */
export const TopicArchivedEventSchema = memoryBase.extend({
  type: z.literal("topic_archived"),
  topicId: z.string(),
  /** The KB entry id the topic was absorbed into; absent for rejects. */
  absorbedInto: z.string().optional(),
});
/** Librarian: a sweep began real work (never emitted for an idle tick). `domain` is "kb", `target` {kind:"den"}. */
export const SweepStartedEventSchema = memoryBase.extend({ type: z.literal("sweep_started"), pending: z.number().int().nonnegative() });
export const SweepOutcomeSchema = z.enum(["create", "merge", "reject", "parked"]);
export type SweepOutcome = z.infer<typeof SweepOutcomeSchema>;
/** Librarian: one contribution ended. `unclassified` receipts get no sweep_item (pipeline receipts only). */
export const SweepItemEventSchema = memoryBase.extend({
  type: z.literal("sweep_item"),
  /** The contributing wolf (the inbox lane). */
  from: z.string(),
  denTopicId: z.string(),
  outcome: SweepOutcomeSchema,
  /** The resulting entry (create / merge). */
  entryId: z.string().optional(),
});
/** Librarian: a sweep that emitted sweep_started ended (always paired, also on failure). */
export const SweepFinishedEventSchema = memoryBase.extend({
  type: z.literal("sweep_finished"),
  processed: z.number().int().nonnegative(),
  created: z.number().int().nonnegative(),
  merged: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  parked: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  /** One line, capped; set when the run threw. */
  error: z.string().optional(),
});

export const MemoryEventSchema = z.discriminatedUnion("type", [
  ObservationCapturedEventSchema,
  TopicConsolidatedEventSchema,
  ContributionEmittedEventSchema,
  PromoteStartedEventSchema,
  PromoteFinishedEventSchema,
  PromoteFailedEventSchema,
  RecordWrittenEventSchema,
  TopicArchivedEventSchema,
  SweepStartedEventSchema,
  SweepItemEventSchema,
  SweepFinishedEventSchema,
]);
export type MemoryEvent = z.infer<typeof MemoryEventSchema>;
export type MemoryEventType = MemoryEvent["type"];

/** A MemoryEvent of a type this version does not know (envelope fields valid). Ignore it. */
export type ParsedMemoryEvent =
  | { kind: "event"; event: MemoryEvent }
  | { kind: "unknown"; raw: unknown }
  | { kind: "invalid"; error: z.ZodError };

const MEMORY_TYPES: ReadonlySet<string> = new Set(MemoryEventSchema.options.map((o) => o.shape.type.value));
const MemoryEnvelopeSchema = z.object({ type: z.string() });

/** Same ignore-unknown contract as parseThreadEvent: unknown `type` -> `unknown`; known type, bad payload -> `invalid`. */
export function parseMemoryEvent(input: unknown): ParsedMemoryEvent {
  const env = MemoryEnvelopeSchema.safeParse(input);
  if (!env.success) return { kind: "invalid", error: env.error };
  if (!MEMORY_TYPES.has(env.data.type)) return { kind: "unknown", raw: input };
  const ev = MemoryEventSchema.safeParse(input);
  return ev.success ? { kind: "event", event: ev.data } : { kind: "invalid", error: ev.error };
}

// ------------------------------------------------------- memory actions

/** Result of `POST /v1/wolves/:name/memory/consolidate`: counts only, never observation text or topic bodies. */
export const ConsolidateResponseSchema = z.object({
  observationsProcessed: z.number().int().nonnegative(),
  topicsCreated: z.number().int().nonnegative(),
  topicsMerged: z.number().int().nonnegative(),
  topicsSkipped: z.number().int().nonnegative(),
  claimsSubmitted: z.number().int().nonnegative(),
  /** Work Records rewritten from tagged observations. */
  recordsWritten: z.number().int().nonnegative().optional(),
  /** Tagged observations left in the pool (the Work API or model was unavailable). */
  observationsPending: z.number().int().nonnegative().optional(),
  /** Ids of the session topics created or merged by this run. */
  topicIds: z.array(z.string()),
});
export type ConsolidateResponse = z.infer<typeof ConsolidateResponseSchema>;

/**
 * Result of `POST /v1/wolves/:name/memory/promote`. The job runs in the background; its outcome is reported as
 * `promote_finished` / `promote_failed` MemoryEvents carrying the same `jobId`. `already_running` (HTTP 409) names
 * the job in flight and starts nothing (HTTP 202 as well: every non-2xx is an ErrorEnvelope).
 */
export const PromoteResponseSchema = z.object({
  jobId: z.string(),
  status: z.enum(["started", "already_running"]),
});
export type PromoteResponse = z.infer<typeof PromoteResponseSchema>;

// -------------------------------------------------- memory read resources

/** `live`/`sandbox`: running (against the live roots / a dev-root snapshot). `inert`: loaded but gated off. `off`: not loaded or disabled. */
export const MemoryStateSchema = z.enum(["live", "sandbox", "inert", "off"]);
export type MemoryState = z.infer<typeof MemoryStateSchema>;

/** A den or session topic in a listing: metadata only (the body comes from the topic resource). */
export const MemoryTopicRefSchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  /** Frontmatter `updated` as written ("" when the file has none). */
  updated: z.string(),
  domain: z.string().optional(),
});
export type MemoryTopicRef = z.infer<typeof MemoryTopicRefSchema>;

export const MemoryPoolStatusSchema = z.object({
  /** Observations waiting in the pool. */
  count: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  /** Pool tokens at which consolidation runs. */
  consolidateAtTokens: z.number().int().nonnegative(),
  /** Pool tokens a consolidation leaves behind. */
  poolTarget: z.number().int().nonnegative(),
  trigger: z.enum(["threshold", "timer", "hybrid", "manual"]),
});
export type MemoryPoolStatus = z.infer<typeof MemoryPoolStatusSchema>;

/** The last promote this wolfd saw finish or fail (tracked in memory from its event bus: null after a restart). */
export const LastPromoteSchema = z.object({
  jobId: z.string(),
  at: IsoSchema,
  result: z.enum(["finished", "failed"]),
  consolidated: z.number().int().nonnegative().optional(),
  contributions: z.number().int().nonnegative().optional(),
  /** One line; present when `result` is failed. */
  message: z.string().optional(),
});
export type LastPromote = z.infer<typeof LastPromoteSchema>;

/** The work item a thread (its conversation family) is bound to. Title and kind are best effort (the Work API may be down). */
export const BoundWorkSchema = z.object({ workId: z.string(), title: z.string().optional(), kind: z.string().optional() });
export type BoundWork = z.infer<typeof BoundWorkSchema>;

/** `GET /v1/wolves/:name/memory`. When state is `inert`/`off` the pool is null and the lists are empty. */
export const MemoryStatusSchema = z.object({
  state: MemoryStateSchema,
  /** One line saying why memory is in this state. */
  reason: z.string(),
  pool: MemoryPoolStatusSchema.nullable(),
  sessionTopics: z.array(MemoryTopicRefSchema),
  denTopics: z.array(MemoryTopicRefSchema),
  lastPromote: LastPromoteSchema.nullable(),
  /** `?thread=<id>`: that thread's bound work item; without it the home thread's. null = unbound. Absent on older servers. */
  bound: BoundWorkSchema.nullable().optional(),
});
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>;

/** `GET /v1/wolves/:name/memory/topics/:id`: one topic with its body. `scope` says which store it came from. */
export const MemoryTopicSchema = MemoryTopicRefSchema.extend({
  scope: z.enum(["den", "session"]),
  body: z.string(),
  /** Den topics only. */
  related: z.array(z.string()).optional(),
  /** Den topics only: false = held back as private working memory, never emitted to the KB. */
  promotable: z.boolean().optional(),
});
export type MemoryTopic = z.infer<typeof MemoryTopicSchema>;

/** One child of a feature, as much as a task graph needs. */
export const WorkChildSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.string(),
  stage: z.string(),
  dependsOn: z.array(z.string()),
});
export type WorkChild = z.infer<typeof WorkChildSchema>;

/**
 * `GET /v1/wolves/:name/work/:id/record`: a work item's page data through the wolf's Work API client.
 * `plan` is the working document without its `## Record` section and the generated `## Log`; `record` is the
 * Record section's text (heading stripped), "" when the item has none.
 */
export const WorkRecordResponseSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.string(),
  stage: z.string(),
  domain: z.string().optional(),
  partOf: z.string().nullable().optional(),
  dependsOn: z.array(z.string()).optional(),
  /** A holding container (a domain's Inbox). Only present when true. */
  container: z.boolean().optional(),
  /** The item's `successCriteria` frontmatter (the done-condition; may hold markdown bullets). Omitted when it has none. */
  successCriteria: z.string().optional(),
  plan: z.string(),
  record: z.string(),
  /** The item's `updated` date as the Work API reports it (YYYY-MM-DD). */
  updated: z.string().optional(),
  /** Features only: the items directly under it. Omitted when the Work API could not list them (best effort). */
  children: z.array(WorkChildSchema).optional(),
  /** Set (true) when the feature has more children than the cap and `children` was cut. */
  childrenTruncated: z.boolean().optional(),
  /** Holding containers only: how many items sit under it (no list is sent). */
  childCount: z.number().int().optional(),
});
export type WorkRecordResponse = z.infer<typeof WorkRecordResponseSchema>;

// ------------------------------------------------------------ KB graph

export const KbNodeKindSchema = z.enum(["domain", "section", "entry", "work", "den-topic"]);
export type KbNodeKind = z.infer<typeof KbNodeKindSchema>;

/** One node. `id` is `dom:<domain>` | `sec:<sectionId>` | `ent:<entryId>` | `work:<workId>` | `den:<wolf>:<topicId>`. `depth` by kind: domain 0, section 1, entry 2, work 3, den topic 4. */
export const KbGraphNodeSchema = z.object({
  id: z.string(),
  kind: KbNodeKindSchema,
  label: z.string(),
  depth: z.number().int().min(0).max(4),
  domain: z.string().optional(),
  sectionId: z.string().optional(),
  summary: z.string().optional(),
  currency: z.string().optional(),
  entryKind: z.string().optional(),
  maturity: z.string().optional(),
  authority: z.string().optional(),
  workKind: z.string().optional(),
  stage: z.string().optional(),
  assignee: z.string().optional(),
  wolf: z.string().optional(),
  promotable: z.boolean().optional(),
  updated: z.string().optional(),
});
export type KbGraphNode = z.infer<typeof KbGraphNodeSchema>;

export const KbEdgeKindSchema = z.enum(["hierarchy", "partOf", "dependsOn", "related", "wikilink"]);
export type KbEdgeKind = z.infer<typeof KbEdgeKindSchema>;

export const KbGraphEdgeSchema = z.object({
  source: z.string(),
  target: z.string(),
  kind: KbEdgeKindSchema,
  /** `related` only: the relation kind (see_also, refines, ...), or `work` for a den topic's work link. */
  relation: z.string().optional(),
});
export type KbGraphEdge = z.infer<typeof KbGraphEdgeSchema>;

export const KbGraphSchema = z.object({
  nodes: z.array(KbGraphNodeSchema),
  edges: z.array(KbGraphEdgeSchema),
  layers: z.object({ archivedWork: z.boolean(), wikilinks: z.boolean(), denTopics: z.boolean() }),
  /** The domain filter as applied; null = all. */
  domain: z.string().nullable(),
  domains: z.array(z.object({ name: z.string(), label: z.string(), color: z.string().optional() })),
  generated: IsoSchema,
});
export type KbGraph = z.infer<typeof KbGraphSchema>;

export const KbEntryDetailSchema = z.object({
  id: z.string(),
  title: z.string(),
  domain: z.string(),
  frontmatter: z.record(z.string(), z.unknown()),
  body: z.string(),
  wikilinks: z.array(z.object({ target: z.string(), exists: z.boolean() })),
  backlinks: z.array(z.object({ id: z.string(), title: z.string(), via: z.enum(["wikilink", "related"]), relation: z.string().optional() })),
});
export type KbEntryDetail = z.infer<typeof KbEntryDetailSchema>;

// ------------------------------------------------------------- commands

export const WhenBusySchema = z.enum(["steer", "followUp", "reject"]);
export type WhenBusy = z.infer<typeof WhenBusySchema>;

/** `whenBusy` is required on the wire: absent -> invalid_request. SDKs may default it; the wire may not. */
export const SubmitRequestSchema = z.object({
  threadId: z.string(),
  input: z.string(),
  whenBusy: WhenBusySchema,
});
export type SubmitRequest = z.infer<typeof SubmitRequestSchema>;

export const SubmitAckSchema = z.object({
  /** Id of the user message created by this submit. */
  messageId: z.string(),
  disposition: z.enum(["started", "steered", "queued"]),
});
export type SubmitAck = z.infer<typeof SubmitAckSchema>;

/** Ends the running turn; the stream finishes with turn-end (reason "aborted"). */
export const AbortRequestSchema = z.object({ threadId: z.string() });
export type AbortRequest = z.infer<typeof AbortRequestSchema>;

/**
 * Create a thread. Idempotent for "home": if the wolf already has a home
 * thread it is returned unchanged (never a second one). v1 supports only "home".
 */
export const CreateThreadRequestSchema = z.object({ wolf: z.string(), kind: z.literal("home") });
export type CreateThreadRequest = z.infer<typeof CreateThreadRequestSchema>;
/** Response of create thread. */
export const CreateThreadResponseSchema = ThreadSummarySchema;

// ------------------------------------------------------- KB pipeline

/** An outcome as receipts spell it after normalising (`created`/`updated`/`rejected` -> create/merge/reject). */
export const PipelineOutcomeSchema = z.enum(["create", "merge", "reject", "parked", "unclassified"]);
export type PipelineOutcome = z.infer<typeof PipelineOutcomeSchema>;

/** One wolf's inbox lane. */
export const PipelineLaneSchema = z.object({
  wolf: z.string(),
  /** Contributions waiting (top-level .md files; `_processed` and `_bad` are not counted). */
  pending: z.number().int().nonnegative(),
  /** Age of the longest-waiting one, ms. Absent when the lane is empty. */
  oldestAgeMs: z.number().int().nonnegative().optional(),
});
export const PipelineReceiptSchema = z.object({
  wolf: z.string(),
  denTopicId: z.string(),
  outcome: PipelineOutcomeSchema,
  /** The resulting entry (create / merge). */
  entryId: z.string().optional(),
  /** Receipt time (ISO). */
  processed: z.string(),
  /** One line of the receipt body (reason for reject / parked / unclassified), capped. */
  detail: z.string().optional(),
});
export const PipelineParkedSchema = z.object({
  wolf: z.string(),
  file: z.string(),
  denTopicId: z.string().optional(),
  /** Why it was parked (from its receipt), when known. */
  reason: z.string().optional(),
});
/** The last finished sweep (persisted to `<den>/kb/sweep-last.json`). */
export const PipelineLastSweepSchema = z.object({
  startedAt: z.string(),
  finishedAt: z.string(),
  processed: z.number().int().nonnegative(),
  created: z.number().int().nonnegative(),
  merged: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  parked: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  error: z.string().optional(),
});
export type PipelineLastSweep = z.infer<typeof PipelineLastSweepSchema>;
export const PipelineCurrentSchema = z.object({
  from: z.string(),
  denTopicId: z.string(),
  startedAt: z.string(),
  route: z.string().optional(),
});

/** `GET /v1/wolves/:name/kb/pipeline` (librarian only; 409 `kb_unavailable` otherwise). */
export const KbPipelineResponseSchema = z.object({
  lanes: z.array(PipelineLaneSchema),
  /** Newest first, at most 50. */
  receipts: z.array(PipelineReceiptSchema),
  /** At most 100; `parkedTotal` counts them all. */
  parked: z.array(PipelineParkedSchema),
  /** All parked items (absent from servers that predate it). */
  parkedTotal: z.number().int().nonnegative().optional(),
  sweep: z.object({
    /** The item being processed right now (absent when idle). */
    current: PipelineCurrentSchema.optional(),
    last: PipelineLastSweepSchema.optional(),
  }),
});
export type KbPipelineResponse = z.infer<typeof KbPipelineResponseSchema>;
export type PipelineLane = z.infer<typeof PipelineLaneSchema>;
export type PipelineReceipt = z.infer<typeof PipelineReceiptSchema>;
export type PipelineParked = z.infer<typeof PipelineParkedSchema>;
export type PipelineCurrent = z.infer<typeof PipelineCurrentSchema>;
