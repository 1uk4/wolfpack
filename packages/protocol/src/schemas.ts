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

// ---------------------------------------------------------------- cards

/**
 * Interaction cards: a wolf's question to the operator, raised by a tool (the model-facing `ask_user_question` or a
 * tool such as `task_done`). A card holds one or more fields; the shape extends `ask_user_question`
 * (question / options / free text). Additive: no version bump.
 *
 * Field kinds: `free-text`, `single`, `multi` (checkboxes, answer string[]) and `confirm` (yes/no, answer boolean).
 * `default` only pre-selects in the UI, it is never auto-submitted (cards wait indefinitely; there is no timeout).
 */
export const CardOptionSchema = z.object({
  label: z.string(),
  /** Machine-readable value returned when picked. Defaults to the label. */
  value: z.string(),
  description: z.string().optional(),
});
export type CardOption = z.infer<typeof CardOptionSchema>;

/**
 * A field shown only while an earlier field's answer matches: `equals` compares a single/free-text value or a confirm
 * boolean; `oneOf` matches any of several single values. Exactly one of the two. A hidden field is neither shown nor
 * required, and any answer it carries is rejected.
 */
export const FieldShowIfSchema = z
  .object({
    /** Id of the controlling field; it must be declared earlier in the card. */
    field: z.string().min(1),
    equals: z.union([z.string(), z.boolean()]).optional(),
    oneOf: z.array(z.string()).min(1).optional(),
  })
  .refine((s) => (s.equals === undefined) !== (s.oneOf === undefined), { message: "showIf needs exactly one of equals / oneOf" });
export type FieldShowIf = z.infer<typeof FieldShowIfSchema>;

const cardFieldBase = z.object({
  /** Unique within the card; keys the answer. */
  id: z.string().min(1),
  label: z.string(),
  /** Extra context shown under the label. */
  description: z.string().optional(),
  /** Conditional visibility (stepped/dependent cards); absent = always shown. */
  showIf: FieldShowIfSchema.optional(),
  /**
   * The operator may leave it blank. Default (absent) = required. A skipped optional field is submitted empty
   * (free-text/single `{value: ""}`, multi `{value: []}`, confirm: no answer) and the wolf is told it was skipped;
   * an answer that is given is validated normally (a multi's min/max still apply once something is picked).
   */
  optional: z.boolean().optional(),
});
export const FreeTextFieldSchema = cardFieldBase.extend({
  kind: z.literal("free-text"),
  default: z.string().optional(),
});
export const SingleFieldSchema = cardFieldBase.extend({
  kind: z.literal("single"),
  options: z.array(CardOptionSchema).min(1),
  /** Offer an "Other" free-text entry beside the options (the `ask_user_question` behaviour). Default true. */
  allowOther: z.boolean().optional(),
  /** An option `value` to pre-select. */
  default: z.string().optional(),
});
export const MultiFieldSchema = cardFieldBase.extend({
  kind: z.literal("multi"),
  options: z.array(CardOptionSchema).min(1),
  /** Offer custom entries beside the options. Default false (unlike `single`): a multi answer is a subset of the options. */
  allowOther: z.boolean().optional(),
  /** Option values to pre-select. */
  default: z.array(z.string()).optional(),
  /** Bounds on the number of picked entries (options and custom ones together). A required multi needs at least one pick regardless; optional: true allows blank. */
  min: z.number().int().min(0).optional(),
  max: z.number().int().min(1).optional(),
});
export const ConfirmFieldSchema = cardFieldBase.extend({
  kind: z.literal("confirm"),
  /** Button labels; default "Yes" / "No". */
  confirmLabel: z.string().optional(),
  rejectLabel: z.string().optional(),
  /** Pre-selects confirm (true) or reject (false); the operator still has to submit. */
  default: z.boolean().optional(),
});
export const CardFieldSchema = z.discriminatedUnion("kind", [FreeTextFieldSchema, SingleFieldSchema, MultiFieldSchema, ConfirmFieldSchema]);
export type CardField = z.infer<typeof CardFieldSchema>;
export type CardFieldKind = CardField["kind"];

