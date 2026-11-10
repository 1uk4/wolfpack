/**
 * Pending cards, derived from the transcript.
 *
 * A card is pending from the tool-result entry that carries it (engine/cards.ts) until an answer entry names its
 * call, or a plain user message supersedes it (dismissed). Because all of these are durable engine entries, pending
 * state survives reconnect and restart with nothing extra to persist: `reset` re-derives it from a snapshot's
 * entries, `apply` follows the live stream.
 *
 * Answers to a turn's sibling cards: the first ones are held (still pending, `heldAnswer` set, changeable) until the
 * last card is answered, then one submission carries them all. Held answers live in memory only; after a restart
 * those cards show as pending again without their held answer.
 *
 * Paged (`ask`) cards: the owner's progress is a DRAFT kept in memory on wolfd (`PagedState`): the saved answers of
 * every page, the page being viewed, how many pages were moved past (`reached`), text/images bound to questions
 * (`bindText`) and the owner's note. Nothing reaches the model before the single submit (`claimSubmit`), which becomes
 * one card-answer entry. A restart loses the draft (the card is pending again, unanswered): persisting it would need a
 * new transcript entry kind for little gain.
 */
import { ATTACHMENT_MAX_PER_SUBMIT, BIND_TEXT_MAX, pageCard, reviseCard, visibleFields, type AnyField, type Card, type CardAnswers, type CardClosed, type CardFieldAnswer, type PendingCard } from "@wolfpack/protocol";
import { fieldKind, type AnyAnswer } from "./card-kinds/index.js";
import { attachmentIds } from "./card-kinds/types.js";
import { CARD_ANSWER_KIND, USER_ENTRY_KIND, cardOfToolMessage, type CardAnswerData, type EngineEvent } from "../engine/index.js";

type Entry = Extract<EngineEvent, { type: "message_end" }>["entry"];

/** The owner's note on a questionnaire: text and uploaded images, delivered with the answers. */
export interface CardNote {
  text?: string;
  attachments?: string[];
}

export interface ReadyAnswer {
  callId: string;
  card: Card;
  answers: CardAnswers;
  /** The operator skipped this card: `answers` is empty and the model is told it was skipped. */
  skipped?: true;
  /** Paged card: the owner's note (text, images) that goes with the answers. */
  note?: CardNote;
  /** Paged card: a line for the agent, e.g. that its earlier ask_revise was not applied. */
  reviseNote?: string;
  /** Paged card, in memory only: the draft as it stood before the submit claim, to restore it if the submit is withdrawn for good. */
  restore?: PagedState;
}

/** Draft state of a paged card on wolfd. */
export interface PagedState {
  /** The page the owner is viewing. */
  pageIndex: number;
  /** Pages moved past with Next (never goes down); an ask_revise cannot change them. */
  reached: number;
  /** Saved answers of every page. */
  answers: CardAnswers;
  /** Text/images bound to questions (any page), not yet folded into `answers`. */
  draft: CardAnswers;
  note?: CardNote;
}

const freshState = (): PagedState => ({ pageIndex: 0, reached: 0, answers: {}, draft: {} });

/** A sibling's recorded resolution while the others still wait: answers, or an explicit skip. */
type Held = { answers: CardAnswers } | { skipped: true };

const imageCount = (answers: CardAnswers, except?: string): number =>
  Object.entries(answers).reduce((n, [id, a]) => (id === except ? n : n + attachmentIds(a as AnyAnswer).length), 0);

/** Images held on the card besides those of question `except`: saved answers, drafts and the note share one cap. */
const imagesHeld = (st: PagedState, except?: string): number => imageCount(st.answers, except) + imageCount(st.draft, except) + (st.note?.attachments?.length ?? 0);

/** Who asked: a card from a tool other than ask is a tool confirmation; a card on a subagent thread is the child's; else the thread's own. */
export function sourceOf(card: Card, thread: { kind: string; agent?: string; title: string }): NonNullable<PendingCard["source"]> {
  if (card.tool !== "ask") return { kind: "tool", label: card.tool };
  if (thread.kind === "subagent") return { kind: "subagent", label: thread.agent ? `${thread.agent}: ${thread.title}` : thread.title };
  return { kind: "self", label: "you" };
}

