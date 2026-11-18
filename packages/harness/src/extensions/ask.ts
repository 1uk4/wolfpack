/**
 * `ask`: the questionnaire a wolf raises when it needs the owner's input.
 *
 * The wolf's normal chat message gives the big picture; `ask` carries structured questions, each with its own context.
 * It raises ONE paged card (engine/cards.ts path): `steps` are the pages, `paged: true`. Answers reach the agent after
 * each page; the card stays pending until the last page. `ask_revise` replaces the pages not yet answered.
 */
import type { Static } from "typebox";
import { CardSchema, DIAGRAM_ID_RE, sliderProblem, type Card, type CardField } from "@wolfpack/protocol";
import { defineExtension, defineTool, Type, type Extension } from "../extension-api.js";

const Choice = Type.Object({
  label: Type.String({ description: "Text on the option." }),
  value: Type.String({ description: "What you get back if it is picked." }),
  tradeoff: Type.String({ description: "REQUIRED, non-empty: what choosing this costs or implies. Every option states its trade-off." }),
});

const Question = Type.Object({
  id: Type.String({ description: "Your handle for this question; unique across the whole questionnaire." }),
  ask: Type.String({ description: "The question text." }),
  kind: Type.Union([Type.Literal("single"), Type.Literal("multi"), Type.Literal("confirm"), Type.Literal("free"), Type.Literal("slider")], {
    description: "single = pick one, multi = pick several, confirm = yes/no, free = typed reply, slider = one number on a scale.",
  }),
  context: Type.Optional(Type.String({ description: "Markdown the owner needs to answer THIS question (each question carries its own context)." })),
  diagram: Type.Optional(Type.String({ description: "Id of a diagram you rendered: the filename of a PNG a diagram tool persisted in the viz dir (viz-<slug>-<ms>.png). An id only, never a path or URL." })),
  choices: Type.Optional(Type.Array(Choice, { description: "single/multi only." })),
  min: Type.Optional(Type.Number({ description: "slider: lowest value (< max)." })),
  max: Type.Optional(Type.Number({ description: "slider: highest value." })),
  step: Type.Optional(Type.Number({ description: "slider: increment (> 0)." })),
  default: Type.Optional(Type.Number({ description: "slider: pre-selected value, within range and on a step." })),
  minLabel: Type.Optional(Type.String({ description: "slider: caption of the low end." })),
  maxLabel: Type.Optional(Type.String({ description: "slider: caption of the high end." })),
  required: Type.Optional(Type.Boolean({ description: "Default false: every question may be skipped." })),
  noOther: Type.Optional(Type.Boolean({ description: 'Default false: single/multi offer "Other (type it)". Set true to hide it.' })),
});

const Page = Type.Object({ title: Type.String({ description: "Page title." }), questions: Type.Array(Question, { description: "At least one." }) });

const AskParams = Type.Object({
  pages: Type.Array(Page, { description: "The pages, answered one at a time. At least one." }),
});
const ReviseParams = Type.Object({
  callId: Type.String({ description: "The call id of the ask whose remaining pages you replace (given in the page result)." }),
  pages: Type.Array(Page, { description: "Replacement for ALL pages not yet answered. Question ids must not repeat ones already used." }),
});

export type AskArgs = Static<typeof AskParams>;
export type AskPage = AskArgs["pages"][number];
export type AskQuestion = AskPage["questions"][number];
export type AskChoice = NonNullable<AskQuestion["choices"]>[number];

