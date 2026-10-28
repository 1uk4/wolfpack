import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_WORK_SORT, NO_INITIATIVE_KEY, buildWorkTable, nextWorkSort, stageRank, type WorkSort } from "../src/core/work-table.ts";
import type { WorkListItem } from "../src/core/kb.ts";

const item = (id: string, kind: string, over: Partial<WorkListItem> = {}): WorkListItem => ({ id, title: id.toUpperCase(), kind, stage: "plan", domain: "d", dependsOn: [], ...over });

const items: WorkListItem[] = [
	item("i1", "initiative", { title: "Phase 1", created: "2026-10-01" }),
	item("f1", "feature", { partOf: "i1", stage: "in_build", created: "2026-10-05", assignee: "luka", title: "Work view" }),
	item("t1", "task", { partOf: "f1", stage: "shipped", created: "2026-10-05" }),
	item("t2", "task", { partOf: "f1", stage: "in_build", dependsOn: ["t1"], created: "2026-10-06" }),
	item("t3", "task", { partOf: "f1", stage: "plan", dependsOn: ["t1", "t2"], created: "2026-10-07" }),
	item("f2", "feature", { partOf: "i1", stage: "shipped", created: "2026-10-02", dependsOn: ["f1"], title: "Graduate" }),
	item("f3", "feature", { stage: "plan", created: "2026-10-09", assignee: "hal", title: "Loose feature" }),
	item("f4", "feature", { stage: "idea", created: "2026-10-08", title: "Zeta" }),
	item("inbox", "feature", { container: true, title: "Inbox" }),
	item("old", "feature", { stage: "archived", graduated: "2026-10-03", created: "2026-09-01", title: "Old one" }),
	item("oldt", "task", { partOf: "old", stage: "archived", created: "2026-09-01" }),
];

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describe("buildWorkTable: grouping", () => {
	it("groups features under initiatives, loose ones under No initiative (last), tasks under features", () => {
		const t = buildWorkTable(items);
		assert.deepEqual(t.groups.map((g) => g.key), ["i1", NO_INITIATIVE_KEY]);
		const [init, none] = t.groups;
		assert.equal(none!.title, "No initiative");
		assert.deepEqual(ids(none!.children).sort(), ["f3", "f4"]);
		assert.deepEqual(ids(init!.children).sort(), ["f1", "f2"]);
		const f1 = init!.children.find((r) => r.id === "f1")!;
		assert.deepEqual(ids(f1.children).sort(), ["t1", "t2", "t3"]);
		assert.deepEqual([init!.depth, f1.depth, f1.children[0]!.depth], [0, 1, 2]);
	});
	it("skips containers and omits the No initiative group when nothing is loose", () => {
		const t = buildWorkTable(items.filter((i) => i.id !== "f3" && i.id !== "f4"));
		assert.deepEqual(t.groups.map((g) => g.key), ["i1"]);
		assert.ok(!JSON.stringify(t).includes("Inbox"));
	});
	it("a loose task becomes a leaf row in No initiative", () => {
		const t = buildWorkTable([item("x", "task", { partOf: "inbox" }), item("inbox", "feature", { container: true })]);
		assert.deepEqual(ids(t.groups[0]!.children), ["x"]);
		assert.equal(t.groups[0]!.children[0]!.kind, "task");
	});
});

describe("buildWorkTable: progress, stage label, columns", () => {
	it("counts shipped tasks per feature and shipped features per initiative", () => {
		const [init] = buildWorkTable(items).groups;
		const f1 = init!.children.find((r) => r.id === "f1")!;
		assert.deepEqual(f1.progress, { shipped: 1, total: 3, label: "1/3 shipped" });
		assert.equal(init!.progress?.label, "1/2 shipped");
		assert.equal(f1.children[0]!.progress, null);
	});
	it("labels a shipped feature ready to graduate, via the graph pane's helper", () => {
		const [init] = buildWorkTable(items).groups;
		const f2 = init!.children.find((r) => r.id === "f2")!;
		assert.equal(f2.stageLabel, "shipped · ready to graduate");
		assert.equal(init!.children.find((r) => r.id === "f1")!.stageLabel, "in build");
		assert.equal(init!.children.find((r) => r.id === "f1")!.children.find((r) => r.id === "t1")!.stageLabel, "shipped");
	});
	it("carries assignee and created", () => {
		const f1 = buildWorkTable(items).groups[0]!.children.find((r) => r.id === "f1")!;
		assert.deepEqual([f1.assignee, f1.created], ["luka", "2026-10-05"]);
	});
});

