import { z } from "zod";
import {
  answerSchemaOf,
  cardKind,
  ConfirmFieldSchema,
  SliderFieldSchema,
  fieldSchemaOf,
  FreeTextFieldSchema,
  MultiFieldSchema,
  SingleFieldSchema,
  type AnyField,
  type CardOption,
  type ConfirmFieldAnswer,
  type FieldShowIf,
  type MultiFieldAnswer,
  type SliderFieldAnswer,
  type TextFieldAnswer,
} from "./card-kinds/index.js";
export * from "./card-kinds/index.js";

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
  /** The caller is identified but this operation is owner-only (actor kind operator). */
  "forbidden",
  "version_mismatch",
  "engine_error",
  "invalid_request",
  /** The wolf's memory is inert or not loaded (fail-closed gate): memory actions have nothing to run. */
  "memory_unavailable",
  /** Promote needs KB roots and this wolf has none; consolidate still works. */
  "promote_unavailable",
  /** A promote is running; consolidate would queue behind it, so it is refused. Retry later. */
  "memory_busy",
  /** The KB routes: this wolf has no KB roots (graph, entries), or is not the librarian (pipeline). */
  "kb_unavailable",
  /** The thread is closed history (its feature graduated): reads work, sends are refused. */
  "thread_closed",
  /** Graduation: the work item is not ready to graduate (the message says why: "2 tasks open"). */
  "not_ready",
  /** Graduation: the preview token is unknown, used, expired or for another item. Preview again. */
  "preview_stale",
  /** Hub claim: the item (or its feature) is held by another wolf; `details.holder` names it. */
  "conflict",
  /** A request body is over its cap (e.g. a prompt override over 64 KB). */
  "too_large",
  /** Too soon to repeat this (e.g. a restart within a minute of the last start). `details.retryAfterSeconds` (a number) says when; the error is retryable. */
  "rate_limited",
  /** The actor is authenticated but not allowed this operation (e.g. a wolf committing to the KB). */
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ErrorEnvelopeSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean(),
  /** Additive, structured facts about the refusal (a graduation `busy` carries `{kind}`, the kind of job that is running). */
  details: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

/**
 * `details.reason` on a 400 `invalid_request` from POST /v1/contributions when the hub refused the contribution because it may hold a secret.
 * The crawl client treats ONLY this 400 as a per-entry refusal (the other entries still go); any other 400 aborts the release. Pinned here so
 * the hub (writer) and the client (reader) cannot drift apart.
 */
export const SECRET_REFUSAL_REASON = "secret_detected";

/** Stable HTTP status per error code. Clients map errors from `code`, never from status. */
export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  busy: 409,
  not_found: 404,
  unauthorized: 401,
  forbidden: 403,
  version_mismatch: 426,
  engine_error: 502,
  invalid_request: 400,
  memory_unavailable: 409,
  promote_unavailable: 409,
  memory_busy: 409,
  kb_unavailable: 409,
  thread_closed: 409,
  not_ready: 409,
  preview_stale: 409,
  conflict: 409,
  too_large: 413,
  rate_limited: 429,
};

// ---------------------------------------------------------------- cards

/**
 * Interaction cards: a wolf's question to the operator, raised by a tool (the model-facing `brief` or a
 * tool such as `task_done`). A card holds one or more fields (question / options / free text). Additive: no version bump.
 *
 * Field kinds: `free-text`, `single`, `multi` (checkboxes, answer string[]) and `confirm` (yes/no, answer boolean).
 * `default` only pre-selects in the UI, it is never auto-submitted (cards wait indefinitely; there is no timeout).
 *
 * Each kind is a module in `card-kinds/` (field schema + answer schema, one registry); the field union dispatches
 * through that registry at parse time, so a kind added with `registerCardKind` parses everywhere.
 * The static types below cover the four built-in kinds only: a registered kind parses and validates at runtime but is
 * not part of these unions.
 */
export type CardField = z.infer<typeof FreeTextFieldSchema> | z.infer<typeof SingleFieldSchema> | z.infer<typeof MultiFieldSchema> | z.infer<typeof ConfirmFieldSchema> | z.infer<typeof SliderFieldSchema>;
export const CardFieldSchema = fieldSchemaOf() as unknown as z.ZodType<CardField>;
/** Kind names of the built-in fields only (see CardField). */
export type CardFieldKind = CardField["kind"];

export const CardStepSchema = z.object({
  title: z.string().optional(),
  /** Field ids shown on this step, in order. */
  fields: z.array(z.string().min(1)).min(1),
});
export type CardStep = z.infer<typeof CardStepSchema>;

/** Why a field's showIf cannot work against its controller (undefined = fine). Shared with the brief builder. */
export function showIfProblem(f: { id: string; showIf?: FieldShowIf }, fields: readonly CardField[]): string | undefined {
  const s = f.showIf;
  if (!s) return undefined;
  const ctl = fields.find((x) => x.id === s.field);
  if (!ctl || ctl.id === f.id) return `showIf.field "${s.field}" is not another field of this card`;
  const check = cardKind(ctl.kind)?.checkShowIfController;
  if (!check) return `field "${ctl.id}" (${ctl.kind}) cannot control another field`;
  return check(ctl as unknown as AnyField, s);
}

