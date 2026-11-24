import { useSyncExternalStore } from "react";
import { viewKey, type ViewDescriptor } from "../viewer/view-descriptor";

/**
 * Shared state of the pinned strip: the unified per-thread pin store (wp.pins.v2, below)
 * and the feature progress panel's open state (session). Neutral module so every pin kind imports the same store.
 */

/** The pre-v2 dismissed list's storage key: read only by the one-time migration into wp.pins.v2. */
const DISMISSED_KEY = "wp.pinned-checklist.dismissed.v1";

// ---------------------------------------------------------------- open panel (session only: survives remounts, not a reload)

/**
 * One open panel per thread across the whole pinned column: the feature progress panel, the checklist and every decision or
 * graph pin. Opening one collapses the rest. Ids: `progress`, `checklist`, `decision:<objectId>`, `graph:<objectId>`.
 */
export const PANEL_PROGRESS = "progress";
const openPanels = new Map<string, string>();
const panelListeners = new Set<() => void>();

/** Open `id` (replacing whichever panel was open) or, with null, collapse whatever is open. */
export function setOpenPanel(threadId: string, id: string | null) {
	if ((openPanels.get(threadId) ?? null) === id) return;
	if (id === null) openPanels.delete(threadId);
	else openPanels.set(threadId, id);
	for (const l of panelListeners) l();
}

/** Collapse `id` only if it is the open one (a closing panel must not collapse a different one that just opened). */
export function closePanel(threadId: string, id: string) {
	if (openPanels.get(threadId) === id) setOpenPanel(threadId, null);
}

export const togglePanel = (threadId: string, id: string) => (openPanels.get(threadId) === id ? closePanel(threadId, id) : setOpenPanel(threadId, id));

function subscribePanels(l: () => void) {
	panelListeners.add(l);
	return () => void panelListeners.delete(l);
}

/** The id of the thread's open panel, or null. */
export function useOpenPanel(threadId: string): string | null {
	return useSyncExternalStore(subscribePanels, () => openPanels.get(threadId) ?? null, () => null);
}

/** Test hook: forget which panels are open. */
export function resetOpenPanels() {
	openPanels.clear();
}

// ---------------------------------------------------------------- unified per-thread pins (wp.pins.v2)

/**
 * Unified pin store. One persisted record per thread: `{ pins, expanded, dismissed }` under localStorage `wp.pins.v2`,
 * i.e. `{ [threadId]: { pins: Pin[]; expanded: string | null; dismissed?: { [`${kind}:${id}`]: { rev, pinRev } } } }`.
 *
 * Rules: `checklist`, `decision` and `graph` keep only the newest pin of their type (pinning another replaces it); `work`
 * and `kb` (and any other viewer kind) pin many, capped at 50 per thread; `task` is a single reserved pin (id "task").
 * At most one pin is `expanded` (`${kind}:${id}`) per thread. Unpinning is dismissing: it removes the pin, and for object
 * kinds records the rev/pinRev dismissed at. Any later explicit `pin()` re-adds it. `syncObjectPins` (auto-pins derived from
 * the transcript) re-adds a dismissed object only for a newer rev, or an explicit pinned:true with a higher pinRev.
 *
 * Migration: on the first read with no `wp.pins.v2`, the old `wp.pinned-views.v1` entries become owner-pinned pins and the
 * old dismissed list (`wp.pinned-checklist.dismissed.v1`) is folded into the dismissed set where its key parses (a migrated
 * dismissal holds against every plain revision, as before; only a higher pinRev revives it). The old keys are left untouched.
 * Every localStorage read/write is guarded; on failure the store keeps working from memory.
 *
 * pinView/unpinView/isViewPinned/getPinnedViews/usePinnedViews are thin wrappers over this store. The open-panel functions
 * above (session-only, ids like `progress`/`checklist`) are unchanged until the rendering moves to `expanded`.
 */
export type PinKind = "checklist" | "decision" | "graph" | "work" | "kb" | "task";
export interface Pin {
	kind: PinKind;
	id: string;
	title?: string;
	pinnedBy: "owner" | "agent";
	/** Object revision the pin was made at (objects only). */
	rev?: number;
	/** The agent's explicit-pin count for the object when pinned (objects only); gates revival of a dismissal. */
	pinRev?: number;
}
export type PinRef = { kind: string; id: string };
interface Dismissal {
	rev: number;
	pinRev: number;
}
interface ThreadPins {
	pins: readonly Pin[];
	expanded: string | null;
	dismissed: Readonly<Record<string, Dismissal>>;
}
/** One block of the transcript's structured objects, as syncObjectPins reads it (transcript order, oldest first). */
export interface SyncObject {
	type: string;
	id: string;
	rev: number;
	pinRev?: number;
	/** Explicit pin state: true re-adds (when pinRev is newer than a dismissal), false removes, absent auto-pins. */
	pinned?: boolean;
	title?: string;
}

