import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { workRecordView, workWolfCandidates } from "../src/core/work-view.ts";

describe("workWolfCandidates", () => {
	const wolves = [
		{ name: "hal", status: "online" },
		{ name: "lib", status: "online", librarian: true },
		{ name: "old", status: "offline" },
	];
	it("librarian first, then other online wolves", () => {
		assert.deepEqual(workWolfCandidates("lib", wolves), ["lib", "hal"]);
	});
	it("falls back to online wolves without a librarian; none online → empty", () => {
		assert.deepEqual(workWolfCandidates(null, wolves), ["hal", "lib"]);
		assert.deepEqual(workWolfCandidates(null, [{ name: "old", status: "offline" }]), []);
	});
});

describe("workRecordView", () => {
	const parent = { id: "f", title: "Feature", record: "parent rec" };
	it("prefers own record", () => {
		assert.deepEqual(workRecordView({ record: "mine" }, parent), { markdown: "mine", fromParent: null });
	});
	it("falls back to parent when own is blank", () => {
		assert.deepEqual(workRecordView({ record: "  " }, parent), { markdown: "parent rec", fromParent: { id: "f", title: "Feature" } });
	});
	it("empty when neither", () => {
		assert.deepEqual(workRecordView({ record: "" }, null), { markdown: "", fromParent: null });
	});
});
