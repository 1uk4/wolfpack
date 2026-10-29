"use client";

/**
 * The graph's docked side pane: the detail view of the selected node (it
 * replaced the floating node card). Docked to the right edge of the graph
 * screen, resizable by dragging its left edge (width remembered per device),
 * closed with Esc / the close button / deselecting.
 *
 * The facts come instantly from the graph payload (the NodeCard); the rest is
 * fetched lazily when the shown node changes, through a small cache:
 *   work   GET /api/wolves/:wolf/work/:id/record  (plan, Record, log, children,
 *          success criteria) — the same lookup the work page does
 *   entry  GET /api/wolves/:librarian/kb/entries/:id — rendered by the entry
 *          reader's body
 *   other  nothing to fetch; a summary from the card
 * The route stepper sits in the pane unchanged (graph-route-nav.tsx); the
 * pane's content follows the cursor's node because the view hands it that
 * node's card.
 */
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { XIcon } from "lucide-react";
import type { KbEntryDetail, NodeCard, WorkRecordResponse } from "@/src/core";
import {
	GRAPH_PANE_WIDTH_KEY,
	PaneCache,
	clampPaneWidth,
	featureGraduateState,
	featureThreadWolves,
	findKbSource,
	findLibrarian,
	paneWork,
	parsePaneWidth,
	resolveWork,
	stageLabel,
	threadHref,
	workWolfCandidates,
	type PaneWork,
} from "@/src/core";
import { KbMarkdown } from "@/components/kb-markdown";
import { fetchKbEntry, fetchWolves, fetchWorkRecord, openFeatureThread } from "@/components/kb-client";
import { EntryBody } from "@/components/entry-reader";
import { Field, KIND_LABEL, LinkList } from "./graph-card.tsx";
import { createGraduateClient, type GraduateClient } from "./graduate-client";
import { GraduateControl } from "./graduate-dialog";
import { useGraduated } from "./graduation-signal";
import { RouteNav, isEditableTarget, type RouteNavModel } from "./graph-route-nav.tsx";

// ---- Data ------------------------------------------------------------------

type Wolves = { name: string; status: string; librarian?: boolean }[];

export type PaneData =
	| { kind: "none" }
	| { kind: "loading" }
	| { kind: "error"; message: string }
	| { kind: "work"; item: WorkRecordResponse; work: PaneWork; threadWolves: string[] }
	| { kind: "entry"; entry: KbEntryDetail };

const dataCache = new PaneCache<PaneData>();
const wolvesCache = new PaneCache<Wolves>(1);

/** Test hook: forget everything fetched so far. */
export function clearPaneCache(): void {
	dataCache.clear();
	wolvesCache.clear();
}

async function loadWolves(): Promise<Wolves> {
	const hit = wolvesCache.get("wolves");
	if (hit) return hit;
	const res = await fetchWolves();
	const wolves = res.ok ? res.data.wolves : [];
	if (res.ok) wolvesCache.set("wolves", wolves);
	return wolves;
}

async function loadPaneData(card: NodeCard): Promise<PaneData> {
	const wolves = await loadWolves();
	const librarian = findLibrarian(wolves)?.name ?? null;
	if (card.kind === "work") {
		const id = card.id.slice("work:".length);
		const hit = await resolveWork(workWolfCandidates(librarian, wolves), id, fetchWorkRecord);
		if (hit.kind === "none") return { kind: "error", message: "No wolf is online to serve this work item." };
		if (!hit.result.ok) return { kind: "error", message: hit.result.reason === "not_found" ? "No such work item." : hit.result.message };
		const item = hit.result.data;
		return { kind: "work", item, work: paneWork(item), threadWolves: item.kind === "feature" && !item.container ? featureThreadWolves(wolves) : [] };
	}
	if (card.kind === "entry") {
		const source = findKbSource(wolves)?.name;
		if (!source) return { kind: "error", message: "The knowledge base is unavailable: no wolf can read it right now." };
		const res = await fetchKbEntry(source, card.id.slice("ent:".length));
		if (!res.ok) return { kind: "error", message: res.reason === "not_found" ? "No such entry." : res.message };
		return { kind: "entry", entry: res.data };
	}
	return { kind: "none" };
}

