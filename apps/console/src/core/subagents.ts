/**
 * Subagent children as the console shows them: the strip above a parent's composer, the nesting in the sidebar and the
 * job list. PURE — no React, no IO. The wire shape is ThreadSummary's child fields (@wolfpack/protocol).
 */

export type SubagentState = "queued" | "running" | "waiting" | "done" | "failed" | "stopped";

/** The child fields of a ThreadSummary the console reads (a thread without `parentThreadId` is top level). */
export interface ChildThread {
	id: string;
	title: string;
	parentThreadId?: string;
	agent?: string;
	state?: SubagentState;
	queuePosition?: number;
	startedAt?: string;
	finishedAt?: string;
	step?: string;
	tokens?: number;
	taskId?: string;
}

export const isChildThread = (t: { parentThreadId?: string }): boolean => t.parentThreadId !== undefined;

/** A child still doing (or about to do) work: Stop applies, and it never collapses. */
export const isLive = (t: { state?: SubagentState }): boolean => t.state === "queued" || t.state === "running" || t.state === "waiting";
export const isSettled = (t: { state?: SubagentState }): boolean => t.state === "done" || t.state === "failed" || t.state === "stopped";
/** Only a running child can be stopped from the strip. */
export const canStop = (t: { state?: SubagentState }): boolean => t.state === "running";

/** The state as a short phrase: a queued child names its place, a waiting one says what it waits on. */
export function stateLabel(t: { state?: SubagentState; queuePosition?: number }): string {
	switch (t.state) {
		case "queued":
			return t.queuePosition ? `queued #${t.queuePosition}` : "queued";
		case "waiting":
			return "waiting on parent";
		case undefined:
			return "";
		default:
			return t.state;
	}
}

/** Milliseconds a child has worked: start to finish when settled, start to `now` while live (queued has not started: 0). */
export function elapsedMs(t: { startedAt?: string; finishedAt?: string; state?: SubagentState }, now: number): number {
	if (!t.startedAt) return 0;
	const start = Date.parse(t.startedAt);
	if (Number.isNaN(start)) return 0;
	const end = isSettled(t) && t.finishedAt ? Date.parse(t.finishedAt) : now;
	return Math.max(0, (Number.isNaN(end) ? now : end) - start);
}

/** "42s", "3m 05s", "1h 02m". */
export function formatChildElapsed(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Insert or replace a child by id (a thread-updated event), keeping the order of first appearance. */
export function upsertChild<T extends { id: string }>(list: readonly T[], next: T): T[] {
	const i = list.findIndex((c) => c.id === next.id);
	return i < 0 ? [...list, next] : list.map((c, n) => (n === i ? next : c));
}

/** A settled child stays in the strip this long, then folds into the "N done" toggle. */
export const DONE_LINGER_MS = 30_000;

/**
 * The strip's rows: live children and recently settled ones are `shown`; settled ones past the linger are `done`
 * (behind the toggle, still reachable). `expanded` shows them all.
 */
export function partitionChildren<T extends ChildThread>(children: readonly T[], now: number, expanded: boolean, lingerMs = DONE_LINGER_MS): { shown: T[]; done: T[] } {
	const old = (c: T) => isSettled(c) && (!c.finishedAt || now - Date.parse(c.finishedAt) >= lingerMs);
	const done = children.filter(old);
	return { shown: expanded ? [...children] : children.filter((c) => !old(c)), done };
}

/** Sidebar order: top-level rows keep their order, each followed by its children (oldest first). Orphans (parent unlisted) stay top level. */
export function nestChildren<T extends { id: string; parentThreadId?: string }>(rows: readonly T[]): { top: T[]; children: Map<string, T[]> } {
	// Depth 1: only a row that is not itself a child can be a parent.
	const ids = new Set(rows.filter((r) => r.parentThreadId === undefined).map((r) => r.id));
	const children = new Map<string, T[]>();
	const top: T[] = [];
	for (const r of rows) {
		if (r.parentThreadId !== undefined && ids.has(r.parentThreadId)) children.set(r.parentThreadId, [...(children.get(r.parentThreadId) ?? []), r]);
		else top.push(r);
	}
	return { top, children };
}

export interface SidebarGroup<T> {
	top: T;
	/** The children to draw under `top` now. */
	kids: T[];
	/** Settled children behind the "N done" toggle (0 while expanded or searching). */
	done: number;
	/** The toggle is drawn when `top` has settled children and no search is running. */
	toggle: boolean;
}

/** A subagent row: kind "subagent" or any parent. Such a row is NEVER top level in the sidebar. */
export function isSubRow(r: { kind?: string; parentThreadId?: string }): boolean {
	return r.kind === "subagent" || r.parentThreadId !== undefined;
}

type LayoutRow = { id: string; kind?: string; parentThreadId?: string; state?: SubagentState; archived?: boolean };

/**
 * The sidebar layout: `groups` are the main (not archived) threads, `archived` the archived ones, each with its LIVE
 * subagents nested. Settled subagents are dropped (visibility only). A live subagent nests under its parent whether
 * the parent is in the main list or archived; with the parent missing it nests under Home; with no Home it is dropped.
 * It is never a top-level row. `ranked` is the (searched) list in display order: with `searching`, only matching rows
 * show (a parent with a matching child shows too).
 */
export function sidebarLayout<T extends LayoutRow>(all: readonly T[], ranked: readonly T[], searching: boolean): { groups: SidebarGroup<T>[]; archived: SidebarGroup<T>[] } {
	const parents = all.filter((r) => !isSubRow(r));
	const byId = new Map(parents.map((t) => [t.id, t]));
	const home = parents.find((p) => p.kind === "home" && !p.archived);
	const parentOf = (k: T): string | undefined => (k.parentThreadId !== undefined && byId.has(k.parentThreadId) ? k.parentThreadId : home?.id);
	const kidsOf = new Map<string, T[]>();
	for (const k of all) {
		if (!isSubRow(k) || isSettled(k)) continue;
		const pid = parentOf(k);
		if (pid !== undefined) kidsOf.set(pid, [...(kidsOf.get(pid) ?? []), k]);
	}
	const matched = new Set(ranked.map((r) => r.id));
	const order: string[] = [];
	for (const r of ranked) {
		const key = isSubRow(r) ? (isSettled(r) ? undefined : parentOf(r)) : r.id;
		if (key !== undefined && byId.has(key) && !order.includes(key)) order.push(key);
	}
	const mk = (id: string): SidebarGroup<T> => {
		const kids = kidsOf.get(id) ?? [];
		return { top: byId.get(id)!, kids: searching ? kids.filter((k) => matched.has(k.id)) : kids, done: 0, toggle: false };
	};
	return { groups: order.filter((id) => !byId.get(id)!.archived).map(mk), archived: order.filter((id) => byId.get(id)!.archived).map(mk) };
}

/** The main groups of `sidebarLayout` (kept for callers that ignore the archive). */
export function sidebarGroups<T extends LayoutRow>(all: readonly T[], ranked: readonly T[], searching: boolean, _expanded?: ReadonlySet<string>): SidebarGroup<T>[] {
	return sidebarLayout(all, ranked, searching).groups;
}
