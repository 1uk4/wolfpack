import { useMemo, useSyncExternalStore } from "react";
import { parseFrameDescriptor, type ViewDescriptor } from "./view-descriptor";

/**
 * The frames a thread's wolf has shown with show_view, one per objectId (latest rev), kept in localStorage so the floating chat bar
 * on other pages can list them too. Plus the owner's per-thread dismissals of frame badges.
 *  - frames:    `wolfpack:frames:<threadId>`                 JSON [{ objectId, path, title?, rev? }]
 *  - dismissed: `wolfpack:frame-dismissed:<threadId>:<objectId>` = "1"
 * Thread ids already start with the wolf name.
 */
export const framesKey = (threadId: string) => `wolfpack:frames:${threadId}`;
export const dismissedKey = (threadId: string, objectId: string) => `wolfpack:frame-dismissed:${threadId}:${objectId}`;

export interface FrameBadge {
	objectId: string;
	/** The frame view descriptor (kind "frame", id = path inside the wolf's frames dir). */
	descriptor: ViewDescriptor;
	/** The chip text: the latest rev's title (else the file name without `.html`) clipped by shortTitle. */
	label: string;
	/** The unclipped title, for the tooltip. */
	fullTitle: string;
}

interface StoredFrame {
	objectId: string;
	path: string;
	title?: string;
	rev?: number;
}

const listeners = new Set<() => void>();
let version = 0;
const emit = () => {
	version++;
	listeners.forEach((l) => l());
};
const subscribe = (cb: () => void) => {
	listeners.add(cb);
	return () => void listeners.delete(cb);
};

function storage(): Storage | null {
	try {
		return typeof window === "undefined" ? null : (window.localStorage ?? null);
	} catch {
		return null;
	}
}

/** Newest frames kept per thread; older ones (and their dismissal keys) are dropped. */
const MAX_FRAMES = 50;

/** A stored path is a relative, forward-slash `.html` path with no `..` segment, NUL or backslash. */
function safePath(p: string): boolean {
	return !p.startsWith("/") && !p.includes("\\") && !p.includes("\0") && /\.html$/i.test(p) && !p.split("/").includes("..");
}

function readFrames(threadId: string): StoredFrame[] {
	try {
		const v = JSON.parse(storage()?.getItem(framesKey(threadId)) ?? "[]") as unknown;
		if (!Array.isArray(v)) return [];
		const out: StoredFrame[] = [];
		for (const f of v as Array<Record<string, unknown> | null>) {
			if (!f || typeof f.objectId !== "string" || typeof f.path !== "string" || !safePath(f.path)) continue;
			const d = parseFrameDescriptor({ kind: "frame", path: f.path, title: f.title, rev: f.rev }, "w");
			if (!d) continue;
			out.push({ objectId: f.objectId, path: d.id, ...(d.title ? { title: d.title } : {}), ...(d.rev !== undefined ? { rev: d.rev } : {}) });
		}
		return out;
	} catch {
		return [];
	}
}

interface ViewPartLike {
	type?: string;
	objectId?: unknown;
	objectType?: unknown;
	rev?: unknown;
	data?: unknown;
}

