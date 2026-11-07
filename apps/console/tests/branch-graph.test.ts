import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ageLabel, agentName, candidateWorkIds, buildCard, headerStatus, branchShortId, groupRuns, workIdOfSubject, type GitOverview, type OverviewBranch, type RawCommit, type RunNode } from "../src/core/branch-graph.ts";
import { parseLog, workspaceGraph } from "../src/server/branch-graph.ts";

const raw = (...subjects: string[]): RawCommit[] => subjects.map((subject, i) => ({ sha: `s${i}`, parents: [], subject }));

describe("groupRuns", () => {
	it("groups consecutive commits of one work item, oldest to newest; commits without an ID group as null", () => {
		// newest first, as git log gives them
		const runs = groupRuns(raw("fix b (work-wolfpack-1nLJglH)", "more b (work-wolfpack-1nLJglH)", "wip", "also wip", "a (work-wolfpack-Zfjn1Vw)", "again a (work-wolfpack-1nLJglH)"));
		assert.deepEqual(runs.map((r) => [r.workId, r.count]), [["work-wolfpack-1nLJglH", 1], ["work-wolfpack-Zfjn1Vw", 1], [null, 2], ["work-wolfpack-1nLJglH", 2]]);
		assert.deepEqual(runs[3]!.shas, ["s1", "s0"]);
	});
	it("reads the full work ID from a subject and the short ID from a branch name", () => {
		assert.equal(workIdOfSubject("console: x (work-snapjack-AbC1234)"), "work-snapjack-AbC1234");
		assert.equal(workIdOfSubject("no id here"), null);
		assert.equal(branchShortId("feat/n73bJGY-console-polish--thread-git-graph-b7f21ea4"), "n73bJGY");
		assert.equal(branchShortId("feat/home--x-1"), null);
	});
	it("sums added and removed lines per run from numstat", () => {
		const log = parseLog("\x01b\0a\0two (work-wolfpack-1nLJglH)\x00200\n3\t1\tf.ts\n-\t-\timg.png\n\x01a\0\0one (work-wolfpack-1nLJglH)\x00100\n10\t4\tg.ts\n");
		const runs = groupRuns(log);
		assert.deepEqual(runs.map((r) => [r.count, r.added, r.removed]), [[2, 13, 5]]);
	});
	it("looks a branch's short id up in every work domain", () => {
		assert.deepEqual(candidateWorkIds("0HuY8Al"), ["work-personal-0HuY8Al", "work-snapjack-0HuY8Al", "work-wolfpack-0HuY8Al"]);
	});
	it("labels ages", () => {
		assert.equal(ageLabel(1000, 1000 + 4 * 86400 + 5), "4d ago");
		assert.equal(ageLabel(1000, 1000 + 7200), "2h ago");
		assert.equal(ageLabel(null, 5), "?");
	});
});

const br = (name: string, ahead: number, behind = 0): OverviewBranch => ({ name, kind: "feature", ahead, behind, landed: ahead === 0, forkIndex: 0, gap: 0, splitAt: 1, lastAt: 1, dirty: false, shortId: null });
const run = (workId: string | null, count: number): RunNode => ({ workId, count, sha: "x", subject: "s", shas: ["x"], time: 5, added: 0, removed: 0 });
const ov = (over: Partial<GitOverview>): GitOverview => ({ main: { name: "wolf/w", kind: "wolf" }, history: [], branches: [], parent: null, ...over });

describe("buildCard", () => {
	it("splits active from landed branches and keeps the 3 newest work-item runs with counts for the rest", () => {
		// history is oldest → newest
		const card = buildCard(ov({ history: [run("work-wolfpack-AAAAAAA", 4), run(null, 20), run("work-wolfpack-BBBBBBB", 5), run("work-wolfpack-CCCCCCC", 1), run(null, 2)], branches: [br("feat/a", 2), br("feat/b", 0), br("feat/c", 1)] }));
		assert.deepEqual(card.active.map((b) => b.name), ["feat/a", "feat/c"]);
		assert.deepEqual(card.landed.map((b) => b.name), ["feat/b"]);
		assert.deepEqual(card.recent.map((r) => [r.workId, r.count]), [[null, 2], ["work-wolfpack-CCCCCCC", 1], ["work-wolfpack-BBBBBBB", 5]]);
		assert.deepEqual(card.more, { items: 2, commits: 24 });
	});
	it("has no 'more' when the history fits in 3 runs", () => {
		assert.deepEqual(buildCard(ov({ history: [run(null, 1)] })).more, { items: 0, commits: 0 });
	});
});

