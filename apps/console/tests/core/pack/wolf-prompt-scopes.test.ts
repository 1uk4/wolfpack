/** Seam: prompt scope chips and the view-only source/size line (src/core/pack/wolf-prompt-scopes.ts). Pure. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SCOPE_GRAPH, filterByScope, promptScope, sizeText, sourceText } from "../../../src/core/pack/wolf-prompt-scopes.ts";

describe("Wolf prompt scopes", () => {
	it("shows each scope on a graph that exists in the prompt flows: Memory the background jobs, Workspace the subagents, the rest the system prompt", () => {
		assert.deepEqual(SCOPE_GRAPH, { all: "system", wolf: "system", memory: "background", workspace: "subagents", system: "system" });
	});

	it("puts the background observe and consolidate prompts under Memory, the composed blocks under System", () => {
		assert.equal(promptScope("pipeline.observer"), "memory");
		assert.equal(promptScope("pipeline.consolidate-user"), "memory");
		assert.equal(promptScope("system.header"), "system");
		assert.equal(promptScope("compaction.summary"), "system");
	});

	it("puts the wolf's own files under Wolf and workspace profiles and standards under Workspace", () => {
		assert.equal(promptScope("identity"), "wolf");
		assert.equal(promptScope("orchestrator-rules"), "wolf");
		assert.equal(promptScope("agent.worker"), "workspace");
		assert.equal(promptScope("standard.testing"), "workspace");
	});

	it("All keeps every row; a scope keeps only its own", () => {
		const rows = [{ id: "pipeline.observer" }, { id: "system.header" }, { id: "identity" }];
		assert.equal(filterByScope(rows, "all").length, 3);
		assert.deepEqual(filterByScope(rows, "memory").map((r) => r.id), ["pipeline.observer"]);
	});

	it("says where a prompt comes from and how big it is, in plain words", () => {
		assert.equal(sourceText({ source: "override", file: "agent/AGENTS.md" }), "Edited for this wolf (agent/AGENTS.md)");
		assert.equal(sourceText({ source: "default", file: "packages/engine/src/prompts.ts" }), "Built in (packages/engine/src/prompts.ts)");
		assert.equal(sizeText("x".repeat(2400)), "2,400 characters, about 600 tokens");
		assert.equal(sizeText(""), "empty");
	});
});