export const CardStepSchema = z.object({
  title: z.string().optional(),
  /** Field ids shown on this step, in order. */
  fields: z.array(z.string().min(1)).min(1),
});
export type CardStep = z.infer<typeof CardStepSchema>;

/** Why a field's showIf cannot work against its controller (undefined = fine). Shared with the ask_user_question builder. */
export function showIfProblem(f: { id: string; showIf?: FieldShowIf }, fields: readonly CardField[]): string | undefined {
  const s = f.showIf;
  if (!s) return undefined;
  const ctl = fields.find((x) => x.id === s.field);
  if (!ctl || ctl.id === f.id) return `showIf.field "${s.field}" is not another field of this card`;
  if (ctl.kind === "confirm") return typeof s.equals === "boolean" && s.oneOf === undefined ? undefined : `showIf on confirm field "${ctl.id}" needs a boolean \`equals\``;
  if (ctl.kind === "single") {
    const values = ctl.options.map((o) => o.value);
    const wanted = s.oneOf ?? (typeof s.equals === "string" ? [s.equals] : []);
    if (wanted.length === 0) return `showIf on single field "${ctl.id}" needs a string \`equals\` or a non-empty \`oneOf\``;
    const bad = wanted.find((w) => !values.includes(w));
    return bad === undefined ? undefined : `showIf value "${bad}" is not an option of "${ctl.id}"`;
  }
  return `field "${ctl.id}" (${ctl.kind}) cannot control another field`;
}

export const CardSchema = z
  .object({
    /** Tool that raised it, e.g. `ask_user_question`. Keys the console's card renderer. */
    tool: z.string(),
    title: z.string().optional(),
    fields: z.array(CardFieldSchema).min(1),
    /**
     * Optional stepped presentation: the fields grouped into ordered steps (every field in exactly one step; a step
     * whose fields are all hidden by `showIf` is skipped). The answer is still ONE submission for the whole card.
     * Absent = a single-page form.
     */
    steps: z.array(CardStepSchema).min(1).optional(),
  })
  .refine((c) => new Set(c.fields.map((f) => f.id)).size === c.fields.length, { message: "field ids must be unique within a card", path: ["fields"] })
  .refine(
    (c) => {
      const seen = new Set<string>();
      return c.fields.every((f) => {
        const ok = f.showIf === undefined || (seen.has(f.showIf.field) && f.showIf.field !== f.id);
        seen.add(f.id);
        return ok;
      });
    },
    { message: "a field's showIf must reference a field declared before it", path: ["fields"] },
  )
  .refine(
    (c) => {
      // Steps partition the fields in card order (so a dependent field's step is never before its controller's).
      if (!c.steps) return true;
      const ids = c.steps.flatMap((s) => s.fields);
      return ids.length === c.fields.length && ids.every((id, i) => id === c.fields[i].id);
    },
    { message: "steps must list every field exactly once, in the card's field order", path: ["steps"] },
  )
  .refine(
    (c) => c.fields.every((f) => showIfProblem(f, c.fields) === undefined),
    { message: "a showIf does not fit its controlling field (confirm: boolean equals; single: option values; other kinds cannot control)", path: ["fields"] },
  )
  .refine((c) => c.fields.every((f) => f.kind !== "single" || f.default === undefined || f.options.some((o) => o.value === f.default)), {
    message: "a single field's default must be one of its option values",
    path: ["fields"],
  })
  .refine((c) => c.fields.every((f) => f.kind !== "multi" || (f.default ?? []).every((d) => f.options.some((o) => o.value === d))), {
    message: "a multi field's default must be a subset of its option values",
    path: ["fields"],
  })
  .refine((c) => c.fields.every((f) => f.kind !== "multi" || new Set(f.default ?? []).size === (f.default ?? []).length), {
    message: "a multi field's default must not repeat a value",
    path: ["fields"],
  })
  .refine((c) => c.fields.every((f) => f.kind !== "multi" || (f.min ?? 0) <= (f.max ?? Infinity)), {
    message: "a multi field's min must not exceed its max",
    path: ["fields"],
  })
  .refine((c) => c.fields.every((f) => f.kind !== "multi" || f.allowOther === true || (f.min ?? 0) <= f.options.length), {
    message: "a multi field's min exceeds its number of options (and allowOther is not set), so it can never be satisfied",
    path: ["fields"],
  })
  .refine((c) => c.fields.every((f) => f.kind !== "multi" || f.default === undefined || (f.default.length >= (f.min ?? 0) && f.default.length <= (f.max ?? Infinity))), {
    message: "a multi field's default must respect its min and max",
    path: ["fields"],
  });
