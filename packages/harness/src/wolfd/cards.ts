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
import type { Card, CardAnswers, PendingCard } from "@wolfpack/protocol";
import { CARD_ANSWER_KIND, USER_ENTRY_KIND, cardOfToolMessage, type CardAnswerData, type EngineEvent } from "../engine/index.js";

type Entry = Extract<EngineEvent, { type: "message_end" }>["entry"];

export interface ReadyAnswer {
  callId: string;
  card: Card;
  answers: CardAnswers;
}

export class CardTracker {
  /** Raised, unanswered cards in raise order. */
  private readonly raised = new Map<string, { card: Card; raisedAt: string }>();
  private readonly held = new Map<string, CardAnswers>();
  /** Calls whose answer is being submitted: no longer answerable. */
  private readonly claimed = new Set<string>();

  constructor(private readonly threadId: string) {}

  reset(entries: readonly Entry[]): void {
    this.raised.clear();
    this.held.clear();
    this.claimed.clear();
    for (const e of entries) this.apply(e);
  }

  /** Fold one engine entry. Returns the calls a plain user message dismissed (empty otherwise). */
  apply(entry: Entry): string[] {
    if (entry.kind === CARD_ANSWER_KIND) {
      for (const c of (entry.data as unknown as CardAnswerData | undefined)?.cards ?? []) this.drop(c.callId);
      return [];
    }
    // NOTE: any future system writer of `pi.user` entries (reminders, injected context) would dismiss pending cards.
    if (entry.kind === USER_ENTRY_KIND) return this.dismissAll();
    if (!entry.kind.startsWith("pi.tool")) return [];
    const msg = entry.model?.[0] as { toolCallId?: string; timestamp?: number } | undefined;
    const card = cardOfToolMessage(msg);
    if (msg?.toolCallId && card) this.raised.set(msg.toolCallId, { card, raisedAt: new Date(msg.timestamp ?? Date.now()).toISOString() });
    return [];
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

  /** Cards waiting for the operator, oldest first; a held one carries its answer. */
  pending(): PendingCard[] {
    return [...this.raised]
      .filter(([callId]) => !this.claimed.has(callId))
      .map(([callId, r]) => {
        const heldAnswer = this.held.get(callId);
        return { callId, threadId: this.threadId, card: r.card, raisedAt: r.raisedAt, ...(heldAnswer ? { heldAnswer } : {}) };
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
    this.held.set(callId, answers);
    const open = [...this.raised].filter(([id]) => !this.claimed.has(id));
    if (open.some(([id]) => !this.held.has(id))) return undefined;
    const ready = open.map(([id, r]) => ({ callId: id, card: r.card, answers: this.held.get(id)! }));
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

/** The model-facing user message for an answer submission: every card's questions with their answers, in raise order. */
export function answerText(cards: readonly ReadyAnswer[]): string {
  const lines: string[] = [];
  for (const { callId, card, answers } of cards) {
    lines.push(`The user answered your ${card.tool} question (call ${callId}):`);
    for (const f of card.fields) {
      const a = answers[f.id];
      const value = a ? (a.value.trim() === "" ? "(empty response)" : a.value) : "(no answer)";
      lines.push(`- ${f.label}: ${value}`);
    }
  }
  return lines.join("\n");
}

/** Check answers against the card; returns the problem, or undefined when valid. */
export function validateAnswers(card: Card, answers: CardAnswers): string | undefined {
  for (const f of card.fields) {
    const a = answers[f.id];
    if (!a) return `missing answer for field "${f.id}"`;
    if (f.kind === "free-text") {
      if (a.other) return `field "${f.id}" is free text: "other" does not apply`;
    } else if (a.other) {
      if (f.allowOther === false) return `field "${f.id}" does not accept a custom answer`;
      if (a.value.trim() === "") return `field "${f.id}": a custom answer cannot be empty`;
    } else if (!f.options.some((o) => o.value === a.value)) {
      return `"${a.value}" is not an option of field "${f.id}"`;
    }
  }
  const extra = Object.keys(answers).find((k) => !card.fields.some((f) => f.id === k));
  return extra ? `unknown field "${extra}"` : undefined;
}
