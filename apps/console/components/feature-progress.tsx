"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { CheckIcon, ChevronDownIcon, LinkIcon, LockIcon } from "lucide-react";
import { useOptionalServerEvent } from "@/components/server-events";
import { bindUrl } from "@/components/thread-transport";
import { cn } from "@/lib/utils";
import { buildFeatureProgress, layoutStrip, STRIP_NODE_H, STRIP_NODE_W, type FeatureProgress, type WorkRecordResponse } from "@/src/core";

type Progress = Extract<FeatureProgress, { kind: "progress" }>;
type ProgressTask = Progress["tasks"][number];

/**
 * THE FEATURE PROGRESS PANEL: pinned at the top of a thread bound to a feature (or to one of its tasks); it replaces
 * the floating checklist there. A small title ("<feature> · 4/9 shipped") with a loader while the thread is busy, a
 * compact left-to-right graph (one column per dependency step, the shape of learnharness's plan map: shipped dimmed,
 * the bound task glowing yellow, upcoming plain) and the task list. Data is live from the Work API (no model input):
 * see useFeatureProgress. Clicking a task focuses it in the graph and offers "open"; the link icon binds the thread to it.
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
		return memoryOpen;
	}
}

export function isProgressOpen(threadId: string): boolean {
	return readOpen().includes(threadId) || memoryOpen.includes(threadId);
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

export type ProgressState = { phase: "pending" } | { phase: "none" } | { phase: "ready"; progress: Progress; boundId: string };

interface ThreadRow {
	id: string;
	boundWorkItem?: string;
	boundItem?: string;
}

const POLL_MS = 15_000;

async function getRecord(wolf: string, id: string): Promise<WorkRecordResponse | null> {
	const res = await fetch(`/api/wolves/${encodeURIComponent(wolf)}/work/${encodeURIComponent(id)}/record`);
	return res.ok ? ((await res.json()) as WorkRecordResponse) : null;
}

/**
 * The bound item is the thread's `boundItem ?? boundWorkItem` (live from the thread list); a task's feature is its
 * parent. Refreshed on mount, on `refreshKey` (a turn ended), on this thread's thread-updated / status events, and every
 * 15 s while the page is visible (there is no work event to subscribe to: that is how a shipped task shows up).
 */
export function useFeatureProgress(wolf: string, threadId: string, refreshKey: number): { state: ProgressState; refresh: () => void } {
	const [state, setState] = useState<ProgressState>({ phase: "pending" });
	const seq = useRef(0);
	const refresh = useCallback(async () => {
		const n = ++seq.current;
		try {
			const res = await fetch(`/api/wolves/${encodeURIComponent(wolf)}/threads`);
			if (!res.ok || n !== seq.current) return;
			const list = ((await res.json()) as { threads?: ThreadRow[] }).threads ?? [];
			const row = list.find((t) => t.id === threadId);
			const boundId = row?.boundItem ?? row?.boundWorkItem;
			if (!boundId) return void (n === seq.current && setState({ phase: "none" }));
			const rec = await getRecord(wolf, boundId);
			const feature = !rec ? null : rec.kind === "feature" ? rec : rec.partOf ? await getRecord(wolf, rec.partOf) : null;
			if (n !== seq.current) return;
			const progress = buildFeatureProgress(rec, feature);
			setState(progress.kind === "progress" ? { phase: "ready", progress, boundId } : { phase: "none" });
		} catch {
			/* keep what is shown; the next trigger refetches */
		}
	}, [wolf, threadId]);
	useEffect(() => {
		void refresh();
	}, [refresh, refreshKey]);
	useEffect(() => {
		const t = setInterval(() => {
			if (typeof document === "undefined" || document.visibilityState !== "hidden") void refresh();
		}, POLL_MS);
		return () => clearInterval(t);
	}, [refresh]);
	useOptionalServerEvent("thread-updated", (p) => {
		if (p.wolf === wolf && p.thread.id === threadId) void refresh();
	});
	useOptionalServerEvent("needs-you-changed", (p) => {
		if (p.wolf === wolf && p.threadId === threadId && p.kind === "status") void refresh();
	});
	return { state, refresh: () => void refresh() };
}

// ---------------------------------------------------------------- graph

/** Node look (learnharness plan-block): shipped = dimmed; current = bright stroke + blurred yellow glow; upcoming = card fill, border stroke. */
function nodeClass(t: ProgressTask): string {
	if (t.shipped) return "fill-background/50 stroke-muted-foreground/40";
	if (t.bound) return "fill-background stroke-yellow-400";
	if (t.status === "building") return "fill-card stroke-sky-400";
	return "fill-card stroke-border";
}