const PINS_KEY = "wp.pins.v2";
const PINS_MAX_MANY = 50;
const OBJECT_KINDS: readonly string[] = ["checklist", "decision", "graph"];
const EMPTY_PINS: readonly Pin[] = [];
const EMPTY_THREAD: ThreadPins = { pins: EMPTY_PINS, expanded: null, dismissed: {} };
const KEPT_FOREVER = Number.MAX_SAFE_INTEGER;
let pinsState: Record<string, ThreadPins> | null = null;
const pinListeners = new Set<() => void>();

const refKey = (r: PinRef) => `${r.kind}:${r.id}`;
const normId = (kind: string, id: string) => (kind === "task" ? "task" : id);
const isObjectKind = (k: string) => OBJECT_KINDS.includes(k);

function cleanPin(x: unknown): Pin | null {
	if (!x || typeof x !== "object") return null;
	const p = x as Record<string, unknown>;
	if (typeof p.kind !== "string" || typeof p.id !== "string" || !p.kind || !p.id) return null;
	const out: Pin = { kind: p.kind as PinKind, id: normId(p.kind, p.id), pinnedBy: p.pinnedBy === "agent" ? "agent" : "owner" };
	if (typeof p.title === "string") out.title = p.title;
	if (typeof p.rev === "number") out.rev = p.rev;
	if (typeof p.pinRev === "number") out.pinRev = p.pinRev;
	return out;
}

function parseStored(v: unknown): Record<string, ThreadPins> {
	const out: Record<string, ThreadPins> = {};
	if (!v || typeof v !== "object" || Array.isArray(v)) return out;
	for (const [tid, raw] of Object.entries(v as Record<string, unknown>)) {
		if (!raw || typeof raw !== "object") continue;
		const r = raw as Record<string, unknown>;
		const pins = (Array.isArray(r.pins) ? r.pins : []).map(cleanPin).filter((p): p is Pin => p !== null);
		const dismissed: Record<string, Dismissal> = {};
		if (r.dismissed && typeof r.dismissed === "object") {
			for (const [k, d] of Object.entries(r.dismissed as Record<string, unknown>)) {
				const dd = d as Partial<Dismissal> | null;
				if (dd && typeof dd.rev === "number") dismissed[k] = { rev: dd.rev, pinRev: typeof dd.pinRev === "number" ? dd.pinRev : 0 };
			}
		}
		const expanded = typeof r.expanded === "string" && pins.some((p) => refKey(p) === r.expanded) ? r.expanded : null;
		if (pins.length || expanded || Object.keys(dismissed).length) out[tid] = { pins, expanded, dismissed };
	}
	return out;
}

/** Fold the old keys into a fresh state (first read only). Never writes or deletes. */
function migrateOld(): Record<string, ThreadPins> {
	const out: Record<string, ThreadPins> = {};
	const get = (tid: string): ThreadPins => out[tid] ?? { pins: [], expanded: null, dismissed: {} };
	try {
		const v: unknown = JSON.parse(localStorage.getItem(VIEWS_KEY) ?? "{}");
		if (v && typeof v === "object" && !Array.isArray(v)) {
			for (const [tid, list] of Object.entries(v as Record<string, unknown>)) {
				if (!Array.isArray(list)) continue;
				const pins = list
					.filter((d): d is ViewDescriptor => !!d && typeof (d as ViewDescriptor).kind === "string" && typeof (d as ViewDescriptor).id === "string")
					.map((d): Pin => (typeof d.title === "string" ? { kind: d.kind as PinKind, id: d.id, title: d.title, pinnedBy: "owner" } : { kind: d.kind as PinKind, id: d.id, pinnedBy: "owner" }));
				if (pins.length) out[tid] = { ...get(tid), pins: pins.slice(-PINS_MAX_MANY) };
			}
		}
	} catch {
		/* unreadable: no views */
	}
	try {
		const v: unknown = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "[]");
		if (Array.isArray(v)) {
			for (const s of v) {
				if (typeof s !== "string") continue;
				let t: unknown;
				try {
					t = JSON.parse(s);
				} catch {
					continue;
				}
				if (!Array.isArray(t) || typeof t[0] !== "string" || typeof t[1] !== "string") continue;
				const key = /^(decision|graph):/.test(t[1]) ? t[1] : `checklist:${t[1]}`;
				const cur = get(t[0]);
				out[t[0]] = { ...cur, dismissed: { ...cur.dismissed, [key]: { rev: KEPT_FOREVER, pinRev: typeof t[2] === "number" ? t[2] : 0 } } };
			}
		}
	} catch {
		/* unreadable: no dismissals */
	}
	return out;
}