export class CardTracker {
  /** Raised, unanswered cards in raise order. */
  private readonly raised = new Map<string, { card: Card; raisedAt: string }>();
  private readonly held = new Map<string, Held>();
  /** Calls whose answer is being submitted: no longer answerable. */
  private readonly claimed = new Set<string>();
  private readonly paged = new Map<string, PagedState>();
  /** Why the last ask_revise of a card was not applied when its transcript entry was folded; told to the agent with the submit. */
  private readonly reviseRejected = new Map<string, string>();
  /** Rejections of an ask_revise folded after the submit claimed the card (its answer is already on its way): the thread tells the agent in a follow-up. */
  private readonly lateRevise: string[] = [];
  /** Cards whose content changed through the transcript (a revise): the thread re-announces them. */
  private readonly changed = new Set<string>();

  constructor(
    private readonly threadId: string,
    private readonly sourceFor?: (card: Card) => NonNullable<PendingCard["source"]>,
  ) {}

  reset(entries: readonly Entry[]): void {
    this.raised.clear();
    this.held.clear();
    this.claimed.clear();
    this.paged.clear();
    this.reviseRejected.clear();
    this.lateRevise.length = 0;
    this.changed.clear();
    for (const e of entries) this.apply(e);
    this.changed.clear();
  }

  /** Rejected ask_revise reasons that came too late for the submit (cleared). */
  takeLateRevise(): string[] {
    return this.lateRevise.splice(0);
  }

  /** Card ids whose content changed since the last call (cleared). */
  takeChanged(): string[] {
    const ids = [...this.changed].filter((id) => this.raised.has(id));
    this.changed.clear();
    return ids;
  }

  /** Fold one engine entry. Returns how each card it closed was closed (empty when none). */
  apply(entry: Entry): Map<string, CardClosed> {
    const closed = new Map<string, CardClosed>();
    if (entry.kind === CARD_ANSWER_KIND) {
      for (const c of (entry.data as unknown as CardAnswerData | undefined)?.cards ?? []) {
        if (this.raised.has(c.callId)) closed.set(c.callId, c.skipped ? "skipped" : "answered");
        this.drop(c.callId);
      }
      return closed;
    }
    // NOTE: any future system writer of `pi.user` entries (reminders, injected context) would dismiss pending cards.
    if (entry.kind === USER_ENTRY_KIND) {
      for (const id of this.dismissAll()) closed.set(id, "superseded");
      return closed;
    }
    if (!entry.kind.startsWith("pi.tool")) return closed;
    const msg = entry.model?.[0] as { toolCallId?: string; timestamp?: number } | undefined;
    const card = cardOfToolMessage(msg);
    if (card?.revises) {
      // ask_revise: replaces the pages the owner has not moved past; it is not a card of its own.
      // The same rules the tool was checked against (`reviseTarget`). A fold that no longer fits is dropped and the
      // agent hears it with the submit.
      const plan = this.reviseTarget(card.revises);
      const orig = this.raised.get(card.revises);
      const next = "problem" in plan ? undefined : reviseCard(plan.card, plan.keep, card);
      if (orig && next) {
        this.raised.set(card.revises, { ...orig, card: next });
        const st = this.paged.get(card.revises);
        if (st) {
          // Saved answers and drafts of questions that are gone are dropped; the rest stays.
          const here = new Set(next.fields.map((f) => f.id));
          const keep = (a: CardAnswers) => Object.fromEntries(Object.entries(a).filter(([id]) => here.has(id)));
          this.paged.set(card.revises, { ...st, pageIndex: Math.min(st.pageIndex, (next.steps?.length ?? 1) - 1), answers: keep(st.answers), draft: keep(st.draft) });
        }
        this.reviseRejected.delete(card.revises);
        this.changed.add(card.revises);
      } else if (orig) {
        const why = "problem" in plan ? plan.problem : "the replacement pages are not a valid questionnaire (a question id is reused?)";
        // A claimed card's answer text was already built: the rejection cannot ride it, so it is told separately.
        if (this.claimed.has(card.revises)) this.lateRevise.push(why);
        else this.reviseRejected.set(card.revises, why);
      }
      return closed;
    }
    if (msg?.toolCallId && card) this.raised.set(msg.toolCallId, { card, raisedAt: new Date(msg.timestamp ?? Date.now()).toISOString() });
    return closed;
  }

