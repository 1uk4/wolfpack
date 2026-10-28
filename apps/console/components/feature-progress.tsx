"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ChevronDownIcon, Maximize2Icon } from "lucide-react";
import { OverlayHeader, OverlayShell } from "@/components/overlay-shell";
import { useOptionalMemoryEvents } from "@/components/memory-events";
import { usePanelHost } from "@/components/panel-host";
import { PlanGraphView } from "@/components/plan-graph-view";
import { useOptionalServerEvent, useOptionalServerResync } from "@/components/server-events";
import { cn } from "@/lib/utils";
import { buildFeatureGraph, featureStrip, isWorkEvent, type FeatureGraph, type WorkRecordResponse } from "@/src/core";

type Model = Extract<FeatureGraph, { kind: "graph" }>;

/**
 * THE PINNED FEATURE GRAPH: at the top of a thread bound to a feature (or to one of its tasks). Folded (the default) it is
 * one line, "<feature> · 4/9 done"; open it is the feature's show_graph-style graph (the shared PlanGraphView), the
 * thread's bound task highlighted, capped at 40vh, a free-pan canvas (drag, re-center, no zoom) with done / skipped tasks as thin bars, and a full-screen button
 * that opens the same canvas in a modal. A node click opens the Status panel on that task.
 * Data is live from the Work API (no model input): see useFeatureProgress. The open/folded state is kept per thread.
 */

// ---------------------------------------------------------------- collapse state (per thread, persisted)

/** Threads whose panel the user opened (default collapsed). localStorage: survives reload; memory fallback otherwise. */
const OPEN_KEY = "wp.feature-progress.open.v1";
const OPEN_MAX = 200;
let memoryOpen: string[] = [];

function readOpen(): string[] {
	try {
		const v: unknown = JSON.parse(localStorage.getItem(OPEN_KEY) ?? "[]");
		return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
	} catch {
		return memoryOpen; // localStorage unavailable: the in-memory copy
	}
}

export function isProgressOpen(threadId: string): boolean {
	return readOpen().includes(threadId);
}

export function setProgressOpen(threadId: string, open: boolean): void {
	const next = [...readOpen().filter((t) => t !== threadId), ...(open ? [threadId] : [])].slice(-OPEN_MAX);
	memoryOpen = next;
	try {
		localStorage.setItem(OPEN_KEY, JSON.stringify(next));
	} catch {
		/* memory fallback */
	}
}

/** Top padding the transcript reserves for the collapsed bar; the expanded panel is an overlay (like the checklist's). */
export const FEATURE_PROGRESS_RESERVE = "pt-14";

// ---------------------------------------------------------------- data

export type ProgressState = { phase: "pending" } | { phase: "none" } | { phase: "ready"; model: Model; boundId: string };
const PENDING: ProgressState = { phase: "pending" };
/** Same graph and binding: the refetch changed nothing, so the panel is not re-rendered (and a user's drag is not disturbed). */
const sameState = (a: ProgressState, b: ProgressState): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

interface ThreadRow {
	id: string;
	boundWorkItem?: string;
	boundItem?: string;
}

const POLL_MS = 15_000;
/** Events that may have moved a task coalesce into one refetch this long after the first of them. */
export const REFETCH_DEBOUNCE_MS = 300;

async function getRecord(wolf: string, id: string): Promise<WorkRecordResponse | null> {
	const res = await fetch(`/api/wolves/${encodeURIComponent(wolf)}/work/${encodeURIComponent(id)}/record`);
	return res.ok ? ((await res.json()) as WorkRecordResponse) : null;
}

/**
 * The bound item is the thread's `boundItem ?? boundWorkItem` (live from the thread list); a task's feature is its
 * parent. Refetched (debounced) on mount, on `refreshKey` (a turn ended), and on every signal that can change what the
 * graph shows. The wolf emits no work-item event of its own (a stage change, a task created or moved, a link added or
 * removed, graduation: all are Work API writes), so the signals are the ones that travel with them: this wolf's
 * thread-updated (a bind or unbind, a graduation closing a thread) and needs-you-changed events, memory events about a
 * work item (record_written, observation_captured), the event streams' reconnects, window focus, and the 15 s poll.
 * Events that do not name a feature refetch anyway.
 */
