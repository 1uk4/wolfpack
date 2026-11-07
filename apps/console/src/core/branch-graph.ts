/**
 * Git overview model for the header popover: time swimlanes of significant moments only (splits, PRs merged to stable,
 * releases, landed work). The thread's branch is the bold lane; children, sibling features, the home branch and stable
 * are the others. Pure; src/server/branch-graph.ts feeds it from read-only git.
 */
import { WORK_DOMAINS, WORK_ID_SOURCE, workIdDomain } from "./work-id-link.ts";

/** One `git log` row (newest first). */
export interface RawCommit {
	sha: string;
	parents: string[];
	subject: string;
	/** Committer time, unix seconds. */
	time?: number;
	/** Lines added / removed (from --numstat; binary files count as 0). */
	added?: number;
	removed?: number;
}

/** Consecutive main-lane commits that share one work item (`workId` null: no ID in the subject). */
export interface RunNode {
	workId: string | null;
	count: number;
	/** Newest commit's sha and subject (the node's tooltip). */
	sha: string;
	subject: string;
	/** Every sha in the run, so a branch's fork commit can be placed on its node. */
	shas: string[];
	/** Committer time (unix s) of the newest commit in the run; null if unknown. */
	time?: number | null;
	added: number;
	removed: number;
}

export interface OverviewBranch {
	name: string;
	kind: "subagent" | "feature";
	ahead: number;
	behind: number;
	/** 0 ahead: everything it did is already on the main lane. */
	landed: boolean;
	/** Committer time (unix s) of the fork commit / of the branch tip; null if unknown. */
	splitAt: number | null;
	lastAt: number | null;
	dirty: boolean;
	/** The 7-char work id in the branch name (`feat/<id>-…`); the domain is found by looking it up. */
	shortId: string | null;
}

/** A first-parent `Merge pull request #N` commit on stable. */
export interface PrMerge {
	n: number;
	at: number;
	sha: string;
}

/** A release tag reachable from stable, at its tag time. */
export interface ReleaseTag {
	name: string;
	at: number;
}

/** Commits a lane has that its target lacks: how many, and the time of the oldest. */
export interface Span {
	count: number;
	since: number | null;
}

export interface GitOverview {
	main: { name: string; kind: "wolf" | "feature" };
	/** The main lane's recent history (30 days), oldest → newest; the work IDs in its subjects feed the landed rings. */
	history: RunNode[];
	/** The main lane's children: a feature thread's subagent branches, a home thread's features. */
	branches: OverviewBranch[];
	/** A feature thread's sibling features (this wolf's other worktree-owned features). */
	siblings: OverviewBranch[];
	/** The wolf's home branch (the main lane in a home thread). */
	home: string;
	/** `stable` (or `main`) when the repo has one. */
	stable: string | null;
	/** The main branch against its own parent (feature thread only); `forkAt` is the merge-base's commit time. */
	parent: { name: string; ahead: number; behind: number; forkAt?: number | null } | null;
	prs: PrMerge[];
	tags: ReleaseTag[];
	/** Home commits not on stable. */
	unreleased: Span | null;
	/** A feature thread's commits not on its parent. */
	unmerged: Span | null;
	/** Exact landings on the main lane (and, in a feature thread, on the home lane), from the parents' reflogs. */
	landings: Landing[];
}

export const EMPTY_OVERVIEW: GitOverview = { main: { name: "", kind: "wolf" }, history: [], branches: [], siblings: [], home: "", stable: null, parent: null, prs: [], tags: [], landings: [], unreleased: null, unmerged: null };

const WORK_ID_IN_SUBJECT = new RegExp(WORK_ID_SOURCE);

/** The first full `work-<domain>-<id>` in a commit subject, or null. */
export function workIdOfSubject(subject: string): string | null {
	return WORK_ID_IN_SUBJECT.exec(subject)?.[0] ?? null;
}

/** Group a newest-first log into oldest → newest runs of consecutive commits sharing a work ID. */
export function groupRuns(log: RawCommit[]): RunNode[] {
	const runs: RunNode[] = [];
	for (const c of [...log].reverse()) {
		const id = workIdOfSubject(c.subject);
		const last = runs[runs.length - 1];
		if (last && last.workId === id) {
			last.count++;
			last.sha = c.sha;
			last.subject = c.subject;
			last.shas.push(c.sha);
			last.time = c.time ?? null;
			last.added += c.added ?? 0;
			last.removed += c.removed ?? 0;
		} else runs.push({ workId: id, count: 1, sha: c.sha, subject: c.subject, shas: [c.sha], time: c.time ?? null, added: c.added ?? 0, removed: c.removed ?? 0 });
	}
	return runs;
}

