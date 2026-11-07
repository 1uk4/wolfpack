"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeftIcon, ChevronsLeftIcon, ChevronsRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fetchMemoryObservations, fetchMemoryStatus, fetchWorkRecord, postConsolidate, postPromote } from "@/components/kb-client";
import { ContextSection } from "@/components/context-section";
import { useMemoryEvents } from "@/components/memory-events";
import { useOptionalServerEvent, useOptionalServerResync } from "@/components/server-events";
import {
	BUSY_TEXT,
	MEMORY_PANEL_OPEN_KEY,
	PROMOTE_IDLE,
	actionBlock,
	applyPromoteEvent,
	bannerOf,
	BLOCKED_LABELS,
	pendingWarning,
	type PoolPending,
	groupLabel,
	groupObservations,
	observationsInGroup,
	focusRefetchDue,
	latestOnly,
	parseOpen,
	poolSummary,
	promoteLine,
	promoteStartedState,
	refreshPlan,
	settlePromotePost,
	serializeOpen,
	type GroupInfo,
	type PoolObservation,
	type MemoryStatus,
	type PromoteState,
} from "@/src/core";

const REFRESH_DEBOUNCE_MS = 250;
/** A work item's title/stage is looked up again once it is this old (stages change; a failed lookup retries too). */
const INFO_TTL_MS = 60_000;


/**
 * The thread's Memory panel (flex sibling of the conversation column): off/inert banner, pool gauge with its
 * consolidate / promote actions, the observation pool (loaded from wolfd on open, refetched on every live capture,
 * grouped into the den and work items) and, at the top, the Context row (live context, Compact). It shows no
 * tasks: work items open in the large task view. Collapse state persists in localStorage (lh.memory-panel.open.v1).
 */