  private drop(callId: string): void {
    this.raised.delete(callId);
    this.held.delete(callId);
    this.claimed.delete(callId);
    this.paged.delete(callId);
    this.reviseRejected.delete(callId);
  }

  /** A plain submit supersedes every pending card: held answers are cleared too. */
  dismissAll(): string[] {
    const ids = [...this.raised.keys()];
    for (const id of ids) this.drop(id);
    return ids;
  }

  /**
   * A chat message accepted mid-turn supersedes the cards still waiting. Claimed cards (an answer is being submitted)
   * are left alone: their closure is answered/skipped, and the model must not get both. Returns the closed ids and
   * which of them had a held answer or skip (discarded).
   */
  dismissUnclaimed(): { ids: string[]; heldDiscarded: string[] } {
    const ids = [...this.raised.keys()].filter((id) => !this.claimed.has(id));
    const heldDiscarded = ids.filter((id) => this.held.has(id));
    for (const id of ids) this.drop(id);
    return { ids, heldDiscarded };
  }

  /** The re-send of a withdrawn answer failed for good: the card is pending again, unanswered, so the owner can answer it. A questionnaire gets its drafts and note back. */
  reraise(cards: readonly ReadyAnswer[]): void {
    for (const c of cards) {
      this.claimed.delete(c.callId);
      this.held.delete(c.callId);
      if (!this.raised.has(c.callId)) this.raised.set(c.callId, { card: c.card, raisedAt: new Date().toISOString() });
      if (c.restore) {
        this.paged.set(c.callId, c.restore);
        this.changed.add(c.callId);
      }
    }
  }

  /** Cards waiting for the operator, oldest first; a held one carries its answer. */
  pending(): PendingCard[] {
    return this.raisedCards().filter((p) => !this.claimed.has(p.callId));
  }

  /** Every raised, not yet settled card, claimed ones included (an answer being submitted is still not settled). */
  raisedCards(): PendingCard[] {
    return [...this.raised].map(([callId, r]) => {
      const held = this.held.get(callId);
      return {
        callId,
        threadId: this.threadId,
        card: r.card,
        raisedAt: r.raisedAt,
        ...(this.sourceFor ? { source: this.sourceFor(r.card) } : {}),
        ...(held && "answers" in held ? { heldAnswer: held.answers } : {}),
        ...(held && "skipped" in held ? { heldSkip: true as const } : {}),
        ...(r.card.paged ? this.pagedView(callId) : {}),
      };
    });
  }

  private pagedView(callId: string): Pick<PendingCard, "pageIndex" | "reached" | "pageAnswers" | "draft" | "note"> {
    const st = this.paged.get(callId) ?? freshState();
    const note = st.note && ((st.note.text ?? "") !== "" || (st.note.attachments?.length ?? 0) > 0) ? { note: st.note } : {};
    return { pageIndex: st.pageIndex, reached: st.reached, ...(Object.keys(st.answers).length ? { pageAnswers: st.answers } : {}), ...(Object.keys(st.draft).length ? { draft: st.draft } : {}), ...note };
  }

