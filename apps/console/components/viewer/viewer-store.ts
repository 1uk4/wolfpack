import { useMemo, useSyncExternalStore } from "react";
import { viewKey, type ViewDescriptor } from "./view-descriptor";

/**
 * Per-thread viewer state (the stack of opened views and whether the panel is open), persisted in localStorage under
 * `wolfpack:viewer:<wolf>:<threadId>` with a small write debounce. Module-level map + useSyncExternalStore, like pin-store.
 */
export interface ViewerState {
	stack: readonly ViewDescriptor[];
	open: boolean;
}

export const VIEWER_DEBOUNCE_MS = 200;
export const VIEWER_MAX_DEPTH = 50;
export const viewerKey = (wolf: string, threadId: string) => `wolfpack:viewer:${wolf}:${threadId}`;

const EMPTY: ViewerState = { stack: [], open: false };
const states = new Map<string, ViewerState>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

function storage(): Storage | null {
	try {
		return typeof window === "undefined" ? null : (window.localStorage ?? null);
	} catch {
		return null;
	}
}

function parse(raw: string | null): ViewerState {
	if (!raw) return EMPTY;
	try {
		const v = JSON.parse(raw) as { stack?: unknown; open?: unknown };
		if (!Array.isArray(v.stack)) return EMPTY;
		const stack = (v.stack as unknown[])
			.filter((d): d is ViewDescriptor => !!d && typeof (d as ViewDescriptor).kind === "string" && typeof (d as ViewDescriptor).id === "string")
			.map((d) => ({
				kind: d.kind,
				id: d.id,
				...(typeof d.title === "string" ? { title: d.title } : {}),
				...(typeof d.wolf === "string" ? { wolf: d.wolf } : {}),
				...(typeof d.rev === "number" ? { rev: d.rev } : {}),
			}))
			.slice(-VIEWER_MAX_DEPTH);
		return { stack, open: v.open === true && stack.length > 0 };
	} catch {
		return EMPTY;
	}
}

/** Restores from storage on the first read of a key. */
export function getViewerState(wolf: string, threadId: string): ViewerState {
	const key = viewerKey(wolf, threadId);
	let s = states.get(key);
	if (!s) {
		let raw: string | null = null;
		try {
			raw = storage()?.getItem(key) ?? null;
		} catch {
			/* storage unavailable (private mode, denied): start empty and keep the state in memory */
		}
		s = parse(raw);
		states.set(key, s);
	}
	return s;
}

function write(key: string) {
	timers.delete(key);
	try {
		const s = states.get(key);
		const st = storage();
		if (!st || !s) return;
		if (s.stack.length === 0) st.removeItem(key);
		else st.setItem(key, JSON.stringify(s));
	} catch {
		/* best effort */
	}
}

/** Writes every pending state now (pagehide, tests). */
export function flushViewer() {
	for (const [key, t] of [...timers]) {
		clearTimeout(t);
		write(key);
	}
}

let hooked = false;
function set(wolf: string, threadId: string, next: ViewerState) {
	const key = viewerKey(wolf, threadId);
	states.set(key, next);
	const t = timers.get(key);
	if (t) clearTimeout(t);
	timers.set(key, setTimeout(() => write(key), VIEWER_DEBOUNCE_MS));
	if (!hooked && typeof window !== "undefined" && typeof window.addEventListener === "function") {
		hooked = true;
		window.addEventListener("pagehide", flushViewer);
	}
	for (const l of listeners) l();
}

const cap = (stack: readonly ViewDescriptor[]) => (stack.length > VIEWER_MAX_DEPTH ? stack.slice(-VIEWER_MAX_DEPTH) : stack);
const topIs = (s: ViewerState, d: ViewDescriptor) => s.stack.length > 0 && viewKey(s.stack[s.stack.length - 1]!) === viewKey(d);

/** Push and open; no duplicate when the top is already this view. */
export function openView(wolf: string, threadId: string, d: ViewDescriptor) {
	const s = getViewerState(wolf, threadId);
	set(wolf, threadId, { stack: topIs(s, d) ? s.stack : cap([...s.stack, d]), open: true });
}

/** A newer show_view rev for a view already in the stack: replaces that entry in place (same key) so its renderer refetches. No-op when absent or the rev is unchanged. */
export function refreshView(wolf: string, threadId: string, d: ViewDescriptor) {
	const s = getViewerState(wolf, threadId);
	const k = viewKey(d);
	if (!s.stack.some((x) => viewKey(x) === k && x.rev !== d.rev)) return;
	set(wolf, threadId, { stack: s.stack.map((x) => (viewKey(x) === k ? d : x)), open: s.open });
}

/** Push without changing open. A duplicate of the top is ignored. */
export function pushView(wolf: string, threadId: string, d: ViewDescriptor) {
	const s = getViewerState(wolf, threadId);
	if (topIs(s, d)) return;
	set(wolf, threadId, { stack: cap([...s.stack, d]), open: s.open });
}

/** Pop the top; an emptied stack closes the viewer. */
export function backView(wolf: string, threadId: string) {
	const s = getViewerState(wolf, threadId);
	if (s.stack.length === 0) return;
	const stack = s.stack.slice(0, -1);
	set(wolf, threadId, { stack, open: stack.length > 0 && s.open });
}

/** Hide the panel but keep the stack. */
export function closeViewer(wolf: string, threadId: string) {
	const s = getViewerState(wolf, threadId);
	if (!s.open) return;
	set(wolf, threadId, { stack: s.stack, open: false });
}

/** Replace the whole state (used by the URL sync's load-time merge). */
export function setViewerState(wolf: string, threadId: string, next: ViewerState) {
	set(wolf, threadId, next);
}

export function clearViewer(wolf: string, threadId: string) {
	set(wolf, threadId, EMPTY);
}

/** Test hook: forget the in-memory state (storage is left as is). */
export function resetViewerCache() {
	for (const t of timers.values()) clearTimeout(t);
	timers.clear();
	states.clear();
}

function subscribe(l: () => void) {
	listeners.add(l);
	return () => void listeners.delete(l);
}

export function useViewer(wolf: string, threadId: string) {
	const state = useSyncExternalStore(subscribe, () => getViewerState(wolf, threadId), () => EMPTY);
	const actions = useMemo(
		() => ({
			openView: (d: ViewDescriptor) => openView(wolf, threadId, d),
			pushView: (d: ViewDescriptor) => pushView(wolf, threadId, d),
			backView: () => backView(wolf, threadId),
			closeViewer: () => closeViewer(wolf, threadId),
			clearViewer: () => clearViewer(wolf, threadId),
		}),
		[wolf, threadId],
	);
	return { ...state, ...actions };
}
