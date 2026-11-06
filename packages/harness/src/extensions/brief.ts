/**
 * `brief`: the tool a wolf ends a turn with when the owner has to decide, answer or review something.
 *
 * It raises one card (engine/cards.ts `cardResult` path, same plumbing as every card): a header (headline, a few
 * context bullets, an optional pointer to the thread) above 0 to 3 questions. With no questions the card offers an
 * "OK" acknowledge; a free-text reply always works. Written for this repo; it shares no code with the older
 * ask-user-question tool, which is now a thin alias (see ask-user-question.ts).
 */
import { BRIEF_LIMITS, CardSchema, type Card, type CardOption } from "@wolfpack/protocol";
import { defineExtension, defineTool, Type, type Extension } from "../extension-api.js";

const Choice = Type.Object({
  label: Type.String({ description: "What the owner sees." }),
  value: Type.Optional(Type.String({ description: "What comes back to you; defaults to the label." })),
  note: Type.Optional(Type.String({ description: "One line of explanation." })),
});

const Condition = Type.Object({
  field: Type.String({ description: "Id of an earlier question." }),
  equals: Type.Optional(Type.Union([Type.String(), Type.Boolean()])),
  oneOf: Type.Optional(Type.Array(Type.String())),
});

const Question = Type.Object({
  id: Type.Optional(Type.String({ description: "Short id keying the answer. Defaults to q1, q2, ..." })),
  ask: Type.String({ description: "The question." }),
  note: Type.Optional(Type.String({ description: "Optional line under the question." })),
  kind: Type.Optional(
    Type.Union([Type.Literal("single"), Type.Literal("multi"), Type.Literal("confirm"), Type.Literal("free")], {
      description: "single: pick one of `choices`. multi: pick several. confirm: yes/no. free: typed answer. Default: single when `choices` is given, else free.",
    }),
  ),
  choices: Type.Optional(Type.Array(Choice, { description: "For single and multi." })),
  allowOther: Type.Optional(Type.Boolean({ description: "Offer a typed entry beside the choices. single: default true. multi: default false." })),
  min: Type.Optional(Type.Integer({ description: "multi: fewest picks." })),
  max: Type.Optional(Type.Integer({ description: "multi: most picks." })),
  yesLabel: Type.Optional(Type.String({ description: "confirm: label of the yes button." })),
  noLabel: Type.Optional(Type.String({ description: "confirm: label of the no button." })),
  optional: Type.Optional(Type.Boolean({ description: "The owner may leave it blank." })),
  showIf: Type.Optional(Condition),
});

const Params = Type.Object({
  headline: Type.String({ description: `One line saying what this is about, at most ${BRIEF_LIMITS.headline} characters.` }),
  context: Type.Optional(
    Type.Array(Type.String(), { description: `Up to ${BRIEF_LIMITS.contextBullets} short bullets (about ${BRIEF_LIMITS.bulletSoftChars} characters each) the owner needs to answer.` }),
  ),
  questions: Type.Optional(Type.Array(Question, { description: `0 to ${BRIEF_LIMITS.questions} questions. With none, the owner just acknowledges.` })),
  steps: Type.Optional(Type.Array(Type.Object({ title: Type.Optional(Type.String()), questions: Type.Array(Type.String()) }), { description: "Optional wizard pages: question ids per step, every question once, in order." })),
  more: Type.Optional(Type.String({ description: 'Where the detail is in the thread (shown as "Open thread for more"). Put long detail in your thread message, not the bullets.' })),
});

export interface BriefQuestion {
  id?: string;
  ask: string;
  note?: string;
  kind?: "single" | "multi" | "confirm" | "free";
  choices?: { label: string; value?: string; note?: string }[];
  allowOther?: boolean;
  min?: number;
  max?: number;
  yesLabel?: string;
  noLabel?: string;
  optional?: boolean;
  showIf?: { field: string; equals?: string | boolean; oneOf?: string[] };
}

export interface BriefArgs {
  headline: string;
  context?: string[];
  questions?: BriefQuestion[];
  steps?: { title?: string; questions: string[] }[];
  more?: string;
}

const TRIM_HINT = "Trim it, or move the detail into your thread message and point at it with `more`.";
const cleanId = (id: string): string => id.trim().replace(/[^A-Za-z0-9_-]+/g, "-");
const idOf = (q: BriefQuestion, i: number): string => (q.id ? cleanId(q.id) : "") || `q${i + 1}`;

