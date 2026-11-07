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
 */
import { visibleFields, type AnyField, type Card, type CardAnswers, type CardClosed, type CardFieldAnswer, type PendingCard } from "@wolfpack/protocol";
import { fieldKind, type AnyAnswer } from "./card-kinds/index.js";
import { CARD_ANSWER_KIND, USER_ENTRY_KIND, cardOfToolMessage, type CardAnswerData, type EngineEvent } from "../engine/index.js";

type Entry = Extract<EngineEvent, { type: "message_end" }>["entry"];

export interface ReadyAnswer {
  callId: string;
  card: Card;
  answers: CardAnswers;
  /** The operator skipped this card: `answers` is empty and the model is told it was skipped. */
  skipped?: true;
}

/** A sibling's recorded resolution while the others still wait: answers, or an explicit skip. */
type Held = { answers: CardAnswers } | { skipped: true };

export class CardTracker {
  /** Raised, unanswered cards in raise order. */
  private readonly raised = new Map<string, { card: Card; raisedAt: string }>();
  private readonly held = new Map<string, Held>();
  /** Calls whose answer is being submitted: no longer answerable. */
  private readonly claimed = new Set<string>();

  constructor(private readonly threadId: string) {}

  reset(entries: readonly Entry[]): void {
    this.raised.clear();
    this.held.clear();
    this.claimed.clear();
    for (const e of entries) this.apply(e);
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
    if (msg?.toolCallId && card) this.raised.set(msg.toolCallId, { card, raisedAt: new Date(msg.timestamp ?? Date.now()).toISOString() });
    return closed;
  }

  private drop(callId: string): void {
    this.raised.delete(callId);
    this.held.delete(callId);
    this.claimed.delete(callId);
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
      this.held.delete(c.callId);
      if (!this.raised.has(c.callId)) this.raised.set(c.callId, { card: c.card, raisedAt: new Date().toISOString() });
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
      };
    });
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
  if (field.optional && isSkipped(field, a)) return SKIPPED;
  if (!a) return "(no answer)";
  return fieldKind(field.kind).answerText(asField(field), a as AnyAnswer);
}

/** The model-facing user message for an answer submission: every card's questions with their answers (or skip), in raise order. */
export function answerText(cards: readonly ReadyAnswer[]): string {
  const lines: string[] = [];
  for (const { callId, card, answers, skipped } of cards) {
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