function readPins(): Record<string, ThreadPins> {
	if (pinsState) return pinsState;
	let stored: string | null = null;
	try {
		stored = localStorage.getItem(PINS_KEY);
	} catch {
		/* memory only */
	}
	if (stored === null) pinsState = migrateOld();
	else {
		try {
			pinsState = parseStored(JSON.parse(stored));
		} catch {
			pinsState = {};
		}
	}
	return pinsState;
}

function commit(next: Record<string, ThreadPins>) {
	pinsState = next;
	try {
		localStorage.setItem(PINS_KEY, JSON.stringify(next)); // always written, even empty: its presence marks the migration done
	} catch {
		/* memory only */
	}
	for (const l of pinListeners) l();
}

function updateThread(threadId: string, fn: (t: ThreadPins) => ThreadPins) {
	const all = readPins();
	const cur = all[threadId] ?? EMPTY_THREAD;
	const next = fn(cur);
	if (next === cur || JSON.stringify(next) === JSON.stringify(cur)) return;
	const { [threadId]: _drop, ...rest } = all;
	commit(next.pins.length || next.expanded || Object.keys(next.dismissed).length ? { ...rest, [threadId]: next } : rest);
}

/** Add `p`: an existing pin of the same ref is refreshed in place; an object kind or the task replaces the older of its type. */
function withPin(t: ThreadPins, p: Pin): ThreadPins {
	const pin: Pin = { ...p, id: normId(p.kind, p.id) };
	const key = refKey(pin);
	const { [key]: _cleared, ...dismissed } = t.dismissed;
	let pins: Pin[];
	if (t.pins.some((x) => refKey(x) === key)) {
		pins = t.pins.map((x) => (refKey(x) === key ? { ...pin, ...(pin.title || !x.title ? {} : { title: x.title }) } : x));
	} else {
		const single = isObjectKind(pin.kind) || pin.kind === "task";
		pins = [...(single ? t.pins.filter((x) => x.kind !== pin.kind) : t.pins), pin];
		if (!single) {
			const many = pins.filter((x) => !isObjectKind(x.kind) && x.kind !== "task");
			const drop = new Set(many.slice(0, Math.max(0, many.length - PINS_MAX_MANY)).map(refKey));
			if (drop.size) pins = pins.filter((x) => !drop.has(refKey(x)));
		}
	}
	const expanded = t.expanded !== null && pins.some((x) => refKey(x) === t.expanded) ? t.expanded : null;
	return { pins, expanded, dismissed };
}

function withoutPin(t: ThreadPins, ref: PinRef, dismissing: boolean): ThreadPins {
	const key = refKey({ kind: ref.kind, id: normId(ref.kind, ref.id) });
	const old = t.pins.find((x) => refKey(x) === key);
	if (!old) return t;
	const dismissed = dismissing && isObjectKind(old.kind) ? { ...t.dismissed, [key]: { rev: old.rev ?? 0, pinRev: old.pinRev ?? 0 } } : t.dismissed;
	return { pins: t.pins.filter((x) => x !== old), expanded: t.expanded === key ? null : t.expanded, dismissed };
}

/** Pin `p` (any explicit pin re-adds a dismissed one). Object kinds replace the thread's older pin of that kind. */
export function pin(threadId: string, p: Pin) {
	updateThread(threadId, (t) => withPin(t, p));
}

/** Dismiss: remove the pin (clearing it if expanded). Object kinds remember the rev dismissed at so auto-pins don't revive it. */
export function unpin(threadId: string, ref: PinRef) {
	updateThread(threadId, (t) => withoutPin(t, ref, true));
}

/** The thread's pins in pin order. The array identity is stable until the list changes. */
export function listPins(threadId: string): readonly Pin[] {
	return readPins()[threadId]?.pins ?? EMPTY_PINS;
}

/** `${kind}:${id}` of the thread's expanded pin, or null. */
export function getExpanded(threadId: string): string | null {
	return readPins()[threadId]?.expanded ?? null;
}

/** Expand `ref` (collapsing any other) or, with null, collapse. A ref that is not pinned is ignored. */
export function setExpanded(threadId: string, ref: PinRef | null) {
	updateThread(threadId, (t) => {
		if (ref === null) return t.expanded === null ? t : { ...t, expanded: null };
		const key = refKey({ kind: ref.kind, id: normId(ref.kind, ref.id) });
		return t.pins.some((x) => refKey(x) === key) ? { ...t, expanded: key } : t;
	});
}