export type Card = z.infer<typeof CardSchema>;

/** Whether the answers so far satisfy a field's `showIf` (always true without one). */
export function fieldVisible(field: CardField, answers: Readonly<Record<string, { value: unknown } | undefined>>): boolean {
  const s = field.showIf;
  if (!s) return true;
  const v = answers[s.field]?.value;
  if (s.equals !== undefined) return v === s.equals;
  return typeof v === "string" && (s.oneOf ?? []).includes(v);
}

/**
 * The fields in play for these answers: a field is hidden when its `showIf` fails OR its controlling field is itself
 * hidden (so a chain collapses with its root).
 */
export function visibleFields(card: Card, answers: Readonly<Record<string, { value: unknown } | undefined>>): CardField[] {
  const shown = new Set<string>();
  const out: CardField[] = [];
  for (const f of card.fields) {
    if (f.showIf && !shown.has(f.showIf.field)) continue;
    if (!fieldVisible(f, answers)) continue;
    shown.add(f.id);
    out.push(f);
  }
  return out;
}

/**
 * One answered field; the `value` type follows the field kind.
 * - free-text / single: `value` is the text or option value; `other` is true when the operator typed an answer instead
 *   of picking an option (`single` with allowOther).
 * - multi: `value` lists the picked option values plus any custom entries; `other` names the custom entries (a subset
 *   of `value`).
 * - confirm: `value` is true (confirm) or false (reject), with an optional `note`.
 */
export const TextFieldAnswerSchema = z.object({ value: z.string(), other: z.boolean().optional() });
export const MultiFieldAnswerSchema = z.object({ value: z.array(z.string()), other: z.array(z.string()).optional() });
export const ConfirmFieldAnswerSchema = z.object({ value: z.boolean(), note: z.string().optional() });
export const CardFieldAnswerSchema = z.union([TextFieldAnswerSchema, MultiFieldAnswerSchema, ConfirmFieldAnswerSchema]);
export type TextFieldAnswer = z.infer<typeof TextFieldAnswerSchema>;
export type MultiFieldAnswer = z.infer<typeof MultiFieldAnswerSchema>;
export type ConfirmFieldAnswer = z.infer<typeof ConfirmFieldAnswerSchema>;
export type CardFieldAnswer = z.infer<typeof CardFieldAnswerSchema>;
/** Answers keyed by field id. */
export const CardAnswersSchema = z.record(z.string(), CardFieldAnswerSchema);
export type CardAnswers = z.infer<typeof CardAnswersSchema>;

/**
 * How a card closed: `answered` (the operator submitted answers), `skipped` (the operator dismissed it explicitly; the
 * agent was told), `superseded` (a plain chat message replaced it; the agent was told).
 */
export const CardClosedSchema = z.enum(["answered", "skipped", "superseded"]);
export type CardClosed = z.infer<typeof CardClosedSchema>;

/** A card waiting for the operator. `callId` is the tool call that raised it and identifies it in the answer command. */
export const PendingCardSchema = z.object({
  callId: z.string(),
  threadId: z.string(),
  card: CardSchema,
  /**
   * The answer already given while sibling cards of the same turn still wait (held, not yet submitted). The card is
   * still pending: it can be answered again to change it until the last sibling is answered.
   */
  heldAnswer: CardAnswersSchema.optional(),
  /** The operator skipped this card while sibling cards still wait (held, changeable like a held answer). */
  heldSkip: z.boolean().optional(),
  /** ISO time the card was raised (the tool call's result time). */
  raisedAt: z.iso.datetime({ offset: true }),
});
export type PendingCard = z.infer<typeof PendingCardSchema>;

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
/** `needs-you`: no turn is running and at least one card waits for the operator's answer. */
export const ThreadStatusSchema = z.enum(["idle", "busy", "needs-you"]);
export type ThreadStatus = z.infer<typeof ThreadStatusSchema>;
/**
 * A subagent's lifecycle: `queued` (waiting for a slot), `running` (a turn is in flight), `waiting` (it asked its parent
 * a question and waits for the answer), `done`, `failed` (its turn ended in an error), `stopped` (cancelled).
 */