function fieldOf(q: BriefQuestion, id: string): Card["fields"][number] {
  const note = q.note?.trim();
  const showIf = q.showIf ? { field: cleanId(q.showIf.field), ...(q.showIf.oneOf ? { oneOf: q.showIf.oneOf } : { equals: q.showIf.equals as string | boolean }) } : undefined;
  const base = { id, label: q.ask.trim(), ...(note ? { description: note } : {}), ...(showIf ? { showIf } : {}), ...(q.optional ? { optional: true as const } : {}) };
  const options: CardOption[] = (q.choices ?? [])
    .filter((c) => c.label?.trim())
    .map((c) => ({ label: c.label.trim(), value: c.value?.trim() || c.label.trim(), ...(c.note?.trim() ? { description: c.note.trim() } : {}) }));
  const kind = q.kind ?? (options.length > 0 ? "single" : "free");
  if (kind === "confirm") {
    return { ...base, kind: "confirm", ...(q.yesLabel?.trim() ? { confirmLabel: q.yesLabel.trim() } : {}), ...(q.noLabel?.trim() ? { rejectLabel: q.noLabel.trim() } : {}) };
  }
  if (kind === "free" || options.length === 0) return { ...base, kind: "free-text" };
  if (kind === "multi") return { ...base, kind: "multi", options, allowOther: q.allowOther ?? false, ...(q.min !== undefined ? { min: q.min } : {}), ...(q.max !== undefined ? { max: q.max } : {}) };
  return { ...base, kind: "single", options, ...(q.allowOther === false ? { allowOther: false } : {}) };
}

/** The card for a brief call; `tool` names the raising tool (`brief`, or `ask_user_question` for the alias). */
export function briefCard(args: BriefArgs, tool = "brief"): Card {
  const context = (args.context ?? []).map((b) => b.trim()).filter(Boolean);
  const more = args.more?.trim();
  const questions = args.questions ?? [];
  const steps = args.steps?.map((s) => ({ ...(s.title?.trim() ? { title: s.title.trim() } : {}), fields: s.questions.map(cleanId) }));
  return {
    tool,
    fields: questions.map((q, i) => fieldOf(q, idOf(q, i))),
    brief: { headline: args.headline.trim(), ...(context.length > 0 ? { context } : {}), ...(more ? { more } : {}) },
    ...(steps ? { steps } : {}),
  };
}

/** Why a call cannot become a card (model-facing, says how to fix it), or undefined. */
export function briefProblem(args: BriefArgs): string | undefined {
  const headline = args.headline?.trim() ?? "";
  if (headline === "") return "brief needs a `headline`: one line saying what this is about.";
  if (headline.length > BRIEF_LIMITS.headline) return `brief: the headline is ${headline.length} characters; the limit is ${BRIEF_LIMITS.headline}. ${TRIM_HINT}`;
  const bullets = (args.context ?? []).filter((b) => b.trim());
  if (bullets.length > BRIEF_LIMITS.contextBullets) return `brief: ${bullets.length} context bullets; the limit is ${BRIEF_LIMITS.contextBullets}. ${TRIM_HINT}`;
  const questions = args.questions ?? [];
  if (questions.length > BRIEF_LIMITS.questions) return `brief: ${questions.length} questions; the limit is ${BRIEF_LIMITS.questions}. Ask the most important ones, or ${TRIM_HINT.toLowerCase()}`;
  const blank = questions.findIndex((q) => !q.ask?.trim());
  if (blank >= 0) return `brief: questions[${blank}] has no \`ask\` text.`;
  const ids = questions.map(idOf);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) return `brief: duplicate question id "${dup}"; ids must be unique.`;
  const badMulti = questions.findIndex((q) => (q.min !== undefined || q.max !== undefined) && q.kind !== "multi");
  if (badMulti >= 0) return `brief: questions[${badMulti}] sets min/max, which only apply to kind "multi".`;
  const parsed = CardSchema.safeParse(briefCard(args));
  if (!parsed.success) return `brief: ${parsed.error.issues[0]?.message ?? "the call does not make a valid card"}.`;
  return undefined;
}

/** The tool result of a brief call, shared with the ask_user_question alias. */
export function briefResult(args: BriefArgs, tool = "brief") {
  const problem = briefProblem(args);
  if (problem) return { content: [{ type: "text" as const, text: problem }], isError: true as const };
  const n = args.questions?.length ?? 0;
  return {
    content: [{ type: "text" as const, text: `Brief shown to the owner (${n === 0 ? "no questions; they acknowledge" : `${n} question${n > 1 ? "s" : ""}`}). Your turn ends here; their reply arrives with your next turn.` }],
    card: briefCard(args, tool),
  };
}

export function createBriefExtension(): Extension {
  return defineExtension({
    name: "brief",
    runtimes: ["pi-durable"],
    tools: [
      defineTool({
        name: "brief",
        description:
          `End your turn with a short brief for the owner when they must decide, answer or review a result. Shows a card: a headline (max ${BRIEF_LIMITS.headline} chars), up to ${BRIEF_LIMITS.contextBullets} context bullets, and 0 to ${BRIEF_LIMITS.questions} questions (single, multi, confirm, free). With no questions the owner acknowledges with OK. Their reply arrives at the start of your next turn. Keep detail in your thread message and point at it with \`more\`.`,
        parameters: Params,
        raisesCard: true,
        async execute(args) {
          return briefResult(args as BriefArgs);
        },
      }),
    ],
  });
}
