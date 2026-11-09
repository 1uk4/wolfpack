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
 * Paged (`ask`) cards: page progress (`pagesDone`, the submitted answers) is re-derived from the transcript like
 * everything else, so it and the "hold your turn" state (`holdOf`) survive a restart. DRAFTS (text bound to a question
 * with `bindText`) live in memory only and are lost on a restart: persisting them would need a new transcript entry
 * kind for little gain (the owner retypes a line).
 */
import { ATTACHMENT_MAX_PER_SUBMIT, BIND_TEXT_MAX, pageCard, reviseCard, visibleFields, type AnyField, type Card, type CardAnswers, type CardClosed, type CardFieldAnswer, type PendingCard } from "@wolfpack/protocol";
import { fieldKind, type AnyAnswer } from "./card-kinds/index.js";
import { attachmentIds } from "./card-kinds/types.js";
import { CARD_ANSWER_KIND, USER_ENTRY_KIND, cardOfToolMessage, type CardAnswerData, type EngineEvent } from "../engine/index.js";

type Entry = Extract<EngineEvent, { type: "message_end" }>["entry"];

export interface ReadyAnswer {
  callId: string;
  card: Card;
  answers: CardAnswers;
  /** The operator skipped this card: `answers` is empty and the model is told it was skipped. */
  skipped?: true;
  /** Paged (`ask`) card: the page these answers belong to (0-based) and whether it is the last. */
  page?: number;
  final?: true;
  /** Paged card, in memory only: the answers of the earlier pages (to restore progress if this submission is withdrawn for good). */
  prior?: CardAnswers;
  /** Paged card: a line for the agent, e.g. that its earlier ask_revise was not applied. */
  note?: string;
}

/** Progress of a paged card: pages submitted, their answers, and text bound to questions of the current page. */
interface PagedState {
  pagesDone: number;
  answers: CardAnswers;
  draft: CardAnswers;
}

/** A sibling's recorded resolution while the others still wait: answers, or an explicit skip. */
type Held = { answers: CardAnswers } | { skipped: true };

export class CardTracker {
  /** Raised, unanswered cards in raise order. */
  private readonly raised = new Map<string, { card: Card; raisedAt: string }>();
  private readonly held = new Map<string, Held>();
  /** Calls whose answer is being submitted: no longer answerable. */
  private readonly claimed = new Set<string>();
  private readonly paged = new Map<string, PagedState>();
  /** The page being submitted per paged card (and whether it is the last): a revise may not touch it. */
  private readonly claimedPage = new Map<string, { page: number; final: boolean }>();
  /** Why the last ask_revise of a card was not applied when its transcript entry was folded; told to the agent with the next page answer. */
  private readonly reviseRejected = new Map<string, string>();
  /** A revise rejected while the final page was being submitted: told to the agent right after that submission (takeLateNote). */
  private readonly lateNote = new Map<string, string>();
  /** Cards whose content changed through the transcript (a revise or a page answer): the thread re-announces them. */
  private readonly changed = new Set<string>();

  constructor(private readonly threadId: string) {}

  reset(entries: readonly Entry[]): void {
    this.raised.clear();
    this.held.clear();
    this.claimed.clear();
    this.paged.clear();
    this.claimedPage.clear();
    this.reviseRejected.clear();
    this.lateNote.clear();
    this.changed.clear();
    for (const e of entries) this.apply(e);
    this.changed.clear();
  }

  /** The reason a revise was rejected after the final page was claimed (cleared), for the thread to tell the agent. */
  takeLateNote(callId: string): string | undefined {
    const n = this.lateNote.get(callId);
    this.lateNote.delete(callId);
    return n;
  }