export const SubagentStateSchema = z.enum(["queued", "running", "waiting", "done", "failed", "stopped"]);
export type SubagentState = z.infer<typeof SubagentStateSchema>;
export const ThreadSummarySchema = z.object({
  id: z.string(),
  wolf: z.string(),
  kind: ThreadKindSchema,
  title: z.string(),
  boundWorkItem: z.string().optional(),
  /** Additive: absent on servers that predate cards (treat as idle/busy from `ThreadDetail.busy`). */
  status: ThreadStatusSchema.optional(),
  /** Additive: the thread that spawned this one (subagent threads only). */
  parentThreadId: z.string().optional(),
  /** Additive, subagent threads only from here on. The agent profile it runs. */
  agent: z.string().optional(),
  state: SubagentStateSchema.optional(),
  /** 1-based place in the queue while `state` is `queued`. */
  queuePosition: z.number().int().positive().optional(),
  startedAt: z.iso.datetime({ offset: true }).optional(),
  /** Set once the child is done, failed or stopped; cleared when it is resumed. */
  finishedAt: z.iso.datetime({ offset: true }).optional(),
  /** What it is doing now (the tool it last started), for the status strip. */
  step: z.string().optional(),
  /** Tokens used so far (input + output, all turns). */
  tokens: z.number().int().nonnegative().optional(),
  /** The work item (task) this child serves: named in its brief, else the one its parent is bound to. */
  taskId: z.string().optional(),
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
  /** A card-raising call: the card it raised. */
  card: CardSchema.optional(),
  /** The operator's answer to that card (absent while it is pending). The `result` then carries the answer text. */
  answer: CardAnswersSchema.optional(),
  /**
   * The card closed without an answer (skipped by the operator, or superseded by a plain submit): no longer answerable.
   * Kept `true` for both so older clients still show it closed; `closed` tells the two apart.
   */
  dismissed: z.boolean().optional(),
  /** Additive: how the card closed. Absent while pending (and on servers that predate it: read `answer` / `dismissed`). */
  closed: CardClosedSchema.optional(),
  /** Length of the message's `text` when the call happened: interleaves tool rows with the merged text. */
  textOffset: z.number().int().nonnegative().optional(),
});
export type ThreadToolCall = z.infer<typeof ThreadToolCallSchema>;

// -------------------------------------------------------- structured objects

import { CHECKLIST_STATES, GRAPH_LIMITS, GRAPH_NODE_STATUSES, graphProblem, parseObjectData, type KnownObjectType, type ObjectToolName } from "./objects.js";
export * from "./objects.js";

/**
 * A structured object a wolf puts in a thread (decision now; checklist and graph later). Generic envelope: `type`
 * is an open string and `data` is validated per type by the consumer (see `parseObjectData`), so a new object type
 * is one more entry in `OBJECT_DATA_SCHEMAS` and never a protocol change. Additive (no version bump).
 */
export const ThreadObjectSchema = z.object({
  objectId: z.string().min(1),
  type: z.string(),
  /** 1 for the first upsert of `objectId` in the thread, +1 per revision. */
  rev: z.number().int().positive(),
  data: z.unknown(),
  /** History only: ordinal (1-based, per thread) of this object's LATEST upsert; orders objects by recency across reloads. */
  seq: z.number().int().positive().optional(),
  /** History only: length of the message's `text` when the object first appeared (interleaves it with the text). */
  textOffset: z.number().int().nonnegative().optional(),
});
export type ThreadObject = z.infer<typeof ThreadObjectSchema>;

export const DecisionOptionSchema = z.object({
  id: z.string().min(1).describe("Short stable id of the option"),
  label: z.string().min(1).describe("The option, in a few words"),
  detail: z.string().optional().describe("Optional one-line elaboration"),
});

