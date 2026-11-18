import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ageLabel, agentName, featureOfItem, candidateWorkIds, collapseRows, preferredDomain, buildMoments, createdAt, headerStatus, branchShortId, groupRuns, isVersionTag, landedMoments, landingsFrom, mergeNear, middleClip, placeBandLabel, parseReflog, placeLabels, shipMoments, swimLanes, tagLabel, timeScale, workIdOfSubject, type GitOverview, type Landing, type Moment, type OverviewBranch, type RawCommit } from "../../../src/core/graph/branch-graph.ts";
import { parseLog, parsePrs, workspaceGraph } from "../../../src/server/thread/branch-graph.ts";

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
		// an all-lowercase word is not a base62 work id (feat/preview-slot-pair would otherwise be looked up as work-*-preview)
		assert.equal(branchShortId("feat/preview-slot-pair"), null);
	});
	it("sums added and removed lines per run from numstat", () => {
		const log = parseLog("\x01b\0a\0two (work-wolfpack-1nLJglH)\x00200\n3\t1\tf.ts\n-\t-\timg.png\n\x01a\0\0one (work-wolfpack-1nLJglH)\x00100\n10\t4\tg.ts\n");
		const runs = groupRuns(log);
		assert.deepEqual(runs.map((r) => [r.count, r.added, r.removed]), [[2, 13, 5]]);
	});
	it("looks a branch's short id up in every work domain", () => {
		assert.deepEqual(candidateWorkIds("0HuY8Al"), ["work-personal-0HuY8Al", "work-snapjack-0HuY8Al", "work-wolfpack-0HuY8Al"]);
		// the thread's own domain goes first, so the other domains are not asked (and do not 404) once it hits
		assert.deepEqual(candidateWorkIds("0HuY8Al", "wolfpack"), ["work-wolfpack-0HuY8Al", "work-personal-0HuY8Al", "work-snapjack-0HuY8Al"]);
		assert.equal(preferredDomain(["work-wolfpack-AAAAAAA", "work-snapjack-BBBBBBB", "work-wolfpack-CCCCCCC"]), "wolfpack");
		assert.equal(preferredDomain([]), undefined);
	});
	it("labels ages", () => {
		assert.equal(ageLabel(1000, 1000 + 4 * 86400 + 5), "4d ago");
		assert.equal(ageLabel(1000, 1000 + 7200), "2h ago");
		assert.equal(ageLabel(null, 5), "?");
	});
});

