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
  label: Type.String({ description: "Text on the option." }),
  value: Type.Optional(Type.String({ description: "What you get back if it is picked; the label stands in when omitted." })),
  note: Type.Optional(Type.String({ description: "A short line of explanation under the label." })),
});

const Condition = Type.Object(
  {
    field: Type.String({ description: "Id of the question this depends on; it must come earlier in the list." }),
    equals: Type.Optional(Type.Union([Type.String(), Type.Boolean()], { description: "The earlier answer that brings this question up." })),
    oneOf: Type.Optional(Type.Array(Type.String(), { description: "Or: it appears when the earlier answer is any of these choice values." })),
  },
  { description: "Show this question only after a particular earlier answer. Set equals or oneOf; never both." },
);

const Question = Type.Object({
  id: Type.Optional(Type.String({ description: "Your own handle for this question; unnamed ones are numbered by position." })),
  ask: Type.String({ description: "The question text." }),
  note: Type.Optional(Type.String({ description: "A short line shown under the question." })),
  kind: Type.Optional(
    Type.Union([Type.Literal("single"), Type.Literal("multi"), Type.Literal("confirm"), Type.Literal("free")], {
      description: "single = pick one choice, multi = pick several, confirm = yes or no, free = typed reply. Without a kind, a question with choices is single and one without is free.",
    }),
  ),
  choices: Type.Optional(Type.Array(Choice, { description: "The options for single and multi (required there, not allowed for confirm or free)." })),
  allowOther: Type.Optional(Type.Boolean({ description: "Let the owner type their own answer too. On by default for single, off for multi." })),
  min: Type.Optional(Type.Integer({ description: "multi only: the smallest number of picks." })),
  max: Type.Optional(Type.Integer({ description: "multi only: the largest number of picks." })),
  yesLabel: Type.Optional(Type.String({ description: "confirm only: text of the yes button." })),
  noLabel: Type.Optional(Type.String({ description: "confirm only: text of the no button." })),
  optional: Type.Optional(Type.Boolean({ description: "The owner may leave this one unanswered." })),
  showIf: Type.Optional(Condition),
});

const Params = Type.Object({
  headline: Type.String({ description: `What this is about, in one line of at most ${BRIEF_LIMITS.headline} characters.` }),
  context: Type.Optional(
    Type.Array(Type.String(), { description: `At most ${BRIEF_LIMITS.contextBullets} bullets with the facts the owner needs; aim for ${BRIEF_LIMITS.bulletSoftChars} characters or fewer each.` }),
  ),
  questions: Type.Optional(Type.Array(Question, { description: `Zero to ${BRIEF_LIMITS.questions} questions. With zero, the owner only acknowledges.` })),
  steps: Type.Optional(
    Type.Array(Type.Object({ title: Type.Optional(Type.String()), questions: Type.Array(Type.String()) }), {
      description: "Spread the questions over several pages. Each page lists the ids it holds; together the pages cover every question exactly once and keep the original order.",
    }),
  ),
  more: Type.Optional(Type.String({ description: 'A hint about where the full detail sits in your thread; the card links to it as "Open thread for more". Long detail belongs in your thread message, not in the bullets.' })),
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

const usableChoices = (q: BriefQuestion): number => (q.choices ?? []).filter((c) => c.label?.trim()).length;
/** The kind a question resolves to: the stated one, else single when it has choices and free when it has none. */
const kindOf = (q: BriefQuestion): NonNullable<BriefQuestion["kind"]> => q.kind ?? (usableChoices(q) > 0 ? "single" : "free");

function fieldOf(q: BriefQuestion, id: string): Card["fields"][number] {
  const note = q.note?.trim();
  const showIf = q.showIf ? { field: cleanId(q.showIf.field), ...(q.showIf.oneOf ? { oneOf: q.showIf.oneOf } : { equals: q.showIf.equals as string | boolean }) } : undefined;
  const base = { id, label: q.ask.trim(), ...(note ? { description: note } : {}), ...(showIf ? { showIf } : {}), ...(q.optional ? { optional: true as const } : {}) };
  const options: CardOption[] = (q.choices ?? [])
    .filter((c) => c.label?.trim())
    .map((c) => ({ label: c.label.trim(), value: c.value?.trim() || c.label.trim(), ...(c.note?.trim() ? { description: c.note.trim() } : {}) }));
  const kind = kindOf(q);
  if (kind === "confirm") {
    return { ...base, kind: "confirm", ...(q.yesLabel?.trim() ? { confirmLabel: q.yesLabel.trim() } : {}), ...(q.noLabel?.trim() ? { rejectLabel: q.noLabel.trim() } : {}) };
  }
  if (kind === "free") return { ...base, kind: "free-text" };
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
  if (blank >= 0) return `brief: questions[${blank}] is missing its \`ask\` text; every question needs one.`;
  const ids = questions.map(idOf);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) return `brief: two questions share the id "${dup}"; give each a different id.`;
  for (const [i, q] of questions.entries()) {
    const kind = kindOf(q);
    const n = usableChoices(q);
    if ((kind === "single" || kind === "multi") && n === 0) return `brief: questions[${i}] is kind "${kind}" but has no choices. Add \`choices\`, or use kind "free" for a typed reply.`;
    if ((kind === "confirm" || kind === "free") && (q.choices?.length ?? 0) > 0) return `brief: questions[${i}] is kind "${kind}", which takes no \`choices\`. Drop them, or use kind "single" or "multi".`;
  }
  const badMulti = questions.findIndex((q) => (q.min !== undefined || q.max !== undefined) && q.kind !== "multi");
  if (badMulti >= 0) return `brief: questions[${badMulti}] sets min or max, but pick limits exist only on multi questions; remove them or change its kind to multi.`;
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
    content: [{ type: "text" as const, text: `Brief delivered (${n === 0 ? "nothing to answer, just an OK" : `${n} question${n > 1 ? "s" : ""} for the owner`}). This turn is over; the owner's response will open your next one.` }],
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
          `Finish your turn by handing the owner a short brief when they have to decide, answer or review something. It appears as a card: a headline (${BRIEF_LIMITS.headline} characters at most), up to ${BRIEF_LIMITS.contextBullets} context bullets, and zero to ${BRIEF_LIMITS.questions} questions of kind single, multi, confirm or free. Without questions the owner just presses OK. Keep the card terse: put the long detail in your thread message and refer to it through \`more\`.`,
        parameters: Params,
        raisesCard: true,
        async execute(args) {
          return briefResult(args as BriefArgs);
        },
      }),
    ],
  });
}
