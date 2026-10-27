import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { composeItemDocument } from "../src/core/item-document.ts";

import type { ItemRecord } from "../src/core/item-document.ts";

const none: ItemRecord = { record: "", inheritedFrom: null };
const compose = (plan: string, rec: ItemRecord = none, successCriteria?: string) => composeItemDocument({ plan, successCriteria }, rec);

describe("composeItemDocument", () => {
	it("strips the leading title and empty template sections", () => {
		assert.equal(compose("# Title\n\n## Plan\n\n## Notes\n\n"), "");
		assert.equal(compose("# Title\n\n## Plan\n\nDo it.\n\n## Notes\n"), "## Plan\n\nDo it.");
	});
	it("removes nested empty sections but keeps a parent whose only content is in a child", () => {
		assert.equal(compose("## A\n\n### A1\n\n### A2\n\ntext\n\n## B\n\n### B1\n"), "## A\n\n### A2\n\ntext");
	});
	it("removes rollup markers", () => {
		assert.equal(compose("## Delivered\n\n<!-- rollup:children -->\n- x\n<!-- /rollup:children -->\n"), "## Delivered\n\n- x");
	});
	it("normalises headings so the shallowest is ## and none is deeper than ####", () => {
		assert.equal(compose("# T\n\n# Spec\n\ntext\n\n## Sub\n\nmore\n"), "## Spec\n\ntext\n\n### Sub\n\nmore");
		assert.equal(compose("#### Deep\n\ntext\n\n###### Deeper\n\nx"), "## Deep\n\ntext\n\n#### Deeper\n\nx");
	});
	it("leaves fenced code alone", () => {
		assert.equal(compose("## A\n\n```sh\n# comment\n```\n"), "## A\n\n```sh\n# comment\n```");
	});
	it("puts Record last under ##, its headings shifted to ###", () => {
		const out = compose("## Plan\n\nx", { record: "## Decisions\n\n- a\n\n### Why\n\nb", inheritedFrom: null });
		assert.equal(out, "## Plan\n\nx\n\n## Record\n\n### Decisions\n\n- a\n\n#### Why\n\nb");
	});
	it("labels an inherited Record with the parent feature", () => {
		assert.match(compose("", { record: "notes", inheritedFrom: { title: "Feat" } }), /^## Record — from Feat\n\nnotes$/);
	});
	it("successCriteria comes first as Done when", () => {
		const out = compose("## Plan\n\nx", { record: "r", inheritedFrom: null }, "- one\n- two");
		assert.equal(out, "## Done when\n\n- one\n- two\n\n## Plan\n\nx\n\n## Record\n\nr");
	});
	it("everything empty → empty string", () => {
		assert.equal(compose("# T\n\n## Plan\n\n## Notes\n", none, "  "), "");
		assert.equal(composeItemDocument({ plan: "" }, null), "");
	});
});
