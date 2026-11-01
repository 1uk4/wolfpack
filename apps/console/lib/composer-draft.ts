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
 * is restored (no focus change) through `restore`.
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
		return () => {
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
