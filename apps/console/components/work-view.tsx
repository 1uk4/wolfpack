"use client";

/**
 * THE WORK VIEW: a read-only, full-bleed overlay over the domain's work, repurposed from learnharness's chain table.
 * Initiative groups hold feature rows, which hold task rows, all collapsed to begin with; indentation carries the
 * structure. Dependencies among siblings are lanes in a narrow left gutter (one SVG per group, work-connectors.ts):
 * a line down from the prerequisite ending in an elbow arrow at the dependent; a dependency outside the parent is a
 * "↖ title" note on the row. Rows have a fixed height so the lanes align. A row's title is a chip styled by stage. Columns: Name, Stage, Progress,
 * Assignee, Created; all sort on click (chevron on the active one); the fuzzy search expands matching groups.
 *
 * Data: the injected `WorkClient` (default: console → wolfd → the Work API), fetched when the view opens, on window
 * focus and on a light poll while open. The domain is remembered in localStorage and starts on wolfpack.
 * `WorkViewProvider` mounts the one overlay; the graph header's Work button and the sidebar's Work entry both open it.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDownIcon, ChevronRightIcon, ChevronUpIcon, SearchIcon } from "lucide-react";
import { OverlayShell } from "@/components/overlay-shell";
import { TopBar } from "@/components/top-bar";
import { WorkViewContext, useWorkView, type WorkSelection } from "./work-view-entry";
import {
	DEFAULT_WORK_SORT,
	WORK_COL_WIDTH_KEY,
	ancestorKeys,
	LANE_COLOR,
	WORK_ROW_H,
	buildWorkTable,
	clampPaneWidth,
	groupConnectors,
	laneKey,
	lanePath,
	laneState,
	nextWorkSort,
	parseWorkColWidth,
	rowRouteState,
	type Chip,
	type WorkRouteView,
	type TableRow,
	type WorkListItem,
	type WorkSort,
	type WorkSortCol,
} from "@/src/core";
import { createWorkClient, type WorkClient, type WorkDomain } from "./work-client";
import { createGraduateClient, type GraduateClient } from "./graduate-client";
import { GraduateButton, GraduateDialog, type GraduateTarget } from "./graduate-dialog";
import { useGraduated } from "./graduation-signal";

export const WORK_DOMAIN_KEY = "wolfpack:work-view-domain";
export const DEFAULT_WORK_DOMAIN = "wolfpack";
export const WORK_POLL_MS = 30_000;

function readDomain(): string {
	try {
		return localStorage.getItem(WORK_DOMAIN_KEY) || DEFAULT_WORK_DOMAIN;
	} catch {
		return DEFAULT_WORK_DOMAIN;
	}
}

export function WorkViewProvider({ children, client, graduate, onSelect }: { children: ReactNode; client?: WorkClient; graduate?: GraduateClient; onSelect?: (id: string) => void }) {
	const [isOpen, setOpen] = useState(false);
	const [selection, setSelection] = useState<WorkSelection | null>(null);
	const [routeView, setRouteView] = useState<WorkRouteView | null>(null);
	const [colWidth, setColWidthState] = useState(() => {
		try {
			return parseWorkColWidth(localStorage.getItem(WORK_COL_WIDTH_KEY), window.innerWidth);
		} catch {
			return parseWorkColWidth(null);
		}
	});
	const open = useCallback(() => setOpen(true), []);
	const close = useCallback(() => {
		setOpen(false);
		setSelection(null);
	}, []);
	const onSelectRef = useRef(onSelect);
	onSelectRef.current = onSelect;
	const select = useCallback((id: string) => {
		setSelection((cur) => ({ id, seq: (cur?.seq ?? 0) + 1 }));
		onSelectRef.current?.(id);
	}, []);
	const clearSelection = useCallback(() => setSelection(null), []);
	// The graph republishes on every render of its selection; keep the old object when nothing changed.
	const publishRoute = useCallback(
		(view: WorkRouteView | null) => setRouteView((cur) => (JSON.stringify(cur) === JSON.stringify(view) ? cur : view)),
		[],
	);
	const setColWidth = useCallback((w: number, persist = false) => {
		const next = clampPaneWidth(w, typeof window === "undefined" ? undefined : window.innerWidth);
		setColWidthState(next);
		if (persist) {
			try {
				localStorage.setItem(WORK_COL_WIDTH_KEY, String(next));
			} catch {
				// storage blocked: the width just isn't remembered
			}
		}
	}, []);
	const api = useMemo(
		() => ({ open, close, isOpen, selection: isOpen ? selection : null, select, clearSelection, routeView, publishRoute, colWidth, setColWidth }),
		[open, close, isOpen, selection, select, clearSelection, routeView, publishRoute, colWidth, setColWidth],
	);
	// The overlay is the LAST child: the TopBar's drag region must not be punched through by later no-drag elements.
	return (
		<WorkViewContext.Provider value={api}>
			{children}
			{isOpen && <WorkOverlay client={client} graduate={graduate} onClose={close} />}
		</WorkViewContext.Provider>
	);
}

// ---- Data ------------------------------------------------------------------

type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; items: WorkListItem[] };

/** Fetches the domain's items; refetches on focus, on a poll and on `reload`, keeping the last good list while it does. */
function useWorkItems(client: WorkClient, domain: string, graduated: boolean): { load: Load; reload: () => void } {
	const [load, setLoad] = useState<Load>({ state: "loading" });
	const seq = useRef(0);
	const refresh = useCallback(async () => {
		const mine = ++seq.current;
		const res = await client.list(domain, graduated);
		if (mine !== seq.current) return; // a newer request (another domain, the toggle) owns the answer
		if (res.ok) setLoad({ state: "ready", items: res.data.items });
		else setLoad((cur) => (cur.state === "ready" ? cur : { state: "error", message: res.message }));
	}, [client, domain, graduated]);
	useEffect(() => {
		setLoad((cur) => (cur.state === "ready" ? cur : { state: "loading" }));
		void refresh();
		const onFocus = () => void refresh();
		window.addEventListener("focus", onFocus);
		const poll = setInterval(() => void refresh(), WORK_POLL_MS);
		return () => {
			seq.current++;
			window.removeEventListener("focus", onFocus);
			clearInterval(poll);
		};
	}, [refresh]);
	// A graduation elsewhere (this view's own dialog, the graph pane) changes the list: read it again now.
	useGraduated(() => void refresh());
	return { load, reload: () => void refresh() };
}