/** `data` of a `decision` object: the options weighed, the one chosen and why. Validate with `parseObjectData`. */
export const DecisionDataSchema = z.object({
  title: z.string().optional().describe("What is being decided"),
  options: z.array(DecisionOptionSchema).min(1).describe("The options considered"),
  chosen: z.string().describe("The id of the chosen option (one of the option ids)"),
  rationale: z.string().describe("Why the chosen option won"),
});

/** Parameters of the `show_decision` tool: the decision plus the wolf-chosen id (reuse it to revise). */
export const ShowDecisionParamsSchema = DecisionDataSchema.extend({
  objectId: z.string().min(1).describe("Stable id for this decision; call again with the same id to revise it (resend the whole decision)"),
}).refine((d) => parseObjectData("decision", d) !== undefined, { message: "chosen must be the id of one of the options" });
export type ShowDecisionParams = z.infer<typeof ShowDecisionParamsSchema>;

export const ChecklistItemSchema = z.object({
  id: z.string().min(1).describe("Short stable id of the item"),
  label: z.string().min(1).describe("The step, in a few words"),
  state: z.enum(CHECKLIST_STATES).describe("todo | doing | done | skipped"),
  note: z.string().optional().describe("Optional one-line note"),
});

/** `data` of a `checklist` object. Progress (done/total) is derived on render, not sent. */
export const ChecklistDataSchema = z.object({
  title: z.string().optional().describe("What the checklist is for"),
  items: z.array(ChecklistItemSchema).min(1).describe("The items, in order"),
});

/** Parameters of the `show_checklist` tool: the checklist plus the wolf-chosen id (reuse it to revise). */
export const ShowChecklistParamsSchema = ChecklistDataSchema.extend({
  objectId: z.string().min(1).describe("Stable id for this checklist; call again with the same id to revise it (resend the whole checklist)"),
}).refine((d) => parseObjectData("checklist", d) !== undefined, { message: "item ids must be unique" });
export type ShowChecklistParams = z.infer<typeof ShowChecklistParamsSchema>;
export const GraphNodeSchema = z.object({
  id: z.string().min(1).max(GRAPH_LIMITS.id).describe("Short stable id of the node, unique in the graph"),
  label: z.string().min(1).max(GRAPH_LIMITS.label).describe("What the node is, in a few words"),
  kind: z.string().min(1).max(GRAPH_LIMITS.kind).describe("step | task | milestone (other kinds are tolerated)"),
  status: z.enum(GRAPH_NODE_STATUSES).describe("todo | doing | done | blocked | skipped"),
  detail: z.string().max(GRAPH_LIMITS.detail).optional().describe("Optional one-line elaboration"),
});
export const GraphEdgeSchema = z.object({
  from: z.string().min(1).max(GRAPH_LIMITS.id).describe("Id of the dependent node"),
  to: z.string().min(1).max(GRAPH_LIMITS.id).describe("Id of the node it depends on (must finish first)"),
});

/** `data` of a `graph` object: a plan/task DAG. Edges mean depends-on. Validate with `parseObjectData`. */
export const GraphDataSchema = z.object({
  title: z.string().optional().describe("What the graph is about"),
  nodes: z.array(GraphNodeSchema).min(1).max(GRAPH_LIMITS.nodes).describe("The steps, tasks or milestones"),
  edges: z.array(GraphEdgeSchema).max(GRAPH_LIMITS.edges).describe("`from` depends on `to`; both must be node ids, no self-loops, no duplicates, no cycles"),
});

/** Parameters of the `show_graph` tool: the graph plus the wolf-chosen id (reuse it to revise). */
export const ShowGraphParamsSchema = GraphDataSchema.extend({
  objectId: z.string().min(1).describe("Stable id for this graph; call again with the same id to revise it (resend the whole graph)"),
}).superRefine((d, ctx) => {
  const problem = graphProblem(d.nodes, d.edges);
  if (problem) ctx.addIssue({ code: "custom", message: problem });
});
export type ShowGraphParams = z.infer<typeof ShowGraphParamsSchema>;

/**
 * Object tools by tool name: the object type each shows and its parameter schema (zod, plus the JSON Schema a tool
 * registration hands the model). A new object type adds one entry here and one in objects.ts.
 */