/** Limits of a brief header (owner decisions): the headline and the bullet count are hard, a bullet's length is soft (the console clamps it). */
export const BRIEF_LIMITS = { headline: 80, contextBullets: 5, bulletSoftChars: 160, questions: 3 } as const;

/**
 * The header of a card raised by the `brief` tool: what the owner needs to know before answering.
 * `context` bullets are short by convention (~160 chars) but never rejected for length; `more` points at detail in the thread.
 */
export const CardBriefSchema = z.object({
  headline: z.string().min(1).max(BRIEF_LIMITS.headline),
  context: z.array(z.string()).max(BRIEF_LIMITS.contextBullets).optional(),
  more: z.string().optional(),
});
export type CardBrief = z.infer<typeof CardBriefSchema>;

export const CardSchema = z
  .object({
    /** Tool that raised it, e.g. `brief`. Keys the console's card renderer. */
    tool: z.string(),
    title: z.string().optional(),
    /** A card needs at least one field, except a brief card, which may have none (the owner then acknowledges with OK); a brief holds at most 3. */
    fields: z.array(CardFieldSchema),
    /** Brief header (the `brief` tool). Absent on cards from other tools. */
    brief: CardBriefSchema.optional(),
    /**
     * Optional stepped presentation: the fields grouped into ordered steps (every field in exactly one step; a step
     * whose fields are all hidden by `showIf` is skipped). The answer is still ONE submission for the whole card.
     * Absent = a single-page form.
     */
    steps: z.array(CardStepSchema).min(1).optional(),
    /**
     * The `ask` tool: `steps` are PAGES and each page is answered on its own (`answerCardPage`); the agent gets the
     * answers after every page and the card stays pending until the last one. Requires `steps`.
     */
    paged: z.boolean().optional(),
    /**
     * Set by the `ask_revise` tool: this card is not raised, it REPLACES the not-yet-answered pages of the paged card
     * raised by that call id (`fields`/`steps` are the replacement pages only).
     */
    revises: z.string().optional(),
  })
  .refine((c) => !c.paged || c.steps !== undefined, { message: "a paged card needs steps (its pages)", path: ["steps"] })
  .refine((c) => c.fields.length >= 1 || c.brief !== undefined, { message: "a card needs at least one field (only a brief card may have none)", path: ["fields"] })
  .refine((c) => c.brief === undefined || c.fields.length <= BRIEF_LIMITS.questions, { message: `a brief card holds at most ${BRIEF_LIMITS.questions} questions`, path: ["fields"] })
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
  .superRefine((c, ctx) => {
    // Kind-specific rules (defaults within options, min/max, ...) live in each kind's `checkField`.
    for (const f of c.fields) {
      const problem = cardKind(f.kind)?.checkField?.(f as unknown as AnyField);
      if (problem) ctx.addIssue({ code: "custom", message: problem, path: ["fields"] });
    }
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
export type { TextFieldAnswer, MultiFieldAnswer, ConfirmFieldAnswer, SliderFieldAnswer };
export type CardFieldAnswer = TextFieldAnswer | MultiFieldAnswer | ConfirmFieldAnswer | SliderFieldAnswer;
/** Any registered kind's answer shape (see card-kinds/). */
export const CardFieldAnswerSchema = answerSchemaOf() as unknown as z.ZodType<CardFieldAnswer>;
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
  /**
   * Paged (`ask`) cards: how many pages are already submitted (the current page is `pageIndex`), and the answers given
   * on them. `draft` holds answers typed so far on the current page (including text bound to a question), not submitted.
   */
  pageIndex: z.number().int().min(0).optional(),
  pageAnswers: CardAnswersSchema.optional(),
  draft: CardAnswersSchema.optional(),
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
  /** Additive: this wolf has KB roots and serves the read-only graph and entry routes (a mirror when it is not the librarian). Absent = false. */
  kbReadable: z.boolean().optional(),
  /** Additive: the wolf's chosen color (a THREAD_COLOR_KEYS key, wolf.yaml `color`). Absent = automatic. */
  color: z.lazy(() => ThreadColorSchema).optional(),
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
// ---- header git tree (workspace) ----------------------------------------------------------------------------------
/** Where a thread works: the repo, the branch it is on, what that branch was cut from, and whether it is a linked worktree. */
export const ThreadWorkspaceSchema = z.object({
  /** Repository name (the main checkout's directory name). */
  repo: z.string(),
  /** Git toplevel of the checkout the thread works in. */
  toplevel: z.string(),
  /** The branch this one was cut from (feature: recorded at creation, else the main checkout's branch; subagent: the feature branch). Absent for home. */
  base: z.string().optional(),
  /** Current branch ("HEAD" when detached). */
  branch: z.string(),
  path: z.string(),
  /** True when `path` is a linked worktree, not the repo's main checkout. */
  isWorktree: z.boolean(),
});
export type ThreadWorkspace = z.infer<typeof ThreadWorkspaceSchema>;
// ---- /header git tree ---------------------------------------------------------------------------------------------

// ---- composer controls: per-thread settings ------------------------------------------------------------------------
/** The wolf's model tiers a thread can run on (the actual models come from the wolf's models.json). */
export const ThreadTierSchema = z.enum(["main", "smart", "fast"]);
export type ThreadTier = z.infer<typeof ThreadTierSchema>;
export const THREAD_TIERS = ThreadTierSchema.options;
/** The fixed thread palette (readable on the dark theme). Keys are what settings store; hex is for display.
 *  The `teal` key is stored in settings, so it stays; its colour is lime (#a3e635) because a teal thread colour was too
 *  close to the UI's teal accent (#2dd4bf). Show it as "lime" (THREAD_COLOR_NAMES in the console). */
export const THREAD_COLORS = {
  red: "#f07178",
  orange: "#f5a15a",
  yellow: "#e6cd69",
  green: "#8bd17c",
  teal: "#a3e635",
  blue: "#6cb2f2",
  purple: "#b69cf5",
  pink: "#f28cc4",
} as const;
export const THREAD_COLOR_KEYS = ["red", "orange", "yellow", "green", "teal", "blue", "purple", "pink"] as const;
export const ThreadColorSchema = z.enum(THREAD_COLOR_KEYS);
export type ThreadColor = z.infer<typeof ThreadColorSchema>;
/** Per-thread composer settings. Persisted by the wolf; the defaults are `main` and auto-ship off. */
export const ThreadSettingsSchema = z.object({
  /** Owner's colour override (a palette key). Absent = automatic (derived from the thread id). */
  color: ThreadColorSchema.optional(),
  tier: ThreadTierSchema,
  /** true: task_done ships in this thread without raising a ship card. false: it asks (one multi-select card). */
  autoShip: z.boolean(),
});
export type ThreadSettings = z.infer<typeof ThreadSettingsSchema>;
export const DEFAULT_THREAD_SETTINGS: ThreadSettings = { tier: "main", autoShip: false };
/** What GET/PUT settings answer: the settings plus the model each tier resolves to (a hint for the picker). */
export const ThreadSettingsResponseSchema = ThreadSettingsSchema.extend({
  models: z.object({ main: z.string().optional(), smart: z.string().optional(), fast: z.string().optional() }).optional(),
});
export type ThreadSettingsResponse = z.infer<typeof ThreadSettingsResponseSchema>;
/** PUT body: the fields to change (at least one). */
// ---- thread context stats + manual compaction ------------------------------------------------------------------------
/** GET /v1/threads/:id/context. Thresholds are absolute token counts; absent when the model's window is unknown. */
export const ThreadContextSchema = z.object({
  /** Current context size (last assistant usage plus an estimate of what came after). */
  tokens: z.number().int().nonnegative(),
  /** The model's context window. */
  window: z.number().int().positive().optional(),
  /** The background summary starts past this many tokens (wolf.yaml `compaction.startAt`, else pi-durable's default). */
  startAt: z.number().int().nonnegative().optional(),
  /** A generation waits for a compaction past this (window - reserveTokens). */
  waitAt: z.number().int().nonnegative().optional(),
  compactions: z.object({ count: z.number().int().nonnegative(), /** ISO time of the newest one. */ lastAt: z.string().optional() }),
  /** A compaction started by this wolf is in flight. */
  compacting: z.boolean(),
  /** The last manual compaction failed with this error (cleared when the next one starts). */
  compactError: z.string().optional(),
});
export type ThreadContext = z.infer<typeof ThreadContextSchema>;
export const CompactBodySchema = z.object({ instructions: z.string().max(4000).optional() });
export type CompactBody = z.infer<typeof CompactBodySchema>;
export const CompactAckSchema = z.object({ accepted: z.literal(true) });
export type CompactAck = z.infer<typeof CompactAckSchema>;

/** `color: null` resets to automatic. */
export const ThreadSettingsPatchSchema = ThreadSettingsSchema.omit({ color: true })
  .partial()
  .extend({ color: ThreadColorSchema.nullable().optional() })
  .refine((p) => p.tier !== undefined || p.autoShip !== undefined || p.color !== undefined, { message: "tier, autoShip or color is required" });
export type ThreadSettingsPatch = z.infer<typeof ThreadSettingsPatchSchema>;
// ---- /composer controls ---------------------------------------------------------------------------------------------

export const ThreadSummarySchema = z.object({
  id: z.string(),
  wolf: z.string(),
  kind: ThreadKindSchema,
  title: z.string(),
  boundWorkItem: z.string().optional(),
  /** Additive: true when the thread is read-only history (its feature graduated). Sends answer `thread_closed`. */
  closed: z.boolean().optional(),
  closedReason: z.string().optional(),
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
  /** Additive, subagent threads: when the current run began (reset on every resume; equals `startedAt` until then). Optional: older servers do not send it. */
  runStartedAt: z.iso.datetime({ offset: true }).optional(),
  /** Additive: when the turn now running began; present only while a turn runs (steers do not reset it). */
  turnStartedAt: z.iso.datetime({ offset: true }).optional(),
  /** Set once the child is done, failed or stopped; cleared when it is resumed. */
  finishedAt: z.iso.datetime({ offset: true }).optional(),
  /** What it is doing now (the tool it last started), for the status strip. */
  step: z.string().optional(),
  /** Tokens used so far (input + output, all turns). */
  tokens: z.number().int().nonnegative().optional(),
  /** The work item (task) this child serves: named in its brief, else the one its parent is bound to. */
  taskId: z.string().optional(),
  /** Additive (header git tree): the thread's git workspace. Absent for a non-git thread, or an older server. */
  workspace: ThreadWorkspaceSchema.optional(),
  // --- feature progress: bound item (additive) ---
  /**
   * Additive: the work item the thread's conversation is bound to RIGHT NOW (the binding file: set by the bind route or
   * the agent's task_bind), present only when it differs from `boundWorkItem` (the feature a feature thread was opened
   * for). The progress panel follows `boundItem ?? boundWorkItem`.
   */
  boundItem: z.string().optional(),
  // --- end feature progress ---
  /** Additive (composer controls): the thread's model tier and auto-ship toggle. Absent on subagent threads and older servers (= defaults). */
  settings: ThreadSettingsSchema.optional(),
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
  /** Additive, paged (`ask`) cards: answers of the pages submitted so far, keyed by question id. Feeds the transcript record (`askRecord`). */
  pageAnswers: CardAnswersSchema.optional(),
  /** Additive, paged cards: how many pages were submitted so far. */
  pagesDone: z.number().int().min(0).optional(),
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

/**
 * A compaction marker (additive, optional): the thread was compacted at this point. Such a message has role
 * "assistant" and empty `text` (an older client shows an empty assistant row); clients render a divider instead.
 * `summary` is the summary text without pi-durable's wrapper; `reason` is why it ran ("manual", "threshold", ...).
 */
export const ThreadCompactionSchema = z.object({
  summary: z.string(),
  reason: z.string().optional(),
});
export type ThreadCompaction = z.infer<typeof ThreadCompactionSchema>;

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
  /** Additive, optional: this entry marks a compaction (see ThreadCompactionSchema); older servers never send it. */
  compaction: ThreadCompactionSchema.optional(),
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
  /**
   * Paging (additive; absent = the whole transcript is in `messages`, i.e. an older server or an unpaged request).
   * `GET /v1/threads/:id?limit=N` returns the newest page; `?limit=N&before=<cursor>` the N messages before it.
   * `hasMore`: older messages exist before the first returned one. `cursor`: id of the first returned message.
   */
  hasMore: z.boolean().optional(),
  cursor: z.string().optional(),
});
export type ThreadDetail = z.infer<typeof ThreadDetailSchema>;

// ---- header git tree (workspace status) ---------------------------------------------------------------------------
export const WorkspaceDirtyFileSchema = z.object({
  path: z.string(),
  /** Two-character `git status --porcelain` code (" M", "??", "A " ...). */
  status: z.string(),
});
export const WorkspaceCommitSchema = z.object({ sha: z.string(), subject: z.string(), at: IsoSchema });
export const WorkspaceChildSchema = z.object({ threadId: z.string(), name: z.string(), branch: z.string(), path: z.string() });
/** The live git state behind the header popover: read-only, a few seconds old at most. */
export const WorkspaceStatusSchema = z.object({
  branch: z.string(),
  /** Commits ahead of / behind the base branch (0 / 0 without a base). */
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  dirty: z.array(WorkspaceDirtyFileSchema),
  /** The last 5 commits, newest first. */
  commits: z.array(WorkspaceCommitSchema),
  /** Worktrees of this thread's running subagents. */
  children: z.array(WorkspaceChildSchema),
});
export type WorkspaceStatus = z.infer<typeof WorkspaceStatusSchema>;
// ---- /header git tree ---------------------------------------------------------------------------------------------

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

export const TurnStartEventSchema = base.extend({
  type: z.literal("turn-start"),
  turnId,
  /** Additive: the server clock when the turn began (same value as `ThreadSummary.turnStartedAt`). Absent on older servers. */
  startedAt: IsoSchema.optional(),
});
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

// ------------------------------------------------------- hub events

/**
 * Hub-scoped pack events (`GET /v1/events`). `id` is minted by the hub (monotonic, positive) and is the SSE id (prefixed with the
 * hub's boot id on the wire: `<boot>:<id>`). `work.changed` fires per hub ledger event; `kb.changed` per KB commit (entry ids);
 * `wolf.presence` when a wolf registers/leaves (defined here; nothing emits it yet). `resync`: the cursor is too old, refetch.
 */
const hubBase = z.object({ id: EventIdSchema, at: IsoSchema });
/** `domain`: the item's domain when the hub could fold it (absent for a deleted item). */
export const HubWorkChangedEventSchema = hubBase.extend({ type: z.literal("work.changed"), itemId: z.string(), event: z.string(), domain: z.string().optional() });
export const HubKbChangedEventSchema = hubBase.extend({ type: z.literal("kb.changed"), entryIds: z.array(z.string()), domain: z.string().optional() });
/** The hub curator's sweep (KB curation in hubd): started once real work begins, one item per contribution, finished always follows a started (also on a throw: `error`). */
export const HubSweepStartedEventSchema = hubBase.extend({ type: z.literal("sweep_started"), pending: z.number().int().nonnegative() });
/**
 * The curator's decision for one contribution (the same summary the KB ledger `decision` event carries; optional: older hubs omit it).
 * Must stay in step with DecisionSummarySchema in packages/kb/src/shared/schemas/events.ts (hubd's decision-drift test checks it).
 * `unchanged` (a merge the contribution agreed with) is reported as sweep_item outcome `merge`; `unclassified` has no sweep_item.
 * On a post-commit failure (receipt or move threw, then the item was parked) sweep_item.outcome is `parked` but `decision` carries the
 * committed outcome (create / merge / unchanged), matching the ledger.
 */
export const HubSweepDecisionSchema = z.object({
  /** `unchanged`: a merge the contribution agreed with; `unclassified`: no declared domain. */
  outcome: z.enum(["create", "merge", "unchanged", "reject", "parked", "unclassified"]),
  entryId: z.string().optional(),
  reason: z.string().optional(),
  routing: z
    .object({
      route: z.enum(["alias", "anchor", "similarity", "new"]),
      candidates: z.array(z.object({ id: z.string(), score: z.number() })),
      band: z.string().optional(),
      subject: z.object({ match: z.string(), valid: z.boolean(), reason: z.string().optional() }).optional(),
      confirm: z.object({ candidate: z.string(), score: z.number(), merge: z.boolean(), valid: z.boolean(), reason: z.string().optional() }).optional(),
      target: z.string().optional(),
      warning: z.string().optional(),
    })
    .optional(),
});
export type HubSweepDecision = z.infer<typeof HubSweepDecisionSchema>;
export const HubSweepItemEventSchema = hubBase.extend({
  type: z.literal("sweep_item"),
  from: z.string(),
  denTopicId: z.string(),
  outcome: z.enum(["create", "merge", "reject", "parked"]),
  entryId: z.string().optional(),
  decision: HubSweepDecisionSchema.optional(),
});
/**
 * The item the curator is working on changed: it started, or its route became known (the sweep's sweep-current.json was rewritten).
 * Emitted by hubd while a sweep runs, not by the sweep itself; the item's end is the sweep_item. Older hubs never send it.
 */
export const HubSweepProgressEventSchema = hubBase.extend({
  type: z.literal("sweep_progress"),
  from: z.string(),
  denTopicId: z.string(),
  /** Epoch ms the item started. */
  startedAt: z.number(),
  route: z.string().optional(),
});
export const HubSweepFinishedEventSchema = hubBase.extend({
  type: z.literal("sweep_finished"),
  processed: z.number().int().nonnegative(),
  created: z.number().int().nonnegative(),
  merged: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  parked: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  error: z.string().optional(),
});
/**
 * `GET /v1/kb/activity` (hub): the hub curator's own ledger and receipts, no relay to a wolf.
 * Query: `since` = "7d" | "30d" | "all" | ISO timestamp (default "30d"), `before` = opaque cursor from `decisions.nextCursor`,
 * `limit` 1..200 (default 50, decisions page size), `domain` (restrict `changes` and growth to one domain).
 */
export const KbDecisionOutcomeSchema = HubSweepDecisionSchema.shape.outcome;
export type KbDecisionOutcome = z.infer<typeof KbDecisionOutcomeSchema>;
/** The latest ledger `decision` per (from, denTopicId, hash). `id`: the ledger event id. `superseded`: earlier decisions it replaced (e.g. parked, then merge). */
export const KbDecisionSchema = z.object({
  id: z.string(),
  at: z.string(),
  from: z.string(),
  denTopicId: z.string(),
  hash: z.string(),
  outcome: KbDecisionOutcomeSchema,
  entryId: z.string().optional(),
  reason: z.string().optional(),
  routing: HubSweepDecisionSchema.shape.routing,
  superseded: z.number().int().nonnegative().optional(),
  /** The entry's domain, else the contribution's hinted domain when it is a real domain. Absent when neither is known. */
  domain: z.string().optional(),
  /** Title of the resulting entry, when there is one. */
  title: z.string().optional(),
});
export type KbDecision = z.infer<typeof KbDecisionSchema>;
/** entry_written carries action create|merge|supersede; entry_retired maps to `retire`. Domain is resolved by the hub (entry_placed sectionId / entry file), not carried by the events. */
export const KbActivityChangeSchema = z.object({
  at: z.string(),
  entryId: z.string(),
  title: z.string().optional(),
  action: z.enum(["create", "merge", "supersede", "retire"]),
  from: z.string().optional(),
  denTopicId: z.string().optional(),
});
export type KbActivityChange = z.infer<typeof KbActivityChangeSchema>;
export const KbActivityResponseSchema = z.object({
  generatedAt: z.string(),
  /** No absolute host paths. `hasDecisions`: the ledger holds any `decision` event (older ledgers have none). */
  source: z.object({ lane: z.enum(["hub", "custom"]), hasDecisions: z.boolean(), curator: z.enum(["on", "off", "unknown"]) }),
  incoming: z.object({
    total: z.number().int().nonnegative(),
    wolves: z.array(
      z.object({
        wolf: z.string(),
        pending: z.number().int().nonnegative(),
        oldestAgeMs: z.number().nonnegative().optional(),
        bad: z.number().int().nonnegative().optional(),
        /** At most 20 per wolf. */
        items: z.array(z.object({ denTopicId: z.string(), hash: z.string().optional(), ageMs: z.number().nonnegative(), domain: z.string().optional() })),
      }),
    ),
    /** Quarantined (`_bad/`) contributions with their reason, newest first, capped. */
    bad: z
      .array(z.object({ id: z.string().optional(), wolf: z.string(), denTopicId: z.string().optional(), domainHint: z.string().optional(), reason: z.string(), at: z.string() }))
      .optional(),
  }),
  /** One summary per domain under the KB (every domain, even with no activity). `contributors`: wolves with decisions in range. */
  domains: z
    .array(
      z.object({
        domain: z.string(),
        entries: z.number().int().nonnegative(),
        waiting: z.number().int().nonnegative(),
        lastChangeAt: z.string().optional(),
        /** Wolves with create / merge / unchanged decisions in range (a rejected contribution does not make a contributor). */
        contributors: z.array(z.object({ wolf: z.string(), count: z.number().int().nonnegative() })),
        /** All decisions in range for the domain, and the newest few (so a block never depends on the overall page). */
        decided: z.number().int().nonnegative().optional(),
        recent: z.array(KbDecisionSchema).optional(),
      }),
    )
    .optional(),
  /** Per wolf, over the whole range: contributions that were rejected / parked / unclassified, with the latest few (see `incoming.bad` for quarantined). */
  attention: z
    .array(z.object({ wolf: z.string(), reject: z.number().int().nonnegative(), parked: z.number().int().nonnegative(), unclassified: z.number().int().nonnegative(), bad: z.number().int().nonnegative(), items: z.array(KbDecisionSchema) }))
    .optional(),
  decisions: z.object({
    items: z.array(KbDecisionSchema),
    nextCursor: z.string().optional(),
    total: z.number().int().nonnegative(),
    counts: z.object({
      create: z.number().int().nonnegative(),
      merge: z.number().int().nonnegative(),
      unchanged: z.number().int().nonnegative(),
      reject: z.number().int().nonnegative(),
      parked: z.number().int().nonnegative(),
      unclassified: z.number().int().nonnegative(),
    }),
  }),
  /** Latest 10 per domain, newest first. */
  changes: z.object({ domains: z.array(z.object({ domain: z.string(), items: z.array(KbActivityChangeSchema) })) }),
  sweep: z
    .object({
      running: z.boolean(),
      /** The contribution being worked on (from the sweep's sweep-current.json); absent when idle or on an older hub. */
      current: z.object({ from: z.string(), denTopicId: z.string(), startedAt: z.number(), route: z.string().optional() }).optional(),
      last: z.object({ finishedAt: z.string(), processed: z.number().int().nonnegative(), error: z.string().optional() }).optional(),
    })
    .optional(),
});
export type KbActivityResponse = z.infer<typeof KbActivityResponseSchema>;
export const HubWolfPresenceEventSchema = hubBase.extend({ type: z.literal("wolf.presence"), wolf: z.string(), state: z.enum(["online", "offline"]), host: z.string().optional() });
/**
 * The cursor cannot be replayed (too old, another hub boot, ahead of the hub) or the hub missed a ledger append: refetch.
 * Not a sequenced event: its `id` is the hub's CURRENT sequence (0 on a hub that has emitted nothing), so a client that stores
 * it as Last-Event-ID resumes with exactly the events after it.
 */
export const HubResyncEventSchema = hubBase.extend({ type: z.literal("resync"), id: z.number().int().nonnegative() });
export const HubEventSchema = z.discriminatedUnion("type", [HubWorkChangedEventSchema, HubKbChangedEventSchema, HubSweepStartedEventSchema, HubSweepItemEventSchema, HubSweepProgressEventSchema, HubSweepFinishedEventSchema, HubWolfPresenceEventSchema, HubResyncEventSchema]);
export type HubEvent = z.infer<typeof HubEventSchema>;
const HUB_EVENT_TYPES: ReadonlySet<string> = new Set(HubEventSchema.options.map((o) => o.shape.type.value));
export type ParsedHubEvent = { kind: "event"; event: HubEvent } | { kind: "unknown" } | { kind: "invalid"; error: z.ZodError };
/** Same ignore-unknown contract as parseWolfEvent. */
export function parseHubEvent(input: unknown): ParsedHubEvent {
  const env = z.object({ type: z.string() }).passthrough().safeParse(input);
  if (!env.success) return { kind: "invalid", error: env.error };
  if (!HUB_EVENT_TYPES.has(env.data.type)) return { kind: "unknown" };
  const ev = HubEventSchema.safeParse(input);
  return ev.success ? { kind: "event", event: ev.data } : { kind: "invalid", error: ev.error };
}
export type HubEventType = HubEvent["type"];

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
  /** Timer cadence ("4h"); applies to the timer and hybrid triggers. Absent from older wolfds. */
  interval: z.string().optional(),
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
  /** Set on a tagged observation that stays pending: the Work API is unreachable or not configured, or the model failed. */
  blocked: z.enum(["work-api-unavailable", "consolidation-failed"]).optional(),
});
export type MemoryObservation = z.infer<typeof MemoryObservationSchema>;

