"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronLeftIcon, CornerDownRightIcon, ChevronsLeftIcon, ChevronsRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fetchMemoryStatus, fetchWorkRecord, postConsolidate, postPromote } from "@/components/kb-client";
import { KbMarkdown } from "@/components/kb-markdown";
import { WorkBadges } from "@/components/work-badges";
import { TaskGraph } from "@/components/task-graph";
import { useMemoryEvents } from "@/components/memory-events";
import {
	BUSY_TEXT,
	MEMORY_PANEL_OPEN_KEY,
	MEMORY_PANEL_VIEW_KEY,
	PROMOTE_IDLE,
	actionBlock,
	applyPromoteEvent,
	bannerOf,
	buildTaskGraph,
	featureIdFor,
	focusRefetchDue,
	latestOnly,
	parseOpen,
	parseView,
	parentToFetch,
	poolSummary,
	promoteLine,
	promoteStartedState,
	pushFeed,
	feedItemOf,
	refreshPlan,
	settlePromotePost,
	recordStale,
	recordView,
	serializeOpen,
	serializeView,
	workHref,
	type FeedItem,
	type MemoryStatus,
	type PanelView,
	type RecordView,
	type TaskGraphModel,
	type PromoteState,
	type WorkRecordResponse,
} from "@/src/core";

const REFRESH_DEBOUNCE_MS = 250;


/** An item's own record plus the parent's when the Record is inherited. */
interface Loaded {
	own: WorkRecordResponse;
	parent: WorkRecordResponse | null;
}

/**
 * The thread's Status panel (flex sibling of the conversation column):
 * off/inert banner, pool gauge with its consolidate / promote actions,
 * and one section, running to the bottom of the panel, with three views:
 * the feature's task graph, the item viewer (the bound item, or the task
 * clicked in the graph) and the live observation feed (live-only, capped,
 * this thread's events). Collapse and view state persist in
 * localStorage (lh.memory-panel.open.v1 / lh.memory-panel.view.v1).
 */
