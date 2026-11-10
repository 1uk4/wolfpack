"use client";

/**
 * THE WORK VIEW: a read-only, full-bleed overlay over the domain's work, repurposed from the original chain table.
 * Initiative groups hold feature rows, which hold task rows, all collapsed to begin with; indentation carries the
 * structure. Dependencies among siblings are lanes in a narrow left gutter (one SVG per group, work-connectors.ts):
 * a line down from the prerequisite ending in an elbow arrow at the dependent; a dependency outside the parent is a
 * "↖ title" note on the row. Rows have a fixed height so the lanes align. A row's title is a chip styled by stage. Columns: Name, Status (stage + progress), Created,
 * Open; the first three sort on click (chevron on the active one); the fuzzy search expands matching groups.
 *
 * Data: the injected `WorkClient` (default: console → wolfd → the Work API), fetched when the view opens, on window
 * focus and on a light poll while open. The domain is remembered in localStorage and starts on wolfpack.
 * It is its own page (/work, app/work/page.tsx), full-bleed, with no graph behind it. A row click opens the item in the
 * reader panel (work-reader.tsx) through `?item=<id>`; the list underneath stays mounted, so closing the reader
 * returns to it with its scroll, filters and domain intact.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, ChevronUpIcon, PanelRightOpenIcon, SearchIcon } from "lucide-react";
import { TopBar } from "@/components/top-bar";
import { useWorkReader } from "./work-reader";
import { MenuShell } from "@/components/menu-shell";
import { WolfpackMark } from "@/components/wolfpack-mark";
import {
	DEFAULT_WORK_SORT,
	LANE_COLOR,
	NOTE_H,
	NO_GRADUATE,
	WORK_ROW_H,
	buildWorkTable,
	groupConnectors,
	laneKey,
	lanePath,
	laneState,
	INBOX_KEY,
	moveOptions,
	nextWorkSort,
	rowHeight,
	rowTops,
	type Chip,
	type MoveOption,
	type TableRow,
	type WorkListItem,
	type WorkSort,
	type WorkSortCol,
} from "@/src/core";
import { createWorkClient, type WorkClient, type WorkDomain } from "./work-client";
import { createGraduateClient, type GraduateClient } from "./graduate-client";
import { GraduateControl } from "./graduate-dialog";
import { useGraduated } from "./graduation-signal";

export const WORK_DOMAIN_KEY = "wolfpack:work-view-domain";
export const DEFAULT_WORK_DOMAIN = "wolfpack";
export const WORK_POLL_MS = 30_000;
/** How long the move notification (with its Undo) stays. */
export const WORK_UNDO_MS = 8000;

/** The one move notification. `undo` reverses the move; `from` is the assignee to give back after a handoff. */
interface MoveToast {
	/** Which notification this is; a late undo only writes to the one it started from. */
	id: number;
	kind: "moved" | "undone" | "error";
	text: string;
	undo?: { id: string; prev: string | null; from: string | null };
	busy?: boolean;
}

function readDomain(): string {
	try {
		return localStorage.getItem(WORK_DOMAIN_KEY) || DEFAULT_WORK_DOMAIN;
	} catch {
		return DEFAULT_WORK_DOMAIN;
	}
}

// ---- Data ------------------------------------------------------------------

type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; items: WorkListItem[] };

