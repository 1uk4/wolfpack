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
	it("groups features under initiatives, loose ones under Inbox (last), tasks under features", () => {
		const t = buildWorkTable(items);
		assert.deepEqual(t.groups.map((g) => g.key), ["i1", NO_INITIATIVE_KEY]);
		const [init, none] = t.groups;
		assert.equal(none!.title, "Inbox");
		assert.deepEqual(ids(none!.children).sort(), ["f3", "f4"]);
		assert.deepEqual(ids(init!.children).sort(), ["f1", "f2"]);
		const f1 = init!.children.find((r) => r.id === "f1")!;
		assert.deepEqual(ids(f1.children).sort(), ["t1", "t2", "t3"]);
		assert.deepEqual([init!.depth, f1.depth, f1.children[0]!.depth], [0, 1, 2]);
	});
	it("skips containers and omits the Inbox group when nothing is loose", () => {
		const t = buildWorkTable(items.filter((i) => i.id !== "f3" && i.id !== "f4"));
		assert.deepEqual(t.groups.map((g) => g.key), ["i1"]);
		assert.ok(!JSON.stringify(t).includes("Inbox"));
	});
	it("a loose task becomes a leaf row in Inbox", () => {
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

describe("buildWorkTable: dependencies", () => {
	const f1 = () => buildWorkTable(items).groups[0]!.children.find((r) => r.id === "f1")!;
	it("a row's dependsOn keeps the sibling dependencies (the lanes); chip state is styled by stage", () => {
		const t3 = f1().children.find((r) => r.id === "t3")!;
		assert.deepEqual(t3.dependsOn, ["t1", "t2"]);
		assert.deepEqual(t3.notes, []);
		assert.equal(t3.self?.state, "blocked");
	});
	it("a feature's dependsOn is its feature-level dependency; a shipped feature is ready to graduate", () => {
		const f2 = buildWorkTable(items).groups[0]!.children.find((r) => r.id === "f2")!;
		assert.deepEqual(f2.dependsOn, ["f1"]);
		assert.equal(f2.self?.state, "ready");
	});
	it("a row with no dependsOn has none; initiatives carry none", () => {
		assert.deepEqual(f1().dependsOn, []);
		assert.deepEqual(buildWorkTable(items).groups[0]!.dependsOn, []);
	});
	it("a dependency missing from the data neither blocks nor gets a lane; it is a note with its id", () => {
		const t = buildWorkTable([item("a", "task", { dependsOn: ["gone"], stage: "plan" })]);
		const row = t.groups[0]!.children[0]!;
		assert.deepEqual(row.dependsOn, []);
		assert.deepEqual(row.notes, [{ id: "gone", title: "gone" }]);
		assert.equal(row.self?.state, "plain");
	});
	it("a dependency outside the parent becomes a titled note, not a lane", () => {
		const t = buildWorkTable([
			item("f1", "feature", { title: "One" }),
			item("f2", "feature", { title: "Two" }),
			item("x", "task", { partOf: "f1" }),
			item("y", "task", { partOf: "f2", dependsOn: ["x"] }),
		]);
		const f2 = t.groups[0]!.children.find((r) => r.id === "f2")!;
		const y = f2.children[0]!;
		assert.deepEqual(y.dependsOn, []);
		assert.deepEqual(y.notes, [{ id: "x", title: "X" }]);
	});
	it("a blocked prerequisite flags its dependent blocked", () => {
		const t = buildWorkTable([item("a", "task", { stage: "plan" }), item("b", "task", { dependsOn: ["a"] }), item("c", "task", { dependsOn: ["b"] })]);
		const c = t.groups[0]!.children.find((r) => r.id === "c")!;
		assert.equal(c.self?.state, "blocked");
	});
});

describe("buildWorkTable: Inbox group", () => {
	it("is titled Inbox and holds loose features, tasks and ideas", () => {
		const t = buildWorkTable([item("f", "feature"), item("t", "task"), item("i", "idea")]);
		assert.deepEqual(t.groups.map((g) => [g.key, g.title]), [[NO_INITIATIVE_KEY, "Inbox"]]);
		assert.deepEqual(ids(t.groups[0]!.children).sort(), ["f", "i", "t"]);
	});
	it("flattens the Inbox container: its children sit directly in the group, never Inbox → Inbox → tasks", () => {
		const t = buildWorkTable([
			item("kb", "container", { title: "Inbox", standing: true }),
			item("a", "task", { partOf: "kb" }),
			item("b", "idea", { partOf: "kb" }),
			item("f", "feature", { partOf: "kb" }),
			item("ft", "task", { partOf: "f" }),
			item("loose", "feature"),
		]);
		assert.equal(t.groups.length, 1);
		const inbox = t.groups[0]!;
		assert.equal(inbox.title, "Inbox");
		assert.deepEqual(ids(inbox.children).sort(), ["a", "b", "f", "loose"]);
		assert.ok(!inbox.children.some((r) => r.title === "Inbox"));
		assert.deepEqual(ids(inbox.children.find((r) => r.id === "f")!.children), ["ft"]);
	});
	it("detects the container by flag or kind, falling back to the title; a task titled Inbox is not one", () => {
		for (const box of [item("kb", "feature", { container: true, title: "Holding" }), item("kb", "container", { title: "Holding" }), item("kb", "initiative", { title: "Inbox" })]) {
			const t = buildWorkTable([box, item("a", "task", { partOf: "kb" })]);
			assert.deepEqual(t.groups.map((g) => g.key), [NO_INITIATIVE_KEY]);
			assert.deepEqual(ids(t.groups[0]!.children), ["a"]);
		}
		const t = buildWorkTable([item("tk", "task", { title: "Inbox" })]);
		assert.deepEqual(ids(t.groups[0]!.children), ["tk"]);
	});
	it("every item appears exactly once", () => {
		const all = buildWorkTable(items, { showGraduated: true });
		const seen: string[] = [];
		const walk = (rows: { id: string; children: any[] }[]) => rows.forEach((r) => (r.id && seen.push(r.id), walk(r.children)));
		walk(all.groups);
		assert.equal(new Set(seen).size, seen.length);
		assert.deepEqual(seen.sort(), items.filter((i) => i.id !== "inbox").map((i) => i.id).sort());
	});
});

describe("layerOrder: dependency layering within a parent", () => {
	const build = (specs: [string, string[]][], created?: Record<string, string>) =>
		buildWorkTable(specs.map(([id, dependsOn]) => item(id, "task", { dependsOn, created: created?.[id] ?? "2026-10-01" })), { sort: { col: "name", dir: 1 } }).groups[0]!.children.map((r) => r.id);
	it("a chain follows its dependencies even against the sort", () => {
		assert.deepEqual(build([["c", ["b"]], ["a", []], ["b", ["a"]]]).sort().join(), "a,b,c");
		assert.deepEqual(build([["a", ["b"]], ["b", ["c"]], ["c", []]]), ["c", "b", "a"]);
	});
	it("a diamond: root, the two parallel siblings adjacent in sort order, then the join", () => {
		assert.deepEqual(build([["d", ["b", "c"]], ["c", ["a"]], ["b", ["a"]], ["a", []]]), ["a", "b", "c", "d"]);
	});
	it("parallel rows with no edges keep the current sort; layers group them after their prerequisites", () => {
		assert.deepEqual(build([["z", []], ["m", ["z"]], ["a", []], ["b", []]]), ["a", "b", "z", "m"]);
	});
	it("a cycle does not hang and keeps every row", () => {
		assert.deepEqual(build([["a", ["b"]], ["b", ["a"]]]).sort(), ["a", "b"]);
	});
	it("tasks inside a feature are layered too", () => {
		const f = buildWorkTable(items).groups[0]!.children.find((r) => r.id === "f1")!;
		assert.deepEqual(ids(f.children), ["t1", "t2", "t3"]);
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
		assert.deepEqual(ids(tasks), ["t1", "t2", "t3"]); // layered: t2 needs t1, t3 needs both (the sort only orders within a layer)
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
		// f2 depends on f1, so layering wins over the name sort in both directions
		assert.deepEqual(order({ col: "name", dir: 1 }), ["f1", "f2"]);
		assert.deepEqual(order({ col: "name", dir: -1 }), ["f1", "f2"]);
		assert.deepEqual(ids(buildWorkTable([item("a", "task", { title: "Alpha" }), item("b", "task", { title: "Beta" })], { sort: { col: "name", dir: -1 } }).groups[0]!.children), ["b", "a"]);
	});
	it("sorts by created", () => {
		assert.deepEqual(order({ col: "created", dir: 1 }), ["f1", "f2"]);
		assert.deepEqual(order({ col: "created", dir: -1 }), ["f1", "f2"]);
	});
	it("sorts by progress, rows without progress last when descending is reversed", () => {
		const t = buildWorkTable(items, { sort: { col: "progress", dir: -1 } });
		const none = t.groups.find((g) => g.key === "i1")!;
		assert.deepEqual(ids(none.children), ["f1", "f2"]); // 1/3 beats none
		const asc = buildWorkTable(items, { sort: { col: "progress", dir: 1 } }).groups[0]!;
		assert.deepEqual(ids(asc.children), ["f1", "f2"]);
	});
	it("sorts by assignee, unassigned last", () => {
		assert.deepEqual(order({ col: "assignee", dir: 1 }, NO_INITIATIVE_KEY), ["f3", "f4"]);
		assert.deepEqual(ids(buildWorkTable(items, { sort: { col: "assignee", dir: 1 } }).groups[0]!.children), ["f1", "f2"]);
	});
	it("orders the groups too, with Inbox always last", () => {
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
	it("the Inbox group never matches by its own name", () => {
		assert.deepEqual(buildWorkTable(items, { query: "initiative" }).groups, []);
	});
});
