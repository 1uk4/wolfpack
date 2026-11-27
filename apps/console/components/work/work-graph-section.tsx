"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ExternalLinkIcon, GitPullRequestIcon, MessageSquareIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/hint";
import { TaskGraphLarge } from "@/components/work/task-graph";
import { THREADS_MOUNT_MAX_AGE_MS, fetchWolfThreads, fetchWolves, fetchWorkList, fetchWorkRecord } from "@/components/kb/kb-client";
import { progressBar, progressPanel, TONE_LABEL, type ProgressPanel, type StageTone, type TaskGraphModel, type ThreadFact, type ThreadLive } from "@/src/core";

type GraphModel = Extract<TaskGraphModel, { kind: "graph" }>;

const TONE_BG: Record<StageTone, string> = { plan: "bg-muted-foreground/40", build: "bg-sky-400", shipped: "bg-emerald-500", archived: "bg-muted-foreground/20" };
const LIVE_LABEL: Record<ThreadLive, string> = { working: "Working", idle: "Idle", "needs-you": "Needs you" };
const LIVE_DOT: Record<ThreadLive, string> = { working: "bg-sky-400 motion-safe:animate-pulse", idle: "bg-muted-foreground/60", "needs-you": "bg-amber-400" };

/** The overall progress bar: shipped, in build and plan segments, in that order. */
export function ProgressBar({ model }: { model: GraphModel }) {
	const bar = progressBar(model.nodes);
	return (
		<div className="flex items-center gap-3" data-testid="work-progress">
			<div className="flex h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={bar.pct.shipped} aria-label={`${bar.shipped} of ${bar.total} shipped`}>
				<div className={TONE_BG.shipped} style={{ width: `${bar.pct.shipped}%` }} />
				<div className={TONE_BG.build} style={{ width: `${bar.pct.build}%` }} />
			</div>
			<span className="shrink-0 text-xs text-muted-foreground" data-testid="task-graph-progress">{model.label}</span>
		</div>
	);
}

/** Reads live data for one node: its record (ledger, record text), the wolves' thread lists and the work list's assignee. Local hub/wolfd only. */
function useNodeProgress(model: GraphModel, id: string | null, wolf: string | undefined, domain: string | undefined): ProgressPanel | null | "loading" {
	const [data, setData] = useState<{ id: string; panel: ProgressPanel | null } | null>(null);
	useEffect(() => {
		if (!id || !wolf) return;
		let cancelled = false;
		const node = model.nodes.find((n) => n.id === id);
		void (async () => {
			const [rec, list, wolves] = await Promise.all([fetchWorkRecord(wolf, id), domain ? fetchWorkList(wolf, domain, false, 10_000) : Promise.resolve(null), fetchWolves()]);
			const threads: ThreadFact[] = [];
			if (wolves.ok) {
				await Promise.all(
					wolves.data.wolves
						.filter((w) => w.status !== "offline")
						.map(async (w) => {
							try {
								const r = await fetchWolfThreads<{ threads?: Omit<ThreadFact, "wolf">[] }>(w.name, THREADS_MOUNT_MAX_AGE_MS);
								if (r.ok) for (const t of r.data.threads ?? []) threads.push({ ...t, wolf: w.name });
							} catch {
								/* an unreachable wolf: no thread shown from it */
							}
						}),
				);
			}
			const assignee = list && list.ok ? list.data.items.find((i) => i.id === id)?.assignee : undefined;
			const base = rec.ok ? rec.data : { id, title: node?.title ?? id, kind: node?.kind ?? "task", stage: node?.stage ?? "" };
			const log = rec.ok ? rec.data.log : undefined;
			if (!cancelled) setData({ id, panel: progressPanel({ ...base, ...(log ? { log } : {}), ...(rec.ok ? { record: rec.data.record } : {}) }, node?.status ?? "ready", threads, assignee) });
		})();
		return () => {
			cancelled = true;
		};
	}, [model, id, wolf, domain]);
	return !id ? null : data?.id === id ? data.panel : "loading";
}