export const MemoryObservationsSchema = z.object({
  /** Newest first. */
  observations: z.array(MemoryObservationSchema),
  /** The pool's size, before `limit`. */
  total: z.number().int().nonnegative(),
  /** Pool-level: tagged observations are waiting because the Work API is unavailable. */
  blocked: z.literal("work-api-unavailable").optional(),
  /** Tagged observations waiting to be folded into a Record, and how long the oldest group has waited. */
  pending: z.object({ count: z.number().int().nonnegative(), oldestAgeMs: z.number().nonnegative().optional() }).optional(),
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
  /** The newest ledger entries ("**when** — what", oldest first, at most 10). Omitted when the item has none. */
  log: z.array(z.string()).optional(),
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

/** One row of `GET /v1/wolves/:name/work`: the slice of a work item the console's Work view needs. */
export const WorkListItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.string(),
  stage: z.string(),
  domain: z.string(),
  partOf: z.string().nullable().optional(),
  dependsOn: z.array(z.string()),
  assignee: z.string().optional(),
  /** YYYY-MM-DD. */
  created: z.string().optional(),
  /** A standing initiative never completes. Only present when true. */
  standing: z.boolean().optional(),
  /** A holding container (a domain's Inbox). Only present when true. */
  container: z.boolean().optional(),
  /** The date it graduated; only present on graduated items. */
  graduated: z.string().optional(),
});
export type WorkListItem = z.infer<typeof WorkListItemSchema>;