/** Fetch the node's detail lazily; the cached answer shows at once, the node's facts never wait. */
export function usePaneData(card: NodeCard): PaneData {
	const fetchable = card.kind === "work" || card.kind === "entry";
	const [fetched, setFetched] = useState<{ id: string; data: PaneData } | null>(null);
	// A graduation changes what the pane showed (the feature is archived now): forget it and read again.
	const [reads, setReads] = useState(0);
	useGraduated(() => {
		dataCache.clear();
		setFetched(null);
		setReads((n) => n + 1);
	});
	useEffect(() => {
		if (!fetchable || dataCache.get(card.id)) return;
		let cancelled = false;
		void loadPaneData(card).then((data) => {
			if (data.kind !== "error") dataCache.set(card.id, data);
			if (!cancelled) setFetched({ id: card.id, data });
		});
		return () => {
			cancelled = true;
		};
	}, [card.id, fetchable, reads]);
	if (!fetchable) return { kind: "none" };
	return dataCache.get(card.id) ?? (fetched?.id === card.id ? fetched.data : { kind: "loading" });
}

// ---- Width -----------------------------------------------------------------

function usePaneWidth(): [number, (w: number, persist?: boolean) => void] {
	const [width, setWidth] = useState(() => {
		try {
			return clampPaneWidth(parsePaneWidth(localStorage.getItem(GRAPH_PANE_WIDTH_KEY)), window.innerWidth);
		} catch {
			return parsePaneWidth(null);
		}
	});
	const set = (w: number, persist = false) => {
		const next = clampPaneWidth(w, typeof window === "undefined" ? undefined : window.innerWidth);
		setWidth(next);
		if (persist) {
			try {
				localStorage.setItem(GRAPH_PANE_WIDTH_KEY, String(next));
			} catch {
				// storage blocked: the width just isn't remembered
			}
		}
	};
	return [width, set];
}

// ---- View ------------------------------------------------------------------

const SECTION = "mt-4 border-t pt-3";
const HEADING = "mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground";
const BTN = "rounded-lg border px-3 py-1 text-xs font-medium transition-colors hover:bg-accent";

function WorkSections({ data, onSelectNode }: { data: Extract<PaneData, { kind: "work" }>; onSelectNode: (id: string) => void }) {
	const { work } = data;
	return (
		<>
			{work.successCriteria && (
				<section className={SECTION} data-section="success-criteria">
					<div className={HEADING}>Done when</div>
					<div className="text-sm">
						<KbMarkdown>{work.successCriteria}</KbMarkdown>
					</div>
				</section>
			)}
			{work.document && (
				<section className={SECTION} data-section="document">
					<div className={HEADING}>Document</div>
					<div className="text-sm">
						<KbMarkdown>{work.document}</KbMarkdown>
					</div>
				</section>
			)}
			{work.record && (
				<section className={SECTION} data-section="record">
					<div className={HEADING}>Record</div>
					<div className="text-sm">
						<KbMarkdown>{work.record}</KbMarkdown>
					</div>
				</section>
			)}
			{work.log.length > 0 && (
				<section className={SECTION} data-section="log">
					<div className={HEADING}>Recent log</div>
					<ul className="flex flex-col gap-1 text-xs text-muted-foreground">
						{work.log.map((l, i) => (
							<li key={`${i}:${l}`} data-log-entry>
								<KbMarkdown>{l}</KbMarkdown>
							</li>
						))}
					</ul>
				</section>
			)}
			{work.tasks.length > 0 && (
				<section className={SECTION} data-section="tasks">
					<div className={HEADING}>Tasks{work.truncated ? " (first 200)" : ""}</div>
					<div className="flex flex-col gap-0.5">
						{work.tasks.map((t) => (
							<button
								key={t.id}
								type="button"
								data-task={t.id}
								onClick={() => onSelectNode(`work:${t.id}`)}
								className="flex min-w-0 items-baseline gap-2 rounded-md px-2 py-1 text-left text-sm transition-colors hover:bg-accent"
							>
								<span className="min-w-0 flex-1 truncate">{t.title || t.id}</span>
								<span className="shrink-0 text-[11px] text-muted-foreground">{t.stage.replace(/_/g, " ")}</span>
							</button>
						))}
					</div>
				</section>
			)}
		</>
	);
}

