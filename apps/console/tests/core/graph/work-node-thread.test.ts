import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { threadForWorkNode } from "../../../src/core/graph/work-node-thread.ts";

const node = (id: string, workKind: string, domain = "wolfpack") => ({ id, kind: "work", label: id, depth: 3, domain, workKind, stage: "build" }) as never;
const graph = {
	nodes: [node("work:feat1", "feature"), node("work:task1", "task"), node("work:init1", "initiative"), node("work:lone", "task"), { id: "ent:x", kind: "entry", label: "x", depth: 2 }],
	edges: [
		{ source: "work:task1", target: "work:feat1", kind: "partOf" },
		{ source: "work:feat1", target: "work:init1", kind: "partOf" },
	],
} as never;
const threads = {
	"1uk4": [
		{ id: "1uk4/home", title: "1uk4", kind: "home" },
		{ id: "1uk4/feature-work-wolfpack-feat1", title: "Feature", kind: "feature" },
	],
	hal: [{ id: "feature-work-wolfpack-other", title: "Other", kind: "feature" }],
};

describe("the thread behind a graph work node", () => {
	it("reads a node keyed by the FULL work id (work:work-<domain>-<id>), as the hub's graph builds it", () => {
		const g = { nodes: [node("work:work-wolfpack-kqnldTm", "feature"), node("work:work-wolfpack-t9", "task")], edges: [{ source: "work:work-wolfpack-t9", target: "work:work-wolfpack-kqnldTm", kind: "partOf" }] } as never;
		const t = { "1uk4": [{ id: "1uk4/feature-work-wolfpack-kqnldTm", title: "Polish", kind: "feature" }] };
		assert.deepEqual(threadForWorkNode(g, "work:work-wolfpack-kqnldTm", t), { wolf: "1uk4", threadId: "1uk4/feature-work-wolfpack-kqnldTm" });
		assert.deepEqual(threadForWorkNode(g, "work:work-wolfpack-t9", t), { wolf: "1uk4", threadId: "1uk4/feature-work-wolfpack-kqnldTm" });
	});

	it("prefers the owner's own wolf when the feature has threads on several wolves", () => {
		const g = { nodes: [node("work:work-wolfpack-f9", "feature")], edges: [] } as never;
		const t = { hal: [{ id: "hal/feature-work-wolfpack-f9", title: "F", kind: "feature" }], "1uk4": [{ id: "1uk4/feature-work-wolfpack-f9", title: "F", kind: "feature" }] };
		assert.deepEqual(threadForWorkNode(g, "work:work-wolfpack-f9", t, "1uk4"), { wolf: "1uk4", threadId: "1uk4/feature-work-wolfpack-f9" });
	});

	it("maps a feature node to the thread whose slug is feature-<work id>", () => {
		assert.deepEqual(threadForWorkNode(graph, "work:feat1", threads), { wolf: "1uk4", threadId: "1uk4/feature-work-wolfpack-feat1" });
	});

	it("maps a task node to its parent feature's thread", () => {
		assert.deepEqual(threadForWorkNode(graph, "work:task1", threads), { wolf: "1uk4", threadId: "1uk4/feature-work-wolfpack-feat1" });
	});

	it("finds no thread for an initiative, a task with no feature, a feature without a thread, or a non-work node", () => {
		assert.equal(threadForWorkNode(graph, "work:init1", threads), null);
		assert.equal(threadForWorkNode(graph, "work:lone", threads), null);
		assert.equal(threadForWorkNode(graph, "work:feat1", { hal: threads.hal }), null);
		assert.equal(threadForWorkNode(graph, "ent:x", threads), null);
	});
});