describe("buildWorkTable: dependency premises", () => {
	const f1 = () => buildWorkTable(items).groups[0]!.children.find((r) => r.id === "f1")!;
	it("a task's premises are its task-level dependsOn, in order, styled by stage", () => {
		const t3 = f1().children.find((r) => r.id === "t3")!;
		assert.deepEqual(t3.premises.map((p) => [p.id, p.state]), [["t1", "shipped"], ["t2", "building"]]);
		assert.equal(t3.self?.state, "blocked");
	});
	it("a feature's premises are its feature-level dependsOn; a shipped feature is ready to graduate", () => {
		const f2 = buildWorkTable(items).groups[0]!.children.find((r) => r.id === "f2")!;
		assert.deepEqual(f2.premises.map((p) => [p.id, p.state]), [["f1", "building"]]);
		assert.equal(f2.self?.state, "ready");
	});
	it("a row with no dependsOn has no premises; initiatives carry none", () => {
		assert.deepEqual(f1().premises, []);
		assert.deepEqual(buildWorkTable(items).groups[0]!.premises, []);
	});
	it("a premise missing from the data neither shows nor blocks", () => {
		const t = buildWorkTable([item("a", "task", { dependsOn: ["gone"], stage: "plan" })]);
		const row = t.groups[0]!.children[0]!;
		assert.deepEqual(row.premises, []);
		assert.equal(row.self?.state, "plain");
	});
	it("a blocked premise is flagged blocked", () => {
		const t = buildWorkTable([item("a", "task", { stage: "plan" }), item("b", "task", { dependsOn: ["a"] }), item("c", "task", { dependsOn: ["b"] })]);
		const c = t.groups[0]!.children.find((r) => r.id === "c")!;
		assert.equal(c.premises[0]!.state, "blocked");
	});
});

describe("buildWorkTable: graduated toggle", () => {
	it("hides graduated and archived items by default", () => {
		const t = buildWorkTable(items);
		assert.ok(!JSON.stringify(ids(t.groups.flatMap((g) => g.children))).includes("old"));
	});
	it("shows them greyed when asked", () => {
		const t = buildWorkTable(items, { showGraduated: true });
		const none = t.groups.find((g) => g.key === NO_INITIATIVE_KEY)!;
		const old = none.children.find((r) => r.id === "old")!;
		assert.equal(old.graduated, true);
		assert.deepEqual(ids(old.children), ["oldt"]);
		assert.equal(none.children.find((r) => r.id === "f3")!.graduated, false);
	});
	it("counts rows after the filters", () => {
		assert.equal(buildWorkTable(items).count, 7);
		assert.equal(buildWorkTable(items, { showGraduated: true }).count, 9);
	});
});

