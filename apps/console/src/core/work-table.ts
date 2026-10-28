/**
 * THE WORK VIEW'S ROW MODEL (pure, browser-safe, deterministic): the domain's work items from the Work API become a
 * tree of initiative groups → feature rows → task rows, each with its progress, its dependency line (premises ⟹ the
 * row) and its stage label. Sorting, the graduated toggle and the fuzzy search all happen here so the component only
 * draws. Stage text comes from the graph pane's `stageLabel`, so both surfaces say "shipped · ready to graduate" alike.
 */

import { fuzzyScore } from "./fuzzy.ts";
import { stageLabel } from "./kb-graph-model.ts";
import type { WorkListItem } from "./kb.ts";

export type WorkSortCol = "name" | "stage" | "progress" | "assignee" | "created";
export interface WorkSort {
	col: WorkSortCol;
	/** 1 = ascending (A→Z, stage order, oldest first, least done first), -1 = descending. */
	dir: 1 | -1;
}

/** Active work first (the owner's default); `created` breaks ties. */
export const DEFAULT_WORK_SORT: WorkSort = { col: "stage", dir: 1 };

/** The direction a column starts in when first clicked. */
export const firstSortDir = (col: WorkSortCol): 1 | -1 => (col === "created" || col === "progress" ? -1 : 1);

/** A header click: the active column flips its direction, another column starts in its own first direction. */
export const nextWorkSort = (cur: WorkSort, col: WorkSortCol): WorkSort =>
	cur.col === col ? { col, dir: cur.dir === 1 ? -1 : 1 } : { col, dir: firstSortDir(col) };

/** Stage order for the default sort: in build, shipped (a shipped feature reads "ready to graduate"), then the pipeline's front. */
const STAGE_ORDER = ["in_build", "shipped", "approved", "feasibility", "plan", "idea", "live", "archived"] as const;
export const stageRank = (stage: string): number => {
	const i = (STAGE_ORDER as readonly string[]).indexOf(stage);
	return i === -1 ? STAGE_ORDER.length : i;
};

const isDone = (stage: string): boolean => stage === "shipped" || stage === "live" || stage === "archived";
const isShipped = (stage: string): boolean => stage === "shipped" || stage === "live";

/** How a chip is drawn: shipped greyed, blocked ringed, ready-to-graduate with the heavy ring. */
export type ChipState = "ready" | "blocked" | "shipped" | "building" | "plain";

export interface Chip {
	id: string;
	title: string;
	stage: string;
	state: ChipState;
}

export interface ProgressCell {
	shipped: number;
	total: number;
	/** "4/9 shipped" */
	label: string;
}

export type RowKind = "initiative" | "feature" | "task";

export interface TableRow {
	/** The work id; "" for the synthetic "No initiative" group. */
	id: string;
	/** Unique across the table (expansion state keys on it). */
	key: string;
	kind: RowKind;
	/** The Work API kind ("task", "issue", "idea", …). */
	workKind: string;
	depth: 0 | 1 | 2;
	title: string;
	stage: string;
	stageLabel: string;
	assignee: string;
	/** YYYY-MM-DD, "" when unknown. */
	created: string;
	progress: ProgressCell | null;
	/** The dependsOn items that are in the table's data; empty for initiatives. */
	premises: Chip[];
	/** The row as the conclusion of its dependency line; null for initiative groups. */
	self: Chip | null;
	/** Graduated or archived: shown greyed (only present with the toggle on). */
	graduated: boolean;
	children: TableRow[];
	/** Searching: a descendant matched, so this row opens by itself. */
	autoExpand: boolean;
}

export interface WorkTableOptions {
	showGraduated?: boolean;
	query?: string;
	sort?: WorkSort;
}

export interface WorkTable {
	groups: TableRow[];
	/** Rows (features and tasks) that survive the filters. */
	count: number;
	searching: boolean;
}

export const NO_INITIATIVE_KEY = "no-initiative";

const isGraduated = (it: WorkListItem): boolean => it.graduated !== undefined || it.stage === "archived";

function chipOf(it: WorkListItem, blocked: ReadonlySet<string>): Chip {
	let state: ChipState = "plain";
	if (it.kind === "feature" && it.stage === "shipped") state = "ready";
	else if (isDone(it.stage) || it.graduated !== undefined) state = "shipped";
	else if (blocked.has(it.id)) state = "blocked";
	else if (it.stage === "in_build") state = "building";
	return { id: it.id, title: it.title, stage: it.stage, state };
}

