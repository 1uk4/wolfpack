/**
 * Interaction cards of a wolf thread (protocol cards, ticket "ask card"): the pure fold from a ThreadDetail to what
 * ThreadChat renders — which calls raised a card, whether it was answered, and which cards still wait. PURE.
 */

import type { Card, CardAnswers, CardFieldAnswer, PendingCard, ThreadDetail } from "@wolfpack/client";

/** A tool call that raised a card: the card, and the operator's answer once given. */
export interface CardCall {
	card: Card;
	answer?: CardAnswers;
	/** Superseded by a plain submit before it was answered: shown as skipped. */
	dismissed?: boolean;
	/** Answered while sibling cards still wait: held by the wolf, changeable until the last one is answered. */
	heldAnswer?: CardAnswers;
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
			if (t.card) calls[t.callId] = { card: t.card, ...(t.answer ? { answer: t.answer } : {}), ...(t.dismissed ? { dismissed: true } : {}) };
		}
	}
	// A pending card whose call fell out of the (compacted) history still renders from the pending list.
	for (const p of detail.pendingCards ?? []) calls[p.callId] = { ...(calls[p.callId] ?? { card: p.card }), ...(p.heldAnswer ? { heldAnswer: p.heldAnswer } : {}) };
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

/** An answer the wolf accepted but held (siblings still wait): the card stays pending and shows it. */
export function withHeld(cards: ThreadCards, callId: string, heldAnswer: CardAnswers): ThreadCards {
	const call = cards.calls[callId];
	if (!call) return cards;
	return {
		pending: cards.pending.map((p) => (p.callId === callId ? { ...p, heldAnswer } : p)),
		calls: { ...cards.calls, [callId]: { ...call, heldAnswer } },
	};
}

/**
 * What the form holds per field id, in the answer's own shape: the picked option value or typed text (free-text,
 * single, Other), the picked values (multi, custom entries named in `other`), or the boolean (confirm).
 */
export interface CardDraft {
	[fieldId: string]: CardFieldAnswer;
}

const copyAnswer = (a: CardFieldAnswer): CardFieldAnswer => {
	if (Array.isArray(a.value)) return { value: [...a.value], ...("other" in a && Array.isArray(a.other) && a.other.length > 0 ? { other: [...a.other] } : {}) };
	if (typeof a.value === "boolean") return { value: a.value, ...("note" in a && a.note ? { note: a.note } : {}) };
	return { value: a.value, ...("other" in a && a.other ? { other: true } : {}) };
};

/** The draft a card starts with: field defaults pre-selected (never auto-submitted). */
export function initialDraft(card: Card, held?: CardAnswers): CardDraft {
	const draft: CardDraft = {};
	for (const f of card.fields) {
		const h = held?.[f.id];
		if (h) draft[f.id] = copyAnswer(h);
		else if (f.kind === "multi") draft[f.id] = { value: [...(f.default ?? [])] };
		else if (f.default !== undefined) draft[f.id] = { value: f.default } as CardFieldAnswer;
	}
	return draft;
}

/** Whether a multi field's pick count is within its bounds. */
export function multiInBounds(f: Extract<Card["fields"][number], { kind: "multi" }>, count: number): boolean {
	return count >= (f.min ?? 0) && count <= (f.max ?? Infinity);
}

/** Every field answered (text non-empty; a multi within min/max; a confirm picked). */
export function draftComplete(card: Card, draft: CardDraft): boolean {
	return card.fields.every((f) => {
		const a = draft[f.id];
		if (a === undefined) return false;
		if (f.kind === "confirm") return typeof a.value === "boolean";
		if (f.kind === "multi") return Array.isArray(a.value) && multiInBounds(f, a.value.length);
		return typeof a.value === "string" && a.value.trim() !== "";
	});
}

/** The answers to send: text trimmed, `other` only when set. */
export function draftAnswers(card: Card, draft: CardDraft): CardAnswers {
	const out: CardAnswers = {};
	for (const f of card.fields) {
		const a = draft[f.id];
		if (!a) continue;
		if (Array.isArray(a.value)) {
			const other = "other" in a && Array.isArray(a.other) ? a.other.filter((o) => (a.value as string[]).includes(o)) : [];
			out[f.id] = { value: a.value, ...(other.length > 0 ? { other } : {}) };
		} else if (typeof a.value === "boolean") out[f.id] = { value: a.value, ...("note" in a && a.note?.trim() ? { note: a.note.trim() } : {}) };
		else out[f.id] = { value: a.value.trim(), ...("other" in a && a.other ? { other: true } : {}) };
	}
	return out;
}

type MultiField = Extract<Card["fields"][number], { kind: "multi" }>;

/**
 * Add one custom entry to a multi answer. Fails (with the reason) when the text collides with an option value, repeats
 * a pick, or would exceed `max`; empty text is a no-op success.
 */
export function addCustomEntry(field: MultiField, answer: CardFieldAnswer | undefined, text: string): { answer: CardFieldAnswer } | { error: string } {
	const picked = Array.isArray(answer?.value) ? answer.value : [];
	const custom = answer && "other" in answer && Array.isArray(answer.other) ? answer.other : [];
	const t = text.trim();
	if (t === "") return { answer: { value: picked, ...(custom.length > 0 ? { other: custom } : {}) } };
	if (field.options.some((o) => o.value === t)) return { error: `“${t}” is already an option: tick it instead` };
	if (picked.includes(t)) return { error: `“${t}” is already added` };
	if (field.max !== undefined && picked.length >= field.max) return { error: `At most ${field.max} entries` };
	return { answer: { value: [...picked, t], other: [...custom, t] } };
}

/**
 * Fold text typed into a multi field's "Other…" box but not yet added into the draft, so Submit never loses it.
 * `error` names the first entry that cannot be added (Submit must then be blocked).
 */
export function foldPendingOther(card: Card, draft: CardDraft, typed: Record<string, string>): { draft: CardDraft; errors: Record<string, string> } {
	const out: CardDraft = { ...draft };
	const errors: Record<string, string> = {};
	for (const f of card.fields) {
		const t = typed[f.id]?.trim();
		if (f.kind !== "multi" || !t) continue;
		const r = addCustomEntry(f, out[f.id], t);
		if ("error" in r) errors[f.id] = r.error;
		else out[f.id] = r.answer;
	}
	return { draft: out, errors };
}

/**
 * Fold a thread's live card event into the cards (so an inline card appears, or goes, without waiting for the turn to
 * settle). `card-pending` adds the card or updates its held answer; `card-settled` removes it from the pending list
 * (a dismissal also marks the call skipped; an answer's text arrives with the record refetch).
 */
export function foldCardEvent(
	cards: ThreadCards,
	ev: { type: "card-pending"; card: PendingCard } | { type: "card-settled"; callId: string; outcome: "answered" | "dismissed" },
): ThreadCards {
	if (ev.type === "card-pending") {
		const p = ev.card;
		const prior = cards.calls[p.callId];
		const pending = cards.pending.some((x) => x.callId === p.callId) ? cards.pending.map((x) => (x.callId === p.callId ? p : x)) : [...cards.pending, p];
		return { pending, calls: { ...cards.calls, [p.callId]: { ...(prior ?? {}), card: p.card, ...(p.heldAnswer ? { heldAnswer: p.heldAnswer } : {}) } } };
	}
	const call = cards.calls[ev.callId];
	return {
		pending: cards.pending.filter((p) => p.callId !== ev.callId),
		calls: call && ev.outcome === "dismissed" ? { ...cards.calls, [ev.callId]: { ...call, dismissed: true } } : cards.calls,
	};
}
