"use client";

import { createPortal } from "react-dom";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Maximize2Icon } from "lucide-react";
import { OverlayHeader, OverlayShell } from "@/components/shell/overlay-shell";
import { useOptionalMemoryEvents } from "@/components/memory/memory-events";
import { useOpenWorkItem } from "@/components/work/work-reader-nav";
import { PlanGraphView } from "@/components/thread/plan-graph-view";
import { useOptionalServerEvent, useOptionalServerResync } from "@/components/shell/server-events";
import { buildFeatureGraph, featureStrip, isWorkEvent, type FeatureGraph, type WorkRecordResponse } from "@/src/core";

type Model = Extract<FeatureGraph, { kind: "graph" }>;

/**
 * THE PINNED FEATURE GRAPH: at the top of a thread bound to a feature (or to one of its tasks). Folded (the default) it is
 * one line, "<feature> · 4/9 done"; open it is the feature's show_graph-style graph (the shared PlanGraphView), the
 * thread's bound task highlighted, capped at 40vh, a free-pan canvas (drag, re-center, no zoom) with done / skipped tasks as thin bars, and a full-screen button
 * that opens the same canvas in a modal. A node click opens the Status panel on that task.
 * Data is live from the Work API (no model input): see useFeatureProgress. The open/folded state is kept per thread.
 */

// ---------------------------------------------------------------- data

export type ProgressState = { phase: "pending" } | { phase: "none" } | { phase: "ready"; model: Model; boundId: string };
const PENDING: ProgressState = { phase: "pending" };
/** Same graph and binding: the refetch changed nothing, so the panel is not re-rendered (and a user's drag is not disturbed). */
const sameState = (a: ProgressState, b: ProgressState): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

const POLL_MS = 15_000;
/** Events that may have moved a task coalesce into one refetch this long after the first of them. */
export const REFETCH_DEBOUNCE_MS = 300;

async function getRecord(wolf: string, id: string): Promise<WorkRecordResponse | null> {
	const res = await fetch(`/api/wolves/${encodeURIComponent(wolf)}/work/${encodeURIComponent(id)}/record`);
	return res.ok ? ((await res.json()) as WorkRecordResponse) : null;
}

/**
 * The bound item is the thread's `boundItem ?? boundWorkItem`, given by the caller (no thread listing here); a task's feature is its
 * parent. Refetched (debounced) on mount, on `refreshKey` (a turn ended), and on every signal that can change what the
 * graph shows. The wolf emits no work-item event of its own (a stage change, a task created or moved, a link added or
 * removed, graduation: all are Work API writes), so the signals are the ones that travel with them: this wolf's
 * thread-updated (a bind or unbind, a graduation closing a thread) and needs-you-changed events, memory events about a
 * work item (record_written, observation_captured), the event streams' reconnects, window focus, and the 15 s poll.
 * Events that do not name a feature refetch anyway.
 */
export function useFeatureProgress(wolf: string, threadId: string, boundId: string | undefined, refreshKey: number): { state: ProgressState } {
	const [state, setState] = useState<ProgressState>(PENDING);
	const stateRef = useRef(state);
	stateRef.current = state;
	const seq = useRef(0);
	const put = useCallback((next: ProgressState) => setState((prev) => (sameState(prev, next) ? prev : next)), []);
	const load = useCallback(async () => {
		const n = ++seq.current;
		try {
			if (!boundId) return void (n === seq.current && put({ phase: "none" }));
			const rec = await getRecord(wolf, boundId);
			const feature = !rec ? null : rec.kind === "feature" ? rec : rec.partOf ? await getRecord(wolf, rec.partOf) : null;
			if (n !== seq.current) return;
			const model = buildFeatureGraph(rec, feature);
			put(model.kind === "graph" ? { phase: "ready", model, boundId } : { phase: "none" });
		} catch {
			/* keep what is shown; the next trigger refetches */
		}
	}, [wolf, boundId, put]);
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

/** The task chip's two texts: the feature's title and its progress ("1/4 done"), from featureStrip's "<title> · n/m done". */
export function progressParts(model: Model): { title: string; progress: string } {
	const strip = featureStrip(model);
	const prefix = `${model.title} · `;
	return { title: model.title, progress: strip.startsWith(prefix) ? strip.slice(prefix.length) : strip };
}

export interface FeatureProgressPanelProps {
	model: Model;
}

/**
 * The body of the bound-task chip when expanded: the feature's graph (the bound task highlighted) and a full-screen modal.
 * The chip row (title, progress, expand, dismiss) is the pinned strip's; this renders only what unfolds under it.
 */
export function FeatureProgressPanel({ model }: FeatureProgressPanelProps) {
	const panelId = useId();
	const openWork = useOpenWorkItem();
	const [full, setFull] = useState(false);
	const openTask = (id: string) => {
		setFull(false); // the modal covers the page: close it so the task view is visible
		openWork(id);
	};
	const titleId = `${panelId}-full`;
	return (
		<div data-testid="feature-progress" data-feature-id={model.featureId}>
			{model.boundId === null && (
				<span className="mb-2 inline-block rounded bg-yellow-400/20 px-1 text-[11px] font-medium text-yellow-600 dark:text-yellow-300" data-testid="feature-progress-bound-feature">
					bound to the feature
				</span>
			)}
			<div role="region" aria-label={`${model.title} graph`} data-testid="feature-progress-panel" className="max-h-[40dvh] min-h-0 overflow-hidden">
				{model.graph.nodes.length > 0 ? (
					<PlanGraphView
						draggable
						collapseDone
						orderByStatus
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
			{full && typeof document !== "undefined" &&
				createPortal(
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
						<PlanGraphView draggable collapseDone orderByStatus fill graph={model.graph} highlightId={model.boundId} label={`Task graph: ${model.title}`} onNodeClick={openTask} />
					</div>
				</OverlayShell>,
				document.body,
			)}
		</div>
	);
}