/**
 * `GET /v1/wolves/:name/work?domain=<d>[&graduated=true]`: the domain's work items through the wolf's Work API client.
 * Graduated and archived items are left out unless `graduated=true`.
 */
export const WorkListResponseSchema = z.object({ items: z.array(WorkListItemSchema) });
export type WorkListResponse = z.infer<typeof WorkListResponseSchema>;

// ------------------------------------------------------------ graduation

/** One KB entry a graduation will write (a distilled contribution), as previewed. */
export const GraduationContributionSchema = z.object({
  /** Den topic id it is emitted under. */
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  /** Markdown. */
  body: z.string(),
  /** The initiative's own entry. */
  initiative: z.boolean(),
  /** The `- ` lines of its History section. */
  history: z.array(z.string()),
  /** The existing entry distill says this is about. */
  target: z.string().optional(),
  /** A standing feature's own pinned entry. */
  feature: z.boolean().optional(),
});
export type GraduationContribution = z.infer<typeof GraduationContributionSchema>;

/**
 * `POST /v1/wolves/:name/work/:id/graduate/preview`: what graduating the item would write to the KB. Nothing is sent
 * or archived. `token` identifies exactly this preview; confirm sends it back.
 */
export const GraduationPreviewSchema = z.object({
  itemId: z.string(),
  kind: z.string(),
  title: z.string(),
  domain: z.string(),
  contributions: z.array(GraduationContributionSchema),
  /** Pending observations folded into the Record just before the entries were distilled. */
  foldedObservations: z.number().int(),
  /** Non-blocking: totals not carried over, secrets redacted, a stale build, missing History lines. */
  warnings: z.array(z.string()),
  /** Set when the entries still break the knowledge lint: they cannot be sent. */
  blocked: z.string().optional(),
  /** Items a confirmed graduation archives (the item first, then what it contains). */
  archive: z.array(z.object({ id: z.string(), title: z.string() })),
  token: z.string(),
  createdAt: IsoSchema,
  /** A preview only exists for a ready item, so `ready` is true here; the field keeps the shape of the readiness check. */
  readiness: z.object({ ready: z.boolean(), reason: z.string().optional() }),
});
export type GraduationPreview = z.infer<typeof GraduationPreviewSchema>;