export function ProgressStrip({ progress, focusId, onFocus }: { progress: Progress; focusId: string | null; onFocus: (id: string) => void }) {
	const layout = layoutStrip(progress);
	const byId = new Map(progress.tasks.map((t) => [t.id, t] as const));
	const h = Math.min(140, layout.height + 12);
	return (
		<svg
			viewBox={`${-6} ${-6} ${layout.width + 12} ${layout.height + 12}`}
			preserveAspectRatio="xMidYMid meet"
			className="w-full"
			style={{ height: h }}
			role="group"
			aria-label={`Task graph: ${progress.title}, ${progress.label}`}
			data-testid="feature-progress-graph"
			data-layers={progress.layers}
		>
			<defs>
				<filter id="fp-glow" x="-60%" y="-60%" width="220%" height="220%">
					<feGaussianBlur stdDeviation="3" />
				</filter>
			</defs>
			{layout.edges.map((e) => {
				const from = byId.get(e.from)!;
				return <path key={`${e.from}->${e.to}`} d={e.d} fill="none" className={cn("stroke-border", from.shipped && "opacity-40")} strokeWidth={1.25} data-testid={`feature-progress-edge-${e.from}-${e.to}`} />;
			})}
			{layout.nodes.map((n) => {
				const t = byId.get(n.id)!;
				const x = n.x - STRIP_NODE_W / 2;
				const y = n.y - STRIP_NODE_H / 2;
				return (
					<g
						key={n.id}
						data-testid={`feature-progress-node-${n.id}`}
						data-layer={t.layer}
						data-status={t.status}
						data-bound={t.bound ? "true" : "false"}
						data-blocked={t.blocked ? "true" : "false"}
						data-focused={focusId === n.id ? "true" : "false"}
						role="button"
						tabIndex={0}
						aria-label={`${t.index}. ${t.title}${t.shipped ? " (shipped)" : ""}${t.bound ? " (current)" : ""}${t.blocked ? " (blocked)" : ""}`}
						className="cursor-pointer outline-none"
						onClick={() => onFocus(n.id)}
						onKeyDown={(e) => {
							if (e.key === "Enter" || e.key === " ") {
								e.preventDefault();
								onFocus(n.id);
							}
						}}
					>
						<title>{t.title}</title>
						{t.bound && <rect x={x} y={y} width={STRIP_NODE_W} height={STRIP_NODE_H} rx={6} className="fill-yellow-400/70" filter="url(#fp-glow)" data-testid="feature-progress-glow" />}
						<rect x={x} y={y} width={STRIP_NODE_W} height={STRIP_NODE_H} rx={6} className={nodeClass(t)} strokeWidth={t.bound ? 1.75 : 1.25} strokeDasharray={t.blocked ? "3 2" : undefined} />
						{focusId === n.id && <rect x={x - 3} y={y - 3} width={STRIP_NODE_W + 6} height={STRIP_NODE_H + 6} rx={8} fill="none" className="stroke-foreground" strokeWidth={1.25} />}
						<text x={n.x} y={n.y} textAnchor="middle" dominantBaseline="central" className={cn("pointer-events-none select-none fill-foreground text-[10px] font-medium", t.shipped && "fill-muted-foreground")}>
							{t.index}
						</text>
					</g>
				);
			})}
		</svg>
	);
}

// ---------------------------------------------------------------- panel

export interface FeatureProgressPanelProps {
	wolf: string;
	slug: string;
	threadId: string;
	progress: Progress;
	/** The thread is running a turn: shows the small loader. */
	busy: boolean;
	/** The thread is read-only history: no binding. */
	closed?: boolean;
	/** The bind succeeded: refresh the data. */
	onBound?: () => void;
}

