/**
 * THE THREAD MEMORY PANEL MODEL: pure reducers + view helpers over memory
 * events and the status resource. Browser-safe, no IO. The live observation
 * feed (capped, thread-scoped, destination-labelled), promote job state
 * (incl. memory_busy), Record staleness on record_written, pool summary and
 * the off/inert banner.
 */

import type { MemoryEventFrame, MemoryPoolStatus, MemoryStatus, WorkRecordResponse } from "./kb.ts";

export const FEED_CAP = 100;
export const MEMORY_PANEL_OPEN_KEY = "lh.memory-panel.open.v1";
export const MEMORY_PANEL_VIEW_KEY = "lh.memory-panel.view.v1";

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

type Target = { kind?: string; topicId?: string; workId?: string; featureId?: string };
const targetOf = (e: MemoryEventFrame): Target | undefined => {
	const t = (e as Record<string, unknown>).target;
	return typeof t === "object" && t !== null ? (t as Target) : undefined;
};

// ─── Persisted open state ────────────────────────────────────────────────────

/** Parse the stored collapse flag; anything but an explicit "0"/"false" means open. */
export function parseOpen(raw: string | null | undefined): boolean {
	return !(raw === "0" || raw === "false");
}
export const serializeOpen = (open: boolean): string => (open ? "1" : "0");

// ─── Persisted item / feed view ────────────────────────────────────────

export type PanelView = "item" | "feed";

/** SSR-safe: "feed" is kept; anything else (incl. no stored value and the retired "graph" view) is the item view. */
export function parseView(raw: string | null | undefined): PanelView {
	return raw === "feed" ? "feed" : "item";
}
export const serializeView = (view: PanelView): string => view;

// ─── Bind this thread to the shown task ───────────────────────────────────────

/**
 * Whether the viewer offers "Bind this thread to this task" for the item it shows: never for the thread's bound item, a
 * feature (a workspace), an archived item or a container, and not without the thread's slug (the bind route's key).
 * A graduated item or one held by another conversation is only known to the bind route; its refusal is shown.
 */
export function bindOffered(item: Pick<WorkRecordResponse, "id" | "kind" | "stage" | "container"> | null, boundId: string | null, hasSlug: boolean): boolean {
	return hasSlug && !!item && item.id !== boundId && item.kind !== "feature" && item.stage !== "archived" && !item.container;
}

// ─── Banner (memory off / inert) ─────────────────────────────────────────────

export interface MemoryBanner {
	tone: "off" | "inert";
	title: string;
	reason: string;
}

/** The state banner: only off/inert are explained; live and sandbox show none. */
export function bannerOf(status: Pick<MemoryStatus, "state" | "reason">): MemoryBanner | null {
	switch (status.state) {
		case "off":
			return { tone: "off", title: "Memory is off", reason: status.reason };
		case "inert":
			return { tone: "inert", title: "Memory is inert", reason: status.reason };
		default:
			return null;
	}
}

/** Consolidate/promote only make sense when memory runs. */
export const memoryActive = (status: Pick<MemoryStatus, "state"> | null): boolean =>
	status !== null && (status.state === "live" || status.state === "sandbox");

// ─── Pool ────────────────────────────────────────────────────────────────────

export interface PoolSummary {
	count: number;
	tokens: number;
	consolidateAtTokens: number;
	poolTarget: number;
	/** tokens / consolidateAtTokens, clamped 0..1 (0 when the threshold is 0). */
	fill: number;
	/** Where poolTarget sits on the same 0..1 scale. */
	targetMark: number;
	/** "1,332 / 20,000 tokens" */
	tokensText: string;
	/** "22 observations" */
	observationsText: string;
	trigger: MemoryPoolStatus["trigger"];
}

