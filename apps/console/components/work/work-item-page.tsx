"use client";

/** A work item page body (/kb/work/[id]): header facts, links to parent / dependencies, plan and Record. */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { XIcon } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { TaskGraph } from "@/components/work/task-graph";
import { KbMarkdown } from "@/components/kb/kb-markdown";
import { fetchWolves, fetchWorkRecord } from "@/components/kb/kb-client";
import { openReaderLink, useOpenWorkItem } from "@/components/work/work-reader-nav";
import { TopBar } from "@/components/shell/top-bar";
import { WorkBadges } from "@/components/work/work-badges";
import { PendingApprovalBlock } from "@/components/work/approval-request";
import { useLibrarian } from "@/components/kb/use-librarian";
import { loadThreadButtons, runThreadButton } from "@/components/work/feature-thread-actions";
import { buildTaskGraph, featureThreadWolves, resolveWork, threadButtonLabel, workHref, composeItemDocument, workRecordView, workWolfCandidates, type FeatureThreadButton, type WorkRecordResponse } from "@/src/core";

export type WorkPageState =
	| { kind: "loading" }
	| { kind: "unavailable" }
	| { kind: "not_found" }
	| { kind: "error"; message: string }
	| { kind: "ready"; item: WorkRecordResponse; parent: WorkRecordResponse | null; /** Wolves a feature thread can open on (features only). */ threadWolves?: string[]; /** Per-wolf thread state (none / open / closed); without it every wolf offers "Open thread". */ threadButtons?: FeatureThreadButton[] };

export function WorkItemPage({ id, onClose, onOpenTask, chrome, onTitle }: { id: string; /** "none" hides the page top bar (title, Full page, close) when a shell hosts the page. Default "full". */ chrome?: "full" | "none"; /** Called with the item title once loaded, and again if it changes. */ onTitle?: (title: string) => void; /** Reader-panel mode: draws a close button and fills its container. */ onClose?: () => void; /** Overrides the default navigation to the full page (the reader switches item in place). */ onOpenTask?: (id: string) => void }) {
	const { librarian, loading } = useLibrarian();
	const router = useRouter();
	const openWork = useOpenWorkItem();
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
			const threadWolves = item.kind === "feature" && w.ok ? featureThreadWolves(w.data.wolves) : [];
			const threadButtons = threadWolves.length > 0 && !item.container ? await loadThreadButtons(item.id, threadWolves) : undefined;
			done({ kind: "ready", item, parent, threadWolves, threadButtons });
		})();
		return () => {
			cancelled = true;
		};
	}, [librarian, loading, id]);

	const state: WorkPageState = fetched?.id === id && !loading ? fetched.state : { kind: "loading" };
	const [threadError, setThreadError] = useState<string | null>(null);
	const openThread = async (b: FeatureThreadButton) => {
		setThreadError(null);
		const r = await runThreadButton(b, id);
		if (r.ok) router.push(r.href);
		else setThreadError(r.message);
	};
	return <WorkItemView id={id} state={state} onOpenTask={onOpenTask ?? openWork} onOpenThread={openThread} threadError={threadError} onClose={onClose} chrome={chrome} onTitle={onTitle} />;
}

const LABEL = "font-mono text-[11px] uppercase tracking-wide text-muted-foreground";

/** Presentational half (SSR-testable). */
export function WorkItemView({ id, state, onOpenTask, onOpenThread, threadError, onClose, chrome = "full", onTitle }: { id: string; chrome?: "full" | "none"; onTitle?: (title: string) => void; onClose?: () => void; state: WorkPageState; onOpenTask?: (id: string) => void; onOpenThread?: (b: FeatureThreadButton) => void; threadError?: string | null }) {
	const item = state.kind === "ready" ? state.item : null;
	const title = item?.title;
	const titleRef = useRef(onTitle);
	titleRef.current = onTitle;
	useEffect(() => {
		if (title) titleRef.current?.(title);
	}, [title]);
	return (
		<div className={onClose ? "flex h-full min-h-0 flex-col" : "flex h-dvh flex-col"} data-testid="work-item-page" data-work={id} data-state={state.kind}>
			{chrome !== "none" && <TopBar>
				<h1 className="min-w-0 truncate font-title text-3xl tracking-tight">{item?.title ?? id}</h1>
				{onClose && (
					<Link href={workHref(id)} className="ml-auto shrink-0 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground" data-testid="work-reader-full">
						Full page
					</Link>
				)}
				{onClose && (
					<Button size="icon-xs" variant="ghost" className="shrink-0 max-md:size-11" aria-label="Close" data-testid="work-reader-close" onClick={onClose}>
						<XIcon />
					</Button>
				)}
			</TopBar>}
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
					{state.kind === "ready" && <WorkBody item={state.item} parent={state.parent} onOpenTask={onOpenTask} threadWolves={state.threadWolves} threadButtons={state.threadButtons} onOpenThread={onOpenThread} threadError={threadError} />}
				</div>
			</div>
		</div>
	);
}

function WorkBody({ item, parent, onOpenTask, threadWolves = [], threadButtons, onOpenThread, threadError }: { item: WorkRecordResponse; parent: WorkRecordResponse | null; onOpenTask?: (id: string) => void; threadWolves?: string[]; threadButtons?: FeatureThreadButton[]; onOpenThread?: (b: FeatureThreadButton) => void; threadError?: string | null }) {
	const record = workRecordView(item, parent);
	const doc = composeItemDocument(item, { record: record.markdown, inheritedFrom: record.fromParent });
	const graph = item.kind === "feature" ? buildTaskGraph(item, item) : null;
	const deps = item.dependsOn ?? [];
	return (
		<article>
			<WorkBadges kind={item.kind} stage={item.stage} domain={item.domain} className="mb-4" />
			<PendingApprovalBlock workId={item.id} />
			{item.kind === "feature" && !item.container && threadWolves.length > 0 && <OpenThread buttons={threadButtons ?? threadWolves.map((wolf): FeatureThreadButton => ({ wolf, state: "none" }))} onOpen={onOpenThread} error={threadError} />}
			<dl className="mb-6 flex flex-wrap gap-x-6 gap-y-2 text-sm">
				{item.partOf && (
					<div data-fact="parent">
						<dt className={LABEL}>part of</dt>
						<dd>
							<a href={workHref(item.partOf)} onClick={(e) => openReaderLink(e, onOpenTask, item.partOf!)} className="underline underline-offset-2">
								{parent?.title ?? item.partOf}
							</a>
						</dd>
					</div>
				)}
				{deps.length > 0 && (
					<div data-fact="dependsOn">
						<dt className={LABEL}>depends on</dt>
						<dd className="flex flex-wrap gap-x-3">
							{deps.map((d) => (
								<a key={d} href={workHref(d)} onClick={(e) => openReaderLink(e, onOpenTask, d)} className="underline underline-offset-2">
									{d}
								</a>
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
function OpenThread({ buttons, onOpen, error }: { buttons: FeatureThreadButton[]; onOpen?: (b: FeatureThreadButton) => void; error?: string | null }) {
	return (
		<div className="mb-4 flex flex-wrap items-center gap-2" data-testid="open-feature-thread">
			{buttons.map((b) => (
				<button
					key={b.wolf}
					type="button"
					data-wolf={b.wolf}
					data-thread-state={b.state}
					onClick={() => onOpen?.(b)}
					className="rounded-md border border-border px-3 py-1 text-sm hover:bg-accent"
				>
					{threadButtonLabel(b, buttons.length > 1)}
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
