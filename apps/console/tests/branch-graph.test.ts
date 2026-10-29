import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildBranchGraph, type RawCommit } from "../src/core/branch-graph.ts";
import { parseLog } from "../src/server/branch-graph.ts";

/** newest-first log from "sha:parent,parent:subject" shorthand */
const log = (...rows: string[]): RawCommit[] => rows.map((r) => { const [sha, p, subject = sha] = r.split(":"); return { sha: sha!, parents: p ? p.split(",") : [], subject }; });
const laneOf = (g: ReturnType<typeof buildBranchGraph>, sha: string) => g.lanes[g.commits.find((c) => c.sha === sha)!.lane]!.name;

describe("buildBranchGraph", () => {
	it("linear history is one lane, oldest first", () => {
		const g = buildBranchGraph([{ name: "main", kind: "base", tip: "c" }], log("c:b", "b:a", "a:"));
		assert.deepEqual(g.lanes, [{ name: "main", kind: "base" }]);
		assert.deepEqual(g.commits.map((c) => c.sha), ["a", "b", "c"]);
		assert.deepEqual(g.commits[2]!.parents, ["b"]);
	});
	it("fork without merge: feature diverges ahead of base", () => {
		const g = buildBranchGraph([{ name: "main", kind: "base", tip: "b" }, { name: "feat", kind: "feature", tip: "f2" }], log("f2:f1", "f1:b", "b:a", "a:"));
		assert.equal(laneOf(g, "a"), "main");
		assert.equal(laneOf(g, "b"), "main");
		assert.equal(laneOf(g, "f1"), "feat");
		assert.equal(laneOf(g, "f2"), "feat");
		assert.deepEqual(g.commits.find((c) => c.sha === "f1")!.parents, ["b"]);
	});
	it("fork + merge: merged side branch keeps its own lane", () => {
		const g = buildBranchGraph(
			[{ name: "feat", kind: "feature", tip: "m" }, { name: "feat--sub-1", kind: "subagent", tip: "s2" }],
			log("m:f1,s2", "s2:s1", "s1:f1", "f1:a", "a:"),
		);
		assert.equal(laneOf(g, "m"), "feat");
		assert.equal(laneOf(g, "f1"), "feat");
		assert.equal(laneOf(g, "s1"), "feat--sub-1");
		assert.equal(laneOf(g, "s2"), "feat--sub-1");
		assert.deepEqual(g.commits.find((c) => c.sha === "m")!.parents, ["f1", "s2"]);
	});
	it("multiple subagent branches get separate lanes in ref order", () => {
		const g = buildBranchGraph(
			[{ name: "main", kind: "base", tip: "b" }, { name: "feat", kind: "feature", tip: "f" }, { name: "feat--x-1", kind: "subagent", tip: "x" }, { name: "feat--y-2", kind: "subagent", tip: "y" }],
			log("y:f", "x:f", "f:b", "b:a", "a:"),
		);
		assert.deepEqual(g.lanes.map((l) => l.name), ["main", "feat", "feat--x-1", "feat--y-2"]);
		assert.equal(laneOf(g, "x"), "feat--x-1");
		assert.equal(laneOf(g, "y"), "feat--y-2");
	});
	it("caps to the newest commits and drops empty lanes and cut parents", () => {
		const g = buildBranchGraph([{ name: "main", kind: "base", tip: "c" }, { name: "feat", kind: "feature", tip: "f" }], log("f:c", "c:b", "b:a", "a:"), 2);
		assert.deepEqual(g.commits.map((c) => c.sha), ["c", "f"]);
		assert.deepEqual(g.commits[0]!.parents, []);
		assert.equal(g.lanes.length, 2);
		const only = buildBranchGraph([{ name: "main", kind: "base", tip: "c" }, { name: "feat", kind: "feature", tip: "c" }], log("c:b", "b:"), 5);
		assert.deepEqual(only.lanes.map((l) => l.name), ["main"]);
	});
	it("unclaimed history (deleted branch) inherits a child's lane", () => {
		const g = buildBranchGraph([{ name: "feat", kind: "feature", tip: "m" }], log("m:f,gone", "gone:f", "f:"));
		assert.equal(laneOf(g, "gone"), "feat");
	});
});

describe("parseLog", () => {
	it("splits sha, parents and subject", () => {
		assert.deepEqual(parseLog("a\0b c\0hello\nd\0\0root\n"), [{ sha: "a", parents: ["b", "c"], subject: "hello" }, { sha: "d", parents: [], subject: "root" }]);
	});
});

describe("workspaceGraph (real repo)", () => {
	it("lays out base, feature and a subagent branch from read-only git", async () => {
		const { execFileSync } = await import("node:child_process");
		const { mkdtempSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { workspaceGraph } = await import("../src/server/branch-graph.ts");
		const dir = mkdtempSync(join(tmpdir(), "bg-"));
		const g = (...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { stdio: "pipe" });
		g("init", "-b", "main");
		g("commit", "--allow-empty", "-m", "root");
		g("checkout", "-b", "feat/x");
		g("commit", "--allow-empty", "-m", "f1");
		g("checkout", "-b", "feat/x--sub-1");
		g("commit", "--allow-empty", "-m", "s1");
		const graph = await workspaceGraph({ toplevel: dir, branch: "feat/x", base: "main" }, "w");
		assert.deepEqual(graph.lanes.map((l) => l.name), ["main", "feat/x", "feat/x--sub-1"]);
		assert.deepEqual(graph.commits.map((c) => c.subject), ["root", "f1", "s1"]);
	});
});
