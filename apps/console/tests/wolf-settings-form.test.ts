import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPayload, fieldKind, parseIssues, retryAfterSeconds } from "../src/core/wolf-settings-form.ts";

const config = { subagents: { maxRunning: 3 }, compaction: { enabled: true, startAt: 100000 }, models: { main: { model: "m1", thinking: "high" } } };

describe("wolf settings form logic", () => {
	it("sends only the keys that changed, typed, and null for a cleared set key", () => {
		const { set, invalid } = buildPayload(config, {
			"subagents.maxRunning": "3", // unchanged: not sent
			"compaction.startAt": "120000", // number
			"compaction.enabled": false, // boolean
			"models.main.thinking": null, // clear a set key
			"models.fast.model": null, // clear a key that is not set: nothing to send
			"models.main.model": "m2",
		});
		assert.deepEqual(set, { "compaction.startAt": 120000, "compaction.enabled": false, "models.main.thinking": null, "models.main.model": "m2" });
		assert.deepEqual(invalid, {});
	});
	it("reports a non-numeric entry for a number field instead of sending it", () => {
		const { set, invalid } = buildPayload(config, { "subagents.maxRunning": "lots" });
		assert.deepEqual(set, {});
		assert.deepEqual(Object.keys(invalid), ["subagents.maxRunning"]);
	});
	it("picks an input kind per key; long-text prompt keys get a textarea", () => {
		assert.equal(fieldKind("subagents.maxRunning").kind, "number");
		assert.equal(fieldKind("compaction.enabled").kind, "boolean");
		assert.equal(fieldKind("prompts.structuredOutput").kind, "textarea");
		assert.deepEqual(fieldKind("memory.consolidation.trigger"), { kind: "enum", options: ["threshold", "timer", "hybrid", "manual"] });
		assert.equal(fieldKind("memory.sweepInterval").kind, "text");
	});
	it("splits wolfd's 400 message into per-key issues", () => {
		assert.deepEqual(parseIssues("subagents.maxRunning: Too small; memory.sweepInterval: expected a duration like \"30s\""), {
			"subagents.maxRunning": "Too small",
			"memory.sweepInterval": 'expected a duration like "30s"',
		});
	});
	it("reads retryAfterSeconds whether it arrives as a number or a string", () => {
		assert.equal(retryAfterSeconds({ retryAfterSeconds: "42" }), 42);
		assert.equal(retryAfterSeconds({ retryAfterSeconds: 7 as unknown as string }), 7);
		assert.equal(retryAfterSeconds(undefined), 0);
	});
});