/** Fetches the domain's items; refetches on focus, on a poll and on `reload`, keeping the last good list while it does. */
function useWorkItems(client: WorkClient, domain: string): { load: Load; reload: () => Promise<boolean> } {
	const [load, setLoad] = useState<Load>({ state: "loading" });
	const seq = useRef(0);
	const refresh = useCallback(async (): Promise<boolean> => {
		const mine = ++seq.current;
		// Always with the graduated ones: an initiative is ready when its features all graduated; the table hides them unless the toggle is on.
		const res = await client.list(domain, true);
		if (mine !== seq.current) return true; // a newer request (another domain, the toggle) owns the answer
		if (res.ok) setLoad({ state: "ready", items: res.data.items });
		else setLoad((cur) => (cur.state === "ready" ? cur : { state: "error", message: res.message }));
		return res.ok;
	}, [client, domain]);
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
	return { load, reload: () => refresh() };
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

/** The row's title chip (truncates before the stage column). */
function RowTitle({ row }: { row: TableRow }) {
	return (
		<span className="block min-w-0 truncate text-[13px] leading-tight">
			<ChipView chip={row.self!} testid={`work-chip-${row.id}`} />
		</span>
	);
}

/** The row's own link line: a "↖ title" per dependency outside its parent; wraps nowhere, truncates when long. */
function RowLinks({ row }: { row: TableRow }) {
	return (
		<div data-testid={`work-links-${row.key}`} style={{ height: NOTE_H }} className="flex min-w-0 items-center gap-x-2 overflow-hidden text-[11px] text-muted-foreground">
			{row.notes.map((n) => (
				<span key={n.id} data-testid={`work-note-${row.id}-${n.id}`} title={`Depends on ${n.title}`} className="min-w-0 max-w-48 shrink truncate">
					↖ {n.title}
				</span>
			))}
		</div>
	);
}

const COLS = {
	assignee: "w-24 shrink-0 md:w-32",
	status: "w-24 shrink-0 md:w-56",
	created: "w-24 shrink-0 max-md:hidden",
	open: "flex w-6 shrink-0 justify-end md:w-16",
};
const INDENT_PX = [8, 20, 32] as const;

interface RowCtx {
	expanded: ReadonlySet<string>;
	onToggle: (key: string) => void;
	onSelect: (id: string) => void;
	/** The item the reader shows (its row is marked). */
	openId: string | null;
	/** The group's gutter width (px), added to the indent of the rows below the group row. */
	gutter: number;
	/** The graduation seam: each feature row's control reads and drives its job through it. */
	graduate: GraduateClient;
	/** The owner's assignee control (absent: assignees show as plain text). */
	assign?: { wolves: readonly string[]; wolvesError: string | null; busy: ReadonlySet<string>; errors: ReadonlyMap<string, string>; onAssign: (id: string, wolf: string) => void };
	/** The owner's move controls (absent: no drag, no menu). Drag and the menu both end in `onMove`. */
	move?: {
		options: (id: string) => MoveOption[];
		busy: ReadonlySet<string>;
		messages: ReadonlyMap<string, MoveMsg>;
		dragId: string | null;
		onDragStart: (id: string) => void;
		onDragEnd: () => void;
		onMove: (id: string, to: string | null) => void;
	};
}

/** A row's move message; a handoff note goes once the list has been read again after the one that set it (`until` = the list count then). */
interface MoveMsg {
	kind: "error" | "handoff";
	text: string;
	until?: number;
}

/** The option a drop on this row would pick for the dragged item: a feature/initiative row by id, the Inbox group for the inbox option. */
function dropOption(row: TableRow, ctx: RowCtx): MoveOption | null {
	const m = ctx.move;
	if (!m || m.dragId === null || m.dragId === row.id) return null;
	const opts = m.options(m.dragId);
	return (row.key === INBOX_KEY ? opts.find((o) => o.inbox) : opts.find((o) => !o.inbox && o.to === row.id)) ?? null;
}

/** A failed assignee change, on its own line under the title. */
function AssignError({ row, ctx }: { row: TableRow; ctx: RowCtx }) {
	const a = ctx.assign;
	const error = a && row.id && row.assignable ? a.errors.get(row.id) : undefined;
	if (error === undefined) return null;
	return (
		<span data-testid={`work-assignee-error-${row.key}`} role="alert" className="block truncate text-[11px] leading-4 text-destructive" title={error}>
			{error}
		</span>
	);
}

/** The move message, on its own line under the title. */
function MoveMessage({ row, ctx }: { row: TableRow; ctx: RowCtx }) {
	const msg = row.id ? ctx.move?.messages.get(row.id) : undefined;
	if (!msg) return null;
	return (
		<span data-testid={`work-move-msg-${row.key}`} data-kind={msg.kind} role={msg.kind === "error" ? "alert" : "status"} className={`block truncate text-[11px] leading-4 ${msg.kind === "error" ? "text-destructive" : "text-emerald-500"}`} title={msg.text}>
			{msg.text}
		</span>
	);
}

/** The assignee column: wolf icon + name (muted "—" when none). On an assignable row it is a button opening a menu of the other wolves; elsewhere it is static. */
function AssigneeCell({ row, ctx }: { row: TableRow; ctx: RowCtx }) {
	const a = ctx.assign;
	const [open, setOpen] = useState(false);
	const btn = useRef<HTMLButtonElement>(null);
	const close = useCallback(() => setOpen(false), []);
	// Escape and a pointer-down outside the button and the (portaled) menu close it; Escape hands focus back to the button.
	useEffect(() => {
		if (!open) return;
		const down = (e: PointerEvent) => {
			const t = e.target as Node;
			if (btn.current?.contains(t) || (t as Element).closest?.(`[data-testid="work-assignee-menu-${row.key}"]`)) return;
			close();
			btn.current?.focus();
		};
		const key = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.stopPropagation();
			close();
			btn.current?.focus();
		};
		document.addEventListener("pointerdown", down);
		// Capture phase, so stopPropagation keeps an open reader or dialog from also closing on this Escape.
		document.addEventListener("keydown", key, true);
		return () => {
			document.removeEventListener("pointerdown", down);
			document.removeEventListener("keydown", key, true);
		};
	}, [open, close, row.key]);
	const face = row.assignee ? (
		<>
			<span className="inline-flex size-3 shrink-0">
				<WolfpackMark className="size-full" />
			</span>
			<span className="truncate">{row.assignee}</span>
		</>
	) : (
		<span aria-label="unassigned">—</span>
	);
	if (!a || !row.assignable || !row.id) {
		return (
			<span data-testid={`work-assignee-${row.key}`} className={`${COLS.assignee} flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground`}>
				{face}
			</span>
		);
	}
	const id = row.id;
	const others = a.wolves.filter((w) => w !== row.assignee);
	return (
		<span className={`${COLS.assignee} flex min-w-0 items-center`} onClick={(e) => e.stopPropagation()}>
			<button
				ref={btn}
				type="button"
				data-testid={`work-assignee-${row.key}`}
				aria-haspopup="menu"
				aria-expanded={open}
				aria-label={`Assignee of ${row.title}: ${row.assignee || "none"}`}
				disabled={a.busy.has(id)}
				onClick={() => setOpen((o) => !o)}
				className="flex min-w-0 max-w-full items-center gap-1 rounded px-1 py-0.5 text-[11px] text-primary hover:bg-accent hover:text-primary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:text-muted-foreground disabled:opacity-50"
			>
				{face}
				<ChevronDownIcon data-testid={`work-assignee-chevron-${row.key}`} aria-hidden className="size-3 shrink-0" />
			</button>
			{open && (
				<MenuShell anchorRef={btn} testid={`work-assignee-menu-${row.key}`} preferredSide="down" align="left" menuClass="flex w-48 flex-col gap-0.5 rounded-xl border bg-card p-1.5 text-xs shadow-xl">
					<span role="menu" className="flex flex-col gap-0.5">
						{a.wolvesError !== null ? (
							<span role="alert" className="px-2 py-1 text-destructive">
								can't load wolves: {a.wolvesError}
							</span>
						) : (
							others.map((w) => (
								<button
									key={w}
									type="button"
									role="menuitem"
									data-testid={`work-assignee-option-${row.key}-${w}`}
									onClick={() => {
										close();
										btn.current?.focus();
										a.onAssign(id, w);
									}}
									className="flex items-center gap-2 rounded-lg px-2 py-1 text-left hover:bg-muted focus:bg-muted focus:outline-none"
								>
									<span className="inline-flex size-3 shrink-0">
										<WolfpackMark className="size-full" />
									</span>
									<span className="truncate">{w}</span>
								</button>
							))
						)}
					</span>
				</MenuShell>
			)}
		</span>
	);
}

