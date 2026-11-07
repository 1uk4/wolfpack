import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ageLabel, agentName, featureOfItem, candidateWorkIds, buildMoments, headerStatus, branchShortId, groupRuns, shipMoments, swimLanes, tagLabel, timeScale, workIdOfSubject, type GitOverview, type Moment, type OverviewBranch, type RawCommit } from "../src/core/branch-graph.ts";
import { parseLog, parsePrs, workspaceGraph } from "../src/server/branch-graph.ts";

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

const br = (name: string, ahead: number, behind = 0, splitAt: number | null = 1): OverviewBranch => ({ name, kind: "feature", ahead, behind, landed: ahead === 0, splitAt, lastAt: 1, dirty: false, shortId: null });
const ov = (over: Partial<GitOverview>): GitOverview => ({ main: { name: "wolf/w", kind: "wolf" }, history: [], branches: [], siblings: [], home: "wolf/w", stable: "stable", parent: null, prs: [], tags: [], unreleased: null, unmerged: null, ...over });

const DAY = 86400;
const NOW = 100 * DAY;

describe("swimLanes", () => {
	it("feature thread: subagents, this feature (bold), sibling features, home, stable; landed ones get no lane", () => {
		const o = ov({
			main: { name: "feat/Fea1111-x", kind: "feature" },
			parent: { name: "wolf/w", ahead: 2, behind: 5, forkAt: NOW - 3 * DAY },
			branches: [{ ...br("feat/Fea1111-x--a-1", 1, 0, NOW - DAY), kind: "subagent" }, { ...br("feat/Fea1111-x--b-2", 0), kind: "subagent" }],
			siblings: [br("feat/Sib2222-y", 4, 9, NOW - 5 * DAY), br("feat/Old3333-z", 0)],
		});
		const lanes = swimLanes(o);
		assert.deepEqual(lanes.map((l) => [l.name, l.role, l.bold, l.parent]), [
			["feat/Fea1111-x--a-1", "child", false, "feat/Fea1111-x"],
			["feat/Fea1111-x", "main", true, "wolf/w"],
			["feat/Sib2222-y", "sibling", false, "wolf/w"],
			["wolf/w", "home", false, null],
			["stable", "stable", false, null],
		]);
		assert.equal(lanes[1]!.forkAt, NOW - 3 * DAY);
	});
	it("home thread: active features, home (bold), stable", () => {
		const lanes = swimLanes(ov({ branches: [br("feat/A", 2, 0, NOW - DAY), br("feat/B", 0)] }));
		assert.deepEqual(lanes.map((l) => [l.name, l.role, l.bold, l.parent]), [["feat/A", "feature", false, "wolf/w"], ["wolf/w", "home", true, null], ["stable", "stable", false, null]]);
	});
	it("has no stable lane when the repo has none", () => {
		assert.deepEqual(swimLanes(ov({ stable: null })).map((l) => l.name), ["wolf/w"]);
	});
});

describe("buildMoments", () => {
	it("lists splits, PRs and releases inside the window, oldest first, and leaves older ones out", () => {
		const o = ov({
			branches: [br("feat/A", 2, 0, NOW - 2 * DAY), br("feat/Old", 3, 0, NOW - 20 * DAY)],
			prs: [{ n: 7, at: NOW - 3 * DAY, sha: "p7" }, { n: 3, at: NOW - 40 * DAY, sha: "p3" }],
			tags: [{ name: "console/v0.1.14", at: NOW - DAY }, { name: "console/v0.1.0", at: NOW - 50 * DAY }],
		});
		const m = buildMoments(o, [], NOW, 7);
		assert.deepEqual(m.map((x) => [x.kind, x.lane, x.label]), [["pr", "stable", "PR #7"], ["split", "feat/A", "split · feat/A"], ["release", "stable", "v0.1.14"]]);
		assert.deepEqual(m.map((x) => x.at), [NOW - 3 * DAY, NOW - 2 * DAY, NOW - DAY]);
		assert.equal(buildMoments(o, [], NOW, 30).filter((x) => x.kind === "split").length, 2);
	});
	it("merges landed rings in time order", () => {
		const ring: Moment = { at: NOW - DAY * 1.5, kind: "landed", lane: "wolf/w", label: "Floating bar ✓", workId: "work-wolfpack-AAAAAAA" };
		assert.deepEqual(buildMoments(ov({ tags: [{ name: "v1", at: NOW - DAY }] }), [ring], NOW, 7).map((x) => x.kind), ["landed", "release"]);
	});
	it("labels a release by its short version", () => {
		assert.equal(tagLabel("console/v0.1.14"), "v0.1.14");
		assert.equal(tagLabel("v2.0.0"), "v2.0.0");
	});
});

