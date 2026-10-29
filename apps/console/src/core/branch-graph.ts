/**
 * Branch-graph model for the git popover: a pure lane assignment over a topo-ordered commit list.
 * No I/O here; src/server/branch-graph.ts feeds it from read-only git.
 */

export type LaneKind = "base" | "wolf" | "feature" | "subagent";

/** A branch to draw, in priority order (earlier lanes claim shared history first). `tip` is its head sha. */
export interface LaneRef {
	name: string;
	kind: LaneKind;
	tip: string;
}

/** One `git log --topo-order` row (newest first). */
export interface RawCommit {
	sha: string;
	parents: string[];
	subject: string;
}

export interface GraphLane {
	name: string;
	kind: LaneKind;
}

/** A commit in the graph; `lane` indexes `lanes`. Commits are oldest → newest, so the array index is the x position. */
export interface GraphCommit {
	sha: string;
	subject: string;
	/** Parent shas that are inside the graph window (older parents are cut off). */
	parents: string[];
	lane: number;
}

export interface BranchGraph {
	lanes: GraphLane[];
	commits: GraphCommit[];
}

export const GRAPH_COMMIT_LIMIT = 18;

/**
 * Assign each commit to a lane. Lanes claim commits in priority order by walking their first-parent chain from the
 * tip and stopping at an already-claimed commit; so a merged subagent branch (reachable only through the merge's
 * second parent) keeps its own lane, giving fork + merge-back, while an unmerged one diverges ahead of the feature.
 * Commits no lane claims (a deleted branch's history) inherit the lane of a child. Only the newest `limit` commits are
 * kept and lanes with no commit left are dropped.
 */
export function buildBranchGraph(refs: LaneRef[], log: RawCommit[], limit = GRAPH_COMMIT_LIMIT): BranchGraph {
	const bySha = new Map(log.map((c) => [c.sha, c]));
	const claimed = new Map<string, number>();
	refs.forEach((ref, i) => {
		let sha: string | undefined = ref.tip;
		while (sha && bySha.has(sha) && !claimed.has(sha)) {
			claimed.set(sha, i);
			sha = bySha.get(sha)!.parents[0];
		}
	});
	// Unclaimed commits: newest first, so a child is already placed. Prefer a child that has it as first parent.
	const children = new Map<string, string[]>();
	for (const c of log) for (const p of c.parents) children.set(p, [...(children.get(p) ?? []), c.sha]);
	for (const c of log) {
		if (claimed.has(c.sha)) continue;
		const kids = children.get(c.sha) ?? [];
		const first = kids.find((k) => bySha.get(k)?.parents[0] === c.sha && claimed.has(k)) ?? kids.find((k) => claimed.has(k));
		claimed.set(c.sha, first !== undefined ? claimed.get(first)! : 0);
	}
	const window = log.slice(0, Math.max(0, limit));
	const inWindow = new Set(window.map((c) => c.sha));
	const used = [...new Set(window.map((c) => claimed.get(c.sha)!))].sort((a, b) => a - b);
	const remap = new Map(used.map((old, i) => [old, i]));
	return {
		lanes: used.map((i) => ({ name: refs[i]!.name, kind: refs[i]!.kind })),
		commits: window
			.map((c) => ({ sha: c.sha, subject: c.subject, parents: c.parents.filter((p) => inWindow.has(p)), lane: remap.get(claimed.get(c.sha)!)! }))
			.reverse(),
	};
}
