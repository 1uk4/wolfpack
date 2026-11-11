/** Read-only git for the popover's overview: ref discovery, one bounded first-parent log and a few cheap counts per child branch. */
import { execFile } from "node:child_process";
import { dirname, sep } from "node:path";
import { branchShortId, createdAt, EMPTY_OVERVIEW, groupRuns, isVersionTag, landingsFrom, parseReflog, type GitOverview, type Landing, type OverviewBranch, type PrMerge, type RawCommit, type ReleaseTag, type Span } from "../../core/graph/branch-graph.ts";

export type GitRunner = (cwd: string, args: string[]) => Promise<string>;

export const runGit: GitRunner = (cwd, args) =>
	new Promise((resolve, reject) => {
		execFile("git", ["-C", cwd, ...args], { maxBuffer: 8 * 1024 * 1024, timeout: 10_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
	});

/** Parse `git log --numstat --format=%x01%H%x00%P%x00%s%x00%ct`: a header line per commit, then its numstat lines. */
export function parseLog(out: string): RawCommit[] {
	const commits: RawCommit[] = [];
	for (const line of out.split("\n")) {
		if (!line) continue;
		const stat = /^(\d+|-)\t(\d+|-)\t/.exec(line);
		if (stat) {
			const last = commits[commits.length - 1];
			if (last) {
				last.added = (last.added ?? 0) + (Number(stat[1]) || 0);
				last.removed = (last.removed ?? 0) + (Number(stat[2]) || 0);
			}
			continue;
		}
		const [sha = "", parents = "", subject = "", time] = line.replace(/^\x01/, "").split("\0");
		commits.push({ sha, parents: parents.split(" ").filter(Boolean), subject, ...(time ? { time: Number(time) } : {}) });
	}
	return commits;
}

const PR_SUBJECT = /^Merge pull request #(\d+)\b/;

/** `Merge pull request #N` commits from a stable first-parent merge log, oldest first. */
export function parsePrs(out: string): PrMerge[] {
	const prs: PrMerge[] = [];
	for (const c of parseLog(out)) {
		const m = PR_SUBJECT.exec(c.subject);
		if (m && c.time !== undefined) prs.push({ n: Number(m[1]), at: c.time, sha: c.sha });
	}
	return prs.sort((a, b) => a.at - b.at);
}

export interface GraphWorkspace {
	toplevel: string;
	branch: string;
	base?: string;
}

/** How far back the overview reads: the large view's range (the card shows the last 7 days of it). */
export interface HistoryWindow {
	days: number;
	commits: number;
}
export const DEFAULT_WINDOW: HistoryWindow = { days: 30, commits: 300 };

/**
 * The git overview of a workspace for the time swimlanes. The main lane is the thread's own branch; its children are
 * a feature thread's `<branch>--*` subagent branches or a home thread's `feat/*` branches whose worktree sits beside
 * its own checkout. A feature thread also gets its sibling features (same rule). Around them: the wolf's home branch
 * and stable, with the PR merges and release tags on stable and the commits not yet released. A bounded number of
 * git calls: for-each-ref, worktree list, one log per lane group, counts per lane, one tag list.
 */
export async function workspaceGraph(ws: GraphWorkspace, wolf: string, git: GitRunner = runGit, window: HistoryWindow = DEFAULT_WINDOW): Promise<GitOverview> {
	try {
		return await overview(ws, wolf, git, window);
	} catch (err) {
		// A git timeout (execFile kills the child) draws an empty overview rather than failing the popover.
		const e = err as { killed?: boolean; signal?: string; code?: string };
		if (e?.killed || e?.signal === "SIGTERM" || e?.code === "ETIMEDOUT") return EMPTY_OVERVIEW;
		throw err;
	}
}

interface Head {
	sha: string;
	time: number | null;
}

/** Branch → worktree path (from `git worktree list --porcelain`). */
async function worktreePaths(cwd: string, git: GitRunner): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	let path = "";
	for (const line of (await git(cwd, ["worktree", "list", "--porcelain"])).split("\n")) {
		if (line.startsWith("worktree ")) path = line.slice(9);
		else if (line.startsWith("branch refs/heads/")) out.set(line.slice(18), path);
	}
	return out;
}

/** One branch's reflog, newest first, bounded. A branch with no reflog (a fresh clone, an expired log) reads as empty. */
async function reflogOf(git: GitRunner, cwd: string, branch: string) {
	try {
		return parseReflog(await git(cwd, ["reflog", "show", "--date=unix", "--format=%H %gd %gs", "-n", "500", `refs/heads/${branch}`, "--"]));
	} catch (err) {
		const e = err as { killed?: boolean; signal?: string; code?: string };
		if (e?.killed || e?.signal === "SIGTERM" || e?.code === "ETIMEDOUT") throw err;
		return [];
	}
}

/** `left...right` → [only in left, only in right]. */
async function leftRight(git: GitRunner, cwd: string, left: string, right: string): Promise<[number, number]> {
	const [l = "0", r = "0"] = (await git(cwd, ["rev-list", "--left-right", "--count", `${left}...${right}`])).trim().split(/\s+/);
	return [Number(l), Number(r)];
}

/** Commits of `branch` not on `base`: the count and the oldest one's time (one log of bare timestamps). */
async function spanOf(git: GitRunner, cwd: string, base: string, branch: string): Promise<Span> {
	const times = (await git(cwd, ["log", "--format=%ct", `${base}..${branch}`, "--"])).split("\n").filter(Boolean);
	return { count: times.length, since: times.length > 0 ? Number(times[times.length - 1]) : null };
}

async function overview(ws: GraphWorkspace, wolf: string, git: GitRunner, window: HistoryWindow): Promise<GitOverview> {
	const cwd = ws.toplevel;
	const heads = new Map<string, Head>();
	for (const line of (await git(cwd, ["for-each-ref", "--format=%(refname:short)%00%(objectname)%00%(committerdate:unix)", "refs/heads"])).split("\n")) {
		const [name, sha, time] = line.split("\0");
		if (name && sha) heads.set(name, { sha, time: time ? Number(time) : null });
	}
	const main = heads.get(ws.branch);
	if (!main) return EMPTY_OVERVIEW;
	const isFeature = ws.branch.startsWith("feat/");
	const home = isFeature ? (heads.has(`wolf/${wolf}`) ? `wolf/${wolf}` : (ws.base && heads.has(ws.base) ? ws.base : `wolf/${wolf}`)) : ws.branch;
	const stable = ["stable", "main"].find((b) => heads.has(b) && b !== ws.branch) ?? null;
	const paths = await worktreePaths(cwd, git);
	const since = `--since=${window.days}.days`;

	// The main lane's recent history, grouped by work item: the work IDs in it feed the landed rings.
	const log = parseLog(await git(cwd, ["log", "--first-parent", "--numstat", "-n", String(window.commits), "--format=%x01%H%x00%P%x00%s%x00%ct", ws.branch, "--"]));
	const startSec = Date.now() / 1000 - window.days * 86400;
	const history = groupRuns(log.filter((c) => (c.time ?? Infinity) >= startSec));

	// Children and siblings: worktree-folder ownership for features of this wolf, `<branch>--*` for subagents.
	const folder = dirname(cwd);
	const owned = (n: string) => n.startsWith("feat/") && !n.includes("--") && (paths.get(n) ?? "").startsWith(folder + sep);
	const childNames = [...heads.keys()].filter((n) => (isFeature ? n.startsWith(`${ws.branch}--`) : owned(n) && n !== ws.branch)).sort();
	const siblingNames = isFeature ? [...heads.keys()].filter((n) => owned(n) && n !== ws.branch).sort() : [];

	const measure = async (names: string[], against: string, kind: OverviewBranch["kind"]): Promise<OverviewBranch[]> => {
		const forkShas = new Map<string, string>();
		const out: OverviewBranch[] = [];
		for (const name of names) {
			const [behind, ahead] = await leftRight(git, cwd, against, name);
			const base = (await git(cwd, ["merge-base", against, name])).trim();
			if (base) forkShas.set(name, base);
			const path = paths.get(name);
			const dirty = path ? (await git(path, ["status", "--porcelain"])).trim() !== "" : false;
			out.push({ name, kind, ahead, behind, landed: ahead === 0, splitAt: null, lastAt: heads.get(name)!.time, dirty, shortId: branchShortId(name) });
		}
		// The fork commits' times in one call.
		const shas = [...new Set(forkShas.values())];
		const times = new Map<string, number>();
		if (shas.length > 0) for (const c of parseLog(await git(cwd, ["show", "-s", "--format=%H%x00%P%x00%s%x00%ct", ...shas]))) if (c.time !== undefined) times.set(c.sha, c.time);
		// Split time: the branch's creation in its reflog (exact); the merge-base commit's time when that entry is gone.
		for (const b of out) b.splitAt = createdAt(await reflogOf(git, cwd, b.name)) ?? times.get(forkShas.get(b.name) ?? "") ?? null;
		return out;
	};
	const branches = await measure(childNames, ws.branch, isFeature ? "subagent" : "feature");
	const siblings = await measure(siblingNames, home, "feature");

	// A feature thread's own split from the home branch and how far it is from it.
	let parent: GitOverview["parent"] = null;
	let unmerged: Span | null = null;
	if (isFeature && heads.has(home)) {
		const [self] = await measure([ws.branch], home, "feature");
		parent = { name: home, ahead: self!.ahead, behind: self!.behind, forkAt: self!.splitAt };
		unmerged = await spanOf(git, cwd, home, ws.branch);
	}

	// Landings: what moved into the main lane (and, in a feature thread, into home), at the reflog's exact times.
	let landings: Landing[] = landingsFrom(await reflogOf(git, cwd, ws.branch), log, "main", startSec);
	if (isFeature && heads.has(home)) {
		const homeLog = parseLog(await git(cwd, ["log", "--first-parent", "-n", String(window.commits), "--format=%x01%H%x00%P%x00%s%x00%ct", home, "--"]));
		landings = [...landings, ...landingsFrom(await reflogOf(git, cwd, home), homeLog, "home", startSec)];
	}

	// Stable: its PR merges in the window, the release tags reachable from it, and the home commits not on it.
	let prs: PrMerge[] = [];
	let tags: ReleaseTag[] = [];
	let unreleased: Span | null = null;
	if (stable) {
		prs = parsePrs(await git(cwd, ["log", stable, "--first-parent", "--merges", "-n", "100", since, "--format=%x01%H%x00%P%x00%s%x00%ct", "--"]));
		for (const line of (await git(cwd, ["tag", "--merged", stable, "--format=%(refname:short)%00%(creatordate:unix)"])).split("\n")) {
			const [name, at] = line.split("\0");
			if (name && at && isVersionTag(name)) tags.push({ name, at: Number(at) });
		}
		tags = tags.sort((a, b) => a.at - b.at).slice(-30);
		if (heads.has(home)) unreleased = await spanOf(git, cwd, stable, home);
	}
	return { main: { name: ws.branch, kind: isFeature ? "feature" : "wolf" }, history, branches, siblings, home, stable, parent, prs, tags, landings, unreleased, unmerged };
}
