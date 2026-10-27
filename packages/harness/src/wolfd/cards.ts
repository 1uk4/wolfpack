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
import type { Card, CardAnswers, CardFieldAnswer, CardOption, PendingCard } from "@wolfpack/protocol";
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
    return this.raisedCards().filter((p) => !this.claimed.has(p.callId));
  }

  /** Every raised, not yet settled card, claimed ones included (an answer being submitted is still not settled). */
  raisedCards(): PendingCard[] {
    return [...this.raised].map(([callId, r]) => {
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

const EMPTY = "(empty response)";

/** Quote an entry when it would blur the comma-separated list. */
const listSafe = (text: string): string => (/[,"]/.test(text) ? JSON.stringify(text) : text);

/** One picked entry of a multi answer: `Label (value)` (just `Label` when equal), or `other: "text"` for a custom one. */
function multiEntry(options: readonly CardOption[], value: string, custom: boolean): string {
  if (custom) return `other: ${JSON.stringify(value)}`;
  const o = options.find((x) => x.value === value);
  if (!o || o.label === o.value) return listSafe(value);
  return listSafe(`${o.label} (${value})`);
}

/** The model-facing text of one answer, by field kind (labels for confirm/reject, comma list for multi). */
export function answerValue(field: Card["fields"][number], a: CardFieldAnswer | undefined): string {
  if (!a) return "(no answer)";
  if (field.kind === "confirm") {
    if (typeof a.value !== "boolean") return "(no answer)";
    const text = a.value ? `yes (${field.confirmLabel ?? "Yes"})` : `no (${field.rejectLabel ?? "No"})`;
    const note = "note" in a ? a.note?.trim() : undefined;
    return note ? `${text} — ${note}` : text;
  }
  if (field.kind === "multi") {
    if (!Array.isArray(a.value)) return "(no answer)";
    if (a.value.length === 0) return "(none selected)";
    const custom = "other" in a && Array.isArray(a.other) ? a.other : [];
    return a.value.map((v) => multiEntry(field.options, v, custom.includes(v))).join(", ");
  }
  if (typeof a.value !== "string") return "(no answer)";
  return a.value.trim() === "" ? EMPTY : a.value;
}

/** The model-facing user message for an answer submission: every card's questions with their answers, in raise order. */
export function answerText(cards: readonly ReadyAnswer[]): string {
  const lines: string[] = [];
  for (const { callId, card, answers } of cards) {
    lines.push(`The user answered your ${card.tool} question (call ${callId}):`);
    for (const f of card.fields) lines.push(`- ${f.label}: ${answerValue(f, answers[f.id])}`);
  }
  return lines.join("\n");
}

function validateField(f: Card["fields"][number], a: CardFieldAnswer): string | undefined {
  const id = f.id;
  switch (f.kind) {
    case "free-text":
      if (typeof a.value !== "string") return `field "${id}" is free text: the answer must be a string`;
      if ("other" in a && a.other) return `field "${id}" is free text: "other" does not apply`;
      return undefined;
    case "single": {
      if (typeof a.value !== "string") return `field "${id}": the answer must be a string`;
      if ("other" in a && a.other) {
        if (f.allowOther === false) return `field "${id}" does not accept a custom answer`;
        if (a.value.trim() === "") return `field "${id}": a custom answer cannot be empty`;
      } else if (!f.options.some((o) => o.value === a.value)) return `"${a.value}" is not an option of field "${id}"`;
      return undefined;
    }
    case "multi": {
      if (!Array.isArray(a.value)) return `field "${id}": the answer must be a list of strings`;
      const other = "other" in a && Array.isArray(a.other) ? a.other : [];
      if (new Set(a.value).size !== a.value.length) return `field "${id}": duplicate entries`;
      if (other.length > 0 && f.allowOther !== true) return `field "${id}" does not accept custom entries`;
      for (const o of other) {
        if (o.trim() === "") return `field "${id}": a custom entry cannot be empty`;
        if (f.options.some((x) => x.value === o.trim())) return `field "${id}": custom entry "${o}" duplicates an option value`;
        if (!a.value.includes(o)) return `field "${id}": custom entry "${o}" is not among the picked values`;
      }
      for (const v of a.value) {
        if (!other.includes(v) && !f.options.some((o) => o.value === v)) return `"${v}" is not an option of field "${id}"`;
      }
      if (f.min !== undefined && a.value.length < f.min) return `field "${id}": pick at least ${f.min}`;
      if (f.max !== undefined && a.value.length > f.max) return `field "${id}": pick at most ${f.max}`;
      return undefined;
    }
    case "confirm":
      if (typeof a.value !== "boolean") return `field "${id}" is a confirm: the answer must be true or false`;
      return undefined;
  }
}

/** Check answers against the card; returns the problem, or undefined when valid. */
export function validateAnswers(card: Card, answers: CardAnswers): string | undefined {
  for (const f of card.fields) {
    const a = answers[f.id];
    if (!a) return `missing answer for field "${f.id}"`;
    const problem = validateField(f, a);
    if (problem) return problem;
  }
  const extra = Object.keys(answers).find((k) => !card.fields.some((f) => f.id === k));
  return extra ? `unknown field "${extra}"` : undefined;
}