/** `feat/1nLJglH-slug--agent-ab12` → `1nLJglH` (the 7-char id part of a feature branch name), or null. */
export function branchShortId(branch: string): string | null {
	return /^feat\/([0-9A-Za-z]{7})-/.exec(branch)?.[1] ?? null;
}

/** "4d ago" style age of a unix-seconds time. */
export function ageLabel(time: number | null, nowSec: number): string {
	if (time === null) return "?";
	const s = Math.max(0, nowSec - time);
	if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86400)}d ago`;
}

/** The agent name of a subagent branch `feat/<id>-<slug>--<agent-name>-<hex>`; any other branch name comes back unchanged. */
export function agentName(branch: string): string {
	const suffix = branch.split("--")[1];
	if (suffix === undefined) return branch;
	return suffix.replace(/-[0-9a-f]{4,}$/, "") || branch;
}

/** The muted second header line: a feature against its parent, a home thread by its branch counts. */
export function headerStatus(overview: GitOverview, dirty: boolean): string {
	const state = dirty ? "dirty" : "clean";
	if (overview.main.kind === "feature") {
		const short = branchShortId(overview.main.name);
		const name = short ? `feat/${short}` : overview.main.name;
		const p = overview.parent;
		if (!p) return `${name} · ${state}`;
		const counts = p.ahead === 0 ? `landed (0 ahead · ${p.behind} behind)` : `${p.ahead} ahead · ${p.behind} behind`;
		return `${name} ← ${p.name} · ${counts} · ${state}`;
	}
	const active = overview.branches.filter((b) => !b.landed).length;
	const landed = overview.branches.length - active;
	return [state, `${active} active ${active === 1 ? "branch" : "branches"}`, ...(landed > 0 ? [`${landed} landed`] : [])].join(" · ");
}

/** Every full work ID a 7-char branch id could be: one per work domain. */
export function candidateWorkIds(shortId: string, preferred?: string): string[] {
	const domains = preferred && (WORK_DOMAINS as readonly string[]).includes(preferred) ? [preferred, ...WORK_DOMAINS.filter((d) => d !== preferred)] : [...WORK_DOMAINS];
	return domains.map((d) => `work-${d}-${shortId}`);
}

/** The work domain most of the given full work IDs belong to (the thread's own), or undefined. */
export function preferredDomain(ids: string[]): string | undefined {
	const n = new Map<string, number>();
	for (const id of ids) n.set(workIdDomain(id), (n.get(workIdDomain(id)) ?? 0) + 1);
	return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/** The feature an item belongs to: itself for a feature, its parent when that is a feature, else null (loose work). */
export function featureOfItem(item: { id: string; kind: string }, parent: { id: string; kind: string; container?: boolean } | null): string | null {
	if (item.kind === "feature") return item.id;
	return parent && parent.kind === "feature" ? parent.id : null;
}

export type LaneRole = "child" | "main" | "sibling" | "feature" | "home" | "stable";

export interface SwimLane {
	name: string;
	role: LaneRole;
	/** The thread's own lane: drawn bold. */
	bold: boolean;
	/** The lane it splits from (null: it does not split). */
	parent: string | null;
	/** Commit time of the split (the merge-base); null if unknown. */
	forkAt: number | null;
	/** Subagent, feature or branch the lane stands for. */
	branch?: OverviewBranch;
}

/** The lanes top → bottom. Landed branches (0 ahead) have no lane; their ship shows as a ring. */
export function swimLanes(o: GitOverview): SwimLane[] {
	const lanes: SwimLane[] = [];
	const active = (bs: OverviewBranch[]) => bs.filter((b) => !b.landed);
	if (o.main.kind === "feature") {
		for (const b of active(o.branches)) lanes.push({ name: b.name, role: "child", bold: false, parent: o.main.name, forkAt: b.splitAt, branch: b });
		lanes.push({ name: o.main.name, role: "main", bold: true, parent: o.home, forkAt: o.parent?.forkAt ?? null });
		for (const b of active(o.siblings)) lanes.push({ name: b.name, role: "sibling", bold: false, parent: o.home, forkAt: b.splitAt, branch: b });
	} else {
		for (const b of active(o.branches)) lanes.push({ name: b.name, role: "feature", bold: false, parent: o.home, forkAt: b.splitAt, branch: b });
	}
	lanes.push({ name: o.home, role: "home", bold: o.main.kind === "wolf", parent: null, forkAt: null });
	if (o.stable) lanes.push({ name: o.stable, role: "stable", bold: false, parent: null, forkAt: null });
	return lanes;
}

export type MomentKind = "split" | "pr" | "release" | "landed";

/** A significant moment: a marker on a lane and a row in the large view's list. `lane` "main" means the thread's own lane. */
export interface Moment {
	at: number;
	kind: MomentKind;
	lane: string;
	label: string;
	workId?: string | null;
	detail?: string;
	/** A release's full tag (`console/v0.1.14`). */
	tag?: string;
	/** The work item title(s) a landing stands for: the list row's text (the ring itself may go unlabelled). */
	title?: string;
	/** Every work item a landing ring stands for (so the ship-date fallback skips them). */
	workIds?: string[];
}

/** `console/v0.1.14` → `console 0.1.14`; a tag with no package prefix stays `v2.0.0`. */
export function tagLabel(tag: string): string {
	const i = tag.lastIndexOf("/");
	return i < 0 ? tag : `${tag.slice(0, i)} ${tag.slice(i + 1).replace(/^v/, "")}`;
}

/** Splits, PRs and releases inside the last `days`, plus the given landed rings, oldest first. */
export function buildMoments(o: GitOverview, rings: Moment[], nowSec: number, days: number): Moment[] {
	const start = nowSec - days * 86400;
	const out: Moment[] = [...rings];
	for (const l of swimLanes(o)) {
		if (l.parent && l.forkAt !== null && l.role !== "main") out.push({ at: l.forkAt, kind: "split", lane: l.name, label: `split · ${l.name}`, workId: null, detail: l.branch ? `${l.branch.ahead} ahead` : undefined });
	}
	if (o.stable) {
		for (const p of o.prs) out.push({ at: p.at, kind: "pr", lane: o.stable, label: `PR #${p.n}` });
		for (const t of o.tags) out.push({ at: t.at, kind: "release", lane: o.stable, label: tagLabel(t.name), tag: t.name });
	}
	return out.filter((m) => m.at >= start && m.at <= nowSec).sort((a, b) => a.at - b.at);
}