/** Folds the thread's messages: every frame view (history too) is upserted by objectId, a higher rev replacing the stored one. Only writes on a change. */
export function recordFrames(wolf: string, threadId: string, messages: ReadonlyArray<{ role?: string; parts?: unknown[] }>): void {
	const viewParts = messages.some((m) => m.role === "assistant" && ((m.parts ?? []) as ViewPartLike[]).some((p) => p.type === "object" && p.objectType === "view" && (p.data as { kind?: unknown } | undefined)?.kind === "frame"));
	if (!viewParts) return;
	const byId = new Map(readFrames(threadId).map((f) => [f.objectId, f]));
	let changed = false;
	for (const m of messages) {
		if (m.role !== "assistant") continue;
		for (const p of (m.parts ?? []) as ViewPartLike[]) {
			if (p.type !== "object" || p.objectType !== "view" || typeof p.objectId !== "string") continue;
			const d = p.data as { kind?: unknown } | undefined;
			if (d?.kind !== "frame") continue;
			const f = parseFrameDescriptor({ ...d, rev: p.rev }, wolf);
			if (!f) continue;
			const prev = byId.get(p.objectId);
			if (prev && (prev.rev ?? 0) > (f.rev ?? 0)) continue;
			const next: StoredFrame = { objectId: p.objectId, path: f.id, ...(f.title ? { title: f.title } : {}), ...(f.rev !== undefined ? { rev: f.rev } : {}) };
			if (prev && JSON.stringify(prev) === JSON.stringify(next)) continue;
			byId.set(p.objectId, next);
			changed = true;
		}
	}
	if (!changed) return;
	const all = [...byId.values()];
	const kept = all.slice(-MAX_FRAMES);
	try {
		for (const f of all.slice(0, all.length - kept.length)) storage()?.removeItem(dismissedKey(threadId, f.objectId));
		storage()?.setItem(framesKey(threadId), JSON.stringify(kept));
	} catch {
		/* best effort */
	}
	emit();
}

/**
 * A frame opened by link (`?view=frame:<path>`, or a reload of that page) gets a badge like one from show_view, titled with the path.
 * Skipped when the thread already has a badge for that path (a show_view one, dismissed or not), so a dismissal is never undone by the link.
 * Its objectId is stable (`link:<path>`), so dismissing it sticks across reloads.
 */
export function recordFrameFromLink(threadId: string, path: string): void {
	if (!safePath(path)) return;
	const stored = readFrames(threadId);
	if (stored.some((f) => f.path === path)) return;
	const kept = [...stored, { objectId: `link:${path}`, path, title: path }].slice(-MAX_FRAMES);
	try {
		storage()?.setItem(framesKey(threadId), JSON.stringify(kept));
	} catch {
		/* best effort */
	}
	emit();
}

export function isFrameDismissed(threadId: string, objectId: string): boolean {
	try {
		return storage()?.getItem(dismissedKey(threadId, objectId)) === "1";
	} catch {
		return false;
	}
}

/** Hides the badge of this objectId for the thread, for every rev. */
export function dismissFrame(threadId: string, objectId: string): void {
	try {
		storage()?.setItem(dismissedKey(threadId, objectId), "1");
	} catch {
		/* best effort */
	}
	emit();
}

/** The chip text for a title: its first two words, at most 16 characters (an ellipsis replaces the cut), with trailing punctuation dropped. The full title stays in the tooltip. */
export function shortTitle(title: string): string {
	const two = title.trim().split(/\s+/).slice(0, 2).join(" ").replace(/[\s.,;:!?\-\u2013\u2014\u2026]+$/, "");
	// By code points, so an emoji or other surrogate pair is never cut in half.
	const chars = Array.from(two);
	return chars.length > 16 ? `${chars.slice(0, 15).join("")}\u2026` : two;
}

const fullLabelOf = (f: StoredFrame) => f.title?.trim() || (f.path.split("/").pop() ?? f.path).replace(/\.html$/i, "");

/** The thread's visible frame badges (not dismissed), in the order the frames first appeared. */
export function useFrameBadges(wolf: string, threadId: string): FrameBadge[] {
	const v = useSyncExternalStore(subscribe, () => version, () => 0);
	// The server (and the hydrating first client render) has no localStorage: render no badges then, so both match; they appear after mount.
	const mounted = useSyncExternalStore(subscribeNever, () => true, () => false);
	return useMemo(
		() =>
			(mounted ? readFrames(threadId) : [])
				.filter((f) => !isFrameDismissed(threadId, f.objectId))
				.map((f) => ({
					objectId: f.objectId,
					label: shortTitle(fullLabelOf(f)),
					fullTitle: fullLabelOf(f),
					descriptor: { kind: "frame", id: f.path, wolf, ...(f.title?.trim() ? { title: f.title.trim() } : {}), ...(f.rev !== undefined ? { rev: f.rev } : {}) },
				})),
		// eslint-disable-next-line react-hooks/exhaustive-deps -- `v` is the store's change counter
		[wolf, threadId, v, mounted],
	);
}

const subscribeNever = () => () => {};
