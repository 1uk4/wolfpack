import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskCard, TaskGraphCompact, taskNodeView } from "../components/task-graph.tsx";
import { buildTaskGraph, type WorkRecordResponse } from "../src/core/index.ts";

const kid = (id: string, stage: string, dependsOn: string[] = [], title = `Task ${id}`) => ({ id, title, kind: "task", stage, dependsOn });
const feat = { id: "F", kind: "feature", title: "Feat", stage: "in_build", plan: "", record: "", children: [kid("a", "shipped"), kid("b", "in_build", ["a"]), kid("c", "idea", ["b"]), kid("d", "idea")] };
const model = (() => {
	const g = buildTaskGraph({ id: "b", kind: "task", title: "", stage: "", plan: "", record: "", partOf: "F" } as WorkRecordResponse, feat as never);
	assert.equal(g.kind, "graph");
	return g as Extract<typeof g, { kind: "graph" }>;
})();

describe("taskNodeView", () => {
	it("labels, aria and classes per status; bound adds the ring and 'current task'", () => {
		const v = taskNodeView({ id: "x", title: "Do it", kind: "task", status: "building" }, true);
		assert.equal(v.statusLabel, "In build");
		assert.equal(v.ariaLabel, "Do it (in build, current task)");
		assert.match(v.cardClass, /border-sky-400/);
		assert.match(v.cardClass, /ring-yellow-400/);
		const b = taskNodeView({ id: "y", title: "T", kind: "issue", status: "blocked" }, false);
		assert.equal(b.ariaLabel, "T (blocked)");
		assert.match(b.cardClass, /border-dashed/);
		assert.doesNotMatch(b.cardClass, /ring-yellow/);
		assert.equal(taskNodeView({ id: "z", title: "T", kind: "task", status: "archived" }, false).statusLabel, "Archived");
	});
});

describe("TaskCard", () => {
	it("renders data attributes, the clamped title with a title attr, a check only when shipped", () => {
		const html = renderToStaticMarkup(<TaskCard view={taskNodeView({ id: "a", title: "A long title", kind: "spike", status: "shipped" }, false)} onSelect={() => {}} />);
		assert.match(html, /data-testid="task-node-a" data-status="shipped" data-bound="false"/);
		assert.match(html, /role="button"/);
		assert.match(html, /line-clamp-3/);
		assert.match(html, /title="A long title"/);
		assert.match(html, /data-check="true"/);
		assert.match(html, />spike</);
		const ready = renderToStaticMarkup(<TaskCard view={taskNodeView({ id: "r", title: "R", kind: "task", status: "ready" }, true)} />);
		assert.doesNotMatch(ready, /data-check/);
		assert.match(ready, /data-bound="true"/);
		assert.match(ready, />current</);
		assert.doesNotMatch(ready, /role="button"/);
	});
});

describe("TaskGraphCompact", () => {
	it("renders the group with each node's status and bound flag", () => {
		const html = renderToStaticMarkup(<TaskGraphCompact model={model} onSelect={() => {}} />);
		assert.match(html, /data-testid="task-graph-svg"/);
		assert.match(html, /aria-label="Task graph: Feat, 1\/4 shipped"/);
		assert.match(html, /data-testid="task-node-a" data-status="shipped" data-bound="false"/);
		assert.match(html, /data-testid="task-node-b" data-status="building" data-bound="true"/);
		assert.match(html, /data-testid="task-node-c" data-status="blocked" data-bound="false"/);
		assert.match(html, /data-testid="task-node-d" data-status="ready" data-bound="false"/);
	});
});