export const GraduationConfirmBodySchema = z.object({ token: z.string().min(1) });
export type GraduationConfirmBody = z.infer<typeof GraduationConfirmBodySchema>;

/** `POST /v1/wolves/:name/work/:id/graduate/confirm`: the graduation happened (it is all or nothing). */
export const GraduationResultSchema = z.object({
  graduated: z.literal(true),
  /** Den topic ids written to the KB inbox. */
  entries: z.array(z.string()),
  /** Work items archived (the item and what it contained). */
  archived: z.array(z.string()),
  /** Observations that arrived after the preview, folded in and included. */
  lateFolded: z.number().int(),
  /** Conversations on this wolf that were bound to the item or its tasks and are unbound now. */
  unbound: z.number().int(),
  /** Feature threads closed to read-only history. */
  closedThreads: z.array(z.string()),
  /** Non-blocking things that went wrong after the graduation happened (e.g. a feature thread that could not be closed). */
  warnings: z.array(z.string()).optional(),
});
export type GraduationResult = z.infer<typeof GraduationResultSchema>;

/**
 * `POST .../graduate/preview` and `POST .../graduate/confirm` start a background job on the wolf and answer at once with
 * it. A start while a job for the same item is running returns that running job instead of refusing. Poll
 * `GET .../graduate/status` for the outcome.
 */