  /**
   * Hold typed text as the answer of question `qid` ("answering Qn"), on any page of the card. Returns a problem or
   * undefined. Free text takes it as the value; single and multi take it as their Other entry unless the question has
   * `allowOther: false` (`noOther`); slider and confirm take no text. Blank text and text over BIND_TEXT_MAX are
   * refused. The draft replaces the question's saved answer; its images stay unless new ones are given.
   */
  bindText(callId: string, qid: string, text: string, attachments: readonly string[] = [], owned?: (id: string) => boolean, multi?: { picked: string[]; others: string[] }): string | undefined {
    const p = this.get(callId);
    if (!p) return "not_found";
    if (!p.card.paged) return "this card is not a questionnaire";
    if (!multi && text.trim() === "" && attachments.length === 0) return "give non-blank text or at least one attachment";
    if (text.length > BIND_TEXT_MAX) return `text is over ${BIND_TEXT_MAX} characters`;
    const st = this.paged.get(callId) ?? freshState();
    const f = p.card.fields.find((x) => x.id === qid);
    if (!f) return `question "${qid}" is not on this questionnaire`;
    const typed = text.trim() !== "";
    // The question's earlier images (saved answer or draft) stay when no new ones come.
    const earlier = attachmentIds((st.draft[qid] ?? st.answers[qid] ?? {}) as AnyAnswer);
    const capMsg = (n: number) => `at most ${ATTACHMENT_MAX_PER_SUBMIT} images per questionnaire answer (${n} already attached elsewhere)`;
    const settle = (a: CardFieldAnswer): void => {
      const { [qid]: _gone, ...answers } = st.answers;
      this.paged.set(callId, { ...st, answers, draft: { ...st.draft, [qid]: a } });
    };
    if (multi) {
      // A multi question holds a LIST of custom answers: this call replaces the whole picked/custom list.
      if (f.kind !== "multi" || f.allowOther === false) return `question "${qid}" takes no list of custom answers`;
      const optionValues = (f.options as { value: string }[]).map((o) => o.value);
      const others = multi.others.map((o) => o.trim());
      if (others.some((o) => o === "")) return "a custom answer cannot be blank";
      if (new Set(others).size !== others.length) return "duplicate custom answers";
      const dup = others.find((o) => optionValues.includes(o));
      if (dup !== undefined) return `custom answer "${dup}" duplicates an option value`;
      const bad = multi.picked.find((v) => !optionValues.includes(v));
      if (bad !== undefined) return `"${bad}" is not an option of "${qid}"`;
      const keep = attachments.length ? [...attachments] : earlier;
      const elsewhere = imagesHeld(st, qid);
      if (elsewhere + keep.length > ATTACHMENT_MAX_PER_SUBMIT) return capMsg(elsewhere);
      const badImg = owned ? attachments.find((id) => !owned(id)) : undefined;
      if (badImg !== undefined) return `unknown attachment ${badImg}`;
      settle({ value: [...multi.picked, ...others], ...(others.length ? { other: others } : {}), ...(keep.length ? { attachments: keep } : {}) } as CardFieldAnswer);
      return undefined;
    }
    // Images only: no text, so no fake Other entry: `{value: ""}` (multi `{value: []}`) plus the attachments.
    let a: CardFieldAnswer;
    if (f.kind === "free-text") a = { value: text };
    else if (f.kind === "single" && f.allowOther !== false) a = typed ? { value: text, other: true } : { value: "" };
    else if (f.kind === "multi" && f.allowOther !== false) a = typed ? { value: [text], other: [text] } : { value: [] };
    else return `question "${qid}" takes no typed answer`;
    if (attachments.length) {
      // Kind checks are done: now the images (a rebind replaces its own).
      const elsewhere = imagesHeld(st, qid);
      if (elsewhere + attachments.length > ATTACHMENT_MAX_PER_SUBMIT) return capMsg(elsewhere);
      const bad = owned ? attachments.find((id) => !owned(id)) : undefined;
      if (bad !== undefined) return `unknown attachment ${bad}`;
      a = { ...a, attachments: [...attachments] } as CardFieldAnswer;
    } else if (earlier.length) a = { ...a, attachments: earlier } as CardFieldAnswer;
    settle(a);
    return undefined;
  }

  /**
   * Fold `own` (the client's answers for the questions of page `page`) with the draft and the images already held:
   * a client answer wins over the drafted text of its question, and the images of the question's draft or earlier saved
   * answer stay attached (images change only through `bindText`). Questions of the page without an answer take their draft.
   */
  private foldPage(card: Card, st: PagedState, page: number, own: CardAnswers | undefined): { answers: CardAnswers; draft: CardAnswers } {
    const ids = new Set(pageCard(card, page)?.fields.map((f) => f.id));
    const answers = Object.fromEntries(Object.entries(st.answers).filter(([id]) => !ids.has(id)));
    const draft = Object.fromEntries(Object.entries(st.draft).filter(([id]) => !ids.has(id)));
    for (const id of ids) {
      const given = own?.[id];
      const d = st.draft[id];
      const imgs = [...new Set([...attachmentIds(d as AnyAnswer), ...attachmentIds(st.answers[id] as AnyAnswer)])];
      const base = given ?? d ?? (own ? undefined : st.answers[id]);
      if (!base) continue;
      const { attachments: _drop, ...rest } = base as { attachments?: string[] };
      answers[id] = (imgs.length ? { ...rest, attachments: imgs } : rest) as CardFieldAnswer;
    }
    return { answers, draft };
  }