export function poolSummary(pool: MemoryPoolStatus | null): PoolSummary | null {
	if (!pool) return null;
	const at = pool.consolidateAtTokens;
	const ratio = (n: number) => (at > 0 ? Math.min(1, Math.max(0, n / at)) : 0);
	return {
		count: pool.count,
		tokens: pool.tokens,
		consolidateAtTokens: at,
		poolTarget: pool.poolTarget,
		fill: ratio(pool.tokens),
		targetMark: ratio(pool.poolTarget),
		trigger: pool.trigger,
		tokensText: `${pool.tokens.toLocaleString("en-US")} / ${at.toLocaleString("en-US")} tokens`,
		observationsText: `${pool.count} ${pool.count === 1 ? "observation" : "observations"}`,
	};
}

// ─── Observation feed ────────────────────────────────────────────────────────

export interface FeedItem {
	key: string;
	timestamp: string;
	count: number;
	summary: string;
	/** Where the observation is headed, human readable. */
	destination: string;
	target: { kind: "den" | "session" | "work"; id?: string };
}

/** The destination label: "den topic <id>", "session topic <id>", "Record of <item>" (or the pool when no topic is known yet). */
export function destinationLabel(t: Target | undefined, workTitles: Readonly<Record<string, string>> = {}): string {
	if (!t) return "pool";
	if (t.kind === "work" && t.workId) return `Record of ${workTitles[t.workId] ?? t.workId}`;
	if (t.kind === "den") return t.topicId ? `den topic ${t.topicId}` : "den pool";
	if (t.kind === "session") return t.topicId ? `session topic ${t.topicId}` : "session pool";
	return "pool";
}

/**
 * True when the event came out of this thread. Only events from the wolf's HOME conversation carry a
 * threadId; pool-level events (consolidate, promote) and other conversations' events have none and are not the thread's.
 */
export const eventInThread = (e: MemoryEventFrame, threadId: string): boolean => str((e as Record<string, unknown>).threadId) === threadId;

/** An observation_captured event of this thread → a feed item (caller supplies the unique key); anything else → null. */
export function feedItemOf(e: MemoryEventFrame, threadId: string, key: string, workTitles?: Readonly<Record<string, string>>): FeedItem | null {
	if (e.type !== "observation_captured" || !eventInThread(e, threadId)) return null;
	const o = e as Record<string, unknown>;
	const t = targetOf(e);
	const kind = t?.kind === "work" || t?.kind === "session" ? t.kind : "den";
	const id = kind === "work" ? t?.workId : t?.topicId;
	return {
		key,
		timestamp: str(o.timestamp) ?? "",
		count: num(o.count) ?? 1,
		summary: str(o.summary) ?? "",
		destination: destinationLabel(t, workTitles),
		target: id ? { kind, id } : { kind },
	};
}

/** Newest first, capped. */
export function pushFeed(feed: readonly FeedItem[], item: FeedItem, cap = FEED_CAP): FeedItem[] {
	return [item, ...feed].slice(0, cap);
}

// ─── Promote job state ───────────────────────────────────────────────────────

export type PromoteState =
	| { phase: "idle" }
	| { phase: "starting" }
	| { phase: "running"; jobId: string }
	| { phase: "finished"; jobId: string; consolidated: number; contributions: number; pending: number }
	| { phase: "failed"; jobId: string; message: string };

export const PROMOTE_IDLE: PromoteState = { phase: "idle" };

/** Fold a promote_* event into the state (other events: unchanged). */
export function applyPromoteEvent(s: PromoteState, e: MemoryEventFrame): PromoteState {
	const o = e as Record<string, unknown>;
	const jobId = str(o.jobId);
	if (!jobId) return s;
	switch (e.type) {
		case "promote_started":
			return { phase: "running", jobId };
		case "promote_finished":
			return { phase: "finished", jobId, consolidated: num(o.consolidated) ?? 0, contributions: num(o.contributions) ?? 0, pending: num(o.pending) ?? 0 };
		case "promote_failed":
			return { phase: "failed", jobId, message: str(o.message) ?? "promote failed" };
		default:
			return s;
	}
}

/** The POST /promote answer → state ("already_running" adopts the job in flight). */
export function promoteStartedState(r: { jobId: string }): PromoteState {
	return { phase: "running", jobId: r.jobId };
}

/** Apply the POST /promote answer only while still "starting": a promote_* event that raced ahead wins. */
export function settlePromotePost(s: PromoteState, next: PromoteState): PromoteState {
	return s.phase === "starting" ? next : s;
}

