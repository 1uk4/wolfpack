/**
 * Git overview model for the header popover: time swimlanes of significant moments only (splits, PRs merged to stable,
 * releases, landed work). The thread's branch is the bold lane; children, sibling features, the home branch and stable
 * are the others. Pure; src/server/branch-graph.ts feeds it from read-only git.
 */
import { WORK_DOMAINS, WORK_ID_SOURCE } from "./work-id-link.ts";

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
}

export const EMPTY_OVERVIEW: GitOverview = { main: { name: "", kind: "wolf" }, history: [], branches: [], siblings: [], home: "", stable: null, parent: null, prs: [], tags: [], unreleased: null, unmerged: null };

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
export function candidateWorkIds(shortId: string): string[] {
	return WORK_DOMAINS.map((d) => `work-${d}-${shortId}`);
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
}

/** `console/v0.1.14` → `v0.1.14`. */
export function tagLabel(tag: string): string {
	return tag.slice(tag.lastIndexOf("/") + 1);
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
		for (const t of o.tags) out.push({ at: t.at, kind: "release", lane: o.stable, label: tagLabel(t.name) });
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
 * Landed rings (fast-forwards leave no git trace) at the work item's ship time. Feature thread: the feature's child
 * tasks. Home: shipped features that no longer have a lane. An item with no ship date is skipped.
 */
export function shipMoments(subjects: ShipSubject[], ctx: { feature: string | null; nowSec: number; activeShortIds: string[] }): Moment[] {
	const seen = new Set<string>();
	const out: Moment[] = [];
	for (const it of subjects) {
		if (seen.has(it.id) || !COMPLETE.has(it.stage) || !it.updated) continue;
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
export function timeScale(times: number[], start: number, end: number): { x: (t: number) => number; width: number } {
	const anchors = [...new Set([start, ...times.filter((t) => t > start && t < end), end])].sort((a, b) => a - b);
	const xs = [0];
	for (let i = 1; i < anchors.length; i++) {
		const px = ((anchors[i]! - anchors[i - 1]!) / 3600) * PX_PER_HOUR;
		xs.push(xs[i - 1]! + Math.min(MAX_GAP_PX, Math.max(MIN_GAP_PX, px)));
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