/** Why a call cannot become a card (model-facing, says how to fix it), or undefined. `usedIds` are ids a revise may not reuse. */
export function askProblem(args: AskArgs, usedIds: readonly string[] = [], diagramCheck?: (id: string) => string | undefined): string | undefined {
  if (!Array.isArray(args.pages) || args.pages.length === 0) return "ask needs at least one page.";
  const seen = new Set<string>(usedIds);
  for (const [p, page] of args.pages.entries()) {
    if (!page.title?.trim()) return `ask: pages[${p}] needs a title.`;
    if (!page.questions?.length) return `ask: pages[${p}] has no questions.`;
    for (const [i, q] of page.questions.entries()) {
      const at = `pages[${p}].questions[${i}]`;
      if (!q.id?.trim()) return `ask: ${at} needs an id.`;
      if (seen.has(q.id)) return `ask: the question id "${q.id}" is used twice; ids are unique across the questionnaire.`;
      seen.add(q.id);
      if (q.diagram !== undefined) {
        const bad = diagramCheck ? diagramCheck(q.diagram.trim()) : DIAGRAM_ID_RE.test(q.diagram.trim()) ? undefined : "not a diagram id";
        if (bad) return `ask: ${at}.diagram: ${bad}`;
      }
      if (!q.ask?.trim()) return `ask: ${at} is missing its \`ask\` text.`;
      if (q.kind === "single" || q.kind === "multi") {
        if (!q.choices?.length) return `ask: ${at} is kind "${q.kind}" but has no choices.`;
        const bad = q.choices.findIndex((c) => !c.label?.trim() || !c.value?.trim());
        if (bad >= 0) return `ask: ${at}.choices[${bad}] needs a label and a value.`;
        const noTrade = q.choices.findIndex((c) => !c.tradeoff?.trim());
        if (noTrade >= 0) return `ask: ${at}.choices[${noTrade}] ("${q.choices[noTrade].label}") needs a non-empty \`tradeoff\`: say what picking it costs or implies.`;
      } else if (q.choices?.length) return `ask: ${at} is kind "${q.kind}", which takes no choices.`;
      if (q.kind === "slider") {
        if (q.min === undefined || q.max === undefined || q.step === undefined) return `ask: ${at} is a slider and needs min, max and step.`;
        const problem = sliderProblem({ min: q.min, max: q.max, step: q.step, ...(q.default !== undefined ? { default: q.default } : {}) });
        if (problem) return `ask: ${at}: ${problem}.`;
      }
    }
  }
  const parsed = CardSchema.safeParse(askCard(args));
  return parsed.success ? undefined : `ask: ${parsed.error.issues[0]?.message ?? "the call does not make a valid card"}.`;
}

function fieldOf(q: AskQuestion): CardField {
  const base = {
    id: q.id,
    label: q.ask.trim(),
    ...(q.context?.trim() ? { description: q.context.trim() } : {}),
    ...(q.diagram?.trim() ? { diagram: q.diagram.trim() } : {}),
    ...(q.required ? {} : { optional: true as const }),
  };
  const options = (q.choices ?? []).map((c) => ({ label: c.label.trim(), value: c.value.trim(), tradeoff: c.tradeoff.trim() }));
  switch (q.kind) {
    case "confirm":
      return { ...base, kind: "confirm" };
    case "free":
      return { ...base, kind: "free-text" };
    case "slider":
      return { ...base, kind: "slider", min: q.min!, max: q.max!, step: q.step!, ...(q.default !== undefined ? { default: q.default } : {}), ...(q.minLabel ? { minLabel: q.minLabel } : {}), ...(q.maxLabel ? { maxLabel: q.maxLabel } : {}) };
    case "multi":
      return { ...base, kind: "multi", options, allowOther: !q.noOther };
    default:
      return { ...base, kind: "single", options, allowOther: !q.noOther };
  }
}

/** The paged card for an ask call; `revises` marks a replacement of the remaining pages of that call. */
export function askCard(args: AskArgs, revises?: string): Card {
  return {
    tool: "ask",
    paged: true,
    fields: args.pages.flatMap((p) => p.questions.map(fieldOf)),
    steps: args.pages.map((p) => ({ title: p.title.trim(), fields: p.questions.map((q) => q.id) })),
    ...(revises ? { revises } : {}),
  };
}

