/** Read-only git for the popover's branch graph: ref discovery + a bounded topo-ordered log, fed to the pure lane assignment. */
import { execFile } from "node:child_process";
import { dirname, sep } from "node:path";
import { buildBranchGraph, type BranchGraph, type LaneRef, type RawCommit } from "../core/branch-graph.ts";

export type GitRunner = (cwd: string, args: string[]) => Promise<string>;

export const runGit: GitRunner = (cwd, args) =>
	new Promise((resolve, reject) => {
		execFile("git", ["-C", cwd, ...args], { maxBuffer: 8 * 1024 * 1024, timeout: 10_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
	});

/** Parse `git log --format=%H%x00%P%x00%s`. */
export function parseLog(out: string): RawCommit[] {
	return out
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [sha = "", parents = "", ...subject] = line.split("\0");
			return { sha, parents: parents.split(" ").filter(Boolean), subject: subject.join("\0") };
		});
}

export interface GraphWorkspace {
	toplevel: string;
	branch: string;
	base?: string;
}

/**
 * The branch graph of a workspace. The main lane is the thread's own branch. Its children are lanes: for a feature
 * thread (`feat/*`) the `<branch>--*` subagent branches; for a home thread the `feat/*` feature branches cut from it.
 * A child whose ref is gone but whose merge commit is on the main lane is drawn from the merge's second parent.
 * The base, `stable`/`main` and other branches are not shown.
 */
export async function workspaceGraph(ws: GraphWorkspace, wolf: string, git: GitRunner = runGit): Promise<BranchGraph> {
	try {
		return await workspaceGraphUnsafe(ws, wolf, git);
	} catch (err) {
		// A git timeout (execFile kills the child) draws an empty graph rather than failing the popover.
		const e = err as { killed?: boolean; signal?: string; code?: string };
		if (e?.killed || e?.signal === "SIGTERM" || e?.code === "ETIMEDOUT") return { lanes: [], commits: [] };
		throw err;
	}
}

/** Branches checked out in a worktree under `folder` (from `git worktree list --porcelain`). */
async function worktreeBranchesUnder(cwd: string, folder: string, git: GitRunner): Promise<Set<string>> {
	const out = new Set<string>();
	let path = "";
	for (const line of (await git(cwd, ["worktree", "list", "--porcelain"])).split("\n")) {
		if (line.startsWith("worktree ")) path = line.slice(9);
		else if (line.startsWith("branch refs/heads/") && path.startsWith(folder + sep)) out.add(line.slice(18));
	}
	return out;
}

/** The branch a merge commit brought in, from its subject ("Merge branch 'x'", "Merge pull request #1 from o/x"), else the short sha. */
export function mergedName(subject: string, sha: string): string {
	const m = /^Merge (?:remote-tracking )?branch '([^']+)'/.exec(subject) ?? /^Merge pull request #\d+ from [^/\s]+\/(\S+)/.exec(subject);
	return m?.[1] ?? `merged ${sha.slice(0, 7)}`;
}

async function workspaceGraphUnsafe(ws: GraphWorkspace, _wolf: string, git: GitRunner): Promise<BranchGraph> {
	const heads = new Map<string, string>();
	for (const line of (await git(ws.toplevel, ["for-each-ref", "--format=%(refname:short)%00%(objectname)", "refs/heads"])).split("\n")) {
		const [name, sha] = line.split("\0");
		if (name && sha) heads.set(name, sha);
	}
	const main = heads.get(ws.branch);
	if (!main) return { lanes: [], commits: [] };
	const isFeature = ws.branch.startsWith("feat/");
	const refs: LaneRef[] = [{ name: ws.branch, kind: isFeature ? "feature" : "wolf", tip: main }];
	// A home thread owns only the feature branches whose worktree sits beside its own checkout (same workspaces folder).
	const owned = isFeature ? undefined : await worktreeBranchesUnder(ws.toplevel, dirname(ws.toplevel), git);
	const children = [...heads.keys()]
		.filter((n) => (isFeature ? n.startsWith(`${ws.branch}--`) : n.startsWith("feat/") && owned!.has(n)))
		.sort();
	for (const n of children) refs.push({ name: n, kind: isFeature ? "subagent" : "feature", tip: heads.get(n)! });
	// Deleted children: second parents of merges on the main lane that no live branch already claims.
	const merges = await git(ws.toplevel, ["log", "--first-parent", "--merges", "-n", "20", "--format=%H%x00%P%x00%s", main, "--"]);
	const live = new Set(refs.map((r) => r.tip));
	const names = new Set(refs.map((r) => r.name));
	for (const m of parseLog(merges)) {
		const second = m.parents[1];
		if (!second || live.has(second)) continue;
		let name = mergedName(m.subject, second);
		if (names.has(name)) name = `${name} ${second.slice(0, 7)}`;
		names.add(name);
		live.add(second);
		refs.push({ name, kind: "merged", tip: second });
	}
	const out = await git(ws.toplevel, ["log", "--topo-order", "-n", "80", "--format=%H%x00%P%x00%s", ...new Set(refs.map((r) => r.tip)), "--"]);
	return buildBranchGraph(refs, parseLog(out));
}
