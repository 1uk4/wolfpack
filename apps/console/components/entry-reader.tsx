"use client";

/** A KB entry page body (/kb/entry/[id]): breadcrumb, frontmatter facts, body with live wikilinks, related + backlinks. */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronRightIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { hasInAppHistory } from "@/components/nav-tracker";
import { KbMarkdown } from "@/components/kb-markdown";
import { fetchKbEntry, type KbResult } from "@/components/kb-client";
import { TopBar } from "@/components/top-bar";
import {
	entryBreadcrumb,
	entryFacts,
	entryHref,
	entryRelated,
	groupBacklinks,
	rewriteWikilinks,
	type KbEntryDetail,
} from "@/src/core";

export type EntryReaderState =
	| { kind: "loading" }
	| { kind: "unavailable" }
	| { kind: "not_found" }
	| { kind: "error"; message: string }
	| { kind: "ready"; entry: KbEntryDetail };

export function entryReaderState(res: KbResult<KbEntryDetail>): EntryReaderState {
	if (res.ok) return { kind: "ready", entry: res.data };
	if (res.reason === "unavailable") return { kind: "unavailable" };
	if (res.reason === "not_found") return { kind: "not_found" };
	return { kind: "error", message: res.message };
}

export interface ReaderOverlayProps {
	onClose: () => void;
}

export function EntryReader({ id, overlay }: { id: string; overlay?: ReaderOverlayProps }) {
	const [fetched, setFetched] = useState<{ id: string; state: EntryReaderState } | null>(null);

	useEffect(() => {
		let cancelled = false;
		void fetchKbEntry(id).then((res) => {
			if (!cancelled) setFetched({ id, state: entryReaderState(res) });
		});
		return () => {
			cancelled = true;
		};
	}, [id]);

	let state: EntryReaderState;
	state = fetched?.id === id ? fetched.state : { kind: "loading" };
	return <EntryReaderView id={id} state={state} overlay={overlay} />;
}

/**
 * The reader as an OVERLAY (the /kb/entry/[id] route): drawn over the graph, which stays mounted behind it. Esc / X
 * remove only the reader (Back, or "/" on a deep link). Esc is claimed in the capture phase so nothing else also acts.
 */
export function EntryReaderOverlay({ id }: { id: string }) {
	const router = useRouter();
	// Closing returns to the page it was opened from (Back) when it was opened in-app, else to "/".
	const close = useCallback(() => {
		if (hasInAppHistory()) router.back();
		else router.push("/");
	}, [router]);
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			e.stopPropagation();
			close();
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [close]);
	return <EntryReader id={id} overlay={{ onClose: close }} />;
}

/** Presentational half (SSR-testable). */
export function EntryReaderView({ id, state, overlay }: { id: string; state: EntryReaderState; overlay?: ReaderOverlayProps }) {
	const entry = state.kind === "ready" ? state.entry : null;
	return (
		<div
			className={overlay ? "fixed inset-y-0 right-0 z-[60] flex w-[min(52rem,70vw)] flex-col border-l bg-background max-md:inset-0 max-md:h-dvh max-md:w-full max-md:border-l-0" : "flex h-dvh flex-col"}
			role={overlay ? "dialog" : undefined}
			aria-label={overlay ? "Entry reader" : undefined}
			data-testid="entry-reader"
			data-entry={id}
			data-state={state.kind}
		>
			<TopBar>
				<h1 className="min-w-0 truncate font-title text-3xl tracking-tight">{entry?.title ?? id}</h1>
				{overlay && (
					<Button size="icon-xs" variant="ghost" className="ml-auto shrink-0 max-md:size-11" aria-label="Close" data-testid="entry-reader-close" onClick={overlay.onClose}>
						<XIcon />
					</Button>
				)}
			</TopBar>
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto max-w-3xl px-6 py-8">
					{state.kind === "loading" && <p className="text-sm text-muted-foreground">Loading…</p>}
					{state.kind === "unavailable" && (
						<p className="text-sm text-muted-foreground" role="status">
							The knowledge base is unavailable: no wolf can read it right now.
						</p>
					)}
					{state.kind === "not_found" && (
						<p className="text-sm text-muted-foreground" role="status">
							No entry <code className="font-mono">{id}</code> in the knowledge base.
						</p>
					)}
					{state.kind === "error" && (
						<p className="text-sm text-destructive" role="alert">
							Could not load this entry: {state.message}
						</p>
					)}
					{entry && <EntryBody entry={entry} />}
				</div>
			</div>
		</div>
	);
}

const LABEL = "font-mono text-[11px] uppercase tracking-wide text-muted-foreground";

export function EntryBody({ entry }: { entry: KbEntryDetail }) {
	const crumbs = entryBreadcrumb(entry);
	const facts = entryFacts(entry.frontmatter);
	const related = entryRelated(entry.frontmatter);
	const backlinks = groupBacklinks(entry.backlinks);
	const body = useMemo(() => rewriteWikilinks(entry.body, entry.wikilinks), [entry.body, entry.wikilinks]);
	return (
		<article>
			<nav aria-label="Breadcrumb" className="mb-3 flex items-center gap-1 font-mono text-xs text-muted-foreground">
				{crumbs.map((c, i) => (
					<span key={`${c.kind}:${c.label}`} className="flex items-center gap-1" data-crumb={c.kind}>
						{i > 0 && <ChevronRightIcon className="size-3" aria-hidden />}
						{c.label}
					</span>
				))}
			</nav>
			{facts.length > 0 && (
				<dl className="mb-6 flex flex-wrap gap-x-6 gap-y-2 text-sm">
					{facts.map((f) => (
						<div key={f.key} data-fact={f.key}>
							<dt className={LABEL}>{f.key}</dt>
							<dd>{f.value}</dd>
						</div>
					))}
				</dl>
			)}
			<div className="text-sm">
				<KbMarkdown>{body}</KbMarkdown>
			</div>
			{related.length > 0 && (
				<section className="mt-8 border-t border-border pt-4" data-section="related">
					<h2 className={`${LABEL} mb-2`}>Related</h2>
					<ul className="space-y-1 text-sm">
						{related.map((r) => (
							<li key={`${r.target}:${r.relation}`}>
								<Link href={entryHref(r.target)} className="underline underline-offset-2">
									{r.target}
								</Link>
								<span className="ml-2 font-mono text-xs text-muted-foreground">{r.relation}</span>
							</li>
						))}
					</ul>
				</section>
			)}
			{backlinks.length > 0 && (
				<section className="mt-8 border-t border-border pt-4" data-section="backlinks">
					<h2 className={`${LABEL} mb-2`}>Backlinks</h2>
					{backlinks.map((g) => (
						<div key={g.via} className="mb-3" data-via={g.via}>
							<h3 className="mb-1 font-mono text-xs text-muted-foreground">via {g.via}</h3>
							<ul className="space-y-1 text-sm">
								{g.items.map((b) => (
									<li key={`${b.id}:${b.relation ?? ""}`}>
										<Link href={entryHref(b.id)} className="underline underline-offset-2">
											{b.title}
										</Link>
										{b.relation && <span className="ml-2 font-mono text-xs text-muted-foreground">{b.relation}</span>}
									</li>
								))}
							</ul>
						</div>
					))}
				</section>
			)}
		</article>
	);
}
