/** Read-only git for the popover's branch graph: ref discovery + a bounded topo-ordered log, fed to the pure lane assignment. */
import { execFile } from "node:child_process";
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

/** The branch graph of a workspace: base, wolf branch, current branch and its `<branch>--*` subagent branches. */
export async function workspaceGraph(ws: GraphWorkspace, wolf: string, git: GitRunner = runGit): Promise<BranchGraph> {
	const heads = new Map<string, string>();
	for (const line of (await git(ws.toplevel, ["for-each-ref", "--format=%(refname:short)%00%(objectname)", "refs/heads"])).split("\n")) {
		const [name, sha] = line.split("\0");
		if (name && sha) heads.set(name, sha);
	}
	const refs: LaneRef[] = [];
	const seen = new Set<string>();
	const add = (name: string | undefined, kind: LaneRef["kind"]) => {
		const tip = name ? heads.get(name) : undefined;
		if (!name || !tip || seen.has(name)) return;
		seen.add(name);
		refs.push({ name, kind, tip });
	};
	add(ws.base ?? ["stable", "main"].find((b) => heads.has(b)), "base");
	add(`wolf/${wolf}`, "wolf");
	add(ws.branch, "feature");
	const subs = [...heads.keys()].filter((n) => n.startsWith(`${ws.branch}--`)).sort();
	for (const n of subs) add(n, "subagent");
	if (refs.length === 0) return { lanes: [], commits: [] };
	const out = await git(ws.toplevel, ["log", "--topo-order", "-n", "80", "--format=%H%x00%P%x00%s", ...new Set(refs.map((r) => r.tip)), "--"]);
	return buildBranchGraph(refs, parseLog(out));
}