/** A row shows its children when it has some and is open (by hand or by search). */
function isOpenRow(row: TableRow, ctx: Pick<RowCtx, "expanded">): boolean {
	return row.children.length > 0 && (row.autoExpand || ctx.expanded.has(row.key));
}

function RowView({ row, ctx }: { row: TableRow; ctx: RowCtx }) {
	const { onToggle, onSelect } = ctx;
	const hasKids = row.children.length > 0;
	const open = isOpenRow(row, ctx);
	// A tap on a row with children expands/collapses it (the chevron's job); a row without children opens the reader.
	const activate = (): void => {
		if (hasKids) onToggle(row.key);
		else if (row.id) onSelect(row.id);
	};
	const mv = ctx.move;
	const target = dropOption(row, ctx);
	const draggable = !!mv && !!row.id && !mv.busy.has(row.id) && mv.options(row.id).length > 0;
	return (
		<>
			<div
				data-testid={`work-row-${row.key}`}
				data-kind={row.kind}
				data-graduated={row.graduated || undefined}
				data-selected={ctx.openId === row.id || undefined}
				data-drop-target={target ? true : undefined}
				draggable={draggable || undefined}
				onDragStart={draggable ? (e) => {
					e.stopPropagation();
					e.dataTransfer?.setData?.("text/plain", row.id);
					mv!.onDragStart(row.id);
				} : undefined}
				onDragEnd={draggable ? () => mv!.onDragEnd() : undefined}
				onDragOver={target ? (e) => { e.preventDefault(); e.stopPropagation(); } : undefined}
				onDrop={target ? (e) => {
					e.preventDefault();
					e.stopPropagation();
					const id = mv!.dragId!;
					mv!.onDragEnd();
					mv!.onMove(id, target.to);
				} : undefined}
				onClick={hasKids || row.id ? activate : undefined}
				onKeyDown={(e) => {
					if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
					e.preventDefault();
					activate();
				}}
				tabIndex={hasKids || row.id ? 0 : undefined}
				aria-expanded={hasKids ? open : undefined}
				style={{ height: rowHeight(row), paddingLeft: INDENT_PX[row.depth] + (row.depth > 0 ? ctx.gutter : 0) }}
				className={`flex flex-col pr-2 md:pr-3 ${row.graduated ? "opacity-50" : ""} ${ctx.openId === row.id ? "bg-accent" : ""} ${target ? "bg-primary/15 outline outline-1 outline-primary" : ""} ${row.id ? "cursor-pointer hover:bg-accent/40" : ""}`}
			>
				<div style={{ height: WORK_ROW_H }} className="flex shrink-0 items-center gap-1">
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
					<span className="min-w-0 flex-1">
						{row.kind === "initiative" ? (
							<span className={`block truncate text-sm font-medium ${row.id ? "" : "text-muted-foreground"}`}>{row.title}</span>
						) : (
							<RowTitle row={row} />
						)}
						<MoveMessage row={row} ctx={ctx} />
						<AssignError row={row} ctx={ctx} />
					</span>
					{/* Only a ready feature (or one with a job in flight) shows the button; why a feature is not ready is the stage cell's tooltip. */}
					<span className="inline-flex shrink-0" onClick={(e) => e.stopPropagation()}>
					<GraduateControl target={{ id: row.id, title: row.title, assignee: row.assignee || undefined }} state={row.graduate.show && row.graduate.ready ? row.graduate : NO_GRADUATE} client={ctx.graduate} testid={`work-graduate-${row.key}`} />
					</span>
					<AssigneeCell row={row} ctx={ctx} />
					<span className={`${COLS.status} flex min-w-0 flex-col md:flex-row md:items-center md:gap-2`}>
						<span
							data-testid={`work-stage-${row.key}`}
							title={row.graduate.show && !row.graduate.ready ? `${row.stageLabel} (not ready to graduate: ${row.graduate.reason})` : row.stageLabel}
							className="truncate text-xs text-muted-foreground"
						>
							{row.stageLabel}
						</span>
						{row.progress && (
							<span data-testid={`work-progress-${row.key}`} className="shrink-0 whitespace-nowrap text-[11px] tabular-nums text-muted-foreground/80">
								{row.progress.label}
							</span>
						)}
					</span>
					<span className={`${COLS.created} text-right text-xs tabular-nums text-muted-foreground`}>{row.created}</span>
					<span className={COLS.open}>
{row.id && (
						<button
							type="button"
							data-testid={`work-open-${row.key}`}
							aria-label={`Open ${row.title}`}
							title="Open"
							onClick={(e) => {
								e.stopPropagation();
								onSelect(row.id);
							}}
							className="flex size-6 shrink-0 items-center justify-center gap-1 rounded-md border border-border/70 text-[11px] text-muted-foreground transition-colors hover:text-foreground md:w-auto md:px-1.5"
						>
							<PanelRightOpenIcon className="size-3.5" />
							<span className="max-md:hidden">Open</span>
						</button>
					)}
</span>
				</div>
				{row.notes.length > 0 && (
					<div className="min-w-0 pl-[1.125rem]">
						<RowLinks row={row} />
					</div>
				)}
			</div>
			{open && row.children.map((c) => <RowView key={c.key} row={c} ctx={ctx} />)}
		</>
	);
}

