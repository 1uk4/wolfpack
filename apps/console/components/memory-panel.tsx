"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, ChevronsLeftIcon, ChevronsRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fetchMemoryNode, fetchMemoryObservations, fetchMemoryStatus, fetchMemoryTree, fetchWorkRecord, postConsolidate, postPromote } from "@/components/kb-client";
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
	blockedLabel,
	consolidateMessage,
	reconcilePromote,
	pendingWarning,
	type PoolPending,
	buildMemoryTreeRows,
	DEN_GROUP,
	groupObservations,
	type MemoryNodeObservations,
	type MemoryTree,
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
 * tasks: work items open in the large task view. Collapse state persists in localStorage (wolfpack.memory-panel.open.v1).
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
	const [tree, setTree] = useState<MemoryTree | null>(null);
	const [treeError, setTreeError] = useState<string | null>(null);
	const [treeVersion, setTreeVersion] = useState(0);
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
			// wolfd knows whether a promote runs: a page that mounts mid-run shows it, and a finished one shows its result
			setPromote((s) => reconcilePromote(s, r.data));
			setStatusError(null);
		} else setStatusError(r.message);
	}, [wolf, threadId]);

	const refreshPool = useCallback(async () => {
		const guard = poolReq.current;
		const token = guard.start();
		const [r, t] = await Promise.all([fetchMemoryObservations(wolf), fetchMemoryTree(wolf)]);
		if (!guard.isCurrent(token)) return;
		if (r.ok) {
			setObsPool(r.data.observations);
			setPoolPending(r.data.pending ?? null);
			setPoolError(null);
		} else setPoolError(r.message);
		if (t.ok) {
			setTree(t.data);
			setTreeError(null);
			setTreeVersion((v) => v + 1);
		} else setTreeError(t.message);
	}, [wolf]);

	// Titles and stages of the work items the pool mentions (the group's work, else its feature); the id stands in when a lookup fails.
	useEffect(() => {
		if (!obsPool) return;
		const now = Date.now();
		// the groups' own items, and the feature whose Record blocks a group
		const keys = new Set<string>();
		for (const g of groupObservations(obsPool)) {
			if (g.kind === "work") keys.add(g.key);
			if (g.blockedKey) keys.add(g.blockedKey);
		}
		for (const key of keys) {
			if (now - (infoAt.current.get(key) ?? -Infinity) < INFO_TTL_MS) continue;
			infoAt.current.set(key, now);
			void fetchWorkRecord(wolf, key).then((r) => {
				if (r.ok) setGroupInfo((m) => ({ ...m, [key]: { title: r.data.title || key, stage: r.data.stage || undefined } }));
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
		setTree(null);
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
		if (r.ok) setNote(consolidateMessage(r.data));
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

			<ObservationsSection wolf={wolf} observations={{ tree, error: treeError ?? poolError, pool: obsPool, pending: poolPending, info: groupInfo, open: openGroup, onOpen: setOpenGroup, version: treeVersion }} />
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

const TOUCH = "min-h-11";

/** "3 pending · 5 archived", zero parts left out. */
const countsText = (c: { pending: number; archived: number }): string => [c.pending ? `${c.pending} pending` : "", c.archived ? `${c.archived} archived` : ""].filter(Boolean).join(" · ") || "none";

/**
 * The observation tree: feature → tasks with their observation counts (pending in the pool, archived over the last 7 days),
 * then unresolved work and the den. Tapping a feature (its own observations) or a task replaces the list with that node's
 * observations (pending first, then archived with outcome and target); Back returns. Blocked/backoff notes come from the pool.
 */
export function ObservationsSection({ wolf, observations }: {
	wolf: string;
	observations: {
		tree: MemoryTree | null;
		error: string | null;
		pool: PoolObservation[] | null;
		pending?: PoolPending | null;
		info: Readonly<Record<string, GroupInfo | undefined>>;
		open: string | null;
		onOpen: (id: string | null) => void;
		/** Bumps when the tree was refetched, so an open node reloads. */
		version?: number;
	};
}) {
	const { tree, pool, info, open } = observations;
	const rows = tree ? buildMemoryTreeRows(tree) : [];
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
	const blocked = new Map((pool ? groupObservations(pool) : []).filter((g) => g.blocked).map((g) => [g.key, g]));
	const blockedNote = (id: string) => {
		const g = blocked.get(id);
		return g ? <span className="text-amber-600" data-testid="memory-obs-blocked">{blockedLabel(g, info)}</span> : null;
	};
	const toggle = (id: string) =>
		setExpanded((s) => {
			const n = new Set(s);
			if (!n.delete(id)) n.add(id);
			return n;
		});
	const titleOf = (id: string): string => {
		if (id === DEN_GROUP) return "Den";
		for (const r of rows) {
			if (r.kind === "feature") {
				if (r.id === id) return r.title;
				const t = r.tasks.find((x) => x.id === id);
				if (t) return t.title;
			}
		}
		return info[id]?.title || id;
	};

	if (open) return <NodeDetail wolf={wolf} id={open} label={titleOf(open)} version={observations.version ?? 0} onBack={() => observations.onOpen(null)} />;

	const rowBtn = `flex w-full ${TOUCH} items-center justify-between gap-2 rounded px-1.5 py-1 text-left text-xs transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring`;
	return (
		<section data-testid="memory-feed" className="min-w-0">
			<h3 className="mb-1 text-xs font-medium uppercase text-muted-foreground">Observations</h3>
			{pendingWarning(observations.pending) ? <p className="rounded bg-amber-50 px-1.5 py-1 text-[11px] text-amber-700" data-testid="memory-obs-pending-warning">{pendingWarning(observations.pending)}</p> : null}
			{tree === null ? (
				<p className="text-xs text-muted-foreground" data-testid="memory-obs-state">{observations.error ? `Observations unavailable: ${observations.error}` : "Loading…"}</p>
			) : rows.every((r) => r.pending + r.archived === 0 && r.kind !== "feature") && rows.length <= 1 ? (
				<p className="text-xs text-muted-foreground">Nothing captured yet.</p>
			) : (
				<ul className="flex min-w-0 flex-col gap-1" data-testid="memory-obs-groups">
					{rows.map((r) => {
						if (r.kind !== "feature") {
							const label = r.kind === "den" ? "Den" : r.id;
							return (
								<li key={r.id}>
									<button type="button" className={rowBtn} data-testid={`memory-obs-group-${r.id}`} data-count={r.pending + r.archived} onClick={() => observations.onOpen(r.id)}>
										<span className="min-w-0 break-words">{label}</span>
										<span className="flex shrink-0 flex-col items-end text-muted-foreground">{blockedNote(r.id)}<span data-testid="memory-obs-count">{countsText(r)}</span></span>
									</button>
								</li>
							);
						}
						const isOpen = expanded.has(r.id);
						return (
							<li key={r.id} data-testid={`memory-obs-feature-${r.id}`}>
								<div className="flex items-stretch">
									<button type="button" aria-label={isOpen ? "Collapse tasks" : "Expand tasks"} aria-expanded={isOpen} className={`flex ${TOUCH} min-w-11 items-center justify-center rounded hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring`} data-testid={`memory-obs-toggle-${r.id}`} onClick={() => toggle(r.id)}>
										{isOpen ? <ChevronDownIcon className="size-4" /> : <ChevronRightIcon className="size-4" />}
									</button>
									<button type="button" className={rowBtn} data-testid={`memory-obs-group-${r.id}`} data-count={r.own.pending + r.own.archived} onClick={() => observations.onOpen(r.id)}>
										<span className="min-w-0 break-words">{r.title}<span className="block text-[10px] text-muted-foreground">{r.id}{r.stage ? ` · ${r.stage.replace(/_/g, " ")}` : ""}</span></span>
										<span className="flex shrink-0 flex-col items-end text-muted-foreground">{blockedNote(r.id)}<span data-testid="memory-obs-count">{countsText(r)}</span></span>
									</button>
								</div>
								{isOpen ? (
									<ul className="ml-6 flex flex-col gap-1" data-testid="memory-obs-tasks">
										{r.tasks.length === 0 ? <li className="px-1.5 py-2 text-xs text-muted-foreground">No tasks with observations.</li> : null}
										{r.tasks.map((t) => (
											<li key={t.id}>
												<button type="button" className={rowBtn} data-testid={`memory-obs-group-${t.id}`} data-count={t.pending + t.archived} onClick={() => observations.onOpen(t.id)}>
													<span className="min-w-0 break-words">{t.title}<span className="block text-[10px] text-muted-foreground">{t.id}</span></span>
													<span className="flex shrink-0 flex-col items-end text-muted-foreground">{blockedNote(t.id)}<span data-testid="memory-obs-count">{countsText(t)}</span></span>
												</button>
											</li>
										))}
									</ul>
								) : null}
							</li>
						);
					})}
				</ul>
			)}
		</section>
	);
}

/** One node's observations: pending first, then archived (outcome + target), with a note when the archived list was cut. */
function NodeDetail({ wolf, id, label, version, onBack }: { wolf: string; id: string; label: string; version: number; onBack: () => void }) {
	const [node, setNode] = useState<MemoryNodeObservations | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		let live = true;
		void fetchMemoryNode(wolf, id).then((r) => {
			if (!live) return;
			if (r.ok) {
				setNode(r.data);
				setError(null);
			} else setError(r.message);
		});
		return () => {
			live = false;
		};
	}, [wolf, id, version]);
	return (
		<section data-testid="memory-feed" className="min-w-0">
			<button
				type="button"
				className={`-ml-1 mb-1 flex ${TOUCH} w-full items-center gap-1 rounded px-1 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring`}
				aria-label="Back to observations"
				data-testid="memory-obs-back"
				onClick={onBack}
			>
				<ChevronLeftIcon className="size-4 shrink-0" />
				<span className="min-w-0 break-words">{label}{label !== id && id !== DEN_GROUP ? <span className="block text-[10px]">{id}</span> : null}</span>
			</button>
			{node === null ? (
				<p className="text-xs text-muted-foreground" data-testid="memory-obs-state">{error ? `Observations unavailable: ${error}` : "Loading…"}</p>
			) : (
				<div className="flex min-w-0 flex-col gap-3" data-testid="memory-obs-items" data-group={id}>
					<div>
						<h4 className="mb-1 text-[10px] font-medium uppercase text-muted-foreground">Pending ({node.pending.length})</h4>
						<ul className="flex flex-col gap-2">
							{node.pending.map((o) => (
								<li key={o.id} className="text-xs" data-testid="memory-obs-item" data-state="pending">
									{o.recordedAt ? <div className="text-muted-foreground">{o.recordedAt}</div> : null}
									<div className="whitespace-pre-wrap break-words">{o.content}</div>
								</li>
							))}
							{node.pending.length === 0 ? <li className="text-xs text-muted-foreground">Nothing pending.</li> : null}
						</ul>
					</div>
					<div>
						<h4 className="mb-1 text-[10px] font-medium uppercase text-muted-foreground">Archived, last 7 days ({node.archived.length})</h4>
						<ul className="flex flex-col gap-2">
							{node.archived.map((o) => (
								<li key={o.id} className="text-xs" data-testid="memory-obs-item" data-state="archived">
									<div className="text-muted-foreground">{o.at}</div>
									<div className="whitespace-pre-wrap break-words">{o.content}</div>
									<div className="break-words text-[10px] text-muted-foreground" data-testid="memory-obs-outcome">{o.outcome} → {o.target}</div>
								</li>
							))}
							{node.archived.length === 0 ? <li className="text-xs text-muted-foreground">Nothing archived.</li> : null}
						</ul>
						{node.truncated ? <p className="mt-1 text-[11px] text-muted-foreground" data-testid="memory-obs-truncated">Older archived observations are not shown.</p> : null}
					</div>
				</div>
			)}
		</section>
	);
}