export const promoteBusy = (s: PromoteState): boolean => s.phase === "starting" || s.phase === "running";
export const promoteTerminal = (s: PromoteState): boolean => s.phase === "finished" || s.phase === "failed";

export function promoteLine(s: PromoteState): string | null {
	switch (s.phase) {
		case "starting":
			return "Starting promote…";
		case "running":
			return "Promote running…";
		case "finished":
			return `Promoted: ${s.consolidated} consolidated, ${s.contributions} contributed${s.pending ? `, ${s.pending} pending` : ""}`;
		case "failed":
			return `Promote failed: ${s.message}`;
		default:
			return null;
	}
}

/** Why the action buttons are disabled right now (null = enabled). `memory_busy` = a promote is running. */
export function actionBlock(args: { status: MemoryStatus | null; promote: PromoteState; consolidating: boolean }): "memory_busy" | "inactive" | "consolidating" | null {
	if (!memoryActive(args.status)) return "inactive";
	if (promoteBusy(args.promote)) return "memory_busy";
	if (args.consolidating) return "consolidating";
	return null;
}

export const BUSY_TEXT = "memory_busy: a promote is running; consolidate is refused until it finishes.";

// ─── Record ──────────────────────────────────────────────────────────────────

/** True when a record_written targets one of the work ids whose Record the panel shows. */
export function recordStale(e: MemoryEventFrame, shown: readonly (string | null | undefined)[]): boolean {
	if (e.type !== "record_written") return false;
	const t = targetOf(e);
	if (t?.kind !== "work") return false;
	const ids = new Set(shown.filter((x): x is string => !!x));
	return (!!t.workId && ids.has(t.workId)) || (!!t.featureId && ids.has(t.featureId));
}

/** Own Record empty + partOf set → the parent's Record should be fetched (returns its id). */
export const parentToFetch = (own: Pick<WorkRecordResponse, "record" | "partOf">): string | null =>
	own.record.trim() === "" && own.partOf ? own.partOf : null;

export interface RecordView {
	/** The item the shown Record belongs to. */
	workId: string;
	title: string;
	record: string;
	/** Set when the Record is the parent's (label "from <title>"). */
	inheritedFrom: { id: string; title: string } | null;
}

export function recordView(own: WorkRecordResponse, parent: WorkRecordResponse | null): RecordView {
	if (own.record.trim() === "" && parent) {
		return { workId: parent.id, title: parent.title, record: parent.record, inheritedFrom: { id: parent.id, title: parent.title } };
	}
	return { workId: own.id, title: own.title, record: own.record, inheritedFrom: null };
}

// ─── Refetch planning ────────────────────────────────────────────────────────

/** What an event makes stale: status (pool/topics/promote result) and/or the shown Record. */
export function refreshPlan(e: MemoryEventFrame, shown: readonly (string | null | undefined)[]): { status: boolean; record: boolean } {
	const status = e.type === "observation_captured" || e.type === "topic_consolidated" || e.type === "topic_archived" || e.type === "promote_finished" || e.type === "promote_failed";
	return { status, record: recordStale(e, shown) };
}

// ─── Latest-wins guard ───────────────────────────────────────────────────────

/** Async refetch guard: only the response of the most recently started request may be applied. */
export function latestOnly(): { start(): number; isCurrent(token: number): boolean } {
	let n = 0;
	return { start: () => ++n, isCurrent: (t) => t === n };
}

/** Should a window-focus refetch run? Visible document, and at most once per `minMs` (default 5s). */
export function focusRefetchDue(visible: boolean, now: number, last: number, minMs = 5000): boolean {
	return visible && now - last >= minMs;
}

// ─── Observation pool, grouped ─────────────────────────────────────────────────

/** The group of general observations (no work item). */
export const DEN_GROUP = "den";

/** A pool observation as the console reads it (`GET .../memory/observations`). */
export interface PoolObservation {
	id: string;
	timestamp: string;
	recordedAt?: string;
	content: string;
	tokenCount: number;
	work?: string;
	feature?: string;
	/** Pending because the Work API is unavailable (consolidation never sends tagged observations to the den). */
	blocked?: "work-api-unavailable" | "consolidation-failed";
}