  /**
   * Save page `page` as a draft and move the cursor to `goto` (the caller checks the ranges). Moving forward raises
   * `reached`; it never goes down. The page's bound drafts are folded into the saved answers. Returns a problem
   * (`not_found` for an unknown or claimed card) or undefined.
   */
  savePage(callId: string, page: number, answers: CardAnswers, goto: number): string | undefined {
    const p = this.get(callId);
    if (!p) return "not_found";
    if (!p.card.paged) return "this card is not a questionnaire";
    const st = this.paged.get(callId) ?? freshState();
    const ids = new Set(pageCard(p.card, page)?.fields.map((f) => f.id));
    const folded = this.foldPage(p.card, st, page, Object.fromEntries(Object.entries(answers).filter(([id]) => ids.has(id))));
    this.paged.set(callId, { ...st, ...folded, pageIndex: goto, reached: goto > page ? Math.max(st.reached, page + 1) : st.reached });
    return undefined;
  }

  /** Store the owner's note (an empty one clears it). Returns a problem or undefined. */
  setNote(callId: string, note: CardNote, owned?: (id: string) => boolean): string | undefined {
    const p = this.get(callId);
    if (!p) return "not_found";
    if (!p.card.paged) return "this card is not a questionnaire";
    const st = this.paged.get(callId) ?? freshState();
    const text = note.text ?? "";
    const atts = [...new Set(note.attachments ?? [])];
    const { note: _n, ...withoutNote } = st;
    const held = imagesHeld(withoutNote);
    if (held + atts.length > ATTACHMENT_MAX_PER_SUBMIT) return `at most ${ATTACHMENT_MAX_PER_SUBMIT} images per questionnaire answer (${held} already attached to questions)`;
    const bad = owned ? atts.find((id) => !owned(id)) : undefined;
    if (bad !== undefined) return `unknown attachment ${bad}`;
    const { note: _old, ...rest } = st;
    this.paged.set(callId, text.trim() === "" && atts.length === 0 ? rest : { ...rest, note: { ...(text.trim() !== "" ? { text } : {}), ...(atts.length ? { attachments: atts } : {}) } });
    return undefined;
  }

  /**
   * The answers a submit would deliver: saved answers of every page, the drafts, and `lastAnswers` (the page on screen)
   * folded in. Pure; hidden-field answers are NOT dropped here. Undefined when the card is not an open questionnaire.
   */
  mergedAnswers(callId: string, lastAnswers?: CardAnswers): CardAnswers | undefined {
    const p = this.get(callId);
    if (!p || !p.card.paged) return undefined;
    const st = this.paged.get(callId) ?? freshState();
    const ids = new Set(pageCard(p.card, st.pageIndex)?.fields.map((f) => f.id));
    const folded = this.foldPage(p.card, st, st.pageIndex, lastAnswers && Object.fromEntries(Object.entries(lastAnswers).filter(([id]) => ids.has(id))));
    // Drafts of the other pages (never saved with Next) are answers too.
    const out: CardAnswers = { ...folded.answers };
    for (const [id, d] of Object.entries(folded.draft)) if (!(id in out)) out[id] = d;
    return out;
  }

  /**
   * Claim the whole questionnaire for submission: one ready answer with every page's answers (`answers`, from
   * `mergedAnswers` after the caller validated them) and the note (`note` replaces the stored one when given). The draft is
   * kept in `restore` in case the submit is withdrawn for good. Undefined when the card is not an open questionnaire.
   */
  claimSubmit(callId: string, answers: CardAnswers, note?: CardNote): ReadyAnswer | undefined {
    const p = this.get(callId);
    if (!p || !p.card.paged) return undefined;
    const st = this.paged.get(callId) ?? freshState();
    const finalNote = note ?? st.note;
    const reviseNote = this.reviseRejected.get(callId);
    this.reviseRejected.delete(callId);
    this.claimed.add(callId);
    const hasNote = finalNote && ((finalNote.text ?? "").trim() !== "" || (finalNote.attachments?.length ?? 0) > 0);
    return { callId, card: p.card, answers, ...(hasNote ? { note: finalNote } : {}), ...(reviseNote ? { reviseNote } : {}), restore: st };
  }

