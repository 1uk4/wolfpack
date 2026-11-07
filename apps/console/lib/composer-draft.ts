"use client";

import { useCallback, useEffect, useMemo, useRef, type MutableRefObject } from "react";

/** Unsent composer text is kept per wolf + thread in localStorage (text only, never sent anywhere). */
export const DRAFT_DEBOUNCE_MS = 300;

export const draftKey = (wolf: string, threadId: string) => `wolfpack:draft:${wolf}:${threadId}`;

function store(): Storage | null {
	try {
		return typeof window === "undefined" ? null : (window.localStorage ?? null);
	} catch {
		return null;
	}
}

/** The one separator rule for dictated text joined onto existing text (the composer, a card field and the draft store all use it). */
export function joinDictation(current: string, final: string): string {
	return current ? current.replace(/\s+$/, "") + " " + final : final;
}

/** Fired when a draft is written from outside its composer (a floating-chat dictation finishing): a mounted composer for that key picks it up. */
export const DRAFT_APPENDED = "wolfpack:draft-appended";

export function readDraft(key: string): string {
	try {
		return store()?.getItem(key) ?? "";
	} catch {
		return "";
	}
}

/** Empty (or whitespace-only) text removes the key. Storage errors are swallowed. */
export function writeDraft(key: string, text: string): void {
	try {
		const s = store();
		if (!s) return;
		if (text.trim() === "") s.removeItem(key);
		else s.setItem(key, text);
	} catch {
		/* quota / private mode: the draft is best effort */
	}
}

/**
 * Append `text` to a thread's stored draft from outside its composer, and tell a composer that is already mounted for the
 * key. A composer still showing the old draft takes the new value; one edited since gets the text joined onto what it
 * shows (and the store is updated to match), so neither the owner's edit nor the dictated words are lost.
 */
export function appendToDraft(key: string, text: string): void {
	const previous = readDraft(key);
	const value = joinDictation(previous, text);
	writeDraft(key, value);
	if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
		window.dispatchEvent(new CustomEvent(DRAFT_APPENDED, { detail: { key, previous, value, added: text } }));
	}
}

/**
 * Persists the composer text for (wolf, threadId). `schedule(v)` is called on every text change: debounced write,
 * immediate removal when empty. The pending write is flushed on unmount or thread switch, and the new thread's draft
 * is restored (no focus change) through `restore`. A pagehide / hidden-visibility event flushes too, since React
 * cleanup does not run when the page unloads.
 *
 * `inert` (a ref): while it reads true another input owns this thread's text (the floating chat during dictation), so this
 * composer is hidden and its text is STALE: it neither writes the draft (timer, pagehide, unmount) nor merges appended
 * words; `useRereadDraftWhenShown` picks the draft up when the composer returns. The returned `schedule` has `flush()`:
 * write the current text now and drop any pending debounce (used right before the hand-off; ignores `inert`).
 *
 * Limits: whitespace-only text is not saved (it removes the key). Two tabs on the same thread share one key and
 * overwrite each other: last write wins.
 */
