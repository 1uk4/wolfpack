"use client";

/**
 * A graduation happened (the settings-signal dialect: a CustomEvent on the window). The Work list, the graph and the
 * graph pane live in different subtrees; each re-reads on this instead of waiting for its poll.
 */
import { useEffect, useRef } from "react";

export const GRADUATED_EVENT = "wolfpack:graduated";

export function notifyGraduated(workId: string): void {
	window.dispatchEvent(new CustomEvent(GRADUATED_EVENT, { detail: { workId } }));
}

export function onGraduated(handler: (workId: string) => void): () => void {
	const listener = (e: Event) => handler((e as CustomEvent<{ workId?: string }>).detail?.workId ?? "");
	window.addEventListener(GRADUATED_EVENT, listener);
	return () => window.removeEventListener(GRADUATED_EVENT, listener);
}

/** Reader subscription; the handler rides a ref so callers never churn the listener. */
export function useGraduated(handler: (workId: string) => void): void {
	const ref = useRef(handler);
	ref.current = handler;
	useEffect(() => onGraduated((id) => ref.current(id)), []);
}