  /** For a final page about to be submitted: fold a revise rejection that arrived since the claim into its answer note, so it travels with "complete, proceed". */
  foldLateNote(ready: ReadyAnswer): ReadyAnswer {
    const late = ready.final ? this.takeLateNote(ready.callId) : undefined;
    return late ? { ...ready, note: ready.note ? `${ready.note} ${late}` : late } : ready;
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
        if (c.page !== undefined && !c.final) {
          // A page of a paged card: the card stays pending on the next page. Progress only moves forward: an entry for a
          // page already counted (the thread counts it as soon as the engine accepts it) changes nothing, draft included.
          if (this.raised.has(c.callId)) {
            const st = this.paged.get(c.callId) ?? { pagesDone: 0, answers: {}, draft: {} };
            if (c.page + 1 > st.pagesDone) {
              this.paged.set(c.callId, { pagesDone: c.page + 1, answers: { ...st.answers, ...c.answers }, draft: {} });
              this.changed.add(c.callId);
            }
          }
          continue;
        }
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
      // ask_revise: replaces the unanswered pages of the open paged card; it is not a card of its own.
      // The same rules the tool was checked against (`reviseTarget`); a revise folded while a page answer is in flight
      // keeps that page. A fold that no longer fits is dropped and the agent hears it with the next page answer.
      const plan = this.reviseTarget(card.revises);
      const orig = this.raised.get(card.revises);
      const next = "problem" in plan ? undefined : reviseCard(plan.card, plan.keep, card);
      if (orig && next) {
        this.raised.set(card.revises, { ...orig, card: next });
        const st = this.paged.get(card.revises);
        // Text typed for a question that is no longer on the current page is dropped; the rest stays.
        if (st) {
          const here = new Set(pageCard(next, st.pagesDone)?.fields.map((f) => f.id));
          this.paged.set(card.revises, { ...st, draft: Object.fromEntries(Object.entries(st.draft).filter(([id]) => here.has(id))) });
        }
        this.reviseRejected.delete(card.revises);
        this.changed.add(card.revises);
      } else if (orig) {
        const why = "problem" in plan ? plan.problem : "the replacement pages are not a valid questionnaire (a question id is reused?)";
        // Folded while the LAST page is in flight: no later page answer will carry the note, so the thread sends it on its own.
        if (this.claimedPage.get(card.revises)?.final) this.lateNote.set(card.revises, why);
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
    this.claimedPage.delete(callId);
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

  /** The re-send of a withdrawn answer failed for good: the card is pending again, unanswered, so the owner can answer it. */
  reraise(cards: readonly ReadyAnswer[]): void {
    for (const c of cards) {
      this.claimed.delete(c.callId);
      this.claimedPage.delete(c.callId);
      this.held.delete(c.callId);
      if (!this.raised.has(c.callId)) this.raised.set(c.callId, { card: c.card, raisedAt: new Date().toISOString() });
      if (c.page !== undefined) {
        // A withdrawn PAGE answer never reached the agent (no transcript entry): progress and answers go back to before
        // that page, and what the owner submitted comes back as the draft so nothing typed is lost. Both the non-final
        // case (progress already advanced) and the final one (card was settled, `prior` restores the earlier pages).
        const card = this.raised.get(c.callId)!.card;
        const ids = new Set(pageCard(card, c.page)?.fields.map((f) => f.id));
        const st = this.paged.get(c.callId);
        const kept = c.prior ?? Object.fromEntries(Object.entries(st?.answers ?? {}).filter(([id]) => !ids.has(id)));
        this.paged.set(c.callId, { pagesDone: c.page, answers: kept, draft: Object.fromEntries(Object.entries(c.answers).filter(([id]) => ids.has(id))) });
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
        ...(held && "answers" in held ? { heldAnswer: held.answers } : {}),
        ...(held && "skipped" in held ? { heldSkip: true as const } : {}),
        ...(r.card.paged ? this.pagedView(callId) : {}),
      };
    });
  }

  private pagedView(callId: string): Pick<PendingCard, "pageIndex" | "pageAnswers" | "draft"> {
    const st = this.paged.get(callId);
    return { pageIndex: st?.pagesDone ?? 0, ...(st && Object.keys(st.answers).length ? { pageAnswers: st.answers } : {}), ...(st && Object.keys(st.draft).length ? { draft: st.draft } : {}) };
  }

  /**
   * Hold typed text as the answer of question `qid` on the current page ("answering Qn"). Returns a problem or undefined.
   * Free text takes it as the value; single and multi take it as their Other entry unless the question has `allowOther:
   * false` (`noOther`); slider and confirm take no text. Blank text and text over BIND_TEXT_MAX are refused.
   */
  bindText(callId: string, qid: string, text: string, attachments: readonly string[] = [], owned?: (id: string) => boolean): string | undefined {
    const p = this.get(callId);
    if (!p) return "not_found";
    if (!p.card.paged) return "this card is not a questionnaire";
    if (text.trim() === "" && attachments.length === 0) return "give non-blank text or at least one attachment";
    if (text.length > BIND_TEXT_MAX) return `text is over ${BIND_TEXT_MAX} characters`;
    const st = this.paged.get(callId) ?? { pagesDone: 0, answers: {}, draft: {} };
    const page = pageCard(p.card, st.pagesDone);
    const f = page?.fields.find((x) => x.id === qid);
    if (!f) return `question "${qid}" is not on the current page`;
    const typed = text.trim() !== "";
    // Images only: no text, so no fake Other entry: `{value: ""}` (multi `{value: []}`) plus the attachments.
    let a: CardFieldAnswer;
    if (f.kind === "free-text") a = { value: text };
    else if (f.kind === "single" && f.allowOther !== false) a = typed ? { value: text, other: true } : { value: "" };
    else if (f.kind === "multi" && f.allowOther !== false) a = typed ? { value: [text], other: [text] } : { value: [] };
    else return `question "${qid}" takes no typed answer`;
    if (attachments.length) {
      // Kind checks are done: now the images. Cap is over the drafts of every question of the card (a rebind replaces its own).
      const others = Object.entries(st.draft).filter(([id]) => id !== qid).reduce((n, [, d]) => n + attachmentIds(d as AnyAnswer).length, 0);
      if (others + attachments.length > ATTACHMENT_MAX_PER_SUBMIT) return `at most ${ATTACHMENT_MAX_PER_SUBMIT} images per questionnaire answer (${others} already attached to other questions)`;
      const bad = owned ? attachments.find((id) => !owned(id)) : undefined;
      if (bad !== undefined) return `unknown attachment ${bad}`;
      a = { ...a, attachments: [...attachments] } as CardFieldAnswer;
    }
    this.paged.set(callId, { ...st, draft: { ...st.draft, [qid]: a } });
    return undefined;
  }

  /**
   * Claim the current page of a paged card for submission with `answers` (draft text fills unanswered questions).
   * `final` is computed against the card as it stands now, and the page is pinned: a revise folded while it is in
   * flight can only replace the pages after it. Undefined when the card is not an open questionnaire.
   */
  claimPage(callId: string, answers: CardAnswers): { ready: ReadyAnswer; merged: CardAnswers } | undefined {
    const p = this.get(callId);
    if (!p || !p.card.paged) return undefined;
    const st = this.paged.get(callId) ?? { pagesDone: 0, answers: {}, draft: {} };
    // A question's drafted images stay attached when the submitted answer replaces its value (the pick is the answer).
    const merged: CardAnswers = { ...st.draft, ...answers };
    for (const [id, d] of Object.entries(st.draft)) {
      const imgs = attachmentIds(d as AnyAnswer);
      if (imgs.length && id in answers) merged[id] = { ...answers[id], attachments: imgs } as CardFieldAnswer;
    }
    const final = st.pagesDone >= (p.card.steps?.length ?? 1) - 1;
    const note = this.reviseRejected.get(callId);
    this.reviseRejected.delete(callId);
    this.claimed.add(callId);
    this.claimedPage.set(callId, { page: st.pagesDone, final });
    return { merged, ready: { callId, card: p.card, answers: merged, page: st.pagesDone, prior: st.answers, ...(final ? { final: true as const } : {}), ...(note ? { note } : {}) } };
  }

  /** A non-final page was accepted: the card is answerable again on the next page. Progress never moves back. */
  pageDone(callId: string, page: number, answers: CardAnswers): void {
    const st = this.paged.get(callId) ?? { pagesDone: 0, answers: {}, draft: {} };
    const card = this.raised.get(callId)?.card;
    const ids = new Set(card ? card.fields.map((f) => f.id) : Object.keys(answers));
    const own = Object.fromEntries(Object.entries(answers).filter(([id]) => ids.has(id)));
    this.paged.set(callId, { pagesDone: Math.max(st.pagesDone, page + 1), answers: { ...st.answers, ...own }, draft: {} });
    this.claimed.delete(callId);
    this.claimedPage.delete(callId);
  }

  /**
   * What an `ask_revise` of `callId` may do right now: how many pages stay (answered ones, plus the one being
   * submitted) and the question ids that therefore cannot be reused. A `problem` is model-facing.
   */
  reviseTarget(callId: string): { keep: number; usedIds: string[]; card: Card } | { problem: string } {
    const r = this.raised.get(callId);
    if (!r) return { problem: `ask_revise: there is no open questionnaire with call id "${callId}" (unknown, already complete, skipped or superseded).` };
    if (!r.card.paged || !r.card.steps) return { problem: `ask_revise: call "${callId}" is not an ask questionnaire.` };
    const done = this.paged.get(callId)?.pagesDone ?? 0;
    const pinned = this.claimedPage.get(callId);
    if (pinned?.final) return { problem: `ask_revise: the last page of "${callId}" is being submitted; nothing left to replace.` };
    const keep = Math.max(done, pinned ? pinned.page + 1 : 0);
    if (keep >= r.card.steps.length) return { problem: `ask_revise: every page of "${callId}" is already answered or being submitted; there is nothing left to replace.` };
    return { keep, usedIds: r.card.steps.slice(0, keep).flatMap((s) => s.fields), card: r.card };
  }

  /** Hold-your-turn: the paged card, if any, whose first page was answered and that is not yet complete. Derived, so it survives a restart. */
  holdOf(): { callId: string; page: number; total: number } | undefined {
    for (const [callId, r] of this.raised) {
      const done = this.paged.get(callId)?.pagesDone ?? 0;
      if (this.claimedPage.get(callId)?.final) continue; // the last page is being submitted: the agent may proceed
      if (r.card.paged && done >= 1) return { callId, page: done + 1, total: r.card.steps?.length ?? 1 };
    }
    return undefined;
  }

  /** The paged progress of a card, for notes and records. */
  pagedProgress(callId: string): { pagesDone: number; answers: CardAnswers; draft: CardAnswers } | undefined {
    const st = this.paged.get(callId);
    return st ? { pagesDone: st.pagesDone, answers: st.answers, draft: st.draft } : undefined;
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
    for (const id of callIds) {
      this.claimed.delete(id);
      this.claimedPage.delete(id);
    }
  }

  /** The submission was accepted: the answered cards are no longer raised. */
  settle(callIds: readonly string[]): void {
    for (const id of callIds) this.drop(id);
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

/** The model-facing user message for an answer submission: every card's questions with their answers (or skip), in raise order. */
export function answerText(cards: readonly ReadyAnswer[]): string {
  const lines: string[] = [];
  for (const { callId, card, answers, skipped, page, final, note } of cards) {
    if (page !== undefined && card.paged) {
      if (note) lines.push(`Note: your earlier ask_revise was NOT applied: ${note}`);
      const total = card.steps?.length ?? 1;
      const step = card.steps?.[page];
      lines.push(`The user submitted page ${page + 1} of ${total}${step?.title ? ` ("${step.title}")` : ""} of your ask questionnaire (call ${callId}):`);
      const ids = new Set(step?.fields ?? []);
      for (const f of card.fields.filter((x) => ids.has(x.id))) lines.push(`- ${f.label}: ${answerValue(f, answers[f.id])}`);
      lines.push(
        final
          ? "That was the last page. The questionnaire is complete: you may proceed."
          : `${total - page - 1} page(s) remain. HOLD YOUR TURN: end this turn with text only. Start no work and make no tool calls (no edits, no commands, no subagents, no task changes) until the last page is submitted; only read-only tools and ask_revise are allowed, and wolfd refuses the rest. You may reply briefly, or call ask_revise with callId "${callId}" and replacement pages for the ones not yet answered.`,
      );
      continue;
    }
    if (skipped) {
      lines.push(`The user skipped your ${card.tool} question (call ${callId}).`);
      continue;
    }
    if (card.fields.length === 0) {
      lines.push(`The user acknowledged your ${card.tool} brief (call ${callId}).`);
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