/** What the landed rings are made from: a work item (a task or feature) as the chip lookup returns it. */
export interface ShipSubject {
	id: string;
	title: string;
	kind: string;
	stage: string;
	/** The item's `updated` date (YYYY-MM-DD): the last event, which is the ship for finished work. */
	updated?: string;
	partOf?: string | null;
}

const COMPLETE = new Set(["shipped", "live", "archived"]);

/**
 * The fallback landed rings, for landings the reflog has no entry for (older than it, or on a clone without it): at the
 * work item's ship date, which is day-only. Feature thread: the feature's child
 * tasks. Home: shipped features that no longer have a lane. An item with no ship date is skipped.
 */
export function shipMoments(subjects: ShipSubject[], ctx: { feature: string | null; nowSec: number; activeShortIds: string[]; covered?: string[] }): Moment[] {
	const seen = new Set<string>();
	const out: Moment[] = [];
	for (const it of subjects) {
		if (seen.has(it.id) || ctx.covered?.includes(it.id) || !COMPLETE.has(it.stage) || !it.updated) continue;
		const short = it.id.slice(-7);
		const wanted = ctx.feature === null ? it.kind === "feature" && !ctx.activeShortIds.includes(short) : it.kind !== "feature" && !!it.partOf && it.partOf.endsWith(ctx.feature);
		if (!wanted) continue;
		const day = Date.parse(`${it.updated}T12:00:00Z`) / 1000;
		if (!Number.isFinite(day)) continue;
		seen.add(it.id);
		out.push({ at: Math.min(day, ctx.nowSec), kind: "landed", lane: "main", label: `${it.title} ✓`, workId: it.id });
	}
	return out.sort((a, b) => a.at - b.at);
}

export const MIN_GAP_PX = 16;
export const MAX_GAP_PX = 48;
const PX_PER_HOUR = 2;