export const OBJECT_TOOL_PARAMS = {
  show_decision: { type: "decision", schema: ShowDecisionParamsSchema },
  show_checklist: { type: "checklist", schema: ShowChecklistParamsSchema },
  show_graph: { type: "graph", schema: ShowGraphParamsSchema },
} as const satisfies Record<ObjectToolName, { type: KnownObjectType; schema: z.ZodType }>;

/** JSON Schema of an object tool's parameters (draft 2020-12 minus `$schema`). */
export function objectToolJsonSchema(name: ObjectToolName): Record<string, unknown> {
  const { $schema: _omit, ...rest } = z.toJSONSchema(OBJECT_TOOL_PARAMS[name].schema, { io: "input" }) as Record<string, unknown>;
  return rest;
}
/** Reference to an uploaded attachment (see `uploadAttachment`), carried by `SubmitRequest.attachments`. */
export const AttachmentRefSchema = z.object({ id: z.string() });
export type AttachmentRef = z.infer<typeof AttachmentRefSchema>;

/** An uploaded attachment, as stored by the wolf. Type-agnostic: `mimeType` says what it is. */
export const AttachmentSchema = z.object({
  /** Opaque id; pass it back as an `AttachmentRef`. */
  id: z.string(),
  /** Original file name when the client sent one, else a generated `<id>.<ext>`. */
  name: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

export const ThreadMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  /** ISO timestamp. */
  at: IsoSchema,
  /** Assistant messages only: the tool calls of the (merged) rounds, in call order. Optional: old servers omit it. */
  tools: z.array(ThreadToolCallSchema).optional(),
  /** Assistant messages only: structured objects first shown in this message, latest rev per objectId. Optional: old servers omit it. */
  objects: z.array(ThreadObjectSchema).optional(),
  /**
   * User messages only (additive, optional: old servers omit it): the attachments the message was sent with, in send
   * order. `text` is unchanged model-facing text and still ends with the `[Attached image: <path>]` lines; clients
   * show the attachments (fetch bytes with `getAttachment`) and may strip those lines from the displayed text.
   */
  attachments: z.array(AttachmentSchema).optional(),
});
export type ThreadMessage = z.infer<typeof ThreadMessageSchema>;