/** The inline progress of one node: a side card on desktop, a bottom sheet on the phone. */
export function ProgressPanelView({ panel, onClose, onOpenTask }: { panel: ProgressPanel; onClose: () => void; onOpenTask?: (id: string) => void }) {
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);
	return (
		<>
		{/* Phone: a backdrop behind the bottom sheet, tap outside closes. */}
		<div data-testid="work-progress-backdrop" className="fixed inset-0 z-30 bg-black/30 md:hidden" onClick={onClose} aria-hidden />
		<aside
			data-testid="work-progress-panel"
			data-work={panel.id}
			className="max-md:fixed max-md:inset-x-0 max-md:bottom-0 max-md:z-40 max-md:max-h-[60dvh] max-md:rounded-b-none max-md:pb-[env(safe-area-inset-bottom)] w-full shrink-0 overflow-y-auto rounded-xl border bg-popover/80 p-4 shadow-lg backdrop-blur-xl md:w-80"
			aria-label={`Progress: ${panel.title}`}
		>
			<div className="mb-3 flex items-start gap-2">
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
						<span className={`size-2 rounded-full ${TONE_BG[panel.tone]}`} aria-hidden />
						<span data-testid="work-progress-stage">{TONE_LABEL[panel.tone]}</span>
						<span>· {panel.kind}</span>
					</div>
					<h3 className="mt-1 text-sm font-medium leading-snug">{panel.title}</h3>
				</div>
				<Hint label="Close">
					<Button size="icon-xs" variant="ghost" className="shrink-0 max-md:size-11" aria-label="Close progress" onClick={onClose}>
						<XIcon />
					</Button>
				</Hint>
			</div>
			<dl className="space-y-2 text-xs">
				<div className="flex items-center gap-2">
					<dt className="w-12 text-muted-foreground">Wolf</dt>
					<dd>{panel.wolf ?? "unassigned"}</dd>
				</div>
				{panel.thread && (
					<div className="flex items-center gap-2" data-testid="work-progress-thread" data-live={panel.thread.live}>
						<dt className="w-12 text-muted-foreground">Thread</dt>
						<dd className="flex items-center gap-1.5">
							<span className={`size-2 rounded-full ${LIVE_DOT[panel.thread.live]}`} aria-hidden />
							{LIVE_LABEL[panel.thread.live]}
						</dd>
					</div>
				)}
			</dl>
			{panel.notes.length + panel.commits.length > 0 && (
				<ul className="mt-3 space-y-1 border-t pt-3 text-xs text-muted-foreground">
					{panel.commits.map((l) => <li key={`c${l}`} className="font-mono">{l}</li>)}
					{panel.notes.map((l) => <li key={`n${l}`}>{l}</li>)}
				</ul>
			)}
			<div className="mt-3 flex items-center gap-1 border-t pt-3">
				{panel.thread && (
					<Hint label="Open thread">
						<Button asChild size="icon" variant="ghost" className="max-md:size-11">
							<Link href={panel.thread.href} aria-label="Open thread" data-testid="work-progress-open-thread"><MessageSquareIcon /></Link>
						</Button>
					</Hint>
				)}
				{panel.pr && (
					<Hint label="Open pull request">
						<Button asChild size="icon" variant="ghost" className="max-md:size-11">
							<a href={panel.pr} target="_blank" rel="noreferrer" aria-label="Open pull request" data-testid="work-progress-pr"><GitPullRequestIcon /></a>
						</Button>
					</Hint>
				)}
				{onOpenTask && (
					<Hint label="Open item">
						<Button size="icon" variant="ghost" className="max-md:size-11" aria-label="Open item" onClick={() => onOpenTask(panel.id)}>
							<ExternalLinkIcon />
						</Button>
					</Hint>
				)}
			</div>
		</aside>
		</>
	);
}

/** The work page's graph: fills the view, with the overall progress bar above and a node's progress inline. */
export function WorkGraphSection({ model, wolf, domain, onOpenTask }: { model: GraphModel; wolf?: string; domain?: string; onOpenTask?: (id: string) => void }) {
	const [selected, setSelected] = useState<string | null>(null);
	const panel = useNodeProgress(model, selected, wolf, domain);
	const select = useMemo(() => (id: string) => setSelected((cur) => (cur === id ? null : id)), []);
	return (
		<div className="space-y-3" data-testid="task-graph">
			<ProgressBar model={model} />
			<div className="flex h-[70dvh] min-h-80 flex-col gap-3 md:flex-row">
				<div className="min-h-0 min-w-0 flex-1">
					<TaskGraphLarge model={model} selectedId={selected} onSelect={select} />
				</div>
				{selected && panel === "loading" && <p className="text-xs text-muted-foreground md:w-80" role="status">Loading…</p>}
				{selected && panel && panel !== "loading" && <ProgressPanelView panel={panel} onClose={() => setSelected(null)} onOpenTask={onOpenTask} />}
			</div>
		</div>
	);
}