/**
 * Squeeze quiet stretches: a piecewise-linear time axis through the moment times where each stretch between
 * neighbours is 2px/hour, at least MIN_GAP_PX and at most MAX_GAP_PX, so busy days get the width.
 */
export function timeScale(times: number[], start: number, end: number, fit?: { width: number; grow: boolean }): { x: (t: number) => number; width: number } {
	const anchors = [...new Set([start, ...times.filter((t) => t > start && t < end), end])].sort((a, b) => a - b);
	const xs = [0];
	for (let i = 1; i < anchors.length; i++) {
		const px = ((anchors[i]! - anchors[i - 1]!) / 3600) * PX_PER_HOUR;
		xs.push(xs[i - 1]! + Math.min(MAX_GAP_PX, Math.max(MIN_GAP_PX, px)));
	}
	// Fit a target width. Too wide: squeeze the quiet gaps toward MIN_GAP_PX first (busy stretches keep their width),
	// and scale everything evenly only if the minimums alone overflow. Grow (the large view) stretches evenly.
	const natural = xs[xs.length - 1]!;
	if (fit && natural > 0 && (natural > fit.width || fit.grow)) {
		const gaps = xs.slice(1).map((v, i) => v - xs[i]!);
		const minTotal = gaps.length * MIN_GAP_PX;
		let out: number[];
		if (natural > fit.width && fit.width > minTotal) {
			const k = (fit.width - minTotal) / (natural - minTotal);
			out = gaps.map((g) => MIN_GAP_PX + (g - MIN_GAP_PX) * k);
		} else {
			const k = fit.width / natural;
			out = gaps.map((g) => g * k);
		}
		for (let i = 1; i < xs.length; i++) xs[i] = xs[i - 1]! + out[i - 1]!;
	}
	const x = (t: number): number => {
		if (t <= start) return 0;
		if (t >= end) return xs[xs.length - 1]!;
		let i = anchors.findIndex((a) => a >= t);
		if (anchors[i] === t) return xs[i]!;
		const [a0, a1, x0, x1] = [anchors[i - 1]!, anchors[i]!, xs[i - 1]!, xs[i]!];
		return x0 + ((t - a0) / (a1 - a0)) * (x1 - x0);
	};
	return { x, width: xs[xs.length - 1]! };
}

/**
 * Merge moments of one `kind` that sit closer than `gap` px on the same lane into one marker at the newest time.
 * Releases: labelled with the newest version and `+N`, the detail lists every version. Landed rings: the newest
 * non-empty label, the detail says how many landings, work IDs are united. Other kinds pass through untouched.
 */
export function mergeNear(moments: Moment[], kind: MomentKind, xOf: (t: number) => number, gap: number): Moment[] {
	const rest = moments.filter((m) => m.kind !== kind);
	const groups: Moment[][] = [];
	const lastOfLane = new Map<string, Moment[]>();
	for (const m of moments.filter((x) => x.kind === kind).sort((a, b) => a.at - b.at)) {
		const g = lastOfLane.get(m.lane);
		if (g && xOf(m.at) - xOf(g[g.length - 1]!.at) < gap) g.push(m);
		else {
			const ng = [m];
			groups.push(ng);
			lastOfLane.set(m.lane, ng);
		}
	}
	const merged = groups.map((g): Moment => {
		const newest = g[g.length - 1]!;
		if (g.length === 1) return newest;
		if (kind === "release") {
			// Newest by tag time (not list order); each full tag once, newest first.
			const byTime = [...g].sort((a, b) => b.at - a.at);
			const tags = [...new Set(byTime.map((m) => m.tag ?? m.label))];
			const top = byTime[0]!;
			return { ...top, label: tags.length > 1 ? `${top.label} +${tags.length - 1}` : top.label, detail: tags.join(", ") };
		}
		const labelled = [...g].reverse().find((m) => m.label !== "");
		const ids = [...new Set(g.flatMap((m) => m.workIds ?? []))];
		return { ...newest, label: labelled?.label ?? "", workId: ids[0] ?? null, workIds: ids, detail: [`${g.length} landings`, ...g.map((m) => m.detail).filter(Boolean)].join(" · ") };
	});
	return [...rest, ...merged].sort((a, b) => a.at - b.at);
}

/** One row of the moments list: the newest moment of a run, and how many identical ones it stands for. */
export interface MomentRow {
	moment: Moment;
	count: number;
}