export const ThreadDetailSchema = ThreadSummarySchema.extend({
  messages: z.array(ThreadMessageSchema),
  /** True while a turn is streaming. */
  busy: z.boolean(),
  /** Id of the latest event emitted on this thread (0 if none). */
  lastEventId: z.number().int().nonnegative(),
  /** Additive: cards waiting for the operator (survives reconnect and restart). Absent = none / older server. */
  pendingCards: z.array(PendingCardSchema).optional(),
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
/** A structured object was shown or revised. Fold by `objectId`: the highest `rev` wins, shown at its first position. */
export const ObjectUpsertEventSchema = base.extend({
  type: z.literal("object-upsert"),
  turnId,
  objectId: z.string().min(1),
  objectType: z.string(),
  rev: z.number().int().positive(),
  data: z.unknown(),
  /** Length of the turn's merged assistant text when the object appeared; same anchor as `ThreadObject.textOffset`. Absent for a mid-turn joiner. */
  textOffset: z.number().int().nonnegative().optional(),
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

/**
 * A card is waiting for the operator: raised, or its held answer changed (fold by `callId`, the latest wins). Additive:
 * older clients skip it and read `ThreadDetail.pendingCards` instead.
 */
export const CardPendingEventSchema = base.extend({ type: z.literal("card-pending"), card: PendingCardSchema });
/** How a pending card left the pending list: answered (the answer was submitted) or dismissed (a plain submit superseded it). */
export const CardOutcomeSchema = z.enum(["answered", "dismissed"]);
export type CardOutcome = z.infer<typeof CardOutcomeSchema>;
/** `closed` is additive and finer than `outcome` (a skip and a supersede are both `dismissed`, so older clients keep working). */
export const CardSettledEventSchema = base.extend({ type: z.literal("card-settled"), callId: z.string(), outcome: CardOutcomeSchema, closed: CardClosedSchema.optional() });

export const ThreadEventSchema = z.discriminatedUnion("type", [
  TurnStartEventSchema,
  TextDeltaEventSchema,
  ThinkingDeltaEventSchema,
  ToolStartEventSchema,
  ToolUpdateEventSchema,
  ToolEndEventSchema,
  TurnEndEventSchema,
  ErrorEventSchema,
  ObjectUpsertEventSchema,
  CardPendingEventSchema,
  CardSettledEventSchema,
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

// ------------------------------------------------------- wolf events

/**
 * Wolf-scoped activity: what the sidebar and notifications need without opening every thread. `id` is minted per wolf
 * process (monotonic, positive) and is the SSE `id:` so a reconnect can resume with Last-Event-ID.
 */
const wolfBase = z.object({ id: EventIdSchema, wolf: z.string(), at: IsoSchema });
/** A thread's status changed (also sent once per thread as the baseline of a fresh connection). */
export const WolfThreadStatusEventSchema = wolfBase.extend({ type: z.literal("thread-status"), threadId: z.string(), status: ThreadStatusSchema });
/** A card was raised (or its held answer changed). Same payload as the thread event. */
export const WolfCardPendingEventSchema = wolfBase.extend({ type: z.literal("card-pending"), card: PendingCardSchema });
export const WolfCardSettledEventSchema = wolfBase.extend({ type: z.literal("card-settled"), threadId: z.string(), callId: z.string(), outcome: CardOutcomeSchema, closed: CardClosedSchema.optional() });
/** The server cannot replay from the client's cursor: refetch threads and cards. */
export const WolfResyncEventSchema = wolfBase.extend({ type: z.literal("resync") });
/** A thread appeared or its summary changed (a subagent was spawned, or its state, step or tokens changed). Fold by `thread.id`. */
export const WolfThreadUpdatedEventSchema = wolfBase.extend({ type: z.literal("thread-updated"), thread: ThreadSummarySchema });

export const WolfEventSchema = z.discriminatedUnion("type", [
  WolfThreadStatusEventSchema,
  WolfCardPendingEventSchema,
  WolfCardSettledEventSchema,
  WolfResyncEventSchema,
  WolfThreadUpdatedEventSchema,
]);
export type WolfEvent = z.infer<typeof WolfEventSchema>;
export type WolfEventType = WolfEvent["type"];

const WOLF_EVENT_TYPES: ReadonlySet<string> = new Set(WolfEventSchema.options.map((o) => o.shape.type.value));

export type ParsedWolfEvent = { kind: "event"; event: WolfEvent } | { kind: "unknown" } | { kind: "invalid"; error: z.ZodError };

/** Same ignore-unknown contract as parseThreadEvent. */
export function parseWolfEvent(input: unknown): ParsedWolfEvent {
  const env = wolfBase.extend({ type: z.string() }).safeParse(input);
  if (!env.success) return { kind: "invalid", error: env.error };
  if (!WOLF_EVENT_TYPES.has(env.data.type)) return { kind: "unknown" };
  const ev = WolfEventSchema.safeParse(input);
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

/**
 * One observation of the wolf's pool (`GET /v1/wolves/:name/memory/observations`). `work` / `feature` are the tags
 * the observation was captured under (absent: general, it feeds the den). `id` is stable for a pool entry across
 * reads (a hash of its recordedAt, timestamp and content, plus an ordinal when two entries are identical).
 */
export const MemoryObservationSchema = z.object({
  id: z.string(),
  /** When the observation was made (as the classifier stamped it). */
  timestamp: z.string(),
  /** When it was appended to the pool; the newest-first order uses it. */
  recordedAt: z.string().optional(),
  content: z.string(),
  /** Estimated tokens (the pool's own estimate: ceil(chars / 4)). */
  tokenCount: z.number().int().nonnegative(),
  domain: z.string().optional(),
  work: z.string().optional(),
  feature: z.string().optional(),
  /** Set on a tagged observation that stays pending because the Work API is unreachable or not configured. */
  blocked: z.literal("work-api-unavailable").optional(),
});
export type MemoryObservation = z.infer<typeof MemoryObservationSchema>;

export const MemoryObservationsSchema = z.object({
  /** Newest first. */
  observations: z.array(MemoryObservationSchema),
  /** The pool's size, before `limit`. */
  total: z.number().int().nonnegative(),
  /** Pool-level: tagged observations are waiting because the Work API is unavailable. */
  blocked: z.literal("work-api-unavailable").optional(),
});
export type MemoryObservations = z.infer<typeof MemoryObservationsSchema>;

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

import { ATTACHMENT_MAX_PER_SUBMIT } from "./attachments.js";
export { ATTACHMENT_IMAGE_TYPES, ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_PER_SUBMIT } from "./attachments.js";

/**
 * `whenBusy` is required on the wire: absent -> invalid_request. SDKs may default it; the wire may not.
 * `attachments` (additive, optional): uploaded files the wolf inlines into the user message; `input` may then be empty.
 */
export const SubmitRequestSchema = z.object({
  threadId: z.string(),
  input: z.string(),
  whenBusy: WhenBusySchema,
  attachments: z.array(AttachmentRefSchema).max(ATTACHMENT_MAX_PER_SUBMIT).optional(),
});
export type SubmitRequest = z.infer<typeof SubmitRequestSchema>;

export const SubmitAckSchema = z.object({
  /** Id of the user message created by this submit. */
  messageId: z.string(),
  disposition: z.enum(["started", "steered", "queued"]),
});
export type SubmitAck = z.infer<typeof SubmitAckSchema>;

/**
 * Answer a pending card. The answer is a submission: the card's tool call is resolved with it and the next turn starts
 * (when no sibling card of the same turn is still pending). `answers` must cover every VISIBLE REQUIRED field; optional and showIf-hidden fields may be omitted.
 * Wire: the thread id and `callId` ride the path.
 */
export const AnswerCardRequestSchema = z.object({
  threadId: z.string(),
  callId: z.string(),
  answers: CardAnswersSchema,
});
export type AnswerCardRequest = z.infer<typeof AnswerCardRequestSchema>;

/**
 * Skip a pending card without answering it. The agent is told ("The user skipped your <tool> question (call X)") and,
 * like an answer, the next turn starts once every sibling card of the turn is answered or skipped. Wire: the thread id
 * and `callId` ride the path; there is no body.
 */
export const SkipCardRequestSchema = z.object({ threadId: z.string(), callId: z.string() });
export type SkipCardRequest = z.infer<typeof SkipCardRequestSchema>;

/** Ends the running turn; the stream finishes with turn-end (reason "aborted"). */
export const AbortRequestSchema = z.object({ threadId: z.string() });
export type AbortRequest = z.infer<typeof AbortRequestSchema>;

// ------------------------------------------------------- subagent ledger

/** Who a ledger entry is from or to: the spawning thread, the child, the operator (typing into the child) or wolfd itself. */
export const LedgerPartySchema = z.enum(["parent", "child", "owner", "system"]);
export type LedgerParty = z.infer<typeof LedgerPartySchema>;
/**
 * `brief` (the spawn), `steer` (a message into a running child), `resume` (a message that restarts a finished or waiting
 * child; an answer to its question is one), `question` (the child asks its parent), `result` (its final answer),
 * `error` (its turn failed), `stop` (it was cancelled).
 */
export const LedgerKindSchema = z.enum(["brief", "steer", "resume", "question", "result", "error", "stop"]);
export type LedgerKind = z.infer<typeof LedgerKindSchema>;
export const LedgerEntrySchema = z.object({
  /** 1-based, per child, in order. */
  id: z.number().int().positive(),
  at: z.iso.datetime({ offset: true }),
  from: LedgerPartySchema,
  to: LedgerPartySchema,
  kind: LedgerKindSchema,
  text: z.string(),
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

/**
 * Create a thread. Idempotent for "home": if the wolf already has a home thread it is returned unchanged (never a
 * second one). "feature" opens an ownerless thread bound to the feature `workItemId` (idempotent per feature: asking
 * again returns the existing thread). Subagent threads are created only by spawn, never here.
 */
export const CreateThreadBodyVariantsSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("home") }),
  z.object({ kind: z.literal("feature"), workItemId: z.string().min(1) }),
]);
export const CreateThreadRequestSchema = z.intersection(z.object({ wolf: z.string() }), CreateThreadBodyVariantsSchema);
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