export const GraduationJobKindSchema = z.enum(["preview", "confirm"]);
export type GraduationJobKind = z.infer<typeof GraduationJobKindSchema>;

export const GraduationJobSchema = z.object({
  jobId: z.string().min(1),
  kind: GraduationJobKindSchema,
  state: z.literal("running"),
  startedAt: IsoSchema,
});
export type GraduationJob = z.infer<typeof GraduationJobSchema>;

/**
 * `GET .../graduate/status`: where the item's graduation stands on this wolf.
 * - `none`: no job and no stored preview.
 * - `running`: a preview or confirm job is running.
 * - `preview_ready`: the preview finished (or was recovered from its token file after a restart); `preview.token` confirms it.
 * - `graduated`: the confirm finished (the result of the graduation).
 * - `error`: the last job failed; `code` is the error code the synchronous route would have answered (`not_ready`,
 *   `preview_stale`, `engine_error`, `memory_unavailable`). Nothing was archived.
 */
export const GraduationStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("none") }),
  GraduationJobSchema,
  z.object({
    state: z.literal("preview_ready"),
    jobId: z.string().optional(),
    preview: GraduationPreviewSchema,
    /** Set when this is the fallback after a failed confirm: the preview is still valid, but the send failed and must not look like a fresh preview. */
    lastError: z.object({ kind: GraduationJobKindSchema, code: ErrorCodeSchema, message: z.string() }).optional(),
  }),
  z.object({ state: z.literal("graduated"), jobId: z.string(), result: GraduationResultSchema }),
  z.object({ state: z.literal("error"), jobId: z.string(), kind: GraduationJobKindSchema, code: ErrorCodeSchema, message: z.string() }),
]);
export type GraduationStatus = z.infer<typeof GraduationStatusSchema>;

