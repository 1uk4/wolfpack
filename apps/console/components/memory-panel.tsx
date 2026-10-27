"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronsLeftIcon, ChevronsRightIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fetchMemoryStatus, fetchMemoryTopic, fetchWorkRecord, postConsolidate, postPromote, type KbResult } from "@/components/kb-client";
import { KbMarkdown } from "@/components/kb-markdown";
import { useMemoryEvents } from "@/components/memory-events";
import {
	BUSY_TEXT,
	MEMORY_PANEL_OPEN_KEY,
	MEMORY_PANEL_VIEW_KEY,
	PROMOTE_IDLE,
	actionBlock,
	applyPromoteEvent,
	bannerOf,
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
	type MemoryTopic,
	type MemoryTopicRef,
	type PanelView,
	type PromoteState,
	type WorkRecordResponse,
} from "@/src/core";

const REFRESH_DEBOUNCE_MS = 250;

/**
 * The thread's memory panel (flex sibling of the conversation column):
 * off/inert banner, pool gauge with its consolidate / promote actions,
 * session/den topics (click → body drawer), and one section that toggles
 * between the bound item's Record and the live observation feed (live-only,
 * capped, this thread's events). Collapse and view state persist in
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

	const [view, setView] = useState<PanelView>("record");
	const viewRef = useRef<PanelView>("record");
	viewRef.current = view;
	const [unread, setUnread] = useState(0);
	useEffect(() => {
		try {
			setView(parseView(localStorage.getItem(MEMORY_PANEL_VIEW_KEY)));
		} catch {}
	}, []);
	const chooseView = (next: PanelView) => {
		setView(next);
		if (next === "feed") setUnread(0);
		try {
			localStorage.setItem(MEMORY_PANEL_VIEW_KEY, serializeView(next));
		} catch {}
	};

	const [status, setStatus] = useState<MemoryStatus | null>(null);
	const [statusError, setStatusError] = useState<string | null>(null);
	const [own, setOwn] = useState<WorkRecordResponse | null>(null);
	const [parent, setParent] = useState<WorkRecordResponse | null>(null);
	const [feed, setFeed] = useState<FeedItem[]>([]);
	const [promote, setPromote] = useState<PromoteState>(PROMOTE_IDLE);
	const [consolidating, setConsolidating] = useState(false);
	const [note, setNote] = useState<string | null>(null);
	const [drawer, setDrawer] = useState<{ ref: MemoryTopicRef; scope: "den" | "session"; topic: MemoryTopic | null; error: string | null } | null>(null);

	const boundId = status?.bound?.workId ?? null;
	const boundTitle = status?.bound?.title;
	const boundRef = useRef<string | null>(null);
	boundRef.current = boundId;
	const parentRef = useRef<string | null>(null);
	parentRef.current = own?.partOf ?? null;

	const statusReq = useRef(0);
	const recordReq = useRef(0);
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

	const refreshRecord = useCallback(async (id: string | null) => {
		const req = ++recordReq.current;
		if (!id) {
			setOwn(null);
			setParent(null);
			return;
		}
		const r = await fetchWorkRecord(wolf, id);
		if (req !== recordReq.current || !r.ok) return;
		const pid = parentToFetch(r.data);
		const p = pid ? await fetchWorkRecord(wolf, pid) : null;
		if (req !== recordReq.current) return;
		setOwn(r.data);
		setParent(p?.ok ? p.data : null);
	}, [wolf]);

	// Trailing-debounced refetch shared by status + record: event bursts coalesce.
	const dirty = useRef({ status: false, record: false });
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const flush = useCallback(() => {
		if (timer.current) clearTimeout(timer.current);
		timer.current = null;
		const d = dirty.current;
		dirty.current = { status: false, record: false };
		if (d.status) void refreshStatus();
		if (d.record) void refreshRecord(boundRef.current);
	}, [refreshStatus, refreshRecord]);
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
		void refreshRecord(boundId);
	}, [boundId, refreshRecord]);

	useMemoryEvents(
		wolf,
		(e) => {
			const titles = boundRef.current && boundTitle ? { [boundRef.current]: boundTitle } : undefined;
			const item = feedItemOf(e, threadId, `f${feedSeq.current++}`, titles);
			if (item) {
				setFeed((f) => pushFeed(f, item));
				if (viewRef.current === "record" && boundRef.current) setUnread((n) => n + 1);
			}
			if (e.type.startsWith("promote_")) setPromote((s) => applyPromoteEvent(s, e));
			schedule(refreshPlan(e, [boundRef.current, parentRef.current]));
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

	const openTopic = async (ref: MemoryTopicRef, scope: "den" | "session") => {
		setDrawer({ ref, scope, topic: null, error: null });
		const r: KbResult<MemoryTopic> = await fetchMemoryTopic(wolf, ref.id, scope);
		setDrawer((d) => (d && d.ref.id === ref.id && d.scope === scope ? (r.ok ? { ...d, topic: r.data } : { ...d, error: r.message }) : d));
	};

	const banner = status ? bannerOf(status) : null;
	const pool = status ? poolSummary(status.pool) : null;
	const showFeed = view === "feed" || !status?.bound;
	const rec = own ? recordView(own, parent) : null;

	if (!open) {
		return (
			<aside className="flex w-9 shrink-0 flex-col items-center border-l border-border py-2" data-testid="memory-panel" data-open="false">
				<Button variant="ghost" size="icon" aria-label="Open memory panel" onClick={toggle}>
					<ChevronsLeftIcon />
				</Button>
			</aside>
		);
	}

	return (
		<aside className="relative flex w-80 shrink-0 flex-col border-l border-border text-sm" data-testid="memory-panel" data-open="true">
			<div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3">
				<span className="font-medium">Memory</span>
				<Button variant="ghost" size="icon" aria-label="Collapse memory panel" onClick={toggle}>
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
						<p className="mt-1 text-xs text-muted-foreground">{pool.label}</p>
						<p className="text-xs text-muted-foreground">target {pool.poolTarget.toLocaleString("en-US")} · trigger {pool.trigger}</p>
						{block === "memory_busy" ? <p className="text-xs text-muted-foreground" data-testid="memory-busy">{BUSY_TEXT}</p> : null}
						{pline ? <p className="text-xs text-muted-foreground" data-testid="memory-promote">{pline}</p> : null}
						{note ? <p className="text-xs text-muted-foreground" data-testid="memory-note">{note}</p> : null}
					</section>
				) : (
					<div data-testid="memory-actions-fallback">
						{note ? <p className="text-xs text-muted-foreground" data-testid="memory-note">{note}</p> : null}
					</div>
				)}

				<BoundOrFeed
					view={view}
					bound={status?.bound ?? null}
					rec={rec}
					feed={feed}
					unread={unread}
					onToggle={() => chooseView(showFeed ? "record" : "feed")}
				/>

				{status ? <TopicList title="Session topics" topics={status.sessionTopics} onOpen={(t) => openTopic(t, "session")} /> : null}
				{status ? <TopicList title="Den topics" topics={status.denTopics} onOpen={(t) => openTopic(t, "den")} /> : null}
			</div>

			{drawer ? (
				<div className="absolute inset-0 z-10 flex flex-col bg-background" data-testid="memory-topic-drawer">
					<div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3">
						<span className="truncate font-medium">{drawer.ref.title}</span>
						<Button variant="ghost" size="icon" aria-label="Close topic" onClick={() => setDrawer(null)}>
							<XIcon />
						</Button>
					</div>
					<div className="min-h-0 flex-1 overflow-y-auto p-3">
						{drawer.error ? <p className="text-muted-foreground">{drawer.error}</p> : drawer.topic ? <pre className="whitespace-pre-wrap text-xs">{drawer.topic.body}</pre> : <p className="text-muted-foreground">Loading…</p>}
					</div>
				</div>
			) : null}
		</aside>
	);
}

function TopicList({ title, topics, onOpen }: { title: string; topics: MemoryTopicRef[]; onOpen: (t: MemoryTopicRef) => void }) {
	return (
		<section data-testid={`memory-topics-${title.split(" ")[0]?.toLowerCase()}`}>
			<h3 className="mb-1 text-xs font-medium uppercase text-muted-foreground">
				{title} ({topics.length})
			</h3>
			<ul className="flex flex-col">
				{topics.map((t) => (
					<li key={t.id}>
						<button type="button" className="w-full truncate rounded px-1 py-0.5 text-left text-xs hover:bg-muted" title={t.summary} onClick={() => onOpen(t)}>
							{t.title}
						</button>
					</li>
				))}
			</ul>
		</section>
	);
}

/** The bound item's Record (markdown) or the live observation feed, one at a time; no bound item → feed only. */
export function BoundOrFeed({ view, bound, rec, feed, unread, onToggle }: {
	view: PanelView;
	bound: MemoryStatus["bound"] | null;
	rec: ReturnType<typeof recordView> | null;
	feed: FeedItem[];
	unread: number;
	onToggle: () => void;
}) {
	const showFeed = view === "feed" || !bound;
	return (
	<section data-testid={showFeed ? "memory-feed" : "memory-record"}>
		<div className="mb-1 flex items-center justify-between gap-2">
			<h3 className="text-xs font-medium uppercase text-muted-foreground">{showFeed ? "Observations (live)" : "Bound item"}</h3>
			{bound ? (
				<Button size="xs" variant="ghost" data-testid="memory-view-toggle" onClick={onToggle}>
					{showFeed ? "« Bound item" : "Live observations »"}
					{!showFeed && unread > 0 ? <span className="rounded-full bg-muted px-1.5 text-[10px]" data-testid="memory-unread">{unread}</span> : null}
				</Button>
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
		) : bound ? (
			<>
				<Link className="underline-offset-2 hover:underline" href={workHref(bound.workId)}>
					{bound.title ?? bound.workId}
				</Link>
				{rec ? (
					<div className="mt-2">
						{rec.inheritedFrom ? <p className="text-xs text-muted-foreground">Record from parent: {rec.inheritedFrom.title}</p> : null}
						{rec.record.trim() ? (
							<div className="mt-1 max-h-60 overflow-auto text-xs [&_*]:text-xs [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_h4]:font-semibold" data-testid="memory-record-md">
								<KbMarkdown>{rec.record}</KbMarkdown>
							</div>
						) : (
							<p className="text-xs text-muted-foreground">No Record yet.</p>
						)}
					</div>
				) : null}
			</>
		) : null}
	</section>
	);
}
