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
};

// ------------------------------------------------------------ resources

export const WolfStatusSchema = z.enum(["online", "offline", "busy"]);
export const WolfSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  host: z.string(),
  status: WolfStatusSchema,
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

export const ThreadMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  /** ISO timestamp. */
  at: IsoSchema,
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

export const MemoryEventSchema = z.discriminatedUnion("type", [
  ObservationCapturedEventSchema,
  TopicConsolidatedEventSchema,
  ContributionEmittedEventSchema,
  PromoteStartedEventSchema,
  PromoteFinishedEventSchema,
  PromoteFailedEventSchema,
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
 * the job in flight and starts nothing.
 */
export const PromoteResponseSchema = z.object({
  jobId: z.string(),
  status: z.enum(["started", "already_running"]),
});
export type PromoteResponse = z.infer<typeof PromoteResponseSchema>;

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