/** Collapse consecutive identical rows (same kind and work item, or label when none; within an hour) of a newest-first list. */
export function collapseRows(moments: Moment[]): MomentRow[] {
	const rows: MomentRow[] = [];
	let prev: Moment | null = null;
	for (const m of moments) {
		const last = rows[rows.length - 1];
		const same = (a: Moment) => a.kind === m.kind && (a.workId ?? `label:${a.label}`) === (m.workId ?? `label:${m.label}`);
		if (last && prev && same(prev) && prev.at - m.at <= 3600) last.count++;
		else rows.push({ moment: m, count: 1 });
		prev = m;
	}
	return rows;
}

/** A label already placed (or to place) on one side of a lane: `key` names the region, `x` its left edge, `w` its width. */
export interface PlacedLabel {
	key: string;
	x: number;
	w: number;
}

/**
 * Where a band's label goes: at the band's left edge if it clears the labels already placed in its region, else
 * right-aligned at the band's end, else null (the tooltip only).
 */
export function placeBandLabel(band: { key: string; left: number; right: number; w: number }, taken: PlacedLabel[], gap = 4): number | null {
	const free = (x: number) => !taken.some((t) => t.key === band.key && x < t.x + t.w + gap && t.x < x + band.w + gap);
	if (free(band.left)) return band.left;
	const right = band.right - band.w;
	return right > band.left && free(right) ? right : null;
}