describe("buildWorkTable: sorting", () => {
	const order = (sort?: WorkSort, group = "i1") => ids(buildWorkTable(items, { sort }).groups.find((g) => g.key === group)!.children);
	it("default is stage order, then created newest first", () => {
		assert.deepEqual(DEFAULT_WORK_SORT, { col: "stage", dir: 1 });
		assert.deepEqual(order(), ["f1", "f2"]); // in_build, then shipped
		assert.deepEqual(order(undefined, NO_INITIATIVE_KEY), ["f3", "f4"]); // plan, then idea
		const tasks = buildWorkTable(items).groups[0]!.children[0]!.children;
		assert.deepEqual(ids(tasks), ["t2", "t1", "t3"]); // in_build, shipped, plan
	});
	it("stage rank puts in_build first, then shipped, approved, plan, idea", () => {
		const ranks = ["in_build", "shipped", "approved", "plan", "idea"].map(stageRank);
		assert.deepEqual([...ranks].sort((a, b) => a - b), ranks);
	});
	it("equal stages fall back to created, newest first", () => {
		const t = buildWorkTable([item("a", "feature", { created: "2026-01-01" }), item("b", "feature", { created: "2026-03-01" })]);
		assert.deepEqual(ids(t.groups[0]!.children), ["b", "a"]);
	});
	it("sorts by name, both directions", () => {
		assert.deepEqual(order({ col: "name", dir: 1 }), ["f2", "f1"]); // Graduate, Work view
		assert.deepEqual(order({ col: "name", dir: -1 }), ["f1", "f2"]);
	});
	it("sorts by created", () => {
		assert.deepEqual(order({ col: "created", dir: 1 }), ["f2", "f1"]);
		assert.deepEqual(order({ col: "created", dir: -1 }), ["f1", "f2"]);
	});
	it("sorts by progress, rows without progress last when descending is reversed", () => {
		const t = buildWorkTable(items, { sort: { col: "progress", dir: -1 } });
		const none = t.groups.find((g) => g.key === "i1")!;
		assert.deepEqual(ids(none.children), ["f1", "f2"]); // 1/3 beats none
		const asc = buildWorkTable(items, { sort: { col: "progress", dir: 1 } }).groups[0]!;
		assert.deepEqual(ids(asc.children), ["f2", "f1"]);
	});
	it("sorts by assignee, unassigned last", () => {
		assert.deepEqual(order({ col: "assignee", dir: 1 }, NO_INITIATIVE_KEY), ["f3", "f4"]);
		assert.deepEqual(ids(buildWorkTable(items, { sort: { col: "assignee", dir: 1 } }).groups[0]!.children), ["f1", "f2"]);
	});
	it("orders the groups too, with No initiative always last", () => {
		const t = buildWorkTable([...items, item("i0", "initiative", { title: "Alpha", created: "2026-10-04" })], { sort: { col: "name", dir: -1 } });
		assert.deepEqual(t.groups.map((g) => g.key), ["i1", "i0", NO_INITIATIVE_KEY]);
		const asc = buildWorkTable([...items, item("i0", "initiative", { title: "Alpha" })], { sort: { col: "name", dir: 1 } });
		assert.deepEqual(asc.groups.map((g) => g.key), ["i0", "i1", NO_INITIATIVE_KEY]);
	});
	it("a header click flips the active column, a new column starts in its own direction", () => {
		assert.deepEqual(nextWorkSort({ col: "stage", dir: 1 }, "stage"), { col: "stage", dir: -1 });
		assert.deepEqual(nextWorkSort({ col: "stage", dir: 1 }, "name"), { col: "name", dir: 1 });
		assert.deepEqual(nextWorkSort({ col: "stage", dir: 1 }, "created"), { col: "created", dir: -1 });
	});
});

describe("buildWorkTable: search", () => {
	it("matches titles, ids and stages, keeping ancestors and auto-expanding them", () => {
		const t = buildWorkTable(items, { query: "t3" });
		assert.deepEqual(t.groups.map((g) => g.key), ["i1"]);
		const [init] = t.groups;
		assert.equal(init!.autoExpand, true);
		assert.deepEqual(ids(init!.children), ["f1"]);
		assert.equal(init!.children[0]!.autoExpand, true);
		assert.deepEqual(ids(init!.children[0]!.children), ["t3"]);
		assert.equal(init!.children[0]!.children[0]!.autoExpand, false);
	});
	it("matches by title and by stage text", () => {
		assert.deepEqual(ids(buildWorkTable(items, { query: "loose" }).groups[0]!.children), ["f3"]);
		const ready = buildWorkTable(items, { query: "ready to graduate" });
		assert.deepEqual(ids(ready.groups[0]!.children), ["f2"]);
		assert.ok(ready.groups[0]!.children[0]!.stageLabel.includes("ready"));
	});
	it("a matching feature keeps all its tasks, collapsed", () => {
		const t = buildWorkTable(items, { query: "work view" });
		const f1 = t.groups[0]!.children[0]!;
		assert.equal(f1.id, "f1");
		assert.equal(f1.autoExpand, false);
		assert.equal(f1.children.length, 3);
	});
	it("a matching initiative keeps its features", () => {
		const t = buildWorkTable(items, { query: "phase" });
		assert.equal(t.groups[0]!.children.length, 2);
		assert.equal(t.groups[0]!.autoExpand, false);
	});
	it("no match, no groups; search also respects the graduated toggle", () => {
		assert.deepEqual(buildWorkTable(items, { query: "zzzz" }).groups, []);
		assert.deepEqual(buildWorkTable(items, { query: "old one" }).groups, []);
		assert.equal(buildWorkTable(items, { query: "old one", showGraduated: true }).groups.length, 1);
	});
	it("the No initiative group never matches by its own name", () => {
		assert.deepEqual(buildWorkTable(items, { query: "initiative" }).groups, []);
	});
});