export function FeatureProgressPanel({ wolf, slug, threadId, progress, busy, closed, onBound }: FeatureProgressPanelProps) {
	const [open, setOpenState] = useState(() => isProgressOpen(threadId));
	const [focusId, setFocusId] = useState<string | null>(null);
	const [confirmId, setConfirmId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [binding, setBinding] = useState(false);
	const panelId = useId();
	const setOpen = (v: boolean) => {
		setProgressOpen(threadId, v);
		setOpenState(v);
	};
	const boundTask = progress.tasks.find((t) => t.bound);
	const bind = async (task: ProgressTask) => {
		setBinding(true);
		setError(null);
		try {
			const res = await fetch(bindUrl(wolf, slug), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workItemId: task.id }) });
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				setError(body?.error ?? `Could not bind (${res.status}).`);
				return;
			}
			setConfirmId(null);
			onBound?.();
		} catch {
			setError("Could not reach the console server.");
		} finally {
			setBinding(false);
		}
	};
	const focused = progress.tasks.find((t) => t.id === focusId);
	return (
		<div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex max-h-full flex-col" data-testid="feature-progress" data-expanded={open} data-feature-id={progress.featureId}>
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
							{progress.title} · {progress.label}
						</span>
						{busy && <span role="status" aria-label="Working" data-testid="feature-progress-loader" className="size-3 shrink-0 animate-spin rounded-full border-2 border-muted-foreground/40 border-t-foreground motion-reduce:animate-none" />}
						<ChevronDownIcon aria-hidden className={cn("size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none", open && "rotate-180")} />
					</button>
					{open && (
						<div id={panelId} role="region" aria-label={`${progress.title} progress`} data-testid="feature-progress-panel" className="flex min-h-0 flex-col gap-2 overflow-y-auto overscroll-contain border-t p-3">
							<ProgressStrip progress={progress} focusId={focusId} onFocus={setFocusId} />
							<ul className="flex flex-col" aria-label="Tasks">
								{progress.tasks.map((t) => (
									<li
										key={t.id}
										data-testid={`feature-progress-task-${t.id}`}
										data-shipped={t.shipped ? "true" : "false"}
										data-bound={t.bound ? "true" : "false"}
										data-blocked={t.blocked ? "true" : "false"}
										data-focused={focusId === t.id ? "true" : "false"}
										className={cn("rounded-md px-1", focusId === t.id && "bg-accent/60", t.bound && "shadow-[0_0_10px_1px_rgba(250,204,21,0.35)] ring-1 ring-yellow-400/70")}
									>
										<div className="flex items-center gap-2 py-1 text-sm">
											<button
												type="button"
												onClick={() => setFocusId(focusId === t.id ? null : t.id)}
												aria-pressed={focusId === t.id}
												className={cn("flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-2 focus-visible:outline-ring", t.shipped && "text-muted-foreground opacity-60")}
											>
												<span className="w-4 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{t.index}</span>
												{t.shipped && <CheckIcon aria-hidden className="size-3.5 shrink-0" />}
												<span className={cn("min-w-0 truncate", t.shipped && "line-through")}>{t.title}</span>
												{t.blocked && (
													<span data-testid={`feature-progress-blocked-${t.id}`} title="Blocked by an unshipped prerequisite" className="flex shrink-0 items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
														<LockIcon aria-hidden className="size-3" />
														blocked
													</span>
												)}
												{t.bound && <span className="shrink-0 rounded bg-yellow-400/20 px-1 text-[11px] font-medium text-yellow-600 dark:text-yellow-300">current</span>}
											</button>
											<button
												type="button"
												aria-label={`Bind this thread to ${t.title}`}
												title={t.bound ? "This thread is bound to this task" : t.shipped ? "Already shipped" : closed ? "Thread is closed" : "Bind this thread to this task"}
												disabled={t.bound || t.shipped || closed || binding}
												onClick={() => {
													setError(null);
													setConfirmId(t.id);
												}}
												data-testid={`feature-progress-bind-${t.id}`}
												className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-30"
											>
												<LinkIcon aria-hidden className="size-3.5" />
											</button>
										</div>
										{confirmId === t.id && (
											<div role="alertdialog" aria-label="Confirm rebind" data-testid="feature-progress-confirm" className="mb-1 flex flex-wrap items-center gap-2 rounded-md border bg-background px-2 py-1.5 text-xs">
												<span className="min-w-0 flex-1">{boundTask ? `Rebind this thread from "${boundTask.title}" to "${t.title}"?` : `Bind this thread to "${t.title}"?`} The agent learns of it on its next prompt.</span>
												<button type="button" disabled={binding} onClick={() => void bind(t)} data-testid="feature-progress-confirm-yes" className="rounded-md bg-primary px-2 py-1 font-medium text-primary-foreground disabled:opacity-50">
													{boundTask ? "Rebind" : "Bind"}
												</button>
												<button type="button" onClick={() => setConfirmId(null)} data-testid="feature-progress-confirm-no" className="rounded-md border px-2 py-1">
													Cancel
												</button>
											</div>
										)}
									</li>
								))}
							</ul>
							{focused && (
								<div className="flex items-center gap-2 border-t pt-2 text-xs text-muted-foreground" data-testid="feature-progress-focus">
									<span className="min-w-0 flex-1 truncate">
										{focused.index}. {focused.title} · {focused.stage}
									</span>
									<a href={`/kb/work/${encodeURIComponent(focused.id)}`} data-testid="feature-progress-open" className="shrink-0 underline-offset-2 hover:underline">
										open
									</a>
								</div>
							)}
							{error && (
								<p role="alert" data-testid="feature-progress-error" className="text-xs text-destructive">
									{error}
								</p>
							)}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
