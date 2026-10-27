/** The sidebar's needs-you dot is a pure function of the thread status: appears for a pending card, clears when idle, survives one bad wolf. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { foldWolfThreads as fold, threadListItem } from "../src/core/index.ts";

type Row = ReturnType<typeof threadListItem>;
const foldWolfThreads = (prev: Row[] | null, r: Parameters<typeof fold>[1]) => fold<Row>(prev, r) as Row[];

const t = (id: string, status: "idle" | "busy" | "needs-you") => ({ id, title: id, status });

describe("foldWolfThreads", () => {
	it("needs-you status -> needsYou row; idle clears it", () => {
		const waiting = foldWolfThreads(null, [{ wolf: "a", threads: [t("a/home", "needs-you")] }]);
		assert.equal(waiting[0]!.needsYou, true);
		const cleared = foldWolfThreads(waiting, [{ wolf: "a", threads: [t("a/home", "idle")] }]);
		assert.equal(cleared[0]!.needsYou, false);
	});

	it("a wolf whose fetch failed keeps its rows; the healthy wolf still clears its dot", () => {
		const first = foldWolfThreads(null, [
			{ wolf: "a", threads: [t("a/home", "needs-you")] },
			{ wolf: "b", threads: [t("b/home", "needs-you")] },
		]);
		const next = foldWolfThreads(first, [{ wolf: "a", threads: [t("a/home", "idle")] }, { wolf: "b" }]);
		assert.deepEqual(next.map((r) => [r.id, r.needsYou]), [["a/home", false], ["b/home", true]]);
	});

	it("a wolf that never loaded contributes nothing", () => {
		assert.deepEqual(foldWolfThreads(null, [{ wolf: "a" }]), []);
	});
});
