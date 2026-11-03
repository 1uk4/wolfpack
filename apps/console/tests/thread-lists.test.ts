/** The sidebar's needs-you dot is a pure function of the thread status: appears for a pending card, clears when idle, survives one bad wolf. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { foldWolfRoster, foldWolfThreads as fold, threadListItem } from "../src/core/index.ts";

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

describe("foldWolfRoster", () => {
	it("an offline wolf is listed after a fresh load with no threads", () => {
		const r = foldWolfRoster(null, [{ name: "1uk4", status: "online" }, { name: "hal2", status: "offline" }]);
		assert.deepEqual(r, [{ name: "1uk4", online: true }, { name: "hal2", online: false }]);
		assert.deepEqual(foldWolfThreads(null, [{ wolf: "hal2" }]), []);
	});

	it("status flips online -> offline -> online", () => {
		const a = foldWolfRoster(null, [{ name: "w", status: "online" }]);
		const b = foldWolfRoster(a, [{ name: "w", status: "offline" }]);
		const c = foldWolfRoster(b, [{ name: "w", status: "online" }]);
		assert.deepEqual([a, b, c].map((x) => x[0]!.online), [true, false, true]);
	});

	it("a threads fetch failure marks the wolf offline but keeps it", () => {
		assert.deepEqual(foldWolfRoster(null, [{ name: "w", status: "online" }], { w: false }), [{ name: "w", online: false }]);
	});

	it("server unreachable keeps the last roster, all offline", () => {
		const prev = foldWolfRoster(null, [{ name: "a", status: "online" }, { name: "b", status: "online" }]);
		assert.deepEqual(foldWolfRoster(prev, undefined), [{ name: "a", online: false }, { name: "b", online: false }]);
		assert.deepEqual(foldWolfRoster(null, undefined), []);
	});
});