export function useFeatureProgress(wolf: string, threadId: string, refreshKey: number): { state: ProgressState } {
	const [state, setState] = useState<ProgressState>(PENDING);
	const stateRef = useRef(state);
	stateRef.current = state;
	const seq = useRef(0);
	const put = useCallback((next: ProgressState) => setState((prev) => (sameState(prev, next) ? prev : next)), []);
	const load = useCallback(async () => {
		const n = ++seq.current;
		try {
			const res = await fetch(`/api/wolves/${encodeURIComponent(wolf)}/threads`);
			if (!res.ok || n !== seq.current) return;
			const list = ((await res.json()) as { threads?: ThreadRow[] }).threads ?? [];
			const row = list.find((t) => t.id === threadId);
			const boundId = row?.boundItem ?? row?.boundWorkItem;
			if (!boundId) return void (n === seq.current && put({ phase: "none" }));
			const rec = await getRecord(wolf, boundId);
			const feature = !rec ? null : rec.kind === "feature" ? rec : rec.partOf ? await getRecord(wolf, rec.partOf) : null;
			if (n !== seq.current) return;
			const model = buildFeatureGraph(rec, feature);
			put(model.kind === "graph" ? { phase: "ready", model, boundId } : { phase: "none" });
		} catch {
			/* keep what is shown; the next trigger refetches */
		}
	}, [wolf, threadId, put]);
	const loadRef = useRef(load);
	loadRef.current = load;
	// Debounce from the FIRST signal (not trailing-reset): a steady stream of events still refetches every window.
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const schedule = useCallback(() => {
		if (timer.current) return;
		timer.current = setTimeout(() => {
			timer.current = null;
			void loadRef.current();
		}, REFETCH_DEBOUNCE_MS);
	}, []);
	useEffect(
		() => () => {
			if (timer.current) clearTimeout(timer.current);
			timer.current = null;
			seq.current++; // a load still in flight must not set state after unmount
		},
		[],
	);
	// Another thread (or wolf) starts from pending, never showing the previous one's graph.
	useEffect(() => {
		setState((prev) => (prev === PENDING ? prev : PENDING));
	}, [wolf, threadId]);
	useEffect(() => {
		void load();
	}, [load, refreshKey]);
	useEffect(() => {
		const t = setInterval(() => {
			if (typeof document === "undefined" || document.visibilityState !== "hidden") schedule();
		}, POLL_MS);
		return () => clearInterval(t);
	}, [schedule]);
	useEffect(() => {
		if (typeof window === "undefined") return;
		window.addEventListener("focus", schedule);
		return () => window.removeEventListener("focus", schedule);
	}, [schedule]);
	useOptionalServerEvent("thread-updated", (p) => {
		// This thread's own change, or any bound thread's (a task moved in the feature; the event does not say which feature).
		const t = p.thread as { id: string; boundWorkItem?: string; boundItem?: string };
		if (p.wolf !== wolf) return;
		const cur = stateRef.current;
		const bound = t.boundItem ?? t.boundWorkItem;
		// Known graph: only this thread, or a thread bound to this feature or one of its tasks. Unknown (no graph yet, or a thread
		// with no binding we can match): refetch anyway.
		if (t.id === threadId || cur.phase !== "ready" || !bound || bound === cur.model.featureId || cur.model.graph.nodes.some((n) => n.id === bound)) schedule();
	});
	useOptionalServerEvent("needs-you-changed", (p) => {
		if (p.wolf === wolf && (p.threadId === undefined || (p.threadId === threadId && p.kind === "status"))) schedule();
	});
	useOptionalServerResync(schedule);
	useOptionalMemoryEvents(
		wolf,
		(e) => {
			if (isWorkEvent(e)) schedule();
		},
		schedule,
	);
	return { state };
}

