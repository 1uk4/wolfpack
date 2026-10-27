"use client";

/** A work item page body (/kb/work/[id]): header facts, links to parent / dependencies, plan and Record. */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { TaskGraph } from "@/components/task-graph";
import { KbMarkdown } from "@/components/kb-markdown";
import { fetchWolves, fetchWorkRecord, openFeatureThread } from "@/components/kb-client";
import { TopBar } from "@/components/top-bar";
import { WorkBadges } from "@/components/work-badges";
import { useLibrarian } from "@/components/use-librarian";
import { buildTaskGraph, featureThreadWolves, resolveWork, threadHref, workHref, composeItemDocument, workRecordView, workWolfCandidates, type WorkRecordResponse } from "@/src/core";

export type WorkPageState =
	| { kind: "loading" }
	| { kind: "unavailable" }
	| { kind: "not_found" }
	| { kind: "error"; message: string }
	| { kind: "ready"; item: WorkRecordResponse; parent: WorkRecordResponse | null; /** Wolves a feature thread can open on (features only). */ threadWolves?: string[] };

export function WorkItemPage({ id }: { id: string }) {
	const { librarian, loading } = useLibrarian();
	const router = useRouter();
	const [fetched, setFetched] = useState<{ id: string; state: WorkPageState } | null>(null);

	useEffect(() => {
		if (loading) return;
		let cancelled = false;
		const done = (state: WorkPageState) => {
			if (!cancelled) setFetched({ id, state });
		};
		void (async () => {
			// candidates: [librarian, ...other online wolves]; the hook does not expose its wolves list, so fetch it once here
			const w = await fetchWolves();
			const hit = await resolveWork(workWolfCandidates(librarian, w.ok ? w.data.wolves : []), id, fetchWorkRecord);
			if (hit.kind === "none") return done({ kind: "unavailable" });
			if (!hit.result.ok) {
				return done(hit.result.reason === "not_found" ? { kind: "not_found" } : { kind: "error", message: hit.result.message });
			}
			const item = hit.result.data;
			let parent: WorkRecordResponse | null = null;
			if (!item.record.trim() && item.partOf) {
				const p = await fetchWorkRecord(hit.wolf, item.partOf);
				if (p.ok) parent = p.data;
			}
			done({ kind: "ready", item, parent, threadWolves: item.kind === "feature" && w.ok ? featureThreadWolves(w.data.wolves) : [] });
		})();
		return () => {
			cancelled = true;
		};
	}, [librarian, loading, id]);

	const state: WorkPageState = fetched?.id === id && !loading ? fetched.state : { kind: "loading" };
	const [threadError, setThreadError] = useState<string | null>(null);
	const openThread = async (wolf: string) => {
		setThreadError(null);
		const r = await openFeatureThread(wolf, id);
		if (r.ok) router.push(threadHref(wolf, r.data.id));
		else setThreadError(r.message);
	};
	return <WorkItemView id={id} state={state} onOpenTask={(taskId) => router.push(workHref(taskId))} onOpenThread={openThread} threadError={threadError} />;
}

const LABEL = "font-mono text-[11px] uppercase tracking-wide text-muted-foreground";