/**
 * Apply the transcript's object blocks (oldest first). `pinned: false` removes the object's pin; per type, the newest
 * object not explicitly unpinned auto-pins unless dismissed at its rev (a newer rev, or pinned:true with a higher pinRev, revives it).
 * Idempotent: syncing the same blocks again changes nothing.
 */
export function syncObjectPins(threadId: string, objects: readonly SyncObject[]) {
	updateThread(threadId, (start) => {
		let t = start;
		const newest = new Map<string, SyncObject>();
		for (const o of objects) {
			if (!isObjectKind(o.type)) continue;
			if (o.pinned === false) {
				t = withoutPin(t, { kind: o.type, id: o.id }, false);
				if (newest.get(o.type)?.id === o.id) newest.delete(o.type);
			} else newest.set(o.type, o);
		}
		for (const o of newest.values()) {
			const key = refKey({ kind: o.type, id: o.id });
			const d = t.dismissed[key];
			const pinRev = o.pinRev ?? 0;
			if (d && !(o.rev > d.rev || (o.pinned === true && pinRev > d.pinRev))) continue;
			const existing = t.pins.find((x) => refKey(x) === key);
			const title = o.title ?? existing?.title;
			t = withPin(t, {
				kind: o.type as PinKind,
				id: o.id,
				pinnedBy: existing?.pinnedBy ?? "agent",
				rev: o.rev,
				...(pinRev ? { pinRev } : {}),
				...(title ? { title } : {}),
			});
		}
		return t;
	});
}

function subscribePins(l: () => void) {
	pinListeners.add(l);
	const onStorage = (e: StorageEvent) => {
		if (e.key !== null && e.key !== PINS_KEY) return;
		pinsState = null;
		for (const x of pinListeners) x();
	};
	window.addEventListener("storage", onStorage);
	return () => {
		pinListeners.delete(l);
		window.removeEventListener("storage", onStorage);
	};
}

export function useThreadPins(threadId: string): readonly Pin[] {
	return useSyncExternalStore(subscribePins, () => listPins(threadId), () => EMPTY_PINS);
}

export function useExpanded(threadId: string): string | null {
	return useSyncExternalStore(subscribePins, () => getExpanded(threadId), () => null);
}

// ---------------------------------------------------------------- pinned views (viewer): wrappers over the unified store

const VIEWS_KEY = "wp.pinned-views.v1"; // legacy, read only by the migration
const EMPTY_VIEWS: readonly ViewDescriptor[] = [];
let viewsMemo: { src: readonly Pin[]; out: readonly ViewDescriptor[] } | null = null;
const toView = (p: Pin): ViewDescriptor => (p.title ? { kind: p.kind, id: p.id, title: p.title } : { kind: p.kind, id: p.id });

/** The thread's pinned views (work/kb and other viewer kinds) in pin order. The array identity is stable until the list changes. */
export function getPinnedViews(threadId: string): readonly ViewDescriptor[] {
	const src = listPins(threadId);
	if (viewsMemo?.src === src) return viewsMemo.out;
	const out = src.filter((p) => !isObjectKind(p.kind) && p.kind !== "task").map(toView);
	viewsMemo = { src, out: out.length ? out : EMPTY_VIEWS };
	return viewsMemo.out;
}

export const isViewPinned = (threadId: string, d: Pick<ViewDescriptor, "kind" | "id">): boolean => getPinnedViews(threadId).some((p) => viewKey(p) === viewKey(d));

/** Pin `d` with its title (the chip shows it). Re-pinning keeps the place and refreshes a given title. */
export function pinView(threadId: string, d: ViewDescriptor) {
	if (isObjectKind(d.kind) || d.kind === "task") return;
	pin(threadId, { kind: d.kind as PinKind, id: d.id, ...(d.title ? { title: d.title } : {}), pinnedBy: "owner" });
}

export function unpinView(threadId: string, d: Pick<ViewDescriptor, "kind" | "id">) {
	if (isObjectKind(d.kind) || d.kind === "task") return;
	unpin(threadId, d);
}

export function usePinnedViews(threadId: string): readonly ViewDescriptor[] {
	return useSyncExternalStore(subscribePins, () => getPinnedViews(threadId), () => EMPTY_VIEWS);
}

/** Test hook: forget the in-memory pins (storage stays). */
export function resetPinnedViewsCache() {
	pinsState = null;
	viewsMemo = null;
}