// ---- View ------------------------------------------------------------------

const CHIP_CLASS: Record<Chip["state"], string> = {
	ready: "border-emerald-400/80 ring-2 ring-emerald-400/70",
	blocked: "border-dashed border-amber-400/80 ring-1 ring-amber-400/50",
	shipped: "border-border/50 text-muted-foreground/60",
	building: "border-sky-500/60",
	plain: "border-border/70",
};

function ChipView({ chip, testid }: { chip: Chip; testid: string }) {
	return (
		<span data-testid={testid} data-chip-state={chip.state} className={`rounded border bg-muted/30 px-1.5 py-0.5 ${CHIP_CLASS[chip.state]}`}>
			{chip.title}
		</span>
	);
}

/** The row's title chip, with a "↖ title" note per dependency outside its parent. */
function RowTitle({ row }: { row: TableRow }) {
	return (
		<span className="flex min-w-0 items-center gap-2 text-[13px] leading-tight">
			<span className="min-w-0 truncate">
				<ChipView chip={row.self!} testid={`work-chip-${row.id}`} />
			</span>
			{row.notes.map((n) => (
				<span key={n.id} data-testid={`work-note-${row.id}-${n.id}`} title={`Depends on ${n.title}`} className="max-w-48 shrink-0 truncate text-[11px] text-muted-foreground">
					↖ {n.title}
				</span>
			))}
		</span>
	);
}

const COLS = {
	stage: "w-48 shrink-0",
	progress: "w-28 shrink-0",
	assignee: "w-24 shrink-0",
	created: "w-24 shrink-0",
};
const INDENT_PX = [12, 40, 72] as const;

interface RowCtx {
	expanded: ReadonlySet<string>;
	onToggle: (key: string) => void;
	onSelect: (id: string) => void;
	/** The graph's selected route (split view), null in the full-screen table. */
	view: WorkRouteView | null;
	/** The split's narrow column: only Name and Stage (plus the step number). */
	compact: boolean;
	/** The group's gutter width (px), added to the indent of the rows below the group row. */
	gutter: number;
	/** The Graduate button of a feature row was clicked. */
	onGraduate: (row: TableRow) => void;
}

/** A row shows its children when it has some, is not a collapsed-route stand-in, and is open (by hand or by search). */
function isOpenRow(row: TableRow, ctx: Pick<RowCtx, "expanded" | "view">): boolean {
	const stood = row.id && ctx.view ? ctx.view.collapsed[row.id] : undefined;
	return row.children.length > 0 && stood === undefined && (row.autoExpand || ctx.expanded.has(row.key));
}

