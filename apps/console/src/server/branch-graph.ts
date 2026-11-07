/** Read-only git for the popover's overview: ref discovery, one bounded first-parent log and a few cheap counts per child branch. */
import { execFile } from "node:child_process";
import { dirname, sep } from "node:path";
import { branchShortId, EMPTY_OVERVIEW, groupRuns, workIdOfSubject, type GitOverview, type OverviewBranch, type RawCommit } from "../core/branch-graph.ts";

export type GitRunner = (cwd: string, args: string[]) => Promise<string>;

export const runGit: GitRunner = (cwd, args) =>
	new Promise((resolve, reject) => {
		execFile("git", ["-C", cwd, ...args], { maxBuffer: 8 * 1024 * 1024, timeout: 10_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
	});

/** Parse `git log --format=%H%x00%P%x00%s%x00%ct`. */
export function parseLog(out: string): RawCommit[] {
	return out
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [sha = "", parents = "", subject = "", time] = line.split("\0");
			return { sha, parents: parents.split(" ").filter(Boolean), subject, ...(time ? { time: Number(time) } : {}) };
		});
}

export interface GraphWorkspace {
	toplevel: string;
	branch: string;
	base?: string;
}

/** How much of the main lane's history to summarise: the newest `commits` first-parent commits, no older than `days`. */
export interface HistoryWindow {
	commits: number;
	days: number;
}
export const DEFAULT_WINDOW: HistoryWindow = { commits: 50, days: 7 };

/**
 * The git overview of a workspace. The main lane is the thread's own branch, its recent history grouped by work item.
 * Children: for a feature thread the `<branch>--*` subagent branches; for a home thread the `feat/*` branches whose
 * worktree sits beside its own checkout. Each child records its fork point (merge-base), ahead/behind and whether its
 * worktree is dirty. Base, `stable`/`main` and other branches are not shown.
 */
export async function workspaceGraph(ws: GraphWorkspace, wolf: string, git: GitRunner = runGit, window: HistoryWindow = DEFAULT_WINDOW): Promise<GitOverview> {
	try {
		return await overview(ws, git, window);
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
	subject: string;
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

/** `left...right` → [only in left, only in right]. */
async function leftRight(git: GitRunner, cwd: string, left: string, right: string): Promise<[number, number]> {
	const [l = "0", r = "0"] = (await git(cwd, ["rev-list", "--left-right", "--count", `${left}...${right}`])).trim().split(/\s+/);
	return [Number(l), Number(r)];
}

async function overview(ws: GraphWorkspace, git: GitRunner, window: HistoryWindow): Promise<GitOverview> {
	const cwd = ws.toplevel;
	const heads = new Map<string, Head>();
	for (const line of (await git(cwd, ["for-each-ref", "--format=%(refname:short)%00%(objectname)%00%(committerdate:unix)%00%(contents:subject)", "refs/heads"])).split("\n")) {
		const [name, sha, time, subject = ""] = line.split("\0");
		if (name && sha) heads.set(name, { sha, time: time ? Number(time) : null, subject });
	}
	const main = heads.get(ws.branch);
	if (!main) return EMPTY_OVERVIEW;
	const isFeature = ws.branch.startsWith("feat/");
	const paths = await worktreePaths(cwd, git);

	// Main lane: one bounded first-parent log, cut to the time window, grouped by work item.
	const cutoff = Date.now() / 1000 - window.days * 86400;
	const log = parseLog(await git(cwd, ["log", "--first-parent", "-n", String(window.commits), "--format=%H%x00%P%x00%s%x00%ct", ws.branch, "--"]));
	const recent = log.filter((c, i) => i === 0 || (c.time ?? Infinity) >= cutoff);
	const history = groupRuns(recent);
	const timeOf = new Map(log.map((c) => [c.sha, c.time ?? null]));

	// Children: a feature thread owns `<branch>--*`; a home thread the `feat/*` heads with a worktree beside its checkout.
	const folder = dirname(cwd);
	const names = [...heads.keys()]
		.filter((n) => (isFeature ? n.startsWith(`${ws.branch}--`) : n.startsWith("feat/") && (paths.get(n) ?? "").startsWith(folder + sep)))
		.sort();
	const idsSeen = recent.map((c) => workIdOfSubject(c.subject)).filter((x): x is string => x !== null);
	const branches: OverviewBranch[] = [];
	for (const name of names) {
		const head = heads.get(name)!;
		const [behind, ahead] = await leftRight(git, cwd, ws.branch, name);
		const base = (await git(cwd, ["merge-base", ws.branch, name])).trim();
		const forkIndex = history.findIndex((h) => h.shas.includes(base));
		let splitAt = timeOf.get(base) ?? null;
		if (splitAt === null && base) splitAt = Number((await git(cwd, ["log", "-1", "--format=%ct", base])).trim()) || null;
		const path = paths.get(name);
		const dirty = path ? (await git(path, ["status", "--porcelain"])).trim() !== "" : false;
		// The work ID: the one in the tip's subject (or a recent main commit) whose 7-char id matches the branch name.
		const short = branchShortId(name);
		const workId = short ? [workIdOfSubject(head.subject), ...idsSeen].find((id) => id?.endsWith(short)) ?? null : null;
		branches.push({
			name,
			kind: isFeature ? "subagent" : "feature",
			ahead,
			behind,
			landed: ahead === 0,
			forkIndex,
			gap: forkIndex === -1 ? Math.max(0, behind - recent.length) : 0,
			splitAt,
			lastAt: head.time,
			dirty,
			workId,
		});
	}

	// A feature thread also shows how far its branch is from the branch it was cut from.
	let parent: GitOverview["parent"] = null;
	if (isFeature && ws.base && heads.has(ws.base)) {
		const [behind, ahead] = await leftRight(git, cwd, ws.base, ws.branch);
		parent = { name: ws.base, ahead, behind };
	}
	return { main: { name: ws.branch, kind: isFeature ? "feature" : "wolf" }, history, branches, parent };
}
