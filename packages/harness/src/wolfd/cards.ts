/**
 * Pending cards, derived from the transcript.
 *
 * A card is pending from the tool-result entry that carries it (engine/cards.ts) until an answer entry names its
 * call. Because both are durable engine entries, pending state survives reconnect and restart with nothing extra to
 * persist: `reset` re-derives it from a snapshot's entries, `apply` follows the live stream.
 *
 * Answers to a turn's sibling cards: the first ones are held (not yet pending, not yet submitted) until the last card
 * is answered, then one submission carries them all. Held answers live in memory only; after a restart those cards
 * show as pending again and are re-answered.
 */
import type { Card, CardAnswers, PendingCard } from "@wolfpack/protocol";
import { CARD_ANSWER_KIND, cardOfToolMessage, type CardAnswerData } from "../engine/cards.js";
import type { EngineEvent } from "../engine/index.js";

type Entry = Extract<EngineEvent, { type: "message_end" }>["entry"];

export class CardTracker {
  private readonly raised = new Map<string, { card: Card; raisedAt: string }>();
  private readonly held = new Map<string, CardAnswers>();

  constructor(private readonly threadId: string) {}

  reset(entries: readonly Entry[]): void {
    this.raised.clear();
    this.held.clear();
    for (const e of entries) this.apply(e);
  }

  apply(entry: Entry): void {
    if (entry.kind === CARD_ANSWER_KIND) {
      for (const c of (entry.data as unknown as CardAnswerData | undefined)?.cards ?? []) {
        this.raised.delete(c.callId);
        this.held.delete(c.callId);
      }
      return;
    }
    if (!entry.kind.startsWith("pi.tool")) return;
    const msg = entry.model?.[0] as { toolCallId?: string; timestamp?: number } | undefined;
    const card = cardOfToolMessage(msg);
    if (!msg?.toolCallId || !card) return;
    this.raised.set(msg.toolCallId, { card, raisedAt: new Date(msg.timestamp ?? Date.now()).toISOString() });
  }

  /** Cards waiting for the operator (held answers excluded), oldest first. */
  pending(): PendingCard[] {
    return [...this.raised]
      .filter(([callId]) => !this.held.has(callId))
      .map(([callId, r]) => ({ callId, threadId: this.threadId, card: r.card, raisedAt: r.raisedAt }));
  }

  /** The card a call raised, whether pending or held. */
  cardOf(callId: string): Card | undefined {
    return this.raised.get(callId)?.card;
  }

  get(callId: string): PendingCard | undefined {
    return this.pending().find((p) => p.callId === callId);
  }

  /**
   * Record an answer. Returns every held answer plus this one when it was the last card of the turn (the caller
   * submits them), or undefined while siblings still wait.
   */
  answer(callId: string, answers: CardAnswers): { callId: string; answers: CardAnswers }[] | undefined {
    this.held.set(callId, answers);
    if (this.pending().length > 0) return undefined;
    return [...this.held].map(([id, a]) => ({ callId: id, answers: a }));
  }

  /** A submission failed: put the held answers back to pending. */
  release(callIds: readonly string[]): void {
    for (const id of callIds) this.held.delete(id);
  }

  /** The submission was accepted: the answered cards are no longer raised. */
  settle(callIds: readonly string[]): void {
    for (const id of callIds) {
      this.held.delete(id);
      this.raised.delete(id);
    }
  }
}

/** The model-facing user message for an answer submission. */
export function answerText(cards: { callId: string; card: Card; answers: CardAnswers }[]): string {
  const lines: string[] = [];
  for (const { callId, card, answers } of cards) {
    lines.push(`The user answered your ${card.tool} question (call ${callId}):`);
    const single = card.fields.length === 1;
    for (const f of card.fields) {
      const a = answers[f.id];
      const value = a ? (a.value.trim() === "" ? "(empty response)" : a.value) : "(no answer)";
      lines.push(single ? value : `- ${f.label}: ${value}`);
    }
  }
  return lines.join("\n");
}

/** Check answers against the card: every field answered, a `single` value is an option (or typed Other when allowed). */
export function validateAnswers(card: Card, answers: CardAnswers): string | undefined {
  for (const f of card.fields) {
    const a = answers[f.id];
    if (!a) return `missing answer for field "${f.id}"`;
    if (f.kind === "single" && !a.other && !f.options.some((o) => o.value === a.value)) return `"${a.value}" is not an option of field "${f.id}"`;
    if (f.kind === "single" && a.other && f.allowOther === false) return `field "${f.id}" does not accept a custom answer`;
  }
  const extra = Object.keys(answers).find((k) => !card.fields.some((f) => f.id === k));
  return extra ? `unknown field "${extra}"` : undefined;
}