export function GraphPane({
	card,
	routeNav,
	onClose,
	onFocus,
	onSelectNode,
	onNavigate,
	onLayout,
	graduate,
}: {
	/** The node whose details show (the route cursor's node while a route is selected). */
	card: NodeCard;
	routeNav?: RouteNavModel | null;
	onClose: () => void;
	onFocus: (ids: string[]) => void;
	onSelectNode: (id: string) => void;
	/** Go to an app path (the opened thread). */
	onNavigate: (href: string) => void;
	/** The pane opened or changed width: the canvas beside it just resized. */
	onLayout?: () => void;
	/** The graduation seam (default: the console routes); tests inject a fake. */
	graduate?: GraduateClient;
}) {
	const [width, setWidth] = usePaneWidth();
	const graduateClient = useMemo(() => graduate ?? createGraduateClient(), [graduate]);
	const data = usePaneData(card);
	const [threadError, setThreadError] = useState<string | null>(null);
	const [threadBusy, setThreadBusy] = useState(false);

	const onLayoutRef = useRef(onLayout);
	onLayoutRef.current = onLayout;
	useEffect(() => {
		onLayoutRef.current?.();
	}, [width]);
	useEffect(() => setThreadError(null), [card.id]);

	// Esc closes (not while typing — Esc belongs to the field then).
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape" || e.defaultPrevented || isEditableTarget(e.target)) return;
			e.preventDefault();
			onCloseRef.current();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, []);

	const startResize = (e: React.PointerEvent) => {
		e.preventDefault();
		const startX = e.clientX;
		const startW = width;
		let latest = startW;
		const move = (ev: Event) => {
			latest = clampPaneWidth(startW + (startX - (ev as PointerEvent).clientX), window.innerWidth);
			setWidth(latest);
		};
		const up = () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			window.removeEventListener("pointercancel", up);
			setWidth(latest, true);
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
		window.addEventListener("pointercancel", up);
	};

	const openThread = async (wolf: string) => {
		setThreadError(null);
		setThreadBusy(true);
		const r = await openFeatureThread(wolf, card.id.slice("work:".length));
		setThreadBusy(false);
		if (r.ok) onNavigate(threadHref(wolf, r.data.id));
		else setThreadError(r.message);
	};

	const threadWolves = data.kind === "work" ? data.threadWolves : [];
	// A feature's tasks come with its record; without them (older server) a shipped feature counts as ready.
	const graduateState =
		data.kind === "work"
			? featureGraduateState({ kind: data.item.kind, stage: data.item.stage, container: data.item.container }, data.item.children ? data.item.children.filter((c) => c.kind !== "feature") : null)
			: featureGraduateState({ kind: "", stage: "" }, null);
	return (
		<aside
			data-testid="graph-pane"
			data-kind={card.kind}
			data-node={card.id}
			style={{ width }}
			className="lh-no-drag relative flex h-full shrink-0 flex-col border-l bg-card text-left"
		>
			<div
				role="separator"
				aria-orientation="vertical"
				aria-label="Resize pane"
				data-testid="pane-resize"
				onPointerDown={startResize}
				className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none transition-colors hover:bg-ring/40"
			/>
			<div className="flex items-start gap-2 border-b px-4 py-3">
				<div className="min-w-0 flex-1">
					<div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{KIND_LABEL[card.kind]}</div>
					<div className="mt-0.5 text-sm font-medium leading-snug" data-testid="pane-title">
						{card.title}
					</div>
				</div>
				<button type="button" aria-label="Close" data-testid="pane-close" onClick={onClose} className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
					<XIcon className="size-4" />
				</button>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-4 py-3" data-testid="pane-body">
				{card.summary && <div className="text-xs leading-relaxed text-muted-foreground">{card.summary}</div>}
				<div className={`${card.summary ? "mt-3 " : ""}flex flex-col gap-1`}>
					{card.domain && card.kind !== "domain" && <Field label="Domain">{card.domain.label}</Field>}
					{card.section && <Field label="Section">{card.section.label}</Field>}
					{card.entryKind && <Field label="Kind">{card.entryKind}</Field>}
					{card.maturity && <Field label="Maturity">{card.maturity}</Field>}
					{card.stage && <Field label="Stage">{stageLabel(card.stage, card.workKind)}</Field>}
					{card.workKind && <Field label="Type">{card.workKind}</Field>}
					{card.assignee && <Field label="Assignee">{card.assignee}</Field>}
					{card.wolf && <Field label="Wolf">{card.wolf}</Field>}
					{card.promotable !== undefined && <Field label="Promotable">{card.promotable ? "yes" : "private"}</Field>}
					{card.updated && <Field label="Updated">{card.updated}</Field>}
					{card.counts &&
						Object.entries(card.counts).map(([kind, n]) => (
							<Field key={kind} label={KIND_LABEL[kind as NodeCard["kind"]] ?? kind}>
								{n}
							</Field>
						))}
					{card.stageCounts &&
						Object.entries(card.stageCounts).map(([stage, n]) => (
							<Field key={stage} label={stage.replace(/_/g, " ")}>
								{n}
							</Field>
						))}
				</div>

				{(card.openHref || card.focusIds) && (
					<div className="mt-3 flex flex-wrap items-center gap-2">
						{card.openHref && (
							<Link href={card.openHref} className={BTN} data-testid="pane-open">
								Open page
							</Link>
						)}
						{threadWolves.map((w) => (
							<button key={w} type="button" data-testid="pane-open-thread" data-wolf={w} disabled={threadBusy} onClick={() => void openThread(w)} className={`${BTN} disabled:opacity-40`}>
								{threadWolves.length > 1 ? `Open thread on ${w}` : "Open thread"}
							</button>
						))}
						{card.focusIds && (
							<button type="button" onClick={() => onFocus(card.focusIds!)} className={BTN}>
								Focus
							</button>
						)}
					</div>
				)}
				{card.kind === "work" && (
					<div className="mt-3 empty:hidden">
						<GraduateControl key={card.id} target={{ id: card.id.slice("work:".length), title: card.title, assignee: card.assignee }} state={graduateState} client={graduateClient} showReason testid="pane-graduate" />
					</div>
				)}
				{threadError && (
					<div className="mt-2 text-xs text-destructive" role="alert">
						{threadError}
					</div>
				)}

				{routeNav && <RouteNav nav={routeNav} />}

				{card.parent && <LinkList title="Part of" links={[card.parent]} onSelectNode={onSelectNode} />}
				<LinkList title="Depends on" links={card.dependencies} onSelectNode={onSelectNode} />

				{data.kind === "loading" && (
					<p className={`${SECTION} text-xs text-muted-foreground`} data-testid="pane-loading">
						Loading…
					</p>
				)}
				{data.kind === "error" && (
					<p className={`${SECTION} text-xs text-muted-foreground`} role="status" data-testid="pane-error">
						{data.message}
					</p>
				)}
				{data.kind === "work" && <WorkSections data={data} onSelectNode={onSelectNode} />}
				{data.kind === "entry" && (
					<div className={`${SECTION} text-sm`} data-section="entry">
						<EntryBody entry={data.entry} />
					</div>
				)}
			</div>
		</aside>
	);
}
