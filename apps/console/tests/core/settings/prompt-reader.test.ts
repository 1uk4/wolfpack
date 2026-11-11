import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseFrontmatter, readerModeOf, splitVars } from "../../../src/core/settings/prompt-reader.ts";

describe("prompt reader", () => {
	it("picks a reader mode by prompt type", () => {
		assert.equal(readerModeOf({ id: "agent.worker", text: "---\nname: worker\n---\nbody" }), "profile");
		assert.equal(readerModeOf({ id: "pipeline.consolidate-user", kind: "pipeline", text: "x {{obsLines}} y" }), "template");
		assert.equal(readerModeOf({ id: "orchestrator-rules", kind: "editable", text: "# Rules\nmentions {{name}} in prose" }), "markdown", "an editable markdown prompt that mentions a placeholder is still markdown");
		assert.equal(readerModeOf({ id: "system.orchestrator", kind: "system-block", text: "# Rules" }), "composed");
		assert.equal(readerModeOf({ id: "orchestrator-rules", kind: "editable", text: "# Rules" }), "markdown");
		assert.equal(readerModeOf({ id: "standard.git", text: "# Git" }), "markdown");
		assert.equal(readerModeOf({ id: "tool.read", kind: "tool", text: "Read a file" }), "markdown");
		assert.equal(readerModeOf({ id: "pipeline.observer", kind: "pipeline", text: "You are the observer." }), "markdown");
	});

	it("splits a template into text and {{var}} segments in order", () => {
		assert.deepEqual(splitVars("A {{x}} and {{ y }}.\n{{x}}"), [
			{ text: "A " }, { variable: "x" }, { text: " and " }, { variable: "y" }, { text: ".\n" }, { variable: "x" },
		]);
		assert.deepEqual(splitVars("no vars"), [{ text: "no vars" }]);
	});

	it("reads profile frontmatter as key/value pairs and returns the body without the --- block", () => {
		const t = "---\nname: worker\ndescription: Implements a change\nmodel: smart\nstandards: testing, git\n---\n\nYou are a worker.";
		const fm = parseFrontmatter(t);
		assert.deepEqual(fm.fields, [["name", "worker"], ["description", "Implements a change"], ["model", "smart"], ["standards", "testing, git"]]);
		assert.equal(fm.body, "You are a worker.");
		assert.deepEqual(parseFrontmatter("# Just markdown"), { fields: [], body: "# Just markdown" });
	});
});
