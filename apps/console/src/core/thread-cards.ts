/**
 * Interaction cards of a wolf thread (protocol cards, ticket "ask card"): the pure fold from a ThreadDetail to what
 * ThreadChat renders — which calls raised a card, whether it was answered, and which cards still wait. PURE.
 */

import type { Card, CardAnswers, CardClosed, CardField, CardFieldAnswer, PendingCard, ThreadDetail } from "@wolfpack/client";

/** A tool call that raised a card: the card, and the operator's answer once given. */
export interface CardCall {
	card: Card;
	answer?: CardAnswers;
	/** Closed without an answer (skipped or superseded): read-only. */
	dismissed?: boolean;
	/** How the card closed; absent while pending. A bare `dismissed` (an older server) reads as superseded. */
	closed?: CardClosed;
	/** Answered while sibling cards still wait: held by the wolf, changeable until the last one is answered. */
	heldAnswer?: CardAnswers;
	/** Skipped while sibling cards still wait: held by the wolf, replaceable by an answer. */
	heldSkip?: boolean;
}

/** How a call closed, from its parts (`closed` when the server says, else inferred for older servers). */
export function closedOf(call: Pick<CardCall, "answer" | "dismissed" | "closed">): CardClosed | undefined {
	return call.closed ?? (call.answer ? "answered" : call.dismissed ? "superseded" : undefined);
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
			if (t.card) calls[t.callId] = { card: t.card, ...(t.answer ? { answer: t.answer } : {}), ...(t.dismissed ? { dismissed: true } : {}), ...(t.closed ? { closed: t.closed } : {}) };
		}
	}
	// A pending card whose call fell out of the (compacted) history still renders from the pending list.
	for (const p of detail.pendingCards ?? []) calls[p.callId] = { ...(calls[p.callId] ?? { card: p.card }), ...(p.heldAnswer ? { heldAnswer: p.heldAnswer } : {}), ...(p.heldSkip ? { heldSkip: true } : {}) };
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

const stripHeld = ({ heldAnswer: _a, heldSkip: _s, ...rest }: CardCall): CardCall => rest;

/** Mark a call skipped locally (before the server record confirms it). */
export function withSkip(cards: ThreadCards, callId: string): ThreadCards {
	const call = cards.calls[callId];
	if (!call) return cards;
	return {
		pending: cards.pending.filter((p) => p.callId !== callId),
		calls: { ...cards.calls, [callId]: { ...call, dismissed: true, closed: "skipped" } },
	};
}

/** A skip the wolf accepted but held (siblings still wait): the card stays pending and shows it. */
export function withHeldSkip(cards: ThreadCards, callId: string): ThreadCards {
	const call = cards.calls[callId];
	if (!call) return cards;
	const rest = stripHeld(call);
	return {
		pending: cards.pending.map((p) => {
			if (p.callId !== callId) return p;
			const { heldAnswer: _a, ...keep } = p;
			return { ...keep, heldSkip: true };
		}),
		calls: { ...cards.calls, [callId]: { ...rest, heldSkip: true } },
	};
}

