"use client";

import { useCallback, useEffect, useRef, type MutableRefObject } from "react";

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
 * Persists the composer text for (wolf, threadId). `schedule(v)` is called on every text change: debounced write,
 * immediate removal when empty. The pending write is flushed on unmount or thread switch, and the new thread's draft
 * is restored (no focus change) through `restore`. A pagehide / hidden-visibility event flushes too, since React
 * cleanup does not run when the page unloads.
 *
 * Limits: whitespace-only text is not saved (it removes the key). Two tabs on the same thread share one key and
 * overwrite each other: last write wins.
 */
export function useComposerDraft(
	wolf: string,
	threadId: string,
	textRef: MutableRefObject<string>,
	restore: (v: string) => void,
): (v: string) => void {
	const key = draftKey(wolf, threadId);
	const keyRef = useRef(key);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const restoreRef = useRef(restore);
	restoreRef.current = restore;

	useEffect(() => {
		keyRef.current = key;
		const draft = readDraft(key);
		if (draft !== textRef.current) restoreRef.current(draft);
		const flush = () => writeDraft(key, textRef.current);
		const onHide = () => {
			if (document.visibilityState === "hidden") flush();
		};
		const canListen = typeof window !== "undefined" && typeof window.addEventListener === "function";
		if (canListen) {
			window.addEventListener("pagehide", flush);
			window.addEventListener("visibilitychange", onHide);
			document.addEventListener("visibilitychange", onHide);
		}
		return () => {
			if (canListen) {
				window.removeEventListener("pagehide", flush);
				window.removeEventListener("visibilitychange", onHide);
				document.removeEventListener("visibilitychange", onHide);
			}
			if (timer.current) {
				clearTimeout(timer.current);
				timer.current = null;
			}
			writeDraft(key, textRef.current);
		};
	}, [key, textRef]);

	return useCallback((v: string) => {
		if (timer.current) clearTimeout(timer.current);
		timer.current = null;
		if (v.trim() === "") return writeDraft(keyRef.current, "");
		const k = keyRef.current;
		timer.current = setTimeout(() => {
			timer.current = null;
			writeDraft(k, textRef.current);
		}, DRAFT_DEBOUNCE_MS);
	}, [textRef]);
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