export function buildWorkTable(items: readonly WorkListItem[], opts: WorkTableOptions = {}): WorkTable {
	const showGraduated = opts.showGraduated ?? false;
	const sort = opts.sort ?? DEFAULT_WORK_SORT;
	const query = (opts.query ?? "").trim();
	const searching = query !== "";

	const live = items.filter((it) => !it.container && (showGraduated || !isGraduated(it)));
	const byId = new Map(items.map((it) => [it.id, it] as const));
	const liveIds = new Set(live.map((it) => it.id));

	// A prerequisite that is not done blocks; one missing from the payload (hidden, other domain) does not.
	const blocked = new Set<string>();
	for (const it of items) {
		for (const d of it.dependsOn) {
			const dep = byId.get(d);
			if (dep && !isDone(dep.stage) && dep.graduated === undefined) blocked.add(it.id);
		}
	}

	const kidsOf = new Map<string, WorkListItem[]>();
	for (const it of live) {
		const p = it.partOf && liveIds.has(it.partOf) ? it.partOf : null;
		if (p === null) continue;
		const list = kidsOf.get(p);
		if (list) list.push(it);
		else kidsOf.set(p, [it]);
	}

	const rowOf = (it: WorkListItem, depth: 1 | 2, kind: RowKind): TableRow => {
		const premises = it.dependsOn.map((d) => byId.get(d)).filter((d): d is WorkListItem => d !== undefined && (showGraduated || !isGraduated(d))).map((d) => chipOf(d, blocked));
		const tasks = kind === "feature" ? kidsOf.get(it.id) ?? [] : [];
		const kids = tasks.map((t) => rowOf(t, 2, "task"));
		const shipped = tasks.filter((t) => isShipped(t.stage) || t.graduated !== undefined).length;
		return {
			id: it.id,
			key: it.id,
			kind,
			workKind: it.kind,
			depth,
			title: it.title,
			stage: it.stage,
			stageLabel: stageLabel(it.stage, it.kind),
			assignee: it.assignee ?? "",
			created: it.created ?? "",
			progress: kind === "feature" && tasks.length > 0 ? { shipped, total: tasks.length, label: `${shipped}/${tasks.length} shipped` } : null,
			premises,
			self: chipOf(it, blocked),
			graduated: isGraduated(it),
			children: kids,
			autoExpand: false,
		};
	};

	const featureRows = (list: WorkListItem[]): TableRow[] => list.map((f) => rowOf(f, 1, f.kind === "feature" ? "feature" : "task"));

	const groups: TableRow[] = [];
	for (const init of live.filter((it) => it.kind === "initiative")) {
		const rows = featureRows(kidsOf.get(init.id) ?? []);
		groups.push(groupOf(init, rows, init.title, init.id, init.id));
	}
	// Everything not under a live feature or initiative: loose features, and loose tasks/ideas as leaf rows.
	const placed = (it: WorkListItem): boolean => {
		const p = it.partOf ? byId.get(it.partOf) : undefined;
		return !!p && liveIds.has(p.id) && (p.kind === "feature" || p.kind === "initiative");
	};
	const loose = live.filter((it) => it.kind !== "initiative" && !placed(it));
	if (loose.length > 0) groups.push(groupOf(null, featureRows(loose), "No initiative", "", NO_INITIATIVE_KEY));

	const filtered = searching ? groups.map((g) => prune(g, query)).filter((g): g is TableRow => g !== null) : groups;
	sortRows(filtered, sort);
	const count = filtered.reduce((n, g) => n + countRows(g.children), 0);
	return { groups: filtered, count, searching };
}

function groupOf(init: WorkListItem | null, rows: TableRow[], title: string, id: string, key: string): TableRow {
	const features = rows.filter((r) => r.kind === "feature");
	const shipped = features.filter((r) => isShipped(r.stage) || r.graduated).length;
	return {
		id,
		key,
		kind: "initiative",
		workKind: "initiative",
		depth: 0,
		title,
		stage: init?.stage ?? "",
		stageLabel: init ? stageLabel(init.stage, init.kind) : "",
		assignee: init?.assignee ?? "",
		created: init?.created ?? "",
		progress: features.length > 0 ? { shipped, total: features.length, label: `${shipped}/${features.length} shipped` } : null,
		premises: [],
		self: null,
		graduated: init ? isGraduated(init) : false,
		children: rows,
		autoExpand: false,
	};
}

const countRows = (rows: readonly TableRow[]): number => rows.reduce((n, r) => n + 1 + countRows(r.children), 0);

/** A row matches on its title, id or stage (the label and the raw stage). The synthetic "No initiative" group never does. */
const matches = (r: TableRow, query: string): boolean => r.key !== NO_INITIATIVE_KEY && fuzzyScore(query, r.title, r.id, r.stageLabel, r.stage) !== null;

/**
 * Keep the rows that match plus their ancestors; an ancestor of a match opens by itself. A matching row whose
 * descendants don't match keeps all its children (collapsed): hiding them would make "expand" a lie.
 */
function prune(row: TableRow, query: string): TableRow | null {
	const keptKids = row.children.map((c) => prune(c, query)).filter((c): c is TableRow => c !== null);
	const self = matches(row, query);
	if (keptKids.length > 0) return { ...row, children: keptKids, autoExpand: true };
	return self ? row : null;
}

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/** The column's value on a row, compared ascending (before `dir`); "" / null sort after real values. */
function compareBy(col: WorkSortCol, a: TableRow, b: TableRow): number {
	switch (col) {
		case "name":
			return collator.compare(a.title, b.title);
		case "stage":
			return rankOf(a) - rankOf(b);
		case "progress":
			return ratio(a) - ratio(b);
		case "assignee":
			return collator.compare(a.assignee || "\uffff", b.assignee || "\uffff");
		case "created":
			return (a.created || "9999").localeCompare(b.created || "9999");
	}
}

/** A group ranks by its most active row (its own stage when it has none). */
const rankOf = (r: TableRow): number =>
	r.kind === "initiative" && r.children.length > 0 ? Math.min(...r.children.map(rankOf)) : stageRank(r.stage);
const ratio = (r: TableRow): number => (r.progress && r.progress.total > 0 ? r.progress.shipped / r.progress.total : -1);

/** Orders the groups and, recursively, the rows within them. "No initiative" stays last. */
function sortRows(rows: TableRow[], sort: WorkSort): void {
	rows.sort((a, b) => {
		const aLast = a.key === NO_INITIATIVE_KEY ? 1 : 0;
		const bLast = b.key === NO_INITIATIVE_KEY ? 1 : 0;
		if (aLast !== bLast) return aLast - bLast;
		const primary = compareBy(sort.col, a, b) * sort.dir;
		if (primary !== 0) return primary;
		// tie-breaks never flip: newest first, then name
		return (b.created || "").localeCompare(a.created || "") || collator.compare(a.title, b.title) || (a.id < b.id ? -1 : 1);
	});
	for (const r of rows) sortRows(r.children, sort);
}