describe("headerStatus", () => {
	it("home: clean/dirty, active and landed counts", () => {
		const o = ov({ branches: [br("feat/a", 2), br("feat/b", 1), br("feat/c", 0), br("feat/d", 0), br("feat/e", 0)] });
		assert.equal(headerStatus(o, false), "clean · 2 active branches · 3 landed");
		assert.equal(headerStatus(ov({ branches: [br("feat/a", 1)] }), true), "dirty · 1 active branch");
	});
	it("feature: says landed at 0 ahead, else ahead/behind, against its parent", () => {
		const parentOf = (ahead: number, behind: number) => ov({ main: { name: "feat/M72D2sk-install-and-onboarding", kind: "feature" }, parent: { name: "wolf/1uk4", ahead, behind } });
		assert.equal(headerStatus(parentOf(0, 20), false), "feat/M72D2sk ← wolf/1uk4 · landed (0 ahead · 20 behind) · clean");
		assert.equal(headerStatus(parentOf(3, 1), true), "feat/M72D2sk ← wolf/1uk4 · 3 ahead · 1 behind · dirty");
	});
});

describe("agentName", () => {
	it("takes the agent name from the --<agent>-<hex> suffix", () => {
		assert.equal(agentName("feat/n73bJGY-console--thread-git-graph-b7f21ea4"), "thread-git-graph");
		assert.equal(agentName("feat/x"), "feat/x");
	});
});

describe("parseLog", () => {
	it("splits sha, parents, subject and time", () => {
		assert.deepEqual(parseLog("a\0b c\0hello\x001700000000\nd\0\0root\x001\n"), [
			{ sha: "a", parents: ["b", "c"], subject: "hello", time: 1700000000 },
			{ sha: "d", parents: [], subject: "root", time: 1 },
		]);
	});
});

/** A temp repo: `home` (branch wolf/w) beside its worktrees folder. */
function repo() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "bg-")));
	const dir = join(root, "home");
	mkdirSync(dir);
	const run = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { stdio: "pipe" }).toString();
	const g = (...a: string[]) => run(dir, ...a);
	const commit = (cwd: string, subject: string) => run(cwd, "commit", "--allow-empty", "-m", subject);
	g("init", "-b", "wolf/w");
	return { root, dir, g, run, commit };
}