// ---------------------------------------------------------------- panel

export interface FeatureProgressPanelProps {
	threadId: string;
	model: Model;
	/** The thread is running a turn: shows the small loader. */
	busy: boolean;
}

export function FeatureProgressPanel({ threadId, model, busy }: FeatureProgressPanelProps) {
	const [open, setOpenState] = useState(() => isProgressOpen(threadId));
	const panelId = useId();
	const panels = usePanelHost();
	const [full, setFull] = useState(false);
	const setOpen = (v: boolean) => {
		setProgressOpen(threadId, v);
		setOpenState(v);
	};
	const openTask = (id: string) => {
		setFull(false); // the modal covers the page: close it so the Status panel is visible
		void panels.openPanel("memory", { taskId: id, nonce: Date.now() });
	};
	const titleId = `${panelId}-full`;
	return (
		<div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex max-h-full flex-col" data-testid="feature-progress" data-expanded={open} data-feature-id={model.featureId}>
			<div className="mx-auto flex min-h-0 w-full max-w-[46rem] flex-col px-4 pt-2">
				<div className="pointer-events-auto flex min-h-0 flex-col overflow-hidden rounded-xl border bg-card text-card-foreground shadow-lg">
					<button
						type="button"
						aria-expanded={open}
						aria-controls={open ? panelId : undefined}
						onClick={() => setOpen(!open)}
						data-testid="feature-progress-toggle"
						className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-ring"
					>
						<span className="min-w-0 flex-1 truncate font-medium" data-testid="feature-progress-title">
							{featureStrip(model)}
						</span>
						{model.boundId === null && (
							<span className="shrink-0 rounded bg-yellow-400/20 px-1 text-[11px] font-medium text-yellow-600 dark:text-yellow-300" data-testid="feature-progress-bound-feature">
								bound
							</span>
						)}
						{busy && <span role="status" aria-label="Working" data-testid="feature-progress-loader" className="size-3 shrink-0 animate-spin rounded-full border-2 border-muted-foreground/40 border-t-foreground motion-reduce:animate-none" />}
						<ChevronDownIcon aria-hidden className={cn("size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none", open && "rotate-180")} />
					</button>
					{open && (
						<div id={panelId} role="region" aria-label={`${model.title} graph`} data-testid="feature-progress-panel" className="max-h-[40vh] min-h-0 overflow-hidden border-t p-3">
							{model.graph.nodes.length > 0 ? (
								<PlanGraphView
									draggable
									collapseDone
									graph={model.graph}
									highlightId={model.boundId}
									label={`Task graph: ${model.title}`}
									onNodeClick={openTask}
									toolbar={
										<button
											type="button"
											data-testid="feature-progress-fullscreen"
											aria-label="Full screen"
											title="Full screen"
											onClick={() => setFull(true)}
											className="inline-flex size-6 items-center justify-center rounded-md border bg-card/90 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
										>
											<Maximize2Icon className="size-3.5" aria-hidden />
										</button>
									}
								/>
							) : (
								<p className="text-xs text-muted-foreground" data-testid="feature-progress-empty">
									No tasks yet.
								</p>
							)}
						</div>
					)}
				</div>
			</div>
			{full && open && (
				<OverlayShell
					labelledBy={titleId}
					testId="feature-progress-modal"
					closeTestId="feature-progress-modal-close"
					onClose={() => setFull(false)}
					header={(close) => (
						<OverlayHeader className="flex items-center gap-2 pb-3">
							<h2 id={titleId} className="min-w-0 flex-1 truncate text-sm font-medium">
								{featureStrip(model)}
							</h2>
							{close}
						</OverlayHeader>
					)}
				>
					<div className="relative min-h-0 flex-1 overflow-hidden rounded-xl border" data-testid="feature-progress-modal-body">
						<PlanGraphView draggable collapseDone fill graph={model.graph} highlightId={model.boundId} label={`Task graph: ${model.title}`} onNodeClick={openTask} />
					</div>
				</OverlayShell>
			)}
		</div>
	);
}