export function useComposerDraft(
	wolf: string,
	threadId: string,
	textRef: MutableRefObject<string>,
	restore: (v: string) => void,
	inert?: MutableRefObject<boolean>,
): ((v: string) => void) & { flush: () => void } {
	const key = draftKey(wolf, threadId);
	const keyRef = useRef(key);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const restoreRef = useRef(restore);
	restoreRef.current = restore;

	useEffect(() => {
		keyRef.current = key;
		const draft = readDraft(key);
		if (draft !== textRef.current) restoreRef.current(draft);
		const flush = () => {
			if (!inert?.current) writeDraft(key, textRef.current);
		};
		const onAppended = (e: Event) => {
			if (inert?.current) return;
			const d = (e as CustomEvent<{ key: string; previous: string; value: string; added: string }>).detail;
			if (d?.key !== key) return;
			if (textRef.current === d.previous) return restoreRef.current(d.value);
			const merged = joinDictation(textRef.current, d.added);
			restoreRef.current(merged);
			writeDraft(key, merged);
		};
		const onHide = () => {
			if (document.visibilityState === "hidden") flush();
		};
		const canListen = typeof window !== "undefined" && typeof window.addEventListener === "function";
		if (canListen) {
			window.addEventListener("pagehide", flush);
			window.addEventListener(DRAFT_APPENDED, onAppended);
			window.addEventListener("visibilitychange", onHide);
			document.addEventListener("visibilitychange", onHide);
		}
		return () => {
			// ORDER: this unmount flush must run before a dictation's `onOrphan` append (useThreadDictation is declared after
			// this hook, and React runs cleanups in declaration order), or the flush would overwrite the appended words.
			if (canListen) {
				window.removeEventListener("pagehide", flush);
				window.removeEventListener(DRAFT_APPENDED, onAppended);
				window.removeEventListener("visibilitychange", onHide);
				document.removeEventListener("visibilitychange", onHide);
			}
			if (timer.current) {
				clearTimeout(timer.current);
				timer.current = null;
			}
			if (!inert?.current) writeDraft(key, textRef.current);
		};
	}, [key, textRef, inert]);

	return useMemo(() => {
		const schedule = (v: string) => {
			if (timer.current) clearTimeout(timer.current);
			timer.current = null;
			if (inert?.current) return;
			if (v.trim() === "") return writeDraft(keyRef.current, "");
			const k = keyRef.current;
			timer.current = setTimeout(() => {
				timer.current = null;
				if (!inert?.current) writeDraft(k, textRef.current);
			}, DRAFT_DEBOUNCE_MS);
		};
		schedule.flush = () => {
			if (timer.current) clearTimeout(timer.current);
			timer.current = null;
			writeDraft(keyRef.current, textRef.current);
		};
		return schedule;
	}, [textRef, inert]);
}

/**
 * Failed-send recovery. `begin(text)` is called as the composer is emptied for a send/steer; the session reports a
 * failure as `error` turning non-null (send: status goes submitted -> error; steer: error set, status unchanged).
 * The text is then put back through `put` (composer + draft) unless the user has typed something new meanwhile.
 * The pending send is forgotten once the turn is acknowledged (status streaming/ready) or the next send begins.
 */
export function useRestoreOnSendFailure(
	error: unknown,
	status: string,
	textRef: MutableRefObject<string>,
	put: (v: string) => void,
): (text: string, steered: boolean) => void {
	const pending = useRef<{ text: string; steered: boolean } | null>(null);
	const putRef = useRef(put);
	putRef.current = put;
	useEffect(() => {
		const p = pending.current;
		if (!p) return;
		if (error) {
			pending.current = null;
			if (textRef.current === "") putRef.current(p.text);
		} else if (!p.steered && (status === "streaming" || status === "ready")) pending.current = null;
	}, [error, status, textRef]);
	return useCallback((text, steered) => {
		pending.current = { text, steered };
	}, []);
}

/**
 * For a composer whose card is hidden (not unmounted) while another input owns the thread's text (the floating chat during
 * dictation): when `hidden` goes true → false, re-read the stored draft (typed plus dictated, flushed by the other input's
 * unmount) into the composer. Declared after useComposerDraft; cleanups of the other input run before this effect.
 */
export function useRereadDraftWhenShown(hidden: boolean, wolf: string, threadId: string, textRef: MutableRefObject<string>, restore: (v: string) => void): void {
	const was = useRef(false);
	const restoreRef = useRef(restore);
	restoreRef.current = restore;
	useEffect(() => {
		const had = was.current;
		was.current = hidden;
		if (had && !hidden) {
			const d = readDraft(draftKey(wolf, threadId));
			if (d !== textRef.current) restoreRef.current(d);
		}
	}, [hidden, wolf, threadId, textRef]);
}