describe("shipMoments", () => {
	const item = (id: string, over: Partial<{ title: string; kind: string; stage: string; updated: string; partOf: string | null }> = {}) => ({ id, title: `T ${id}`, kind: "task", stage: "shipped", updated: "1970-04-10", partOf: null, ...over });
	// day 99 (1970-04-10) is NOW - 1 day
	it("a feature thread rings its child tasks at their ship date; no ship date or unfinished work is skipped", () => {
		const ctx = { feature: "Fea1111", nowSec: NOW, activeShortIds: [] as string[] };
		const subjects = [
			item("work-wolfpack-T000001", { partOf: "work-wolfpack-Fea1111" }),
			item("work-wolfpack-T000002", { partOf: "work-wolfpack-Fea1111", updated: "" }),
			item("work-wolfpack-T000003", { partOf: "work-wolfpack-Fea1111", stage: "build" }),
			item("work-wolfpack-T000004", { partOf: "work-wolfpack-Other11" }),
		];
		const m = shipMoments(subjects, ctx);
		assert.deepEqual(m.map((x) => [x.kind, x.lane, x.workId, x.label]), [["landed", "main", "work-wolfpack-T000001", "T work-wolfpack-T000001 ✓"]]);
		assert.ok(m[0]!.at <= NOW && m[0]!.at > NOW - 2 * DAY);
	});
	it("home rings shipped features that are not active lanes; once per feature", () => {
		const ctx = { feature: null, nowSec: NOW, activeShortIds: ["Act1111"] };
		const m = shipMoments([item("work-wolfpack-Fea2222", { kind: "feature" }), item("work-wolfpack-Fea2222", { kind: "feature" }), item("work-wolfpack-Act1111", { kind: "feature" }), item("work-wolfpack-Tsk3333", { kind: "task" })], ctx);
		assert.deepEqual(m.map((x) => [x.lane, x.workId]), [["main", "work-wolfpack-Fea2222"]]);
	});
});

describe("timeScale", () => {
	it("orders moments left to right and caps quiet stretches so busy days get the width", () => {
		const times = [NOW - 6 * DAY, NOW - 6 * DAY + 600, NOW - 6 * DAY + 1200, NOW - 2 * DAY];
		const s = timeScale(times, NOW - 7 * DAY, NOW);
		const xs = times.map(s.x);
		assert.deepEqual([...xs].sort((a, b) => a - b), xs);
		assert.ok(xs[1]! - xs[0]! >= 16, "close moments keep a minimum gap");
		assert.ok(xs[3]! - xs[2]! <= 48, "a four-day quiet stretch is capped");
		assert.ok(s.x(NOW) >= xs[3]! && s.x(NOW) <= s.width);
		assert.equal(s.x(NOW - 7 * DAY), 0);
	});
	it("an empty window is just its start and end", () => {
		const s = timeScale([], 0, DAY);
		assert.ok(s.x(DAY) > s.x(0));
	});
});

describe("featureOfItem", () => {
	it("finds an item's feature: itself for a feature, its parent when that is a feature, none for loose work", () => {
		assert.equal(featureOfItem({ id: "f", kind: "feature" }, null), "f");
		assert.equal(featureOfItem({ id: "t", kind: "task" }, { id: "f", kind: "feature" }), "f");
		assert.equal(featureOfItem({ id: "t", kind: "task" }, { id: "inbox", kind: "initiative", container: true }), null);
		assert.equal(featureOfItem({ id: "t", kind: "task" }, null), null);
	});
});

describe("parsePrs", () => {
	it("reads PR numbers from first-parent merge commits on stable, ignoring other merges", () => {
		const out = "a\0p1 p2\0Merge pull request #10 from 1uk4/wolf/1uk4\x00200\nb\0q1 q2\0Merge branch 'x'\x00150\nc\0r1 r2\0Merge pull request #7 from 1uk4/feat/y\x00100\n";
		assert.deepEqual(parsePrs(out), [{ n: 7, at: 100, sha: "c" }, { n: 10, at: 200, sha: "a" }]);
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
		assert.deepEqual([by["feat/Old1111-old"]!.ahead, by["feat/Old1111-old"]!.behind], [2, 5]);
		assert.equal(by["feat/Old1111-old"]!.shortId, "Old1111");
		assert.deepEqual([by["feat/New2222-new"]!.ahead, by["feat/New2222-new"]!.behind, by["feat/New2222-new"]!.dirty], [1, 1, true]);
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
		assert.deepEqual([o.parent!.name, o.parent!.ahead, o.parent!.behind, typeof o.parent!.forkAt], ["wolf/w", 1, 2, "number"]);
		assert.deepEqual(o.siblings.map((b) => [b.name, b.ahead]), [["feat/Oth2222-other", 0]]);
		assert.equal(o.home, "wolf/w");
		assert.equal(o.unmerged!.count, 1);
		assert.deepEqual(o.branches.map((b) => [b.name, b.kind, b.ahead, b.behind]), [["feat/Fea1111-feat--a-1", "subagent", 1, 0]]);
		assert.equal(typeof o.branches[0]!.splitAt, "number");
	});

	it("stable: PR merges and release tags on it, and the home commits not yet released", async () => {
		const { dir, g, commit } = repo();
		commit(dir, "root");
		g("branch", "stable");
		commit(dir, "home 1");
		g("checkout", "-q", "stable");
		g("merge", "--no-ff", "-m", "Merge pull request #7 from 1uk4/wolf/w", "wolf/w");
		g("tag", "-a", "console/v0.1.14", "-m", "release");
		g("checkout", "-q", "wolf/w");
		commit(dir, "home 2");
		commit(dir, "home 3");
		const o = await workspaceGraph({ toplevel: dir, branch: "wolf/w" }, "w");
		assert.equal(o.stable, "stable");
		assert.deepEqual(o.prs.map((p) => p.n), [7]);
		assert.deepEqual(o.tags.map((t) => t.name), ["console/v0.1.14"]);
		assert.equal(o.unreleased!.count, 2);
		assert.equal(typeof o.unreleased!.since, "number");
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
