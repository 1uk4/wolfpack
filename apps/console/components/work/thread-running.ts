"use client";

/**
 * Is the feature thread of a work item running? Graduate controls (Work page, item view, graph pane, graduation cards) stay
 * disabled while it has a turn in progress or a live sub-agent (work-wolfpack-3EYS8mM). The wolf's thread list says it:
 * a feature thread's `status` is busy during a turn, and running sub-agents are listed with `parentThreadId` and `state`.
 * One store per wolf is shared by every control on screen and refreshed on each `thread-updated` event and resync, so the
 * controls enable again when the thread goes idle, without a reload. wolfd refuses too (a stale tab cannot graduate).
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { fetchWolfThreads } from "../kb/kb-client";
import { useOptionalServerEvent, useOptionalServerResync } from "../shell/server-events";

export interface RunRow {
	id: string;
	kind?: string;
	boundWorkItem?: string;
	status?: string;
	closed?: boolean;
	parentThreadId?: string;
	state?: string;
}

export const THREAD_RUNNING_LABEL = "Thread still running: graduate once it is idle";
const LIVE_CHILD = new Set(["queued", "running", "waiting"]);

/** The work items whose open feature thread has a turn in progress or a live sub-agent. */
export function runningItemIds(rows: readonly RunRow[]): Set<string> {
	const parentsWithLiveChild = new Set<string>();
	for (const r of rows) if (r.parentThreadId && r.state && LIVE_CHILD.has(r.state)) parentsWithLiveChild.add(r.parentThreadId);
	const out = new Set<string>();
	for (const r of rows) {
		if (r.kind !== "feature" || !r.boundWorkItem || r.closed) continue;
		if (r.status === "busy" || parentsWithLiveChild.has(r.id)) out.add(r.boundWorkItem);
	}
	return out;
}

const EMPTY: ReadonlySet<string> = new Set();

class ThreadRunningStore {
	private byWolf = new Map<string, ReadonlySet<string>>();
	private subs = new Set<() => void>();
	/** Swappable in tests. */
	load: (wolf: string) => Promise<RunRow[]> = async (wolf) => {
		const r = await fetchWolfThreads<{ threads?: RunRow[] }>(wolf, 1000);
		if (!r.ok) throw new Error(r.message);
		return r.data.threads ?? [];
	};
	subscribe = (fn: () => void) => {
		this.subs.add(fn);
		return () => void this.subs.delete(fn);
	};
	running(wolf: string | undefined, itemId: string): boolean {
		return !!wolf && (this.byWolf.get(wolf) ?? EMPTY).has(itemId);
	}
	itemsOf(wolf: string | undefined): ReadonlySet<string> {
		return (wolf && this.byWolf.get(wolf)) || EMPTY;
	}
	private inflight = new Map<string, Promise<void>>();
	private again = new Set<string>();
	private epoch = 0;
	/**
	 * Read the wolf's thread list again. One read per wolf is in flight at a time, shared by every caller; refreshes that arrive
	 * meanwhile fold into ONE trailing read, so answers apply in order. An unreadable list keeps the last answer.
	 */
	refresh(wolf: string): Promise<void> {
		const running = this.inflight.get(wolf);
		if (running) {
			this.again.add(wolf);
			return running;
		}
		const p = this.drain(wolf).finally(() => this.inflight.delete(wolf));
		this.inflight.set(wolf, p);
		return p;
	}
	private async drain(wolf: string): Promise<void> {
		do {
			this.again.delete(wolf);
			const epoch = this.epoch;
			try {
				const next = runningItemIds(await this.load(wolf));
				if (epoch !== this.epoch) continue; // a reset overtook this answer
				const prev = this.byWolf.get(wolf) ?? EMPTY;
				if (next.size === prev.size && [...next].every((id) => prev.has(id))) continue;
				this.byWolf.set(wolf, next);
				for (const fn of this.subs) fn();
			} catch {
				/* keeps the last answer; the wolf refuses anyway */
			}
		} while (this.again.has(wolf));
	}
	reset() {
		this.epoch++;
		this.again.clear();
		this.byWolf.clear();
		for (const fn of this.subs) fn();
	}
}

export const threadRunningStore = new ThreadRunningStore();

/** Whether `itemId`'s feature thread on `wolf` is running now; live. False when the wolf is unknown. */
export function useThreadRunning(wolf: string | undefined, itemId: string): boolean {
	const snap = useCallback(() => threadRunningStore.running(wolf, itemId), [wolf, itemId]);
	const running = useSyncExternalStore(threadRunningStore.subscribe, snap, () => false);
	const refresh = useCallback(() => {
		if (wolf) void threadRunningStore.refresh(wolf);
	}, [wolf]);
	useEffect(refresh, [refresh]);
	useOptionalServerEvent("thread-updated", refresh);
	useOptionalServerResync(refresh);
	return running;
}

/** Every work item of  whose feature thread is running now (a card lists several items); live. */
export function useRunningItems(wolf: string | undefined): ReadonlySet<string> {
	const snap = useCallback(() => threadRunningStore.itemsOf(wolf), [wolf]);
	const items = useSyncExternalStore(threadRunningStore.subscribe, snap, () => EMPTY);
	const refresh = useCallback(() => {
		if (wolf) void threadRunningStore.refresh(wolf);
	}, [wolf]);
	useEffect(refresh, [refresh]);
	useOptionalServerEvent("thread-updated", refresh);
	useOptionalServerResync(refresh);
	return items;
}

/** The wolf a graduation card option names in its more-details link (`/work/<id>?view=graduation&wolf=<name>`), if it is one. */
export function graduationOptionWolf(href: string | undefined): string | undefined {
	if (!href || !/^\/work\/[^?]+\?(?:.*&)?view=graduation(?:&|$)/.test(href)) return undefined;
	return new URL(href, "http://x").searchParams.get("wolf") ?? undefined;
}