export const ASK_TURN_RULE =
  "The owner fills in the pages at their own pace, going back and forth, and submits ONCE: you then get one message with every page's answers and an optional note from the owner. Nothing arrives before that. `ask_revise` can still replace the pages the owner has not moved past yet. A plain chat message from the owner replaces the whole set and arrives with whatever was already answered.";

const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true as const });

export function askResult(args: AskArgs, diagramCheck?: (id: string) => string | undefined) {
  const problem = askProblem(args, [], diagramCheck);
  if (problem) return fail(problem);
  const n = args.pages.length;
  return {
    content: [{ type: "text" as const, text: `Questionnaire delivered (${n} page${n > 1 ? "s" : ""}). This turn is over. ${ASK_TURN_RULE}` }],
    card: askCard(args),
  };
}

export function reviseResult(args: { callId: string; pages: AskPage[] }, usedIds: readonly string[] = [], diagramCheck?: (id: string) => string | undefined) {
  const problem = askProblem({ pages: args.pages }, usedIds, diagramCheck);
  if (problem) return fail(problem);
  return {
    content: [{ type: "text" as const, text: `Remaining pages replaced (${args.pages.length}). This turn is over. ${ASK_TURN_RULE}` }],
    card: askCard({ pages: args.pages }, args.callId),
  };
}

/** What wolfd tells the ask tools about the thread's open questionnaires (the tools cannot see card state themselves). */
export interface AskHost {
  /** The open questionnaire `callId` of the thread owning conversation `conversationId`: the ids a revise may not reuse, or why it cannot be revised. */
  reviseTarget(conversationId: string, callId: string): { usedIds: string[] } | { problem: string };
}

/** Late-bound handle to wolfd's thread state: the tools are installed in the engine before the server exists (like SubagentBridge). */
export class AskBridge {
  host?: AskHost;
}

export interface AskExtensionOptions {
  /** Validates a diagram id against this wolf's published diagrams. Unset: only the id's shape is checked. */
  diagramCheck?: (id: string) => string | undefined;
}

/**
 * ask_revise reaches wolfd's state through the bridge BEFORE its result is produced, so an invalid revise (unknown or
 * closed call, a non-paged card, a reused answered id) is an error result the agent sees. A revise that is valid here
 * but no longer fits when its transcript entry is folded (a page answer raced it) is told to the agent with the next
 * page answer instead (CardTracker.reviseRejected).
 */
export function createAskExtension(bridge: AskBridge = new AskBridge(), opts: AskExtensionOptions = {}): Extension {
  return defineExtension({
    name: "ask",
    runtimes: ["pi-durable"],
    tools: [
      defineTool({
        name: "ask",
        description:
          "Ask the owner structured questions after you have given the big picture in your normal chat message. pages[] each with a title and questions[]; every question has its own markdown `context`. kinds: single, multi, confirm, free, slider. Every choice needs a non-empty `tradeoff`. Questions are skippable unless `required`; single/multi offer an Other box unless `noOther`. A question may show a `diagram` you rendered with a diagram tool and persisted (pass the returned filename). The answers come back together in one message when the owner submits. " + ASK_TURN_RULE,
        parameters: AskParams,
        raisesCard: true,
        async execute(args) {
          return askResult(args as AskArgs, opts.diagramCheck);
        },
      }),
      defineTool({
        name: "ask_revise",
        description: "Replace the pages of an open `ask` questionnaire that the owner has not moved past yet (use the call id from the ask result). Keeps the pages they moved past. Errors if the call id is not an open questionnaire or a question id repeats an answered one.",
        parameters: ReviseParams,
        raisesCard: true,
        async execute(args, ctx) {
          const a = args as Static<typeof ReviseParams>;
          const target = bridge.host?.reviseTarget(String(ctx.conversationId), a.callId);
          if (!target) return fail("ask_revise: questionnaires are not available here.");
          if ("problem" in target) return fail(target.problem);
          return reviseResult(a, target.usedIds, opts.diagramCheck);
        },
      }),
    ],
  });
}