const br = (name: string, ahead: number, behind = 0, splitAt: number | null = 1): OverviewBranch => ({ name, kind: "feature", ahead, behind, landed: ahead === 0, splitAt, lastAt: 1, dirty: false, shortId: null });
const ov = (over: Partial<GitOverview>): GitOverview => ({ main: { name: "wolf/w", kind: "wolf" }, history: [], branches: [], siblings: [], home: "wolf/w", stable: "stable", parent: null, prs: [], tags: [], landings: [], unreleased: null, unmerged: null, ...over });

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
		assert.deepEqual(m.map((x) => [x.kind, x.lane, x.label]), [["pr", "stable", "PR #7"], ["split", "feat/A", "split · feat/A"], ["release", "stable", "console 0.1.14"]]);
		assert.deepEqual(m.map((x) => x.at), [NOW - 3 * DAY, NOW - 2 * DAY, NOW - DAY]);
		assert.equal(buildMoments(o, [], NOW, 30).filter((x) => x.kind === "split").length, 2);
	});
	it("merges landed rings in time order", () => {
		const ring: Moment = { at: NOW - DAY * 1.5, kind: "landed", lane: "wolf/w", label: "Floating bar ✓", workId: "work-wolfpack-AAAAAAA" };
		assert.deepEqual(buildMoments(ov({ tags: [{ name: "v1", at: NOW - DAY }] }), [ring], NOW, 7).map((x) => x.kind), ["landed", "release"]);
	});
	it("labels a release by its short version", () => {
		assert.equal(tagLabel("console/v0.1.14"), "console 0.1.14");
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

describe("parseReflog", () => {
	const out = [
		"abc0009 wolf/w@{900} merge feat/Fea1111-x--worker-ab12cd34: Fast-forward",
		"abc0008 wolf/w@{800} merge abc0007: Fast-forward",
		"abc0007 wolf/w@{700} commit (merge): Merge branch 'feat/B' into wolf/w",
		"abc0006 wolf/w@{600} commit: tweak",
		"abc0005 wolf/w@{500} cherry-pick: x",
		"abc0004 wolf/w@{400} rebase (finish): returning to refs/heads/wolf/w",
		"abc0003 wolf/w@{300} reset: moving to HEAD~1",
		"abc0002 wolf/w@{200} pull: Fast-forward",
		"abc0001 wolf/w@{100} branch: Created from 9c569f1f",
	].join("\n");
	it("reads landings (fast-forward and real merges) with their source, a creation, and ignores other moves", () => {
		const e = parseReflog(out);
		assert.deepEqual(e.map((x) => [x.kind, x.at]), [["landing", 900], ["landing", 800], ["landing", 700], ["other", 600], ["other", 500], ["other", 400], ["other", 300], ["other", 200], ["created", 100]]);
		assert.deepEqual(e.slice(0, 3).map((x) => x.source), ["feat/Fea1111-x--worker-ab12cd34", "abc0007", "feat/B"]);
		assert.equal(e[0]!.sha, "abc0009");
		assert.equal(createdAt(e), 100);
		assert.equal(createdAt(parseReflog("abc0002 wolf/w@{200} commit: x")), null);
	});
});

describe("landingsFrom", () => {
	const commit = (sha: string, parent: string | null, subject: string): RawCommit => ({ sha, parents: parent ? [parent] : [], subject });
	const log = [commit("abc0003", "abc0002", "b (work-wolfpack-T000002)"), commit("abc0002", "abc0001", "a (work-wolfpack-T000001)"), commit("abc0001", null, "base")];
	it("names a landing by the commits it brought: the range from the previous reflog value to the new one", () => {
		const entries = parseReflog("abc0003 wolf/w@{300} merge abc0003: Fast-forward\nabc0001 wolf/w@{100} branch: Created from HEAD");
		const l = landingsFrom(entries, log, "main", 0);
		assert.deepEqual(l, [{ at: 300, lane: "main", source: "abc0003", sha: "abc0003", commits: 2, workIds: ["work-wolfpack-T000001", "work-wolfpack-T000002"] }]);
	});
	it("only keeps landings inside the window, and uses just the tip when the range's start is unknown", () => {
		const entries = parseReflog("abc0003 wolf/w@{300} merge feat/x: Fast-forward");
		assert.deepEqual(landingsFrom(entries, log, "home", 400), []);
		const only = landingsFrom(entries, log, "home", 0);
		assert.deepEqual([only[0]!.commits, only[0]!.workIds, only[0]!.lane], [1, ["work-wolfpack-T000002"], "home"]);
	});
});

describe("landedMoments", () => {
	const task = (id: string, title: string) => ({ id, title, kind: "task", stage: "shipped", partOf: "work-wolfpack-Fea1111" });
	const landing = (over: Partial<Landing>): Landing => ({ at: 500, lane: "main", source: null, sha: "x", commits: 1, workIds: [], ...over });
	it("a feature thread rings each landing at its exact time, labelled by the tasks; with no work item title there is no label (never a hash, branch or agent)", () => {
		const items = { "work-wolfpack-T000001": task("work-wolfpack-T000001", "Task one") };
		const m = landedMoments(
			[landing({ at: 500, workIds: ["work-wolfpack-T000001"], source: "feat/Fea1111-x--worker-ab12cd34" }), landing({ at: 600, source: "feat/Fea1111-x--helper-0a1b2c3d" })],
			items,
			{ feature: "Fea1111", activeShortIds: [] },
		);
		assert.deepEqual(m.map((x) => [x.at, x.kind, x.lane, x.label, x.workIds]), [[500, "landed", "main", "Task one ✓", ["work-wolfpack-T000001"]], [600, "landed", "main", "", []]]);
	});
	it("home rings landed features that are not active lanes; the feature's own landing on home shows in its thread", () => {
		const feat = (id: string, title: string) => ({ id, title, kind: "feature", stage: "shipped", partOf: null });
		const items = { "work-wolfpack-Fea2222": feat("work-wolfpack-Fea2222", "Done feature"), "work-wolfpack-Act1111": feat("work-wolfpack-Act1111", "Active one") };
		const home = landedMoments([landing({ workIds: ["work-wolfpack-Fea2222"] }), landing({ at: 600, workIds: ["work-wolfpack-Act1111"] })], items, { feature: null, activeShortIds: ["Act1111"] });
		assert.deepEqual(home.map((x) => x.label), ["Done feature ✓"]);
		const mine = landedMoments([landing({ lane: "home", workIds: ["work-wolfpack-Fea1111"] }), landing({ lane: "home", at: 700, workIds: ["work-wolfpack-Fea2222"] })], { "work-wolfpack-Fea1111": feat("work-wolfpack-Fea1111", "This one"), ...items }, { feature: "Fea1111", activeShortIds: [] });
		assert.deepEqual(mine.map((x) => [x.lane, x.label]), [["home", "This one ✓"]]);
	});
	it("falls back to the work item's ship date only for items the reflog did not cover", () => {
		const item = (id: string) => ({ id, title: `T ${id}`, kind: "task", stage: "shipped", updated: "1970-04-10", partOf: "work-wolfpack-Fea1111" });
		const m = shipMoments([item("work-wolfpack-T000001"), item("work-wolfpack-T000002")], { feature: "Fea1111", nowSec: NOW, activeShortIds: [], covered: ["work-wolfpack-T000001"] });
		assert.deepEqual(m.map((x) => x.workId), ["work-wolfpack-T000002"]);
	});
});

describe("isVersionTag", () => {
	it("keeps tags that look like versions and drops the rest", () => {
		assert.deepEqual(["console/v0.1.14", "v2.0.0", "wolfd/v0.1.8", "main", "nightly", "release/candidate"].map(isVersionTag), [true, true, true, false, false, false]);
	});
});

describe("placeLabels with obstacles", () => {
	it("a label that would run into the NEXT flag's shape is dropped; the flag's own shape does not block it", () => {
		const shape = (x: number) => ({ key: "stable-above", x: x - 6, w: 12, obstacle: true });
		const label = (x: number, w: number) => ({ key: "stable-above", x: x + 13, w });
		// flag A at 100 with an 80px label (113..193), flag B at 150 with a short label (163..193)
		const keep = placeLabels([shape(100), label(100, 80), shape(150), label(150, 30)]);
		assert.deepEqual(keep, [true, false, true, true]);
	});
});

describe("placeLabels", () => {
	it("drops the later label when two on the same side of a lane would overlap, keeps others", () => {
		const keep = placeLabels([{ key: "stable-below", x: 90, w: 40 }, { key: "stable-below", x: 0, w: 40 }, { key: "stable-below", x: 30, w: 40 }, { key: "stable-above", x: 30, w: 40 }]);
		assert.deepEqual(keep, [true, true, false, true]);
	});
});

describe("mergeNear", () => {
	const at = (t: number, kind: Moment["kind"], label: string, lane = "stable", detail?: string): Moment => ({ at: t, kind, lane, label, detail });
	const xOf = (t: number) => t;
	it("merges release flags closer than the gap: newest BY TIME labelled with its package and +N; the detail lists each full tag newest first, once", () => {
		const rel = (t: number, tag: string): Moment => ({ ...at(t, "release", tagLabel(tag)), tag });
		// listed out of time order, with one tag repeated
		const m = mergeNear([rel(20, "hubd/v0.1.3"), rel(0, "console/v0.1.1"), rel(10, "console/v0.1.2"), rel(10, "console/v0.1.2"), rel(100, "console/v0.1.4"), at(5, "pr", "PR #1")], "release", xOf, 40);
		assert.deepEqual(m.filter((x) => x.kind === "release").map((x) => [x.at, x.label]), [[20, "hubd 0.1.3 +2"], [100, "console 0.1.4"]]);
		assert.equal(m.find((x) => x.at === 20)!.detail, "hubd/v0.1.3, console/v0.1.2, console/v0.1.1");
		assert.equal(m.filter((x) => x.kind === "pr").length, 1);
	});
	it("merges landed rings closer than the gap on one lane into one ring with the count in the tooltip; other lanes stay apart", () => {
		const ring = (t: number, label: string, lane = "main", ids: string[] = []): Moment => ({ ...at(t, "landed", label, lane, `from x · 1 commit`), workIds: ids });
		const m = mergeNear([ring(0, "A ✓", "main", ["a"]), ring(5, "", "main", ["b"]), ring(9, "C ✓", "main"), ring(8, "D ✓", "home"), ring(60, "E ✓")], "landed", xOf, 12);
		assert.deepEqual(m.map((x) => [x.lane, x.at, x.label]), [["home", 8, "D ✓"], ["main", 9, "C ✓"], ["main", 60, "E ✓"]]);
		assert.match(m[1]!.detail!, /3 landings/);
		assert.deepEqual(m[1]!.workIds, ["a", "b"]);
	});
});

describe("collapseRows", () => {
	const row = (at: number, kind: Moment["kind"], workId: string | null, label = "x"): Moment => ({ at, kind, lane: "main", label, workId });
	it("collapses consecutive identical rows (same kind and work item, within an hour) into one with a count, newest first", () => {
		const rows = collapseRows([row(9000, "landed", "w1"), row(8000, "landed", "w1"), row(7000, "landed", "w1"), row(6000, "landed", "w2"), row(5000, "landed", "w1"), row(900000, "landed", "w1")].sort((a, b) => b.at - a.at));
		assert.deepEqual(rows.map((r) => [r.moment.at, r.moment.workId, r.count]), [[900000, "w1", 1], [9000, "w1", 3], [6000, "w2", 1], [5000, "w1", 1]]);
	});
	it("rows with no work item collapse only when their label matches; different kinds never collapse", () => {
		const rows = collapseRows([row(300, "pr", null, "PR #1"), row(200, "pr", null, "PR #2"), row(100, "release", null, "PR #2")]);
		assert.deepEqual(rows.map((r) => r.count), [1, 1, 1]);
	});
});

describe("placeBandLabel", () => {
	it("keeps the label at the band's left, else tries the right end, else drops it to the tooltip", () => {
		const taken = [{ key: "r", x: 100, w: 40 }];
		assert.equal(placeBandLabel({ key: "r", left: 0, right: 400, w: 50 }, taken), 0);
		assert.equal(placeBandLabel({ key: "r", left: 90, right: 400, w: 120 }, taken), 280);
		assert.equal(placeBandLabel({ key: "r", left: 90, right: 200, w: 120 }, [...taken, { key: "r", x: 180, w: 10 }]), null);
		assert.equal(placeBandLabel({ key: "other", left: 90, right: 400, w: 120 }, taken), 90);
	});
});

describe("middleClip", () => {
	it("keeps short text, and clips the middle of long text with an ellipsis", () => {
		assert.equal(middleClip("wolf/1uk4", 20), "wolf/1uk4");
		assert.equal(middleClip("feat/n73bJGY-console-polish--thread-git-graph", 21), "feat/n73bJ…-git-graph");
		assert.equal(middleClip("feat/n73bJGY-console-polish--thread-git-graph", 21).length, 21);
	});
});

describe("timeScale fit", () => {
	const times = [100 * DAY - 6 * DAY, 100 * DAY - 5 * DAY, 100 * DAY - 2 * DAY, 100 * DAY - DAY];
	it("compresses to the target width, keeping moments ordered", () => {
		const natural = timeScale(times, NOW - 7 * DAY, NOW);
		assert.ok(natural.width > 150);
		const fit = timeScale(times, NOW - 7 * DAY, NOW, { width: 150, grow: false });
		assert.ok(fit.width <= 150 + 0.001);
		const xs = times.map(fit.x);
		assert.deepEqual([...xs].sort((a, b) => a - b), xs);
		assert.ok(xs[0]! > 0);
	});
	it("fitting squeezes the quiet stretches to the minimum first, so a busy stretch keeps its width", () => {
		// 4 moments within 2h of each other (busy, 16px each), then quiet days before them
		const busy = [NOW - 3 * 3600, NOW - 2.9 * 3600, NOW - 2.8 * 3600, NOW - 2.7 * 3600];
		const quiet = [NOW - 6 * DAY, NOW - 4 * DAY, NOW - 2 * DAY];
		const all = [...quiet, ...busy];
		const natural = timeScale(all, NOW - 7 * DAY, NOW);
		const target = natural.width - 100;
		const fit = timeScale(all, NOW - 7 * DAY, NOW, { width: target, grow: false });
		assert.ok(Math.abs(fit.width - target) < 0.001);
		const nat = timeScale(all, NOW - 7 * DAY, NOW);
		for (let i = 1; i < busy.length; i++) assert.ok(Math.abs(fit.x(busy[i]!) - fit.x(busy[i - 1]!) - (nat.x(busy[i]!) - nat.x(busy[i - 1]!))) < 0.001, "busy stretch unchanged");
		assert.ok(fit.x(quiet[1]!) - fit.x(quiet[0]!) >= 16 - 0.001, "quiet stretch not below the minimum while room remains");
		assert.ok(fit.x(quiet[1]!) - fit.x(quiet[0]!) < nat.x(quiet[1]!) - nat.x(quiet[0]!), "quiet stretch squeezed");
	});
	it("this thread's real shape: 3 PRs and ~37 release tags over 6 days, then 30 moments in the last 4 hours; the last 4 hours get at least half the card", () => {
		const quiet = Array.from({ length: 40 }, (_, i) => NOW - 6 * DAY + i * 3 * 3600);
		const busy = Array.from({ length: 30 }, (_, i) => NOW - 4 * 3600 + 600 + i * 450);
		const fit = timeScale([...quiet, ...busy], NOW - 7 * DAY, NOW, { width: 380, grow: false });
		assert.ok(Math.abs(fit.width - 380) < 0.001);
		assert.ok(fit.x(NOW) - fit.x(NOW - 4 * 3600) >= 190, `last 4h got ${fit.x(NOW) - fit.x(NOW - 4 * 3600)}px of 380`);
		const xs = [...quiet, ...busy].map(fit.x);
		assert.deepEqual([...xs].sort((a, b) => a - b), xs);
	});
	it("home shape: 2 PR clusters 4 and 1 days ago, 3 splits in the last 3 hours, 380px; quiet gaps stay under their 48px cap and the last 3 hours get 40%+", () => {
		const times = [4 * DAY, 4 * DAY - 600, 1 * DAY, 1 * DAY - 600].map((d) => NOW - d).concat([3 * 3600, 2 * 3600, 3600].map((h) => NOW - h));
		const fit = timeScale(times, NOW - 7 * DAY, NOW, { width: 380, grow: false });
		const anchors = [NOW - 7 * DAY, ...times, NOW].sort((a, b) => a - b);
		for (let i = 1; i < anchors.length; i++) {
			if (anchors[i]! - anchors[i - 1]! > 8 * 3600) assert.ok(fit.x(anchors[i]!) - fit.x(anchors[i - 1]!) <= 48.001, `quiet gap ${i} is ${fit.x(anchors[i]!) - fit.x(anchors[i - 1]!)}px`);
		}
		const recent = fit.x(NOW) - fit.x(NOW - 3 * 3600);
		assert.ok(recent >= 380 * 0.4, `last 3h got ${recent}px of 380`);
		assert.ok(fit.width <= 380 + 0.001);
	});
	it("only when the minimums alone overflow does it scale everything evenly", () => {
		const times = Array.from({ length: 20 }, (_, i) => NOW - 3600 + i * 60);
		const fit = timeScale(times, NOW - DAY, NOW, { width: 100, grow: false });
		assert.ok(Math.abs(fit.width - 100) < 0.001);
		const xs = times.map(fit.x);
		assert.deepEqual([...xs].sort((a, b) => a - b), xs);
	});
	it("a card does not stretch a short axis, but the large view grows it to exactly the width", () => {
		const natural = timeScale(times, NOW - 7 * DAY, NOW);
		assert.equal(timeScale(times, NOW - 7 * DAY, NOW, { width: 5000, grow: false }).width, natural.width);
		assert.ok(Math.abs(timeScale(times, NOW - 7 * DAY, NOW, { width: 5000, grow: true }).width - 5000) < 0.001);
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
		g("tag", "nightly");
		g("checkout", "-q", "wolf/w");
		commit(dir, "home 2");
		commit(dir, "home 3");
		const o = await workspaceGraph({ toplevel: dir, branch: "wolf/w" }, "w");
		assert.equal(o.stable, "stable");
		assert.deepEqual(o.prs.map((p) => p.n), [7]);
		assert.deepEqual(o.tags.map((t) => t.name), ["console/v0.1.14"]); // the lightweight "nightly" tag is not a version
		assert.equal(o.unreleased!.count, 2);
		assert.equal(typeof o.unreleased!.since, "number");
	});

	it("split time is the branch's creation in the reflog (not the old merge-base); a fast-forward landing is read from the parent's reflog", async () => {
		const { root, dir, g, run } = repo();
		const old = { ...process.env, GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z", GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z" };
		execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "root (work-wolfpack-AAAAAAA)"], { stdio: "pipe", env: old });
		g("worktree", "add", "-b", "feat/Rfl1111-x", join(root, "x"));
		run(join(root, "x"), "commit", "--allow-empty", "-m", "x1 (work-wolfpack-Rfl1111)");
		g("merge", "--ff-only", "feat/Rfl1111-x");
		const o = await workspaceGraph({ toplevel: dir, branch: "wolf/w" }, "w");
		const b = o.branches.find((x) => x.name === "feat/Rfl1111-x")!;
		assert.ok(b.splitAt! > Date.parse("2024-01-01") / 1000, "created time, not the 2020 merge-base");
		assert.deepEqual(o.landings.map((l) => [l.lane, l.source, l.workIds]), [["main", "feat/Rfl1111-x", ["work-wolfpack-Rfl1111"]]]);
	});

	it("with no reflog for a branch (fresh clone) it falls back to the merge-base time and has no landings", async () => {
		const { root, dir, g, run } = repo();
		const old = { ...process.env, GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z", GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z" };
		execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "root"], { stdio: "pipe", env: old });
		g("worktree", "add", "-b", "feat/Nrf1111-x", join(root, "x"));
		run(join(root, "x"), "commit", "--allow-empty", "-m", "x1");
		g("reflog", "expire", "--expire=all", "--all");
		const o = await workspaceGraph({ toplevel: dir, branch: "wolf/w" }, "w");
		assert.equal(o.branches[0]!.splitAt, Date.parse("2020-01-01T00:00:00Z") / 1000);
		assert.deepEqual(o.landings, []);
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
