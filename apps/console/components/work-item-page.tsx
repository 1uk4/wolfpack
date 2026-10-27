"use client";

/** A work item page body (/kb/work/[id]): header facts, links to parent / dependencies, plan and Record. */
import { useEffect, useState } from "react";
import Link from "next/link";
import { KbMarkdown } from "@/components/kb-markdown";
import { fetchWolves, fetchWorkRecord } from "@/components/kb-client";
import { TopBar } from "@/components/top-bar";
import { useLibrarian } from "@/components/use-librarian";
import { resolveWork, workHref, workRecordView, workWolfCandidates, type WorkRecordResponse } from "@/src/core";

export type WorkPageState =
	| { kind: "loading" }
	| { kind: "unavailable" }
	| { kind: "not_found" }
	| { kind: "error"; message: string }
	| { kind: "ready"; item: WorkRecordResponse; parent: WorkRecordResponse | null };

export function WorkItemPage({ id }: { id: string }) {
	const { librarian, loading } = useLibrarian();
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
			done({ kind: "ready", item, parent });
		})();
		return () => {
			cancelled = true;
		};
	}, [librarian, loading, id]);

	const state: WorkPageState = fetched?.id === id && !loading ? fetched.state : { kind: "loading" };
	return <WorkItemView id={id} state={state} />;
}

const LABEL = "font-mono text-[11px] uppercase tracking-wide text-muted-foreground";

/** Presentational half (SSR-testable). */
export function WorkItemView({ id, state }: { id: string; state: WorkPageState }) {
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
					{state.kind === "ready" && <WorkBody item={state.item} parent={state.parent} />}
				</div>
			</div>
		</div>
	);
}

function WorkBody({ item, parent }: { item: WorkRecordResponse; parent: WorkRecordResponse | null }) {
	const record = workRecordView(item, parent);
	const deps = item.dependsOn ?? [];
	return (
		<article>
			<dl className="mb-6 flex flex-wrap gap-x-6 gap-y-2 text-sm">
				<Fact name="kind" value={item.kind} />
				<Fact name="stage" value={item.stage} />
				{item.domain && <Fact name="domain" value={item.domain} />}
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
			{item.plan.trim() && (
				<section className="mb-8" data-section="plan">
					<h2 className={`${LABEL} mb-2`}>Plan</h2>
					<div className="text-sm">
						<KbMarkdown>{item.plan}</KbMarkdown>
					</div>
				</section>
			)}
			<section data-section="record">
				<h2 className={`${LABEL} mb-2`}>
					{record.fromParent ? (
						<>
							Record (from parent feature{" "}
							<Link href={workHref(record.fromParent.id)} className="underline underline-offset-2">
								{record.fromParent.title}
							</Link>
							)
						</>
					) : (
						"Record"
					)}
				</h2>
				{record.markdown ? (
					<div className="text-sm">
						<KbMarkdown>{record.markdown}</KbMarkdown>
					</div>
				) : (
					<p className="text-sm text-muted-foreground">No Record yet.</p>
				)}
			</section>
		</article>
	);
}

function Fact({ name, value }: { name: string; value: string }) {
	return (
		<div data-fact={name}>
			<dt className={LABEL}>{name}</dt>
			<dd>{value}</dd>
		</div>
	);
}