export function MemoryPanel({ wolf, threadId, slug, embedded = false }: {
	wolf: string;
	threadId: string;
	/** The thread's route slug: the context routes are keyed by it (no slug, no Context section). */
	slug?: string;
	/** Inside the panel host: body only; the host owns the aside, header, collapse and open state. */
	embedded?: boolean;
}) {
	const [open, setOpen] = useState(true);
	useEffect(() => {
		if (embedded) return;
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

	const [status, setStatus] = useState<MemoryStatus | null>(null);
	const [statusError, setStatusError] = useState<string | null>(null);
	/** The wolf's observation pool (null until the first load) and the work items' titles/stages looked up for its groups. */
	const [obsPool, setObsPool] = useState<PoolObservation[] | null>(null);
	const [poolError, setPoolError] = useState<string | null>(null);
	const [poolPending, setPoolPending] = useState<PoolPending | null>(null);
	const [groupInfo, setGroupInfo] = useState<Record<string, GroupInfo | undefined>>({});
	/** The group whose observations are open: DEN_GROUP or a work id; null = the list. */
	const [openGroup, setOpenGroup] = useState<string | null>(null);
	const [promote, setPromote] = useState<PromoteState>(PROMOTE_IDLE);
	const [consolidating, setConsolidating] = useState(false);
	const [note, setNote] = useState<string | null>(null);

	const statusReq = useRef(0);
	const poolReq = useRef(latestOnly());
	/** When each work id's info was fetched (success or failure), so lookups are not repeated every event. */
	const infoAt = useRef(new Map<string, number>());

	const refreshStatus = useCallback(async () => {
		const req = ++statusReq.current;
		const r = await fetchMemoryStatus(wolf, threadId);
		if (req !== statusReq.current) return;
		if (r.ok) {
			setStatus(r.data);
			setStatusError(null);
		} else setStatusError(r.message);
	}, [wolf, threadId]);

	const refreshPool = useCallback(async () => {
		const guard = poolReq.current;
		const token = guard.start();
		const r = await fetchMemoryObservations(wolf);
		if (!guard.isCurrent(token)) return;
		if (r.ok) {
			setObsPool(r.data.observations);
			setPoolPending(r.data.pending ?? null);
			setPoolError(null);
		} else setPoolError(r.message);
	}, [wolf]);

	// Titles and stages of the work items the pool mentions (the group's work, else its feature); the id stands in when a lookup fails.
	useEffect(() => {
		if (!obsPool) return;
		const now = Date.now();
		const due = groupObservations(obsPool).filter((g) => g.kind === "work" && now - (infoAt.current.get(g.key) ?? -Infinity) >= INFO_TTL_MS);
		for (const g of due) {
			infoAt.current.set(g.key, now);
			void fetchWorkRecord(wolf, g.key).then((r) => {
				if (r.ok) setGroupInfo((m) => ({ ...m, [g.key]: { title: r.data.title || g.key, stage: r.data.stage || undefined } }));
			});
		}
	}, [obsPool, wolf]);

	// Trailing-debounced refetch of status + pool: event bursts coalesce.
	const dirty = useRef(false);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const flush = useCallback(() => {
		if (timer.current) clearTimeout(timer.current);
		timer.current = null;
		dirty.current = false;
		// the pool is read whenever the status is (a capture, consolidation, promote or archive all change both)
		void refreshStatus();
		void refreshPool();
	}, [refreshStatus, refreshPool]);
	const schedule = useCallback(() => {
		dirty.current = true;
		if (timer.current) clearTimeout(timer.current);
		timer.current = setTimeout(flush, REFRESH_DEBOUNCE_MS);
	}, [flush]);
	useEffect(
		() => () => {
			if (timer.current) clearTimeout(timer.current);
		},
		[],
	);

	useEffect(() => {
		setObsPool(null);
		setPoolError(null);
		setGroupInfo({});
		infoAt.current.clear();
		setOpenGroup(null);
		setPromote(PROMOTE_IDLE);
		void refreshStatus();
		void refreshPool();
	}, [refreshStatus, refreshPool]);
	// Refetch when the window regains focus, debounced via schedule(), only while visible, at most once per 5s.
	const lastFocus = useRef(0);
	useEffect(() => {
		const onFocus = () => {
			const now = Date.now();
			if (!focusRefetchDue(document.visibilityState === "visible", now, lastFocus.current)) return;
			lastFocus.current = now;
			schedule();
		};
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [schedule]);

	// What changes the bind state or the pool: this thread's own change (a bind), a memory event, a reconnect.
	useOptionalServerEvent("thread-updated", (p) => {
		if (p.wolf === wolf && p.thread.id === threadId) schedule();
	});
	useOptionalServerEvent("needs-you-changed", (p) => {
		if (p.wolf === wolf && p.threadId === threadId && p.kind === "status") schedule();
	});
	useOptionalServerResync(() => schedule());

	useMemoryEvents(
		wolf,
		(e) => {
			if (e.type.startsWith("promote_")) setPromote((s) => applyPromoteEvent(s, e));
			if (refreshPlan(e, []).status) schedule();
		},
		() => flush(),
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
		void refreshPool();
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
	const content = (
		<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
			{statusError && !status ? <p className="text-muted-foreground" data-testid="memory-status-error">Memory status unavailable: {statusError}</p> : null}
			{banner ? (
				<div className="rounded-md border border-destructive/40 px-3 py-2 text-destructive" data-testid="memory-banner" data-tone={banner.tone}>
					<div className="font-medium">{banner.title}</div>
					<div className="text-xs">{banner.reason}</div>
				</div>
			) : null}

			{slug ? <ContextSection wolf={wolf} slug={slug} threadId={threadId} /> : null}

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
						<span data-testid="memory-observations">{pool.observationsText}</span>
					</p>
					<p className="text-xs text-muted-foreground" data-testid="memory-trigger">Consolidation {pool.triggerText}</p>
					{block === "memory_busy" ? <p className="text-xs text-muted-foreground" data-testid="memory-busy">{BUSY_TEXT}</p> : null}
					{pline ? <p className="text-xs text-muted-foreground" data-testid="memory-promote">{pline}</p> : null}
					{note ? <p className="text-xs text-muted-foreground" data-testid="memory-note">{note}</p> : null}
				</section>
			) : (
				<div data-testid="memory-actions-fallback">
					{note ? <p className="text-xs text-muted-foreground" data-testid="memory-note">{note}</p> : null}
				</div>
			)}

			<ObservationsSection observations={{ list: obsPool, pending: poolPending, error: poolError, info: groupInfo, open: openGroup, onOpen: setOpenGroup }} />
		</div>
	);
	if (embedded) return content;

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
			{content}
		</aside>
	);
}

/** The observation pool, grouped into the den and work items; opening a group lists its observations. */
export function ObservationsSection({ observations }: {
	/** The loaded observations (null until the first load), grouped; `open` is the group being read. */
	observations: { list: PoolObservation[] | null; pending?: PoolPending | null; error: string | null; info: Readonly<Record<string, GroupInfo | undefined>>; open: string | null; onOpen: (key: string | null) => void };
}) {
	const list = observations.list;
	const groups = list ? groupObservations(list) : [];
	// a group that emptied (consolidated away) falls back to the list
	const openKey = observations.open && groups.some((g) => g.key === observations.open) ? observations.open : null;
	return (
		<section data-testid="memory-feed">
			<div className="mb-1 flex items-center justify-between gap-2">
				{openKey ? (
					<button
						type="button"
						className="-ml-1 flex min-w-0 items-center gap-1 rounded px-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
						aria-label="Back to observation groups"
						data-testid="memory-obs-back"
						onClick={() => observations.onOpen(null)}
					>
						<ChevronLeftIcon className="size-3 shrink-0" />
						<span className="truncate">{groupLabel(openKey, observations.info)}</span>
					</button>
				) : (
					<h3 className="text-xs font-medium uppercase text-muted-foreground">Observations</h3>
				)}
			</div>
				{list === null ? (
					<p className="text-xs text-muted-foreground" data-testid="memory-obs-state">{observations.error ? `Observations unavailable: ${observations.error}` : "Loading…"}</p>
				) : groups.length === 0 ? (
					<p className="text-xs text-muted-foreground">Nothing captured yet.</p>
				) : openKey ? (
					<ul className="flex flex-col gap-2" data-testid="memory-obs-items" data-group={openKey}>
						{observationsInGroup(list, openKey).map((o) => (
							<li key={o.id} className="text-xs" data-testid="memory-obs-item">
								<div className="text-muted-foreground">{o.timestamp}</div>
								<div className="whitespace-pre-wrap break-words">{o.content}</div>
							</li>
						))}
					</ul>
				) : (
					<>
					{pendingWarning(observations.pending) ? <p className="rounded bg-amber-50 px-1.5 py-1 text-[11px] text-amber-700" data-testid="memory-obs-pending-warning">{pendingWarning(observations.pending)}</p> : null}
					<ul className="flex flex-col gap-1" data-testid="memory-obs-groups">
						{groups.map((g) => {
							const info = observations.info[g.key];
							return (
								<li key={g.key}>
									<button
										type="button"
										className="flex w-full items-center justify-between gap-2 rounded px-1.5 py-1 text-left text-xs transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
										data-testid={`memory-obs-group-${g.key}`}
										data-count={g.count}
										onClick={() => observations.onOpen(g.key)}
									>
										<span className="min-w-0 truncate">{groupLabel(g.key, observations.info)}</span>
										<span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
											{g.blocked ? <span className="text-amber-600" data-testid="memory-obs-blocked">{BLOCKED_LABELS[g.blocked]}</span> : null}
											{info?.stage ? <span data-testid="memory-obs-stage">{info.stage.replace(/_/g, " ")}</span> : null}
											<span className="rounded-full bg-muted px-1.5 text-[10px]" data-testid="memory-obs-count">{g.count}</span>
										</span>
									</button>
								</li>
							);
						})}
					</ul>
					</>
				)}
		</section>
	);
}
