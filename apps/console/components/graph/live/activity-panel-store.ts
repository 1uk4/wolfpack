"use client";

/** The Activity panel's open flag and unseen badge, shared by the toolbar button and the panel (a tiny external store). */
import { useSyncExternalStore } from "react";

export const OPEN_KEY = "wolfpack.graph.activityFeed.open";
interface State {
	open: boolean;
	unseen: number;
	/** False until the panel read the remembered state after mount (SSR-safe). */
	ready: boolean;
}
let state: State = { open: false, unseen: 0, ready: false };
const subs = new Set<() => void>();

export function patchActivityPanel(p: Partial<State>): void {
	const next = { ...state, ...p };
	if (next.open === state.open && next.unseen === state.unseen && next.ready === state.ready) return;
	state = next;
	for (const s of subs) s();
}
export function toggleActivityPanel(open?: boolean): void {
	const o = open ?? !state.open;
	try {
		if (typeof localStorage !== "undefined") localStorage.setItem(OPEN_KEY, o ? "1" : "0");
	} catch {
		/* storage blocked */
	}
	patchActivityPanel({ open: o, ...(o ? { unseen: 0 } : {}) });
}
export function useActivityPanel(): State {
	return useSyncExternalStore(
		(cb) => {
			subs.add(cb);
			return () => void subs.delete(cb);
		},
		() => state,
		() => state,
	);
}