/** An answer the wolf accepted but held (siblings still wait): the card stays pending and shows it. */
export function withHeld(cards: ThreadCards, callId: string, heldAnswer: CardAnswers): ThreadCards {
	const call = cards.calls[callId];
	if (!call) return cards;
	return {
		pending: cards.pending.map((p) => {
			if (p.callId !== callId) return p;
			const { heldSkip: _s, ...keep } = p;
			return { ...keep, heldAnswer };
		}),
		calls: { ...cards.calls, [callId]: { ...stripHeld(call), heldAnswer } },
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

/**
 * Whether a multi field's pick count is within its bounds. A required multi needs at least one pick (an explicit `min`
 * applies on top; `min: 0` counts as 1); an optional one may be blank, and once something is picked min/max apply.
 */
export function multiInBounds(f: Extract<Card["fields"][number], { kind: "multi" }>, count: number): boolean {
	if (f.optional && count === 0) return true;
	return count >= Math.max(f.min ?? 0, f.optional ? 0 : 1) && count <= (f.max ?? Infinity);
}

/**
 * The fields in play for these answers (mirror of the protocol's `visibleFields`; the console core stays free of runtime
 * protocol imports): a field is hidden when its `showIf` fails or its controlling field is itself hidden.
 */
export function visibleFields(card: Card, answers: Readonly<Record<string, { value: unknown } | undefined>>): CardField[] {
	const shown = new Set<string>();
	const out: CardField[] = [];
	for (const f of card.fields) {
		const s = f.showIf;
		if (s) {
			if (!shown.has(s.field)) continue;
			const v = answers[s.field]?.value;
			if (s.equals !== undefined ? v !== s.equals : !(typeof v === "string" && (s.oneOf ?? []).includes(v))) continue;
		}
		shown.add(f.id);
		out.push(f);
	}
	return out;
}

/** One page of a stepped card with the fields currently visible on it. */
export interface VisibleStep {
	title?: string;
	fields: CardField[];
}

/**
 * The steps to walk for this draft: the card's steps with their hidden fields removed and empty steps skipped (so a
 * dependent step vanishes while its controlling answer is unset). A card without `steps` is one step of every visible field.
 */
export function visibleSteps(card: Card, draft: CardDraft): VisibleStep[] {
	const shown = visibleFields(card, draft);
	if (!card.steps) return [{ fields: shown }];
	const out: VisibleStep[] = [];
	for (const s of card.steps) {
		const fields = shown.filter((f) => s.fields.includes(f.id));
		if (fields.length > 0) out.push({ ...(s.title ? { title: s.title } : {}), fields });
	}
	return out;
}

/**
 * An optional field with nothing entered (no answer, blank text, no picks). A confirm is blank only while unpicked; the
 * server (isSkipped) counts a confirm skipped only when ABSENT, so a present-but-malformed confirm is validated and rejected there.
 */
export const fieldBlank = (f: CardField, a: CardFieldAnswer | undefined): boolean => {
	if (a === undefined) return true;
	if (f.kind === "confirm") return typeof a.value !== "boolean";
	if (f.kind === "multi") return !Array.isArray(a.value) || a.value.length === 0;
	return typeof a.value !== "string" || a.value.trim() === "";
};

const fieldDone = (f: CardField, a: CardFieldAnswer | undefined): boolean => {
	if (f.optional && fieldBlank(f, a)) return true; // skipped; once something is picked, min/max still apply below
	if (a === undefined) return false;
	if (f.kind === "confirm") return typeof a.value === "boolean";
	if (f.kind === "multi") return Array.isArray(a.value) && multiInBounds(f, a.value.length);
	return typeof a.value === "string" && a.value.trim() !== "";
};

/** Every given field answered. */
export function fieldsComplete(fields: readonly CardField[], draft: CardDraft): boolean {
	return fields.every((f) => fieldDone(f, draft[f.id]));
}

/** Every visible field answered (text non-empty; a multi within min/max; a confirm picked). A hidden field is not required. */
export function draftComplete(card: Card, draft: CardDraft): boolean {
	return fieldsComplete(visibleFields(card, draft), draft);
}

/**
 * The answers to send: text trimmed, `other` only when set. A skipped optional field is sent empty (free-text/single
 * `{value: ""}`, multi `{value: []}`); a skipped optional confirm is left out (there is no empty boolean).
 */
export function draftAnswers(card: Card, draft: CardDraft): CardAnswers {
	const out: CardAnswers = {};
	for (const f of visibleFields(card, draft)) {
		const a = draft[f.id];
		if (f.optional && fieldBlank(f, a)) {
			if (f.kind === "multi") out[f.id] = { value: [] };
			else if (f.kind !== "confirm") out[f.id] = { value: "" };
			continue;
		}
		if (!a) continue;
		if (Array.isArray(a.value)) {
			const value = [...new Set(a.value)]; // a custom entry is one entry, however it got in
			const other = "other" in a && Array.isArray(a.other) ? [...new Set(a.other)].filter((o) => value.includes(o)) : [];
			out[f.id] = { value, ...(other.length > 0 ? { other } : {}) };
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
 * (a dismissal also marks the call skipped or superseded; an answer's text arrives with the record refetch).
 */
export function foldCardEvent(
	cards: ThreadCards,
	ev: { type: "card-pending"; card: PendingCard } | { type: "card-settled"; callId: string; outcome: "answered" | "dismissed"; closed?: CardClosed },
): ThreadCards {
	if (ev.type === "card-pending") {
		const p = ev.card;
		const prior = cards.calls[p.callId];
		const pending = cards.pending.some((x) => x.callId === p.callId) ? cards.pending.map((x) => (x.callId === p.callId ? p : x)) : [...cards.pending, p];
		return { pending, calls: { ...cards.calls, [p.callId]: { ...(prior ? stripHeld(prior) : {}), card: p.card, ...(p.heldAnswer ? { heldAnswer: p.heldAnswer } : {}), ...(p.heldSkip ? { heldSkip: true } : {}) } } };
	}
	const call = cards.calls[ev.callId];
	return {
		pending: cards.pending.filter((p) => p.callId !== ev.callId),
		calls: call && ev.outcome === "dismissed" ? { ...cards.calls, [ev.callId]: { ...call, dismissed: true, closed: ev.closed === "skipped" ? "skipped" : "superseded" } } : cards.calls,
	};
}
