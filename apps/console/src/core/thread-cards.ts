/**
 * Interaction cards of a wolf thread (protocol cards, ticket "ask card"): the pure fold from a ThreadDetail to what
 * ThreadChat renders — which calls raised a card, whether it was answered, and which cards still wait. PURE.
 */

import type { Card, CardAnswers, PendingCard, ThreadDetail } from "@wolfpack/client";

/** A tool call that raised a card: the card, and the operator's answer once given. */
export interface CardCall {
	card: Card;
	answer?: CardAnswers;
}

export interface ThreadCards {
	/** Cards waiting for the operator, oldest first. */
	pending: PendingCard[];
	/** Every card-raising call of the history, keyed by call id. */
	calls: Record<string, CardCall>;
}

export const NO_CARDS: ThreadCards = { pending: [], calls: {} };

export function cardsOfThread(detail: Pick<ThreadDetail, "messages" | "pendingCards">): ThreadCards {
	const calls: Record<string, CardCall> = {};
	for (const m of detail.messages) {
		for (const t of m.tools ?? []) {
			if (t.card) calls[t.callId] = { card: t.card, ...(t.answer ? { answer: t.answer } : {}) };
		}
	}
	// A pending card whose call fell out of the (compacted) history still renders from the pending list.
	for (const p of detail.pendingCards ?? []) calls[p.callId] ??= { card: p.card };
	return { pending: detail.pendingCards ?? [], calls };
}

/** The thread record JSON (GET thread) → cards; null when it isn't a thread record. */
export function parseThreadCards(json: unknown): ThreadCards | null {
	const d = json as { messages?: unknown; pendingCards?: unknown } | null;
	if (!d || !Array.isArray(d.messages)) return null;
	return cardsOfThread({ messages: d.messages as ThreadDetail["messages"], pendingCards: Array.isArray(d.pendingCards) ? (d.pendingCards as PendingCard[]) : undefined });
}

/** Mark a call answered locally (before the server record confirms it). */
export function withAnswer(cards: ThreadCards, callId: string, answer: CardAnswers): ThreadCards {
	const call = cards.calls[callId];
	if (!call) return cards;
	return {
		pending: cards.pending.filter((p) => p.callId !== callId),
		calls: { ...cards.calls, [callId]: { ...call, answer } },
	};
}

/** What the form holds per field id: the picked option value, or typed text (free-text, or Other). */
export interface CardDraft {
	[fieldId: string]: { value: string; other?: boolean };
}

/** The draft a card starts with: field defaults pre-selected (never auto-submitted). */
export function initialDraft(card: Card): CardDraft {
	const draft: CardDraft = {};
	for (const f of card.fields) {
		if (f.default !== undefined) draft[f.id] = { value: f.default };
	}
	return draft;
}

/** Every field answered (free text may be non-empty text; a single needs a pick or non-empty Other text). */
export function draftComplete(card: Card, draft: CardDraft): boolean {
	return card.fields.every((f) => {
		const a = draft[f.id];
		return a !== undefined && a.value.trim() !== "";
	});
}

/** The answers to send: values trimmed, `other` only when set. */
export function draftAnswers(card: Card, draft: CardDraft): CardAnswers {
	const out: CardAnswers = {};
	for (const f of card.fields) {
		const a = draft[f.id];
		if (a) out[f.id] = { value: a.value.trim(), ...(a.other ? { other: true } : {}) };
	}
	return out;
}