  /**
   * What an `ask_revise` of `callId` may do right now: how many pages stay (those the owner moved past) and the
   * question ids that therefore cannot be reused. A `problem` is model-facing.
   */
  reviseTarget(callId: string): { keep: number; usedIds: string[]; card: Card } | { problem: string } {
    const r = this.raised.get(callId);
    if (!r) return { problem: `ask_revise: there is no open questionnaire with call id "${callId}" (unknown, already complete, skipped or superseded).` };
    if (!r.card.paged || !r.card.steps) return { problem: `ask_revise: call "${callId}" is not an ask questionnaire.` };
    if (this.claimed.has(callId)) return { problem: `ask_revise: "${callId}" is being submitted; nothing left to replace.` };
    const keep = this.paged.get(callId)?.reached ?? 0;
    if (keep >= r.card.steps.length) return { problem: `ask_revise: the owner has moved past every page of "${callId}"; there is nothing left to replace.` };
    return { keep, usedIds: r.card.steps.slice(0, keep).flatMap((s) => s.fields), card: r.card };
  }

  get(callId: string): PendingCard | undefined {
    return this.pending().find((p) => p.callId === callId);
  }

  /**
   * Record an answer (replacing a held one). When it completes the turn's cards, claims them all and returns them in
   * raise order for the caller to submit; otherwise undefined (siblings still wait). Synchronous: two concurrent
   * answers for the same call cannot both complete.
   */
  answer(callId: string, answers: CardAnswers): ReadyAnswer[] | undefined {
    return this.resolve(callId, { answers });
  }

  /** Record a skip for the card: it counts as that card's resolution (same completion rule as `answer`). */
  skip(callId: string): ReadyAnswer[] | undefined {
    return this.resolve(callId, { skipped: true });
  }

  private resolve(callId: string, resolution: Held): ReadyAnswer[] | undefined {
    this.held.set(callId, resolution);
    const open = [...this.raised].filter(([id]) => !this.claimed.has(id));
    if (open.some(([id]) => !this.held.has(id))) return undefined;
    const ready = open.map(([id, r]): ReadyAnswer => {
      const h = this.held.get(id)!;
      return "answers" in h ? { callId: id, card: r.card, answers: h.answers } : { callId: id, card: r.card, answers: {}, skipped: true };
    });
    for (const r of ready) this.claimed.add(r.callId);
    return ready;
  }

  /** The submission failed: the claimed cards are pending again, answers held. */
  release(callIds: readonly string[]): void {
    for (const id of callIds) this.claimed.delete(id);
  }

  /** The submission was accepted: the answered cards are no longer raised. */
  settle(callIds: readonly string[]): void {
    for (const id of callIds) this.drop(id);
  }

  /** Is the call raised but claimed (its submit is in flight)? */
  isClaimed(callId: string): boolean {
    return this.claimed.has(callId);
  }
}

const SKIPPED = "(skipped)";
const asField = (f: Card["fields"][number]): AnyField => f as unknown as AnyField;

/** An optional field left blank: no answer, or an answer its kind counts as empty. */
function isSkipped(field: Card["fields"][number], a: CardFieldAnswer | undefined): boolean {
  if (a === undefined) return true;
  return fieldKind(field.kind).isEmpty(asField(field), a as AnyAnswer);
}

/** The model-facing text of one answer, by field kind (the kind's own `answerText`). */
export function answerValue(field: Card["fields"][number], a: CardFieldAnswer | undefined): string {
  // An image-only answer whose files are all gone (set by the thread when it delivers the answer).
  if ((a as { imagesGone?: boolean } | undefined)?.imagesGone) return "(image no longer available)";
  if (field.optional && isSkipped(field, a)) return SKIPPED;
  if (!a) return "(no answer)";
  const n = attachmentIds(a).length;
  return fieldKind(field.kind).answerText(asField(field), a as AnyAnswer) + (n ? ` [${n} image${n === 1 ? "" : "s"} attached below]` : "");
}