export function MemoryPanel({ wolf, threadId }: { wolf: string; threadId: string }) {
	const [open, setOpen] = useState(true);
	useEffect(() => {
		try {
			setOpen(parseOpen(localStorage.getItem(MEMORY_PANEL_OPEN_KEY)));
		} catch {}
	}, []);
	const toggle = () => {
		const next = !open;
		setOpen(next);
		try {
			localStorage.setItem(MEMORY_PANEL_OPEN_KEY, serializeOpen(next));
		} catch {}
	};

	const [view, setView] = useState<PanelView>("graph");
	const viewRef = useRef<PanelView>("graph");
	viewRef.current = view;
	/** The view the feed toggle returns to. */
	const lastView = useRef<"graph" | "item">("graph");
	const [unread, setUnread] = useState(0);
	useEffect(() => {
		try {
			const v = parseView(localStorage.getItem(MEMORY_PANEL_VIEW_KEY));
			if (v !== "feed") lastView.current = v;
			setView(v);
		} catch {}
	}, []);
	const chooseView = (next: PanelView) => {
		if (next !== "feed") lastView.current = next;
		setView(next);
		if (next === "feed") setUnread(0);
		try {
			localStorage.setItem(MEMORY_PANEL_VIEW_KEY, serializeView(next));
		} catch {}
	};

	const [status, setStatus] = useState<MemoryStatus | null>(null);
	const [statusError, setStatusError] = useState<string | null>(null);
	const [bound, setBound] = useState<Loaded | null>(null);
	const [feature, setFeature] = useState<WorkRecordResponse | null>(null);
	/** A task picked in the graph (not the bound item) and its record. */
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [selected, setSelected] = useState<Loaded | null>(null);
	const [selectedFailed, setSelectedFailed] = useState(false);
	const [feed, setFeed] = useState<FeedItem[]>([]);
	const [promote, setPromote] = useState<PromoteState>(PROMOTE_IDLE);
	const [consolidating, setConsolidating] = useState(false);
	const [note, setNote] = useState<string | null>(null);

	const boundId = status?.bound?.workId ?? null;
	const boundTitle = status?.bound?.title;
	const boundRef = useRef<string | null>(null);
	boundRef.current = boundId;
	const selectedRef = useRef<string | null>(null);
	selectedRef.current = selectedId;
	/** Work ids whose Record the panel shows: a record_written for any of them refetches. */
	const shownRef = useRef<(string | null | undefined)[]>([]);
	shownRef.current = [boundId, bound?.own.partOf, feature?.id, selectedId, selected?.own.partOf];

	const statusReq = useRef(0);
	const recordReq = useRef(0);
	const selectedReq = useRef(latestOnly());
	const feedSeq = useRef(0);

	const refreshStatus = useCallback(async () => {
		const req = ++statusReq.current;
		const r = await fetchMemoryStatus(wolf, threadId);
		if (req !== statusReq.current) return;
		if (r.ok) {
			setStatus(r.data);
			setStatusError(null);
		} else setStatusError(r.message);
	}, [wolf, threadId]);

	const loadItem = useCallback(
		async (id: string): Promise<Loaded | null> => {
			const r = await fetchWorkRecord(wolf, id);
			if (!r.ok) return null;
			const pid = parentToFetch(r.data);
			const p = pid ? await fetchWorkRecord(wolf, pid) : null;
			return { own: r.data, parent: p?.ok ? p.data : null };
		},
		[wolf],
	);

	/** The bound item and its feature (itself when it is a feature, else its parent, which carries `children`). */
	const refreshRecord = useCallback(
		async (id: string | null) => {
			const req = ++recordReq.current;
			if (!id) {
				setBound(null);
				setFeature(null);
				return;
			}
			const l = await loadItem(id);
			if (req !== recordReq.current || !l) return;
			const fid = featureIdFor(l.own);
			const f = l.own.kind === "feature" ? { ok: true as const, data: l.own } : fid ? await fetchWorkRecord(wolf, fid) : null;
			if (req !== recordReq.current) return;
			setBound(l);
			setFeature(f?.ok ? f.data : null);
		},
		[wolf, loadItem],
	);

	const refreshSelected = useCallback(
		async (id: string | null) => {
			const guard = selectedReq.current;
			const token = guard.start();
			if (!id) {
				setSelected(null);
				setSelectedFailed(false);
				return;
			}
			const l = await loadItem(id);
			if (!guard.isCurrent(token)) return;
			if (l) {
				setSelected(l);
				setSelectedFailed(false);
			} else setSelectedFailed(true);
		},
		[loadItem],
	);

	// Trailing-debounced refetch shared by status + record: event bursts coalesce.
	const dirty = useRef({ status: false, record: false });
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const flush = useCallback(() => {
		if (timer.current) clearTimeout(timer.current);
		timer.current = null;
		const d = dirty.current;
		dirty.current = { status: false, record: false };
		if (d.status) void refreshStatus();
		if (d.record) {
			void refreshRecord(boundRef.current);
			void refreshSelected(selectedRef.current);
		}
	}, [refreshStatus, refreshRecord, refreshSelected]);
	const schedule = useCallback(
		(plan: { status: boolean; record: boolean }) => {
			if (!plan.status && !plan.record) return;
			dirty.current = { status: dirty.current.status || plan.status, record: dirty.current.record || plan.record };
			if (timer.current) clearTimeout(timer.current);
			timer.current = setTimeout(flush, REFRESH_DEBOUNCE_MS);
		},
		[flush],
	);
	useEffect(
		() => () => {
			if (timer.current) clearTimeout(timer.current);
		},
		[],
	);

	useEffect(() => {
		setFeed([]);
		setUnread(0);
		setPromote(PROMOTE_IDLE);
		void refreshStatus();
	}, [refreshStatus]);
	useEffect(() => {
		setSelectedId(null);
		void refreshRecord(boundId);
	}, [boundId, refreshRecord]);
	useEffect(() => {
		setSelected(null);
		setSelectedFailed(false);
		void refreshSelected(selectedId);
	}, [selectedId, refreshSelected]);
	// Stage changes emit no event yet (and a sibling's change never reaches this thread): refetch when the
	// window regains focus, debounced via schedule(), only while visible, at most once per 5s.
	const lastFocus = useRef(0);
	useEffect(() => {
		const onFocus = () => {
			const now = Date.now();
			if (!focusRefetchDue(document.visibilityState === "visible", now, lastFocus.current)) return;
			lastFocus.current = now;
			schedule({ status: true, record: true });
		};
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [schedule]);

	useMemoryEvents(
		wolf,
		(e) => {
			const titles = boundRef.current && boundTitle ? { [boundRef.current]: boundTitle } : undefined;
			const item = feedItemOf(e, threadId, `f${feedSeq.current++}`, titles);
			if (item) {
				setFeed((f) => pushFeed(f, item));
				if (viewRef.current !== "feed" && boundRef.current) setUnread((n) => n + 1);
			}
			if (e.type.startsWith("promote_")) setPromote((s) => applyPromoteEvent(s, e));
			schedule(refreshPlan(e, shownRef.current));
		},
		() => {
			dirty.current = { status: true, record: true };
			flush();
		},
	);

	const pline = promoteLine(promote);
	const block = actionBlock({ status, promote, consolidating });

	const consolidate = async () => {
		setConsolidating(true);
		setNote(null);
		const r = await postConsolidate(wolf);
		setConsolidating(false);
		if (r.ok) setNote(`Consolidated ${r.data.observationsProcessed} observations → ${r.data.topicsCreated} new, ${r.data.topicsMerged} merged topics`);
		else setNote(r.code === "memory_busy" ? BUSY_TEXT : r.message);
		void refreshStatus();
		void refreshRecord(boundRef.current);
		void refreshSelected(selectedRef.current);
	};
	const startPromote = async () => {
		setNote(null);
		setPromote({ phase: "starting" });
		const r = await postPromote(wolf);
		if (r.ok) setPromote((s) => settlePromotePost(s, promoteStartedState(r.data)));
		else {
			setPromote((s) => settlePromotePost(s, PROMOTE_IDLE));
			setNote(r.message);
		}
	};

	const banner = status ? bannerOf(status) : null;
	const pool = status ? poolSummary(status.pool) : null;
	const graph = buildTaskGraph(bound?.own ?? null, feature);
	const viewingOther = !!selectedId && selectedId !== boundId;
	// the viewer shows a clicked task only once ITS record is in; never the bound item's under another title
	const showing = viewingOther ? (selected?.own.id === selectedId ? selected : null) : bound;
	const otherState = viewingOther && !showing ? (selectedFailed ? "error" : "loading") : undefined;

	if (!open) {
		return (
			<aside className="flex w-9 shrink-0 flex-col items-center border-l border-border py-2" data-testid="memory-panel" data-open="false">
				<Button variant="ghost" size="icon" aria-label="Open status panel" onClick={toggle}>
					<ChevronsLeftIcon />
				</Button>
			</aside>
		);
	}

	return (
		<aside className="relative flex w-80 shrink-0 flex-col border-l border-border text-sm" data-testid="memory-panel" data-open="true">
			<div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3">
				<span className="font-medium">Status</span>
				<Button variant="ghost" size="icon" aria-label="Collapse status panel" onClick={toggle}>
					<ChevronsRightIcon />
				</Button>
			</div>
			<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
				{statusError && !status ? <p className="text-muted-foreground" data-testid="memory-status-error">Memory status unavailable: {statusError}</p> : null}
				{banner ? (
					<div className="rounded-md border border-destructive/40 px-3 py-2 text-destructive" data-testid="memory-banner" data-tone={banner.tone}>
						<div className="font-medium">{banner.title}</div>
						<div className="text-xs">{banner.reason}</div>
					</div>
				) : null}

				{pool ? (
					<section data-testid="memory-pool">
						<div className="mb-1 flex items-center justify-between gap-2">
							<h3 className="text-xs font-medium uppercase text-muted-foreground">Pool</h3>
							<div className="flex items-center gap-1" data-testid="memory-actions">
								<Button size="xs" variant="ghost" disabled={block !== null} onClick={consolidate}>
									{consolidating ? "Consolidating…" : "Consolidate"}
								</Button>
								<Button size="xs" variant="ghost" disabled={block !== null} onClick={startPromote}>
									Promote
								</Button>
							</div>
						</div>
						<div className="relative h-1.5 rounded bg-muted">
							<div className="h-full rounded bg-foreground/60" style={{ width: `${Math.round(pool.fill * 100)}%` }} />
							<div className="absolute top-[-2px] h-2.5 w-px bg-foreground" style={{ left: `${Math.round(pool.targetMark * 100)}%` }} title={`pool target ${pool.poolTarget.toLocaleString("en-US")}`} />
						</div>
						<p className="mt-1 text-xs text-muted-foreground" data-testid="memory-pool-line">
							{pool.tokensText} ·{" "}
							<button
								type="button"
								className="inline-flex items-center gap-1 underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring"
								aria-pressed={view === "feed"}
								data-testid="memory-observations"
								onClick={() => chooseView(view === "feed" ? lastView.current : "feed")}
							>
								{pool.observationsText}
								{view !== "feed" && unread > 0 ? <span className="rounded-full bg-muted px-1.5 text-[10px]" data-testid="memory-unread">{unread}</span> : null}
							</button>
						</p>
						{block === "memory_busy" ? <p className="text-xs text-muted-foreground" data-testid="memory-busy">{BUSY_TEXT}</p> : null}
						{pline ? <p className="text-xs text-muted-foreground" data-testid="memory-promote">{pline}</p> : null}
						{note ? <p className="text-xs text-muted-foreground" data-testid="memory-note">{note}</p> : null}
					</section>
				) : (
					<div data-testid="memory-actions-fallback">
						{note ? <p className="text-xs text-muted-foreground" data-testid="memory-note">{note}</p> : null}
					</div>
				)}

				<StatusSection
					view={view}
					bound={status?.bound ?? null}
					graph={graph}
					shown={showing ? { item: showing.own, rec: recordView(showing.own, showing.parent) } : null}
					viewingOther={viewingOther}
					otherState={otherState}
					onRetry={() => {
						setSelectedFailed(false);
						void refreshSelected(selectedRef.current);
					}}
					feed={feed}
					onGraph={() => {
						setSelectedId(null);
						chooseView("graph");
					}}
					onToggleFeed={() => chooseView(view === "feed" ? lastView.current : "feed")}
					// intentionally does not persist the view: a click never changes the saved choice
					onSelect={(id) => {
						setSelectedId(id === boundId ? null : id);
						setView("item");
						lastView.current = "item";
					}}
					onBack={() => setSelectedId(null)}
				/>
			</div>
		</aside>
	);
}

const MD = "text-xs [&_*]:text-xs [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_h4]:font-semibold";

/** The Status section: the feature graph, the item viewer or the live observation feed, one at a time; no bound item → feed only. */
export function StatusSection({ view, bound, graph, shown, viewingOther = false, otherState, onRetry, feed, onGraph, onToggleFeed, onSelect, onBack }: {
	view: PanelView;
	bound: MemoryStatus["bound"] | null;
	graph: TaskGraphModel;
	/** The item the viewer shows (the bound one or a clicked task): its record (badges, plan) and the Record to display. */
	shown: { item: WorkRecordResponse; rec: RecordView } | null;
	/** The viewer shows a task other than the bound item: offer the way back. */
	viewingOther?: boolean;
	/** Viewing another task whose record is not in: still loading, or the fetch failed. */
	otherState?: "loading" | "error";
	onRetry?: () => void;
	feed: FeedItem[];
	/** Back to the feature graph (persisted as the graph view). */
	onGraph: () => void;
	onToggleFeed: () => void;
	onSelect: (id: string) => void;
	onBack: () => void;
}) {
	const showFeed = view === "feed" || !bound;
	const featureTitle = graph.kind === "graph" ? graph.featureTitle : null;
	/** The shown item sits under the graphed feature (a task, not the feature itself). */
	const isChild = !!shown?.item.partOf && graph.kind === "graph" && shown.item.partOf === graph.featureId;
	return (
		<section data-testid={showFeed ? "memory-feed" : view === "graph" ? "memory-graph" : "memory-record"} data-view={showFeed ? "feed" : view}>
			<div className="mb-1 flex items-center justify-between gap-2">
				{showFeed ? (
					<h3 className="text-xs font-medium uppercase text-muted-foreground">Observations (live)</h3>
				) : view === "graph" ? (
					graph.kind === "graph" ? (
						<>
							<Link className="min-w-0 truncate font-medium underline-offset-2 hover:underline" href={workHref(graph.featureId)} data-testid="memory-graph-label">
								{graph.featureTitle}
							</Link>
							<span className="shrink-0 text-xs text-muted-foreground" data-testid="task-graph-progress">{graph.label}</span>
						</>
					) : (
						<h3 className="text-xs font-medium uppercase text-muted-foreground" data-testid="memory-graph-label">Feature</h3>
					)
				) : (
					<>
						<button
							type="button"
							className="-ml-1 flex min-w-0 items-center gap-1 rounded px-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
							aria-label="Back to feature graph"
							data-testid="memory-back-graph"
							onClick={onGraph}
						>
							<ChevronLeftIcon className="size-3 shrink-0" />
							<span className="truncate">{featureTitle ?? "Feature graph"}</span>
						</button>
						{viewingOther ? (
							<Button size="xs" variant="ghost" className="shrink-0" data-testid="memory-back-bound" onClick={onBack}>
								Bound item
							</Button>
						) : null}
					</>
				)}
				{showFeed && bound ? (
					<button
						type="button"
						className="rounded px-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
						aria-label="Back to previous view"
						data-testid="memory-feed-back"
						onClick={onToggleFeed}
					>
						‹ back
					</button>
				) : null}
			</div>
			{showFeed ? (
				<>
					{feed.length === 0 ? <p className="text-xs text-muted-foreground">Nothing captured yet.</p> : null}
					<ul className="flex flex-col gap-1.5">
						{feed.map((f) => (
							<li key={f.key} className="text-xs">
								<div>{f.summary || "(observation)"}{f.count > 1 ? ` ×${f.count}` : ""}</div>
								<div className="text-muted-foreground">→ {f.destination}</div>
							</li>
						))}
					</ul>
				</>
			) : view === "graph" ? (
				graph.kind === "graph" ? (
					<>
						{graph.nodes.length > 0 ? <TaskGraph model={graph} onSelect={onSelect} /> : <p className="text-xs text-muted-foreground">No tasks yet.</p>}
					</>
				) : graph.kind === "inbox" ? (
					<p className="text-xs text-muted-foreground" data-testid="task-graph-inbox">
						<Link className="underline-offset-2 hover:underline" href={workHref(graph.featureId)}>{graph.title}</Link>
						{graph.count === null ? "" : ` · ${graph.count} ${graph.count === 1 ? "item" : "items"}`}
					</p>
				) : (
					<p className="text-xs text-muted-foreground" data-testid="task-graph-none">No feature to graph.</p>
				)
			) : (
				<>
					{viewingOther && !shown ? (
						otherState === "error" ? (
							<p className="text-xs text-muted-foreground" data-testid="memory-other-error">
								Couldn't load this task.{" "}
								<Button size="xs" variant="ghost" data-testid="memory-other-retry" onClick={onRetry}>Retry</Button>
							</p>
						) : (
							<p className="text-xs text-muted-foreground" data-testid="memory-other-loading">Loading…</p>
						)
					) : shown || bound ? (
						<div className="flex items-start gap-1">
							{isChild ? <CornerDownRightIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-label="task in this feature" data-testid="memory-child-arrow" /> : null}
							<Link className="min-w-0 underline-offset-2 hover:underline" href={workHref(shown?.item.id ?? bound!.workId)}>
								{shown?.item.title || bound?.title || shown?.item.id || bound?.workId}
							</Link>
						</div>
					) : null}
					{shown ? <WorkBadges kind={shown.item.kind} stage={shown.item.stage} domain={shown.item.domain} className="mt-1.5" /> : null}
					{shown ? (
						<div className="mt-2">
							{shown.rec.inheritedFrom ? <p className="text-xs text-muted-foreground">Record from parent: {shown.rec.inheritedFrom.title}</p> : null}
							{shown.rec.record.trim() ? (
								<div className={`mt-1 ${MD}`} data-testid="memory-record-md">
									<KbMarkdown>{shown.rec.record}</KbMarkdown>
								</div>
							) : (
								<p className="text-xs text-muted-foreground">No Record yet.</p>
							)}
							{shown.item.plan.trim() ? (
								<div className="mt-3" data-testid="memory-plan">
									<h4 className="mb-1 text-xs font-medium uppercase text-muted-foreground">Plan</h4>
									<div className={MD}>
										<KbMarkdown>{shown.item.plan}</KbMarkdown>
									</div>
								</div>
							) : null}
						</div>
					) : null}
				</>
			)}
		</section>
	);
}
