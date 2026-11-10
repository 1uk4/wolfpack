"use client";

/**
 * What the floating bar knows about its attached thread's cards and last reply, over REST only (the bar has no stream):
 * GET the thread record (`pendingCards` + the newest messages) and refetch when /api/events says the thread changed
 * (thread-updated, needs-you-changed). All state is keyed by the target: a different target reads as empty at once, an
 * in-flight fetch for another target is dropped, so thread A's cards can never be shown (or answered) on thread B.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Card, PendingCard } from "@wolfpack/client";
import { useOptionalServerEvent } from "@/components/server-events";
import { threadBase } from "@/components/thread-transport";
import { isOwnCard } from "@/components/ask-session";
import { parseThreadCards, type AttachedRef } from "@/src/core";

/** A card the owner's free text just closed: shown as superseded for a moment. */
export interface SupersededCard {
	callId: string;
	card: Card;
}

export interface BarCards {
	/** Pending cards, oldest first. */
	pending: PendingCard[];
	/** The last assistant reply, once a turn has ended and until sent / dismissed / a card is settled / a turn starts. */
	peek: string | null;
	superseded: SupersededCard[];
	/** The last answer / skip failure (kept visible even when a refetch removes the card). */
	error: string | null;
	setError: (m: string | null) => void;
	dismissPeek: () => void;
	/** A card was answered or skipped here: drop it at once, then refetch. */
	settle: (callId: string) => void;
	/** The owner sent free text: pending cards close as superseded (the wolf does the same), the peek goes. */
	replied: () => void;
	refetch: () => void;
}

/** The reply to the owner's latest message: the newest assistant text after the last user message (walks back past tool-only messages). */
export function lastReplyOf(json: unknown): string | null {
	const msgs = (json as { messages?: { role?: string; text?: string }[] } | null)?.messages;
	if (!Array.isArray(msgs)) return null;
	for (let i = msgs.length - 1; i >= 0; i--) {
		const m = msgs[i]!;
		if (m.role === "user") return null;
		if (m.role === "assistant" && typeof m.text === "string" && m.text.trim() !== "") return m.text;
	}
	return null;
}

export const SUPERSEDED_MS = 4000;

interface Bundle {
	key: string;
	pending: PendingCard[];
	reply: string | null;
	peekOn: boolean;
	superseded: SupersededCard[];
	error: string | null;
}
const fresh = (key: string): Bundle => ({ key, pending: [], reply: null, peekOn: false, superseded: [], error: null });

export function useBarCards(target: AttachedRef, working: boolean, enabled = true): BarCards {
	const key = `${target.wolf}:${target.threadId}`;
	const [bundle, setBundle] = useState<Bundle>(() => fresh(key));
	/** Update the bundle of the CURRENT target only (a stale key starts from empty). */
	const keyRef = useRef(key);
	const gone = useRef(new Set<string>());
	const pendingRef = useRef<PendingCard[]>([]);
	const seq = useRef(0);
	if (keyRef.current !== key) {
		// The target changed: nothing of the old thread survives, and its in-flight fetch is dropped.
		keyRef.current = key;
		seq.current++;
		gone.current = new Set();
		pendingRef.current = [];
	}
	const update = useCallback((k: string, f: (b: Bundle) => Bundle) => {
		if (k !== keyRef.current) return;
		setBundle((b) => f(b.key === k ? b : fresh(k)));
	}, []);
	const b = bundle.key === key ? bundle : fresh(key);
	const base = threadBase(target.wolf, target.slug);

	const refetch = useCallback(() => {
		if (!enabled) return;
		const n = ++seq.current;
		const k = keyRef.current;
		void (async () => {
			try {
				const res = await fetch(`${base}?limit=20`, { cache: "no-store" });
				if (!res.ok || n !== seq.current || k !== keyRef.current) return;
				const json = await res.json();
				if (n !== seq.current || k !== keyRef.current) return;
				const cards = parseThreadCards(json);
				if (!cards) return;
				const ids = new Set(cards.pending.map((p) => p.callId));
				for (const id of gone.current) if (!ids.has(id)) gone.current.delete(id); // the server forgot it: stop filtering
				const next = cards.pending.filter((p) => !gone.current.has(p.callId));
				pendingRef.current = next;
				const reply = lastReplyOf(json);
				update(k, (x) => ({ ...x, pending: next, reply }));
			} catch {
				/* the next event refetches */
			}
		})();
	}, [base, update, enabled]);

	useEffect(() => refetch(), [refetch]);
	const mine = (wolf: string, id?: string) => wolf === target.wolf && (!id || id === target.threadId);
	useOptionalServerEvent("thread-updated", (ev) => {
		if (mine(ev.wolf, ev.thread.id) && ev.thread.status !== "busy") refetch();
	});
	useOptionalServerEvent("needs-you-changed", (ev) => {
		if (mine(ev.wolf, ev.threadId) && ev.status !== "busy") refetch();
		// A subagent's questionnaire joins (or leaves) this thread's queue: its card events carry the child's thread id.
		else if (ev.wolf === target.wolf && ev.kind === "card") refetch();
	});

	// A turn ending arms the peek (and refetches the reply it produced); a turn starting clears it.
	const was = useRef(working);
	useEffect(() => {
		if (was.current && !working) {
			update(keyRef.current, (x) => ({ ...x, peekOn: true }));
			refetch();
		} else if (!was.current && working) update(keyRef.current, (x) => ({ ...x, peekOn: false }));
		was.current = working;
	}, [working, refetch, update]);

	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
	useEffect(() => {
		if (timer.current) clearTimeout(timer.current);
	}, [key]);

	const settle = useCallback((callId: string) => {
		gone.current.add(callId);
		pendingRef.current = pendingRef.current.filter((x) => x.callId !== callId);
		update(keyRef.current, (x) => ({ ...x, pending: x.pending.filter((p) => p.callId !== callId), peekOn: false, error: null }));
		refetch();
	}, [refetch, update]);
	const replied = useCallback(() => {
		const k = keyRef.current;
		// A plain message supersedes only this thread's own cards: a subagent's questionnaire stays queued.
		const closing = pendingRef.current.filter(isOwnCard);
		for (const p of closing) gone.current.add(p.callId);
		pendingRef.current = pendingRef.current.filter((p) => !isOwnCard(p));
		update(k, (x) => ({ ...x, peekOn: false, pending: x.pending.filter((p) => !isOwnCard(p)), error: null, superseded: closing.map((p) => ({ callId: p.callId, card: p.card })) }));
		if (closing.length === 0) return;
		if (timer.current) clearTimeout(timer.current);
		timer.current = setTimeout(() => update(k, (x) => ({ ...x, superseded: [] })), SUPERSEDED_MS);
	}, [update]);
	const dismissPeek = useCallback(() => update(keyRef.current, (x) => ({ ...x, peekOn: false })), [update]);
	const setError = useCallback((m: string | null) => update(keyRef.current, (x) => ({ ...x, error: m })), [update]);

	return { pending: b.pending, peek: b.peekOn && b.pending.length === 0 ? b.reply : null, superseded: b.superseded, error: b.error, setError, dismissPeek, settle, replied, refetch };
}