export { attachmentIds };

/** Question numbers across the whole card: Q1, Q2, ... in page order (what the owner sees and what errors cite). */
export function questionNumbers(card: Card): Map<string, number> {
  const order = card.steps ? card.steps.flatMap((st) => st.fields) : card.fields.map((f) => f.id);
  return new Map(order.map((id, i) => [id, i + 1]));
}

/** The model-facing user message for an answer submission: every card's questions with their answers (or skip), in raise order. */
export function answerText(cards: readonly ReadyAnswer[]): string {
  const lines: string[] = [];
  for (const { callId, card, answers, skipped, note, reviseNote } of cards) {
    if (card.paged && !skipped) {
      if (reviseNote) lines.push(`Note: your earlier ask_revise was NOT applied: ${reviseNote}`);
      const steps = card.steps ?? [{ fields: card.fields.map((f) => f.id) }];
      const nums = questionNumbers(card);
      const what = card.tool === "ask" ? "ask questionnaire" : `${card.tool} confirmation`;
      lines.push(`The user submitted your ${what} (call ${callId}), ${steps.length} page${steps.length === 1 ? "" : "s"}:`);
      steps.forEach((step, i) => {
        const title = (step as { title?: string }).title;
        lines.push(`Page ${i + 1} of ${steps.length}${title ? ` ("${title}")` : ""}:`);
        const ids = new Set(step.fields);
        const shown = new Set(visibleFields(card, answers).map((x) => x.id)); // a question hidden by its showIf was never asked
        for (const f of card.fields.filter((x) => ids.has(x.id) && shown.has(x.id))) lines.push(`- Q${nums.get(f.id)} ${f.label}: ${answerValue(f, answers[f.id])}`);
      });
      const n = note?.attachments?.length ?? 0;
      if ((note?.text ?? "").trim() !== "" || n > 0) lines.push(`Note from the user: ${(note?.text ?? "").trim() || "(no text)"}${n ? ` [${n} image${n === 1 ? "" : "s"} attached below]` : ""}`);
      lines.push("The questionnaire is complete: you may proceed.");
      continue;
    }
    if (skipped) {
      lines.push(`The user skipped your ${card.tool} question (call ${callId}).`);
      continue;
    }
    lines.push(`The user answered your ${card.tool} question (call ${callId}):`);
    for (const f of visibleFields(card, answers)) lines.push(`- ${f.label}: ${answerValue(f, answers[f.id])}`);
  }
  return lines.join("\n");
}

export { stripSupersededNotes, supersededNotes } from "../superseded-note.js";

function validateField(f: Card["fields"][number], a: CardFieldAnswer): string | undefined {
  return fieldKind(f.kind).validate(asField(f), a as AnyAnswer);
}

/**
 * The answers without those of hidden fields. An older console renders every field and may send an answer for one the
 * showIf hides; it is dropped (not an error) so such a client still works. Returns the same object when nothing drops.
 */
export function dropHiddenAnswers(card: Card, answers: CardAnswers): CardAnswers {
  const shown = new Set(visibleFields(card, answers).map((f) => f.id));
  const dropped = Object.keys(answers).filter((k) => !shown.has(k));
  if (dropped.length === 0) return answers;
  console.debug(`[cards] dropped answer(s) for hidden field(s): ${dropped.join(", ")}`);
  return Object.fromEntries(Object.entries(answers).filter(([k]) => shown.has(k)));
}

/** Check answers against the card; returns the problem, or undefined when valid. */
export function validateAnswers(card: Card, answers: CardAnswers): string | undefined {
  const shown = visibleFields(card, answers);
  for (const f of shown) {
    const a = answers[f.id];
    if (f.optional && isSkipped(f, a)) continue;
    if (!a) return `missing answer for field "${f.id}"`;
    const problem = validateField(f, a);
    if (problem) return problem;
  }
  const extra = Object.keys(answers).find((k) => !card.fields.some((f) => f.id === k));
  return extra ? `unknown field "${extra}"` : undefined;
}