/** Clip long text in the middle: `feat/n73bJ…git-graph`. */
export function middleClip(text: string, max: number): string {
	if (text.length <= max) return text;
	const keep = max - 1;
	const head = Math.ceil(keep / 2);
	return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`;
}

// ---- reflog: exact times for splits and landings -------------------------------------------------------------------

export interface ReflogEntry {
	/** The value the ref moved to. */
	sha: string;
	/** Unix seconds. */
	at: number;
	kind: "created" | "landing" | "other";
	/** A landing's merge source (a branch name, or a raw hash), when the entry names one. */
	source: string | null;
}

const REFLOG_LINE = /^([0-9a-f]{7,40}) \S+@\{(\d+)\} (.*)$/;

/** Parse `git reflog show --date=unix --format='%H %gd %gs'` (newest first). Only creations and landings are classified. */
export function parseReflog(out: string): ReflogEntry[] {
	const entries: ReflogEntry[] = [];
	for (const line of out.split("\n")) {
		const m = REFLOG_LINE.exec(line);
		if (!m) continue;
		const [, sha, at, msg = ""] = m;
		let kind: ReflogEntry["kind"] = "other";
		let source: string | null = null;
		if (/^branch: Created/.test(msg)) kind = "created";
		else if (/^merge \S+?(?::|$)/.test(msg)) {
			kind = "landing";
			source = /^merge (\S+?)(?::|$)/.exec(msg)![1]!;
		} else if (/^commit \(merge\)/.test(msg)) {
			kind = "landing";
			source = /Merge (?:remote-tracking )?branch '([^']+)'/.exec(msg)?.[1] ?? null;
		}
		entries.push({ sha: sha!, at: Number(at), kind, source });
	}
	return entries;
}

/** When the branch was created, from its reflog (null: the entry is gone). */
export function createdAt(entries: ReflogEntry[]): number | null {
	const made = entries.filter((e) => e.kind === "created");
	return made.length > 0 ? made[made.length - 1]!.at : null;
}

/** A landing on a lane: what moved in, named by the commits between the previous reflog value and the new one. */
export interface Landing {
	at: number;
	/** `main`: the thread's own lane; `home`: the home branch while in a feature thread. */
	lane: "main" | "home";
	source: string | null;
	sha: string;
	commits: number;
	/** Work IDs in those commits' subjects, oldest first. */
	workIds: string[];
}

const RANGE_CAP = 100;

/** The commits `prev..tip` along the first-parent chain of `log` (newest first); just the tip when the chain doesn't reach `prev`. */
function rangeCommits(log: RawCommit[], tip: string, prev: string | undefined): RawCommit[] {
	const by = new Map(log.map((c) => [c.sha, c]));
	const first = by.get(tip);
	if (!first) return [];
	const out: RawCommit[] = [];
	let cur: RawCommit | undefined = first;
	while (cur && out.length < RANGE_CAP) {
		if (cur.sha === prev) return out;
		out.push(cur);
		cur = by.get(cur.parents[0] ?? "");
	}
	return prev === undefined || !cur || cur.sha !== prev ? [first] : out;
}

/** Landings in the window from a lane's reflog (newest first), each with the work IDs of the commits it brought. */
export function landingsFrom(entries: ReflogEntry[], log: RawCommit[], lane: Landing["lane"], startSec: number): Landing[] {
	const out: Landing[] = [];
	entries.forEach((e, i) => {
		if (e.kind !== "landing" || e.at < startSec) return;
		const commits = rangeCommits(log, e.sha, entries[i + 1]?.sha);
		const workIds: string[] = [];
		for (const c of [...commits].reverse()) {
			const id = workIdOfSubject(c.subject);
			if (id && !workIds.includes(id)) workIds.push(id);
		}
		out.push({ at: e.at, lane, source: e.source, sha: e.sha, commits: commits.length, workIds });
	});
	return out.reverse();
}

/**
 * Landed rings from exact landings. `items` maps a work ID found in the landing's commits to the item the ring names (a
 * feature thread: the item itself; home: the feature it belongs to). Feature thread: every landing on its lane is a
 * child landing, labelled by its tasks or else the agent; a landing on home counts only when it carries this feature
 * or its tasks. Home thread: landed features that no longer have a lane, or an unnamed landing labelled by its source.
 */
export function landedMoments(landings: Landing[], items: Record<string, ShipSubject>, ctx: { feature: string | null; activeShortIds: string[] }): Moment[] {
	const out: Moment[] = [];
	for (const l of landings) {
		const subs: ShipSubject[] = [];
		for (const id of l.workIds) {
			const it = items[id];
			if (it && !subs.some((x) => x.id === it.id)) subs.push(it);
		}
		let relevant: ShipSubject[];
		if (ctx.feature !== null && l.lane === "home") relevant = subs.filter((s) => s.id.endsWith(ctx.feature!) || (s.partOf ?? "").endsWith(ctx.feature!));
		else if (ctx.feature !== null) relevant = subs.filter((s) => s.kind !== "feature" && (s.partOf ?? "").endsWith(ctx.feature!));
		else relevant = subs.filter((s) => s.kind === "feature" && !ctx.activeShortIds.includes(s.id.slice(-7)));
		if (ctx.feature !== null && l.lane === "home" && relevant.length === 0) continue;
		if (ctx.feature === null && l.workIds.length > 0 && relevant.length === 0) continue;
		// Only a work item title labels a ring; with none it is a ring and a tooltip (never a hash, branch or agent).
		const shown = ctx.feature !== null && l.lane === "home" ? relevant.filter((s) => s.id.endsWith(ctx.feature!)) : relevant;
		const label = shown.length > 0 ? `${shown[0]!.title}${shown.length > 1 ? ` +${shown.length - 1}` : ""} ✓` : "";
		out.push({
			at: l.at,
			kind: "landed",
			lane: l.lane,
			label,
			title: shown.length > 0 ? `${shown[0]!.title}${shown.length > 1 ? ` +${shown.length - 1}` : ""}` : undefined,
			workId: relevant[0]?.id ?? null,
			workIds: relevant.map((s) => s.id),
			detail: `${l.source ? `from ${l.source} · ` : ""}${l.commits} ${l.commits === 1 ? "commit" : "commits"}`,
		});
	}
	return out.sort((a, b) => a.at - b.at);
}

/** Release tags look like versions: `v1.2.3` or `<name>/v1.2.3`. */
export function isVersionTag(name: string): boolean {
	return /(?:^|\/)v\d[\w.+-]*$/.test(name);
}

/** A label to place: `key` names the lane side it sits on, `x` its left edge and `w` its width in px. */
export interface LabelBox {
	key: string;
	x: number;
	w: number;
}

/** Which labels to draw: left to right within a lane side, a label that would overlap the previous kept one is dropped. */
export function placeLabels(labels: LabelBox[], gap = 4): boolean[] {
	const keep = labels.map(() => true);
	const lastEnd = new Map<string, number>();
	labels
		.map((l, i) => ({ l, i }))
		.sort((a, b) => a.l.x - b.l.x)
		.forEach(({ l, i }) => {
			const end = lastEnd.get(l.key);
			if (end !== undefined && l.x < end + gap) keep[i] = false;
			else lastEnd.set(l.key, l.x + l.w);
		});
	return keep;
}
