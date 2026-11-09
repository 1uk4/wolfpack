/**
 * The `ask` questionnaire's record: for a paged card, what each question was, its context and how it ended. Pure
 * functions over the card and the page answers, shared by wolfd (superseded note) and the console / transcript record.
 */
import { CardSchema, type Card, type CardAnswers, type CardClosed, type CardField, type CardFieldAnswer } from "./schemas.js";

export type AskQuestionState = "answered" | "skipped" | "unanswered";

export interface AskRecordItem {
  id: string;
  page: number;
  ask: string;
  /** The question's markdown context (the field description). */
  context?: string;
  /** Id of a rendered diagram (`GET /v1/threads/:id/diagrams/:diagramId`). */
  diagram?: string;
  state: AskQuestionState;
  /** Present when `state` is `answered`. */
  answer?: CardFieldAnswer;
  /** The answer is typed text bound to the question and never submitted (a draft): `state` is `answered` all the same. */
  draft?: true;
}

export interface AskRecord {
  /** `answered`: every page submitted. `superseded`: a plain message replaced the open set. `open`: still pending. */
  state: "answered" | "superseded" | "open";
  items: AskRecordItem[];
}

const pagesOf = (card: Card): string[][] => (card.steps ?? [{ fields: card.fields.map((f) => f.id) }]).map((s) => s.fields);

/** Plain-text rendering of one answer (no option labels: the record keeps the answer value). */
export function plainAnswer(field: CardField, a: CardFieldAnswer): string {
  const v = (a as { value: unknown }).value;
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "string") return (a as { other?: boolean }).other === true ? `other: ${JSON.stringify(v)}` : v;
  return String(v);
}

/**
 * Record of a paged card. `submittedPages` is how many pages were submitted (their unanswered questions are
 * `skipped`); questions on later pages are `unanswered`. `closed` is how the card ended, undefined while pending.
 * `draft` is text typed for questions of the current page but not submitted: it counts as an answer (marked `draft`),
 * never as `unanswered`.
 */
export function askRecord(card: Card, pageAnswers: CardAnswers | undefined, submittedPages: number, closed?: CardClosed, draft?: CardAnswers): AskRecord {
  const items: AskRecordItem[] = [];
  pagesOf(card).forEach((ids, page) => {
    for (const id of ids) {
      const f = card.fields.find((x) => x.id === id);
      if (!f) continue;
      const submitted = page < submittedPages;
      const typed = !submitted ? draft?.[id] : undefined;
      const a = pageAnswers?.[id] ?? typed;
      const state: AskQuestionState = a !== undefined ? "answered" : submitted ? "skipped" : "unanswered";
      items.push({ id, page, ask: f.label, ...(f.description ? { context: f.description } : {}), ...(f.diagram ? { diagram: f.diagram } : {}), state, ...(a !== undefined ? { answer: a } : {}), ...(a !== undefined && pageAnswers?.[id] === undefined ? { draft: true as const } : {}) });
    }
  });
  const state = closed === "superseded" ? "superseded" : submittedPages >= pagesOf(card).length || closed === "answered" ? "answered" : "open";
  return { state, items };
}

/** One line (no newline) saying where a superseded questionnaire stood: used in the superseded note. */
export function askSupersedeDetail(card: Card, pageAnswers: CardAnswers | undefined, submittedPages: number, draft?: CardAnswers): string {
  const rec = askRecord(card, pageAnswers, submittedPages, "superseded", draft);
  // Each answer is cut to 500 characters: a free-text page answer can be long, and the note travels with the owner's message.
  const one = (s: string) => {
    const t = s.replace(/\s+/g, " ").trim();
    return t.length > 500 ? `${t.slice(0, 500)}...` : t;
  };
  const part = (i: AskRecordItem) => {
    const f = card.fields.find((x) => x.id === i.id)!;
    return `${one(i.ask)} => ${i.state === "answered" ? one(plainAnswer(f, i.answer!)) + (i.draft ? " (typed, not submitted)" : "") : i.state}`;
  };
  return rec.items.map(part).join("; ");
}

/** The sub-card holding only page `page` of a paged card (what one page submission is validated against). */
export function pageCard(card: Card, page: number): Card | undefined {
  const step = card.steps?.[page];
  if (!step) return undefined;
  const ids = new Set(step.fields);
  return { tool: card.tool, fields: card.fields.filter((f) => ids.has(f.id)) };
}

/**
 * The card after an `ask_revise`: the first `pagesDone` pages stay, the rest are replaced by the revision's pages.
 * Undefined when the result would not be a valid card (e.g. a replacement reuses an id): nothing changes then.
 */
export function reviseCard(card: Card, pagesDone: number, revision: Card): Card | undefined {
  if (!card.paged || !card.steps || !revision.steps) return undefined;
  const keptSteps = card.steps.slice(0, pagesDone);
  const keptIds = new Set(keptSteps.flatMap((s) => s.fields));
  const parsed = CardSchema.safeParse({
    ...card,
    fields: [...card.fields.filter((f) => keptIds.has(f.id)), ...revision.fields],
    steps: [...keptSteps, ...revision.steps],
  });
  return parsed.success ? parsed.data : undefined;
}