describe("workspaceGraph (real repo)", () => {
	it("home thread: main history grouped by work item; children by worktree folder with fork, ahead/behind, landed and dirty", async () => {
		const { root, dir, g, run, commit } = repo();
		const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "bg-else-")));
		commit(dir, "root (work-wolfpack-AAAAAAA)");
		g("branch", "stable");
		g("worktree", "add", "-b", "feat/Old1111-old", join(root, "old"));
		commit(join(root, "old"), "old work (work-wolfpack-Old1111)");
		commit(join(root, "old"), "old work 2 (work-wolfpack-Old1111)");
		for (const n of [1, 2, 3, 4]) commit(dir, `main ${n} (work-wolfpack-BBBBBBB)`);
		g("worktree", "add", "-b", "feat/New2222-new", join(root, "new"));
		commit(join(root, "new"), "new work (work-wolfpack-New2222)");
		writeFileSync(join(root, "new", "dirty.txt"), "x");
		g("worktree", "add", "-b", "feat/Done333-done", join(root, "done")); // 0 ahead: landed
		g("worktree", "add", "-b", "feat/Else444-else", join(elsewhere, "else"));
		commit(join(elsewhere, "else"), "other wolf");
		g("branch", "feat/Nowt555-no-worktree");
		g("worktree", "add", "-b", "feat/Done333-done--agent-ab12cd34", join(root, "child")); // a feature's subagent: not home's
		commit(dir, "main 5 no id");
		const o = await workspaceGraph({ toplevel: dir, branch: "wolf/w" }, "w", undefined, { commits: 4, days: 7 });
		assert.deepEqual(o.main, { name: "wolf/w", kind: "wolf" });
		assert.equal(o.parent, null);
		// window = the newest 4 main commits: BBBBBBB x3 before the unlabelled one
		assert.deepEqual(o.history.map((h) => [h.workId, h.count]), [["work-wolfpack-BBBBBBB", 3], [null, 1]]);
		assert.deepEqual(o.branches.map((b) => b.name), ["feat/Done333-done", "feat/New2222-new", "feat/Old1111-old"]);
		assert.deepEqual([o.history[0]!.added, o.history[0]!.removed], [0, 0]);
		const by = Object.fromEntries(o.branches.map((b) => [b.name, b]));
		assert.deepEqual([by["feat/Old1111-old"]!.ahead, by["feat/Old1111-old"]!.behind, by["feat/Old1111-old"]!.forkIndex], [2, 5, -1]);
		assert.equal(by["feat/Old1111-old"]!.gap, 1); // 5 behind, 4 in the window
		assert.equal(by["feat/Old1111-old"]!.shortId, "Old1111");
		assert.deepEqual([by["feat/New2222-new"]!.ahead, by["feat/New2222-new"]!.behind, by["feat/New2222-new"]!.forkIndex, by["feat/New2222-new"]!.dirty], [1, 1, 0, true]);
		assert.deepEqual([by["feat/Done333-done"]!.landed, by["feat/Done333-done"]!.dirty], [true, false]);
		assert.equal(by["feat/Old1111-old"]!.landed, false);
		assert.equal(by["feat/Done333-done"]!.ahead, 0);
		assert.equal(typeof by["feat/Old1111-old"]!.splitAt, "number");
		assert.equal(run(dir, "rev-parse", "--abbrev-ref", "HEAD").trim(), "wolf/w");
	});

	it("feature thread: its own subagent branches as children, and its ahead/behind against its parent", async () => {
		const { root, dir, g, commit } = repo();
		commit(dir, "root");
		g("worktree", "add", "-b", "feat/Fea1111-feat", join(root, "feat"));
		const feat = join(root, "feat");
		commit(feat, "f1 (work-wolfpack-Fea1111)");
		g("worktree", "add", "-b", "feat/Fea1111-feat--a-1", join(root, "sub"));
		// the subagent's worktree is cut from the feature in real use; here from home, so rebase the point
		execFileSync("git", ["-C", join(root, "sub"), "reset", "-q", "--hard", "feat/Fea1111-feat"]);
		commit(join(root, "sub"), "sub work");
		g("worktree", "add", "-b", "feat/Oth2222-other", join(root, "other"));
		commit(dir, "home moves");
		commit(dir, "home moves again");
		const o = await workspaceGraph({ toplevel: feat, branch: "feat/Fea1111-feat", base: "wolf/w" }, "w");
		assert.deepEqual(o.main, { name: "feat/Fea1111-feat", kind: "feature" });
		assert.deepEqual(o.parent, { name: "wolf/w", ahead: 1, behind: 2 });
		assert.deepEqual(o.branches.map((b) => [b.name, b.kind, b.ahead, b.behind]), [["feat/Fea1111-feat--a-1", "subagent", 1, 0]]);
		assert.equal(o.branches[0]!.forkIndex, o.history.length - 1);
	});

	it("a branch with nothing ahead is landed", async () => {
		const { root, dir, g, commit } = repo();
		commit(dir, "root");
		g("worktree", "add", "-b", "feat/Don1111-done", join(root, "done"));
		commit(dir, "later");
		const o = await workspaceGraph({ toplevel: dir, branch: "wolf/w" }, "w");
		assert.deepEqual(o.branches.map((b) => [b.name, b.ahead, b.behind, b.landed]), [["feat/Don1111-done", 0, 1, true]]);
	});

	it("a git timeout gives an empty overview; other errors still throw", async () => {
		const timeout = async () => { throw Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM" }); };
		assert.deepEqual((await workspaceGraph({ toplevel: "/x", branch: "b" }, "w", timeout)).history, []);
		const boom = async () => { throw new Error("not a repo"); };
		await assert.rejects(workspaceGraph({ toplevel: "/x", branch: "b" }, "w", boom), /not a repo/);
	});
});