function RowView({ row, ctx }: { row: TableRow; ctx: RowCtx }) {
	const { onToggle, onSelect, view, compact } = ctx;
	const rr = rowRouteState(view, row.id);
	// A collapsed done feature is one row standing in for N route tasks ("+N"); expanding it on the map opens it here too.
	const stood = row.id && view ? view.collapsed[row.id] : undefined;
	const hasKids = row.children.length > 0 && stood === undefined;
	const open = isOpenRow(row, ctx);
	const lit = rr.mode === "on";
	return (
		<>
			<div
				data-testid={`work-row-${row.key}`}
				data-kind={row.kind}
				data-graduated={row.graduated || undefined}
				data-route={rr.mode === "none" ? undefined : rr.mode}
				data-step={rr.mode !== "none" && rr.step !== null ? rr.step : undefined}
				data-selected={rr.selected || undefined}
				data-cursor={view && rr.cursor ? true : undefined}
				onClick={row.id ? () => onSelect(row.id) : undefined}
				style={{ height: WORK_ROW_H, paddingLeft: INDENT_PX[row.depth] + (row.depth > 0 ? ctx.gutter : 0) }}
				className={`flex items-center gap-1 pr-3 ${row.graduated ? "opacity-50" : ""} ${rr.mode === "off" ? "opacity-35" : ""} ${lit ? "bg-emerald-500/10" : ""} ${view && rr.cursor ? "bg-accent ring-1 ring-inset ring-ring/60" : ""} ${row.id ? "cursor-pointer hover:bg-accent/40" : ""}`}
			>
				{hasKids ? (
					<button
						type="button"
						data-testid={`work-toggle-${row.key}`}
						aria-expanded={open}
						aria-label={`${open ? "Collapse" : "Expand"} ${row.title}`}
						onClick={(e) => {
							e.stopPropagation();
							onToggle(row.key);
						}}
						className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
					>
						{open ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
					</button>
				) : (
					<span className="size-3.5 shrink-0" />
				)}
				{view && (
					<span
						data-testid={`work-step-${row.key}`}
						aria-label={rr.mode !== "none" && rr.step !== null ? `Step ${rr.step}${rr.parallel ? " (parallel)" : ""}` : undefined}
						className={`w-5 shrink-0 text-center text-[11px] font-medium tabular-nums ${rr.mode === "on" ? "text-emerald-400" : "text-transparent"}`}
					>
						{rr.mode !== "none" && rr.step !== null ? rr.step : ""}
					</span>
				)}
				<span className="min-w-0 flex-1">
					{row.kind === "initiative" ? (
						<span className={`truncate text-sm font-medium ${row.id ? "" : "text-muted-foreground"}`}>{row.title}</span>
					) : (
						<RowTitle row={row} />
					)}
				</span>
				<GraduateButton state={row.graduate} testid={`work-graduate-${row.key}`} onClick={() => ctx.onGraduate(row)} />
				{stood !== undefined && (
					<span data-testid={`work-collapsed-${row.key}`} title={`${stood} shipped tasks, collapsed on the route`} className="shrink-0 rounded border border-border/70 px-1 text-[11px] tabular-nums text-muted-foreground">
						+{stood}
					</span>
				)}
				<span data-testid={`work-stage-${row.key}`} className={`${compact ? "w-32 shrink-0" : COLS.stage} truncate text-xs text-muted-foreground`}>
					{row.stageLabel}
				</span>
				{!compact && (
					<>
						<span data-testid={`work-progress-${row.key}`} className={`${COLS.progress} text-xs tabular-nums text-muted-foreground`}>
							{row.progress?.label ?? ""}
						</span>
						<span className={`${COLS.assignee} truncate text-xs text-muted-foreground`}>{row.assignee}</span>
						<span className={`${COLS.created} text-right text-xs tabular-nums text-muted-foreground`}>{row.created}</span>
					</>
				)}
			</div>
			{open && row.children.map((c) => <RowView key={c.key} row={c} ctx={ctx} />)}
		</>
	);
}

/** One group: its rows plus the gutter SVG with the group's dependency lanes (none while the group is collapsed). */
function GroupView({ group, ctx }: { group: TableRow; ctx: RowCtx }) {
	const gc = groupConnectors(group, (r) => isOpenRow(r, ctx));
	const states = gc.edges.map((e) => laneState(e, ctx.view));
	// Muted lanes first, lit ones last, so a lit lane is never painted over by a shared trunk.
	const order = gc.edges.map((_, i) => i).sort((a, b) => ["done", "plain", "lit"].indexOf(states[a]!) - ["done", "plain", "lit"].indexOf(states[b]!));
	return (
		<div data-testid={`work-group-${group.key}`} className="relative border-b border-border/60">
			{gc.width > 0 && (
				<svg
					data-testid={`work-lanes-${group.key}`}
					data-lanes={gc.lanes}
					width={gc.width}
					height={gc.rows.length * WORK_ROW_H}
					aria-hidden="true"
					className="pointer-events-none absolute left-0 top-0"
				>
					{order.map((i) => {
						const e = gc.edges[i]!;
						const st = states[i]!;
						const p = lanePath(e, gc.lanes);
						const color = LANE_COLOR[st];
						return (
							<g key={laneKey(e)} data-testid={`work-lane-${e.from}-${e.to}`} data-lane={e.lane} data-lane-state={st} stroke={color} fill="none" strokeWidth={st === "done" ? 1 : 1.5}>
								<path d={p.d} />
								<path d={p.head} fill={color} stroke="none" />
							</g>
						);
					})}
				</svg>
			)}
			<RowView row={group} ctx={{ ...ctx, gutter: gc.width }} />
		</div>
	);
}

const HEADERS: { col: WorkSortCol; label: string; cls: string }[] = [
	{ col: "name", label: "Name", cls: "flex-1 pl-[1.125rem]" },
	{ col: "stage", label: "Stage", cls: COLS.stage },
	{ col: "progress", label: "Progress", cls: COLS.progress },
	{ col: "assignee", label: "Assignee", cls: COLS.assignee },
	{ col: "created", label: "Created", cls: `${COLS.created} justify-end` },
];

export function WorkOverlay({ client: injected, graduate: injectedGraduate, onClose }: { client?: WorkClient; graduate?: GraduateClient; onClose: () => void }) {
	const { selection, select, clearSelection, routeView, colWidth, setColWidth } = useWorkView();
	const split = selection !== null;
	// In the split the graph's selection is what's lit: the table mirrors the route the graph computed.
	const view = split ? routeView : null;
	const client = useMemo(() => injected ?? createWorkClient(), [injected]);
	const [domain, setDomainState] = useState(readDomain);
	const [domains, setDomains] = useState<WorkDomain[]>([]);
	const [showGraduated, setShowGraduated] = useState(false);
	const [query, setQuery] = useState("");
	const [sort, setSort] = useState<WorkSort>(DEFAULT_WORK_SORT);
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
	const { load } = useWorkItems(client, domain, showGraduated);
	const graduateClient = useMemo(() => injectedGraduate ?? createGraduateClient(), [injectedGraduate]);
	const [graduating, setGraduating] = useState<GraduateTarget | null>(null);

	useEffect(() => {
		let cancelled = false;
		void client.domains().then((d) => {
			if (!cancelled) setDomains(d);
		});
		return () => {
			cancelled = true;
		};
	}, [client]);

	const setDomain = (next: string) => {
		setDomainState(next);
		setExpanded(new Set());
		try {
			localStorage.setItem(WORK_DOMAIN_KEY, next);
		} catch {
			// storage blocked: the domain just isn't remembered
		}
	};
	const toggle = (key: string) =>
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});

	const items = load.state === "ready" ? load.items : null;
	const table = useMemo(() => (items ? buildWorkTable(items, { showGraduated, query, sort }) : null), [items, showGraduated, query, sort]);
	const tableRef = useRef(table);
	tableRef.current = table;
	// Open the groups holding lit rows, once per route (a manual collapse stays collapsed until the route changes).
	const routeKey = view ? JSON.stringify(Object.keys(view.steps).sort()) + view.selected : "";
	useEffect(() => {
		if (!view || !tableRef.current) return;
		const ids = new Set([...Object.keys(view.steps), view.selected]);
		const keys = ancestorKeys(tableRef.current.groups, ids);
		setExpanded((prev) => (keys.every((k) => prev.has(k)) ? prev : new Set([...prev, ...keys])));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [routeKey, items === null]);
	// The pane's cursor row stays in sight as ←/→ walk the route.
	const cursorId = view ? (view.cursor ?? view.selected) : null;
	useEffect(() => {
		if (!cursorId) return;
		const el = document.querySelector(`[data-testid="work-row-${cursorId}"]`) as (HTMLElement & { scrollIntoView?: (o?: object) => void }) | null;
		el?.scrollIntoView?.({ block: "nearest" });
	}, [cursorId]);
	const ctx: RowCtx = { expanded, onToggle: toggle, onSelect: select, view, compact: split, gutter: 0, onGraduate: (r) => setGraduating({ id: r.id, title: r.title, assignee: r.assignee || undefined }) };
	const startResize = (e: React.PointerEvent) => {
		e.preventDefault();
		const startX = e.clientX;
		const startW = colWidth;
		let latest = startW;
		const move = (ev: Event) => {
			latest = clampPaneWidth(startW + ((ev as PointerEvent).clientX - startX), window.innerWidth);
			setColWidth(latest);
		};
		const up = () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			window.removeEventListener("pointercancel", up);
			setColWidth(latest, true);
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
		window.addEventListener("pointercancel", up);
	};
	const options = domains.some((d) => d.name === domain) ? domains : [{ name: domain, label: domain }, ...domains];
	const chevron = (col: WorkSortCol) => (sort.col !== col ? null : sort.dir === 1 ? <ChevronUpIcon className="size-3" /> : <ChevronDownIcon className="size-3" />);

	return (
		<OverlayShell label="Work" testId="work-view" closeTestId="work-close" onClose={split ? clearSelection : onClose} bleed column={split ? colWidth : undefined}>
			{(close) => (
				<div data-split={split || undefined} className="flex h-full min-h-0 flex-1 flex-col">
					{split && (
						<div
							role="separator"
							aria-orientation="vertical"
							aria-label="Resize Work column"
							data-testid="work-resize"
							onPointerDown={startResize}
							className="absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize touch-none transition-colors hover:bg-ring/40"
						/>
					)}
					<TopBar>
						<span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
							{table ? `${table.count} ${table.count === 1 ? "item" : "items"}` : ""}
						</span>
						<select
							data-testid="work-domain"
							aria-label="Domain"
							value={domain}
							onChange={(e) => setDomain(e.target.value)}
							className="h-8 shrink-0 rounded-lg border bg-background px-2 text-xs outline-none focus:border-ring"
						>
							{options.map((d) => (
								<option key={d.name} value={d.name}>
									{d.label || d.name}
								</option>
							))}
						</select>
						<label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
							<input type="checkbox" data-testid="work-show-graduated" checked={showGraduated} onChange={(e) => setShowGraduated(e.target.checked)} className="size-3.5 accent-primary" />
							Graduated
						</label>
						<div className="relative shrink-0">
							<SearchIcon className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
							<input
								data-testid="work-search"
								value={query}
								onChange={(e) => setQuery(e.target.value)}
								placeholder="Search work…"
								aria-label="Search work"
								spellCheck={false}
								className={`h-8 rounded-lg border bg-background pl-8 pr-3 text-xs outline-none placeholder:text-muted-foreground focus:border-ring ${split ? "w-32" : "w-56"}`}
							/>
						</div>
						{close}
					</TopBar>
					<div className="min-h-0 flex-1 overflow-y-auto">
						<div className="sticky top-0 z-10 flex items-center gap-1 border-b border-border/60 bg-background/80 px-3 py-1.5 text-[11px] uppercase tracking-widest text-muted-foreground/70 backdrop-blur">
							{(split ? HEADERS.filter((h) => h.col === "name" || h.col === "stage") : HEADERS).map((h) => (
								<button
									key={h.col}
									type="button"
									data-testid={`work-sort-${h.col}`}
									aria-sort={sort.col === h.col ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
									onClick={() => setSort((cur) => nextWorkSort(cur, h.col))}
									className={`flex items-center gap-1 text-left transition-colors hover:text-foreground ${split ? (h.col === "name" ? "flex-1 pl-[2.625rem]" : "w-32 shrink-0") : h.cls}`}
								>
									{h.label} {chevron(h.col)}
								</button>
							))}
						</div>
						{load.state === "loading" && (
							<div data-testid="work-loading" className="px-4 pt-3 text-xs text-muted-foreground">
								Loading work…
							</div>
						)}
						{load.state === "error" && (
							<div data-testid="work-error" className="px-4 pt-3 text-xs text-muted-foreground">
								Work is unavailable: {load.message}
							</div>
						)}
						{table && table.groups.length === 0 && (
							<div data-testid="work-empty" className="px-4 pt-3 text-xs text-muted-foreground">
								{query.trim() ? "No matching work." : "No work in this domain."}
							</div>
						)}
						{table?.groups.map((g) => (
							<GroupView key={g.key} group={g} ctx={ctx} />
						))}
					</div>
					{graduating && <GraduateDialog target={graduating} client={graduateClient} onClose={() => setGraduating(null)} />}
				</div>
			)}
		</OverlayShell>
	);
}
