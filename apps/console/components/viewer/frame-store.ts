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
	/** The latest rev's title, else the file name without `.html`. */
	label: string;
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

function readFrames(threadId: string): StoredFrame[] {
	try {
		const v = JSON.parse(storage()?.getItem(framesKey(threadId)) ?? "[]") as unknown;
		if (!Array.isArray(v)) return [];
		return v.filter((f): f is StoredFrame => !!f && typeof f.objectId === "string" && typeof f.path === "string" && !!f.path);
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
	try {
		storage()?.setItem(framesKey(threadId), JSON.stringify([...byId.values()]));
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

const labelOf = (f: StoredFrame) => f.title || (f.path.split("/").pop() ?? f.path).replace(/\.html$/i, "");

/** The thread's visible frame badges (not dismissed), in the order the frames first appeared. */
export function useFrameBadges(wolf: string, threadId: string): FrameBadge[] {
	const v = useSyncExternalStore(subscribe, () => version, () => 0);
	return useMemo(
		() =>
			readFrames(threadId)
				.filter((f) => !isFrameDismissed(threadId, f.objectId))
				.map((f) => ({
					objectId: f.objectId,
					label: labelOf(f),
					descriptor: { kind: "frame", id: f.path, wolf, ...(f.title ? { title: f.title } : {}), ...(f.rev !== undefined ? { rev: f.rev } : {}) },
				})),
		// eslint-disable-next-line react-hooks/exhaustive-deps -- `v` is the store's change counter
		[wolf, threadId, v],
	);
}
