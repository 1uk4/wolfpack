import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveWork, workRecordView, workWolfCandidates, type WorkLookup } from "../src/core/work-view.ts";

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
		// a wolf mid-turn (busy) still serves the Work API
		assert.deepEqual(workWolfCandidates(null, [{ name: "1uk4", status: "busy" }]), ["1uk4"]);
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

describe("resolveWork", () => {
	const item = { id: "t", title: "T", kind: "task", stage: "plan", partOf: null, dependsOn: [], plan: "", record: "" };
	const unavailable: WorkLookup = { ok: false, reason: "unavailable", message: "" };
	const run = (table: Record<string, WorkLookup>, candidates: string[]) => {
		const asked: string[] = [];
		return resolveWork(candidates, "t", async (w) => (asked.push(w), table[w] ?? unavailable)).then((r) => ({ r, asked }));
	};
	it("all unavailable (or no candidates) → none, each asked once", async () => {
		const { r, asked } = await run({}, ["a", "b"]);
		assert.deepEqual(r, { kind: "none" });
		assert.deepEqual(asked, ["a", "b"]);
		assert.deepEqual((await run({}, [])).r, { kind: "none" });
	});
	it("first hit wins and stops the loop", async () => {
		const { r, asked } = await run({ b: { ok: true, data: item }, c: { ok: true, data: item } }, ["a", "b", "c"]);
		assert.equal(r.kind === "hit" && r.wolf, "b");
		assert.deepEqual(asked, ["a", "b"]);
	});
	it("404 is final", async () => {
		const nf: WorkLookup = { ok: false, reason: "not_found", message: "" };
		const { r, asked } = await run({ a: nf, b: { ok: true, data: item } }, ["a", "b"]);
		assert.deepEqual(r, { kind: "hit", wolf: "a", result: nf });
		assert.deepEqual(asked, ["a"]);
	});
});
