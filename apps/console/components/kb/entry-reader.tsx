"use client";

/** A KB entry PAGE (/kb/entry/[id]): breadcrumb, frontmatter facts, body with live wikilinks, related + backlinks. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronRightIcon } from "lucide-react";
import { isDictationActive } from "@/components/composer/dictation";
import { hasInAppHistory } from "@/components/shell/nav-tracker";
import { KbMarkdown } from "@/components/kb/kb-markdown";
import { fetchKbEntry, type KbResult } from "@/components/kb/kb-client";
import { TopBar } from "@/components/shell/top-bar";
import {
	entryBreadcrumb,
	entryFacts,
	entryHref,
	focusHref,
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

/** An in-app KB link: `/kb/entry/<id>` is kind kb, `/kb/work/<id>` is kind work; anything else is null. */
function viewFromHref(href: string | null): { kind: "kb" | "work"; id: string } | null {
	const m = /^\/kb\/(entry|work)\/([^/?#]+)$/.exec(href ?? "");
	if (!m) return null;
	try {
		return { kind: m[1] === "entry" ? "kb" : "work", id: decodeURIComponent(m[2]!) };
	} catch {
		return null;
	}
}

/**
 * `chrome="none"` hosts the entry in the viewer shell: no top bar. EntryReader never handles Esc (only EntryReaderPage does).
 * `onOpenView` takes over plain clicks on links to other entries / work items; modified or non-primary clicks and external links behave as usual.
 */
export function EntryReader({ id, chrome = "full", onTitle, onOpenView }: { id: string; chrome?: "full" | "none"; onTitle?: (title: string) => void; onOpenView?: (view: { kind: "kb" | "work"; id: string }) => void }) {
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

	const state: EntryReaderState = fetched?.id === id ? fetched.state : { kind: "loading" };
	const title = state.kind === "ready" ? state.entry.title : null;
	const titleRef = useRef(onTitle);
	titleRef.current = onTitle;
	useEffect(() => {
		if (title) titleRef.current?.(title);
	}, [title]);
	const view = <EntryReaderView id={id} state={state} chrome={chrome} />;
	if (!onOpenView) return view;
	return (
		<div
			className="contents"
			onClick={(e) => {
				if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
				const a = (e.target as Element | null)?.closest?.("a");
				const target = viewFromHref(a?.getAttribute("href") ?? null);
				if (!target) return;
				e.preventDefault();
				onOpenView(target);
			}}
		>
			{view}
		</div>
	);
}

/**
 * The entry as a standalone PAGE (/kb/entry/[id]); the graph is not mounted behind it. Esc returns to the page it
 * was opened from when that was in-app (graph, /kb-activity), else to "/". The browser Back button does the same natively.
 */
/** Whether this keydown is an Esc that should leave the entry page (pure; the listener calls it). */
export function shouldGoBackOnEscape(
	e: Pick<KeyboardEvent, "key" | "defaultPrevented" | "metaKey" | "ctrlKey" | "altKey" | "isComposing" | "target">,
	doc: Pick<Document, "querySelector">,
	dictationActive: boolean,
): boolean {
	if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return false;
	if (e.metaKey || e.ctrlKey || e.altKey) return false;
	// Dictation owns this Esc (it cancels the capture); never also navigate.
	if (dictationActive) return false;
	const t = e.target as Element | null;
	if (t && typeof t.closest === "function" && (t.closest("[contenteditable]") || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return false;
	// A dialog or popover above the page owns this Esc.
	if (doc.querySelector('[role="dialog"],[role="alertdialog"],[aria-modal="true"]')) return false;
	return true;
}

export function EntryReaderPage({ id }: { id: string }) {
	const router = useRouter();
	const back = useCallback(() => {
		if (hasInAppHistory()) router.back();
		else router.push("/");
	}, [router]);
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (shouldGoBackOnEscape(e, document, isDictationActive())) {
				e.preventDefault();
				back();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [back]);
	return <EntryReader id={id} />;
}

/** Presentational half (SSR-testable). */
export function EntryReaderView({ id, state, chrome = "full" }: { id: string; state: EntryReaderState; chrome?: "full" | "none" }) {
	const entry = state.kind === "ready" ? state.entry : null;
	return (
		<div className={chrome === "none" ? "flex flex-col" : "flex h-dvh flex-col"} data-testid="entry-reader" data-entry={id} data-state={state.kind}>
			{chrome !== "none" && <TopBar>
				<h1 className="min-w-0 truncate font-title text-3xl tracking-tight">{entry?.title ?? id}</h1>
				<Link href={focusHref(`ent:${id}`)} className="ml-auto flex shrink-0 items-center text-xs text-muted-foreground underline underline-offset-2 max-md:min-h-11 max-md:min-w-11 max-md:justify-center" data-testid="entry-open-in-graph">
					Open in graph
				</Link>
			</TopBar>}
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