/** One group: its rows plus the gutter SVG with the group's dependency lanes (none while the group is collapsed). */
function GroupView({ group, ctx }: { group: TableRow; ctx: RowCtx }) {
	const gc = groupConnectors(group, (r) => isOpenRow(r, ctx));
	const tops = rowTops(gc.rows);
	const states = gc.edges.map((e) => laneState(e, null));
	// Muted lanes first, lit ones last, so a lit lane is never painted over by a shared trunk.
	const order = gc.edges.map((_, i) => i).sort((a, b) => ["done", "plain", "lit"].indexOf(states[a]!) - ["done", "plain", "lit"].indexOf(states[b]!));
	return (
		<div data-testid={`work-group-${group.key}`} className="relative border-b border-border/60">
			{gc.width > 0 && (
				<svg
					data-testid={`work-lanes-${group.key}`}
					data-lanes={gc.lanes}
					width={gc.width}
					height={tops[tops.length - 1]! + rowHeight(gc.rows[gc.rows.length - 1]!)}
					aria-hidden="true"
					className="pointer-events-none absolute left-0 top-0"
				>
					{order.map((i) => {
						const e = gc.edges[i]!;
						const st = states[i]!;
						const p = lanePath(e, gc.lanes, tops);
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
	{ col: "stage", label: "Status", cls: COLS.status },
	{ col: "created", label: "Created", cls: `${COLS.created} justify-end` },
];

export function WorkList({ client: injected, graduate: injectedGraduate, undoMs = WORK_UNDO_MS }: { client?: WorkClient; graduate?: GraduateClient; undoMs?: number }) {
	const { open: openItem, itemId } = useWorkReader();
	const client = useMemo(() => injected ?? createWorkClient(), [injected]);
	const [domain, setDomainState] = useState(readDomain);
	const [domains, setDomains] = useState<WorkDomain[]>([]);
	const [showGraduated, setShowGraduated] = useState(false);
	const [query, setQuery] = useState("");
	const [sort, setSort] = useState<WorkSort>(DEFAULT_WORK_SORT);
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
	const { load, reload } = useWorkItems(client, domain);
	const [wolves, setWolves] = useState<string[]>([]);
	const [wolvesError, setWolvesError] = useState<string | null>(null);
	const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
	const [assignErrors, setAssignErrors] = useState<ReadonlyMap<string, string>>(() => new Map());
	const [busyMove, setBusyMove] = useState<ReadonlySet<string>>(() => new Set());
	const [moveMsgs, setMoveMsgs] = useState<ReadonlyMap<string, MoveMsg>>(() => new Map());
	const [toast, setToast] = useState<MoveToast | null>(null);
	const toastSeq = useRef(0);
	const undoing = useRef<number | null>(null);
	const loads = useRef(0);
	const [dragId, setDragId] = useState<string | null>(null);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const graduateClient = useMemo(() => injectedGraduate ?? createGraduateClient(), [injectedGraduate]);

	useEffect(() => {
		let cancelled = false;
		void client.domains().then((d) => {
			if (!cancelled) setDomains(d);
		});
		return () => {
			cancelled = true;
		};
	}, [client]);
	useEffect(() => {
		let cancelled = false;
		void client.assignees?.().then((res) => {
			if (cancelled) return;
			if (res.ok) {
				setWolves(res.data);
				setWolvesError(null);
			} else setWolvesError(res.message);
		});
		return () => {
			cancelled = true;
		};
	}, [client]);
	// No optimistic update: the hub answers, then the list is read again.
	const onAssign = async (id: string, wolf: string): Promise<void> => {
		if (!client.assign) return;
		const setErr = (message: string | null) =>
			setAssignErrors((prev) => {
				const next = new Map(prev);
				if (message === null) next.delete(id);
				else next.set(id, message);
				return next;
			});
		setBusy((prev) => new Set(prev).add(id));
		try {
			const res = await client.assign(id, wolf);
			if (!mounted.current) return;
			if (!res.ok) setErr(res.message);
			else {
				const fresh = await reload();
				if (mounted.current) setErr(fresh ? null : "assigned, but the list couldn't refresh");
			}
		} catch (err) {
			if (mounted.current) setErr(err instanceof Error ? err.message : "assign failed");
		} finally {
			if (mounted.current)
				setBusy((prev) => {
					const next = new Set(prev);
					next.delete(id);
					return next;
				});
		}
	};

	// Drag and the menu share this one path; no optimistic update: the hub answers, then the list is read again. An error stays until the next move of that row; a handoff note until the second list read after it.
	const onMove = async (id: string, to: string | null): Promise<void> => {
		if (!client.move || busyMove.has(id)) return;
		const say = (m: MoveMsg | null) =>
			setMoveMsgs((prev) => {
				const next = new Map(prev);
				if (m === null) next.delete(id);
				else next.set(id, m);
				return next;
			});
		// The parent before the move, from the loaded items (not the row label). Undo is offered only when it is known and still exists.
		const before = items?.find((x) => x.id === id);
		const prevParent = before && (before.partOf !== undefined || before.kind === "feature") ? (before.partOf ?? null) : undefined;
		// Read from this render's items, before the move changes them.
		const prevOk = prevParent !== undefined && (prevParent === null || !!items?.some((x) => x.id === prevParent));
		setBusyMove((prev) => new Set(prev).add(id));
		say(null);
		try {
			const res = await client.move(id, to);
			if (!mounted.current) return;
			if (!res.ok) say({ kind: "error", text: res.message });
			else {
				const handoff = res.data.reassigned?.find((r) => r.id === id);
				const target = items?.find((x) => x.id === to);
				const parent = target?.title ?? to;
				const where = to === null ? "no initiative" : target?.container ? "Inbox" : String(parent);
				setToast({
					id: ++toastSeq.current,
					kind: "moved",
					text: `Moved ${before?.title ?? id} to ${where}${handoff ? ` and assigned to ${handoff.to}` : ""}`,
					...(prevOk ? { undo: { id, prev: prevParent as string | null, from: handoff?.from ?? null } } : {}),
				});
				if (handoff) say({ kind: "handoff", text: `Moved under ${parent}; now assigned to ${handoff.to}`, until: loads.current + 1 });
				const fresh = await reload();
				if (!mounted.current) return;
				if (!fresh) say({ kind: "error", text: "moved, but the list couldn't refresh" });
			}
		} catch (err) {
			if (mounted.current) say({ kind: "error", text: err instanceof Error ? err.message : "move failed" });
		} finally {
			if (mounted.current)
				setBusyMove((prev) => {
					const next = new Set(prev);
					next.delete(id);
					return next;
				});
		}
	};

	// Undo: move back with the same client path (no new notification), then give the old assignee back unless the move-back already did.
	const onUndo = async (): Promise<void> => {
		const u = toast?.undo;
		if (!toast || !u || !client.move || toast.busy) return;
		// A synchronous guard: a second click before the re-render must not send a second undo.
		if (undoing.current === toast.id) return;
		undoing.current = toast.id;
		const tid = toast.id;
		// Writes only while this toast is still the current one (a newer move replaces it).
		const put = (t: Omit<MoveToast, "id">) => {
			if (mounted.current && toastSeq.current === tid) setToast({ ...t, id: tid });
		};
		put({ ...toast, busy: true });
		const fail = (text: string, keepUndo: boolean) => put({ kind: "error", text, ...(keepUndo ? { undo: u } : {}) });
		try {
			const res = await client.move(u.id, u.prev);
			if (!mounted.current) return;
			if (!res.ok) return fail(res.message, true);
			const back = res.data.reassigned?.find((r) => r.id === u.id);
			if (u.from !== null && client.assign && back?.to !== u.from) {
				const a = await client.assign(u.id, u.from);
				if (!a.ok) {
					await reload();
					return fail(`moved back, but couldn't restore the assignee: ${a.message}`, false);
				}
			}
			await reload();
			put({ kind: "undone", text: "Move undone" });
		} catch (err) {
			fail(err instanceof Error ? err.message : "undo failed", true);
		} finally {
			if (undoing.current === tid) undoing.current = null;
		}
	};
	// The notification (an error too, with its Undo) goes after `undoMs`, unless an undo is running.
	useEffect(() => {
		if (!toast || toast.busy) return;
		const t = setTimeout(() => setToast(null), undoMs);
		return () => clearTimeout(t);
	}, [toast, undoMs]);

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
	// Each new list: end a drag whose row went away (no dragend reaches an unmounted row), and age out handoff notes.
	useEffect(() => {
		loads.current++;
		setDragId(null);
		setMoveMsgs((prev) => {
			if (![...prev.values()].some((m) => m.until !== undefined && m.until < loads.current)) return prev;
			return new Map([...prev].filter(([, m]) => m.until === undefined || m.until >= loads.current));
		});
	}, [items]);
	useEffect(() => {
		const end = () => setDragId(null);
		window.addEventListener("dragend", end);
		window.addEventListener("drop", end);
		return () => {
			window.removeEventListener("dragend", end);
			window.removeEventListener("drop", end);
		};
	}, []);
	const table = useMemo(() => (items ? buildWorkTable(items, { showGraduated, query, sort }) : null), [items, showGraduated, query, sort]);
	const ctx: RowCtx = { expanded, onToggle: toggle, onSelect: openItem, gutter: 0, graduate: graduateClient, openId: itemId, ...(client.move && items ? { move: { options: (id: string) => moveOptions(items, id), busy: busyMove, messages: moveMsgs, dragId, onDragStart: setDragId, onDragEnd: () => setDragId(null), onMove: (id: string, to: string | null) => void onMove(id, to) } } : {}), ...(client.assign ? { assign: { wolves, wolvesError, busy, errors: assignErrors, onAssign: (id: string, wolf: string) => void onAssign(id, wolf) } } : {}) };
	const options = domains.some((d) => d.name === domain) ? domains : [{ name: domain, label: domain }, ...domains];
	const chevron = (col: WorkSortCol) => (sort.col !== col ? null : sort.dir === 1 ? <ChevronUpIcon className="size-3" /> : <ChevronDownIcon className="size-3" />);

	// A direct child of AppShell's <main>: on phones globals.css sizes `main > .h-dvh` to main, under the shell's safe-area inset.
	return (
		<div data-testid="work-view" className="flex h-dvh min-h-0 flex-col bg-background">
			<div className="flex h-full min-h-0 flex-1 flex-col">
					<TopBar>
						<span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
							{table ? (
								<>
									{table.count}
									<span className="max-md:hidden"> {table.count === 1 ? "item" : "items"}</span>
								</>
							) : null}
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
						<div className="relative min-w-0 flex-1 md:flex-none">
							<SearchIcon className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
							<input
								data-testid="work-search"
								value={query}
								onChange={(e) => setQuery(e.target.value)}
								placeholder="Search work…"
								aria-label="Search work"
								spellCheck={false}
								className={`h-8 rounded-lg border bg-background pl-8 pr-2 text-xs outline-none placeholder:text-muted-foreground focus:border-ring w-full min-w-0 md:w-56`}
							/>
						</div>
					</TopBar>
					<div className="min-h-0 flex-1 overflow-y-auto">
						<div className="sticky top-0 z-10 flex items-center gap-1 border-b border-border/60 bg-background/80 px-3 py-1.5 text-[11px] uppercase tracking-widest text-muted-foreground/70 backdrop-blur">
							{HEADERS.map((h) => (
								<Fragment key={h.col}>
									{h.col === "stage" && (
										<span data-testid="work-header-assignee" className={COLS.assignee}>
											Assignee
										</span>
									)}
									<button
										type="button"
										data-testid={`work-sort-${h.col}`}
										aria-sort={sort.col === h.col ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
										onClick={() => setSort((cur) => nextWorkSort(cur, h.col))}
										className={`flex items-center gap-1 text-left transition-colors hover:text-foreground ${h.cls}`}
									>
										{h.label} {chevron(h.col)}
									</button>
								</Fragment>
							))}
							<span aria-hidden className={COLS.open} />
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
				</div>
			{toast && (
				<div data-testid="work-move-toast" data-kind={toast.kind} role={toast.kind === "error" ? "alert" : "status"} className="fixed bottom-4 left-1/2 z-50 flex max-w-[90vw] -translate-x-1/2 items-center gap-3 rounded-lg border bg-popover px-3 py-2 text-xs shadow-lg">
					<span data-testid="work-move-toast-msg" className={`min-w-0 truncate ${toast.kind === "error" ? "text-destructive" : ""}`} title={toast.text}>
						{toast.text}
					</span>
					{toast.undo && (
						<button type="button" data-testid="work-move-undo" disabled={toast.busy} onClick={() => void onUndo()} className="shrink-0 rounded border px-2 py-0.5 font-medium hover:bg-accent disabled:opacity-50">
							Undo
						</button>
					)}
				</div>
			)}
		</div>
	);
}