/** One row of the grouped list: the den, or a work item (id = its key). */
export interface ObservationGroup {
	key: string;
	kind: "den" | "work";
	count: number;
	/** Waiting for the Work API: some of the group's observations are blocked on it. */
	blocked?: "work-api-unavailable" | "consolidation-failed";
	/** Sort stamp of the group's newest observation. */
	latest: string;
}

const stampOf = (o: PoolObservation): string => o.recordedAt ?? o.timestamp;

/** Which group an observation belongs to: its `work` tag, else its `feature` tag (tagged only with the feature), else the den. */
export const groupKeyOf = (o: Pick<PoolObservation, "work" | "feature">): string => o.work || o.feature || DEN_GROUP;

/** Newest first (the server's order is kept for ties). */
export function newestFirst<T extends PoolObservation>(obs: readonly T[]): T[] {
	return obs.map((o, i) => [o, i] as const).sort(([a, i], [b, j]) => stampOf(b).localeCompare(stampOf(a)) || i - j).map(([o]) => o);
}

/** Add `incoming` to `current` without repeating an id (a later copy replaces the earlier one); newest first. */
export function mergeObservations<T extends PoolObservation>(current: readonly T[], incoming: readonly T[]): T[] {
	const byId = new Map<string, T>();
	for (const o of current) byId.set(o.id, o);
	for (const o of incoming) byId.set(o.id, o);
	return newestFirst([...byId.values()]);
}

/** The den first (when it has observations), then work items by their newest observation. */
export function groupObservations(obs: readonly PoolObservation[]): ObservationGroup[] {
	const groups = new Map<string, ObservationGroup>();
	for (const o of obs) {
		const key = groupKeyOf(o);
		const g = groups.get(key);
		if (!g) groups.set(key, { key, kind: key === DEN_GROUP ? "den" : "work", count: 1, latest: stampOf(o), ...(o.blocked ? { blocked: o.blocked } : {}) });
		else {
			if (o.blocked) g.blocked = o.blocked;
			g.count++;
			if (stampOf(o) > g.latest) g.latest = stampOf(o);
		}
	}
	const rows = [...groups.values()];
	const den = rows.filter((g) => g.kind === "den");
	return [...den, ...rows.filter((g) => g.kind === "work").sort((a, b) => b.latest.localeCompare(a.latest) || a.key.localeCompare(b.key))];
}

/** One group's observations, newest first. */
export const observationsInGroup = (obs: readonly PoolObservation[], key: string): PoolObservation[] => newestFirst(obs.filter((o) => groupKeyOf(o) === key));

/** The note a blocked group shows. */
export const BLOCKED_LABEL = "waiting for Work API";
export const BLOCKED_LABELS = { "work-api-unavailable": BLOCKED_LABEL, "consolidation-failed": "consolidation failed, retrying" } as const;

/** Pending observations older than this, or more than PENDING_WARN_COUNT of them, raise a warning in the panel. */
export const PENDING_WARN_AGE_MS = 24 * 3_600_000;
export const PENDING_WARN_COUNT = 50;
export interface PoolPending { count: number; oldestAgeMs?: number }
export function pendingWarning(p: PoolPending | undefined | null): string | null {
	if (!p || p.count === 0) return null;
	if ((p.oldestAgeMs ?? 0) >= PENDING_WARN_AGE_MS) return `${p.count} observation(s) have waited over ${Math.floor((p.oldestAgeMs ?? 0) / 3_600_000)} h to be folded into a Record`;
	if (p.count > PENDING_WARN_COUNT) return `${p.count} observations are waiting to be folded into a Record`;
	return null;
}

/** What the list shows for a work item: its title and stage, or just the id when the lookup failed. */
export interface GroupInfo {
	title: string;
	stage?: string;
}
export const groupLabel = (key: string, info: Readonly<Record<string, GroupInfo | undefined>>): string => (key === DEN_GROUP ? "Den" : info[key]?.title || key);
