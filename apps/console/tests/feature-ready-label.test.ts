import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nodeStyle, stageLabel } from "../src/core/kb-graph-model.ts";
import { buildTaskGraph } from "../src/core/task-graph.ts";
import type { KbGraphNode } from "../src/core/kb.ts";

const node = (stage: string, workKind: string): Pick<KbGraphNode, "kind" | "stage" | "workKind"> => ({ kind: "work", stage, workKind });

describe("shipped feature = ready to graduate", () => {
	it("graph side pane stage text", () => {
		assert.equal(stageLabel("shipped", "feature"), "shipped · ready to graduate");
		assert.equal(stageLabel("shipped", "task"), "shipped");
		assert.equal(stageLabel("in_build", "feature"), "in build");
	});
	it("node style differs from a shipped task (bright ring vs dim disc)", () => {
		const f = nodeStyle(node("shipped", "feature"));
		const t = nodeStyle(node("shipped", "task"));
		assert.deepEqual([t.shape, t.dim], ["disc", true]);
		assert.deepEqual([f.shape, f.dim], ["ring", false]);
		assert.ok(f.ring > 0 && f.radius > t.radius);
	});
	it("progress panel title/label", () => {
		const rec = (stage: string) => ({
			id: "F", kind: "feature", title: "Feat", stage, plan: "", record: "",
			children: [{ id: "a", title: "A", kind: "task", stage: "shipped", dependsOn: [] }],
		});
		const label = (stage: string) => {
			const g = buildTaskGraph(rec(stage) as never, rec(stage) as never);
			return g.kind === "graph" ? g.label : "";
		};
		assert.equal(label("shipped"), "1/1 shipped · ready to graduate");
		assert.equal(label("in_build"), "1/1 shipped");
	});
});