/**
 * `GET .../graduate/observations`: the pending observations in this wolf's pool that a graduation of the item would fold
 * (those tagged with the item or any of its descendant tasks), per work item.
 */
export const GraduationObservationsSchema = z.object({
  total: z.number().int(),
  byWork: z.array(z.object({ id: z.string(), title: z.string().optional(), count: z.number().int() })),
});
export type GraduationObservations = z.infer<typeof GraduationObservationsSchema>;

// ------------------------------------------------------------ KB graph

export const KbNodeKindSchema = z.enum(["domain", "factory", "section", "entry", "work", "den-topic"]);
export type KbNodeKind = z.infer<typeof KbNodeKindSchema>;

/** One node. `id` is `dom:<domain>` | `fac:<domain>` | `sec:<sectionId>` | `ent:<entryId>` | `work:<workId>` | `den:<wolf>:<topicId>`. `depth` by kind: domain 0, factory 1, section 1, entry 2, work 3, den topic 4. */
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

export const KbEdgeKindSchema = z.enum(["hierarchy", "partOf", "dependsOn"]);
export type KbEdgeKind = z.infer<typeof KbEdgeKindSchema>;

export const KbGraphEdgeSchema = z.object({
  source: z.string(),
  target: z.string(),
  kind: KbEdgeKindSchema,
});
export type KbGraphEdge = z.infer<typeof KbGraphEdgeSchema>;