/** Presentational half (SSR-testable). */
export function WorkItemView({ id, state, onOpenTask, onOpenThread, threadError }: { id: string; state: WorkPageState; onOpenTask?: (id: string) => void; onOpenThread?: (wolf: string) => void; threadError?: string | null }) {
	const item = state.kind === "ready" ? state.item : null;
	return (
		<div className="flex h-dvh flex-col" data-testid="work-item-page" data-work={id} data-state={state.kind}>
			<TopBar>
				<h1 className="min-w-0 truncate font-title text-3xl tracking-tight">{item?.title ?? id}</h1>
			</TopBar>
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto max-w-3xl px-6 py-8">
					{state.kind === "loading" && <p className="text-sm text-muted-foreground">Loading…</p>}
					{state.kind === "unavailable" && (
						<p className="text-sm text-muted-foreground" role="status">
							No wolf is online to serve this work item.
						</p>
					)}
					{state.kind === "not_found" && (
						<p className="text-sm text-muted-foreground" role="status">
							No work item <code className="font-mono">{id}</code>.
						</p>
					)}
					{state.kind === "error" && (
						<p className="text-sm text-destructive" role="alert">
							Could not load this work item: {state.message}
						</p>
					)}
					{state.kind === "ready" && <WorkBody item={state.item} parent={state.parent} onOpenTask={onOpenTask} threadWolves={state.threadWolves} onOpenThread={onOpenThread} threadError={threadError} />}
				</div>
			</div>
		</div>
	);
}

function WorkBody({ item, parent, onOpenTask, threadWolves = [], onOpenThread, threadError }: { item: WorkRecordResponse; parent: WorkRecordResponse | null; onOpenTask?: (id: string) => void; threadWolves?: string[]; onOpenThread?: (wolf: string) => void; threadError?: string | null }) {
	const record = workRecordView(item, parent);
	const doc = composeItemDocument(item, { record: record.markdown, inheritedFrom: record.fromParent });
	const graph = item.kind === "feature" ? buildTaskGraph(item, item) : null;
	const deps = item.dependsOn ?? [];
	return (
		<article>
			<WorkBadges kind={item.kind} stage={item.stage} domain={item.domain} className="mb-4" />
			{item.kind === "feature" && !item.container && threadWolves.length > 0 && <OpenThread wolves={threadWolves} onOpen={onOpenThread} error={threadError} />}
			<dl className="mb-6 flex flex-wrap gap-x-6 gap-y-2 text-sm">
				{item.partOf && (
					<div data-fact="parent">
						<dt className={LABEL}>part of</dt>
						<dd>
							<Link href={workHref(item.partOf)} className="underline underline-offset-2">
								{parent?.title ?? item.partOf}
							</Link>
						</dd>
					</div>
				)}
				{deps.length > 0 && (
					<div data-fact="dependsOn">
						<dt className={LABEL}>depends on</dt>
						<dd className="flex flex-wrap gap-x-3">
							{deps.map((d) => (
								<Link key={d} href={workHref(d)} className="underline underline-offset-2">
									{d}
								</Link>
							))}
						</dd>
					</div>
				)}
			</dl>
			{graph?.kind === "graph" && graph.nodes.length > 0 && (
				<section className="mb-8" data-section="tasks">
					<h2 className={`${LABEL} mb-2 flex justify-between`}>
						<span>Tasks</span>
						<span data-testid="task-graph-progress">{graph.label}</span>
					</h2>
					<TaskGraph model={graph} onSelect={(taskId) => onOpenTask?.(taskId)} />
				</section>
			)}
			<section data-section="document">
				{doc ? (
					<KbMarkdown density="normal">{doc}</KbMarkdown>
				) : (
					<p className="text-sm text-muted-foreground">Nothing written yet.</p>
				)}
			</section>
		</article>
	);
}



/** "Open thread": a thread on a wolf bound to this feature (one wolf: a button; several: a button per wolf). */
function OpenThread({ wolves, onOpen, error }: { wolves: string[]; onOpen?: (wolf: string) => void; error?: string | null }) {
	return (
		<div className="mb-4 flex flex-wrap items-center gap-2" data-testid="open-feature-thread">
			{wolves.map((w) => (
				<button
					key={w}
					type="button"
					data-wolf={w}
					onClick={() => onOpen?.(w)}
					className="rounded-md border border-border px-3 py-1 text-sm hover:bg-accent"
				>
					{wolves.length > 1 ? `Open thread on ${w}` : "Open thread"}
				</button>
			))}
			{error && (
				<span className="text-sm text-destructive" role="alert">
					{error}
				</span>
			)}
		</div>
	);
}