export const KbGraphSchema = z.object({
  nodes: z.array(KbGraphNodeSchema),
  edges: z.array(KbGraphEdgeSchema),
  layers: z.object({ archivedWork: z.boolean(), denTopics: z.boolean() }),
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

// --- feature progress: bind a thread to a work item ---
/** Bind the thread's conversation to a work item (a task, issue or spike). Wire: the thread id rides the path. */
export const BindThreadRequestSchema = z.object({ workItemId: z.string().min(1) });
export type BindThreadRequest = z.infer<typeof BindThreadRequestSchema>;
export const BindThreadResponseSchema = z.object({
  threadId: z.string(),
  /** The item the conversation is bound to now. */
  workItemId: z.string(),
  /** What it was bound to before, when that was another item. */
  previousWorkItemId: z.string().optional(),
});
export type BindThreadResponse = z.infer<typeof BindThreadResponseSchema>;
// --- end feature progress ---

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

/**
 * Submit one page of a paged (`ask`) card. `answers` covers the questions of that page (a skippable question may be
 * omitted = skipped). Wire: thread id, `callId` and `page` (0-based, must be the next unanswered page) ride the path.
 */
export const AnswerCardPageBodySchema = z.object({
  // Images reach a question only through bindCardText (the draft): a direct answer with `attachments` is refused.
  answers: CardAnswersSchema.refine((a) => Object.values(a).every((x) => (x as { attachments?: unknown }).attachments === undefined), {
    message: "answers carry no attachments: attach images with bindCardText",
  }),
});
export type AnswerCardPageBody = z.infer<typeof AnswerCardPageBodySchema>;

/**
 * Bind typed text to one question of the current page ("answering Q2"): it is that question's free-text / Other
 * answer held as a draft, NOT a chat message, so it supersedes nothing. Wire: thread id, `callId`, `qid` ride the path.
 */
export const BIND_TEXT_MAX = 4000;
export const BindCardTextBodySchema = z
  .object({
    text: z.string().max(BIND_TEXT_MAX).optional(),
    /** Ids from `uploadAttachment` on this thread (same rules as `SubmitRequest.attachments`: at most ATTACHMENT_MAX_PER_SUBMIT). */
    attachments: z.array(z.string()).max(ATTACHMENT_MAX_PER_SUBMIT).optional(),
  })
  .refine((b) => (b.text ?? "").trim() !== "" || (b.attachments?.length ?? 0) > 0, { message: "give non-blank text or at least one attachment" });
export type BindCardTextBody = z.infer<typeof BindCardTextBodySchema>;

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

