/** The sidebar's needs-you dot is a pure function of the thread status: appears for a pending card, clears when idle, survives one bad wolf. */
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { checkRoster, foldWolfRoster, startVisibleTimer, foldWolfThreads as fold, threadListItem } from "../../../src/core/index.ts";

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
	it("carries a wolf's chosen color, and keeps it while the wolf is offline", () => {
		const a = foldWolfRoster(null, [{ name: "w", status: "online", color: "pink" }, { name: "x", status: "online" }]);
		assert.deepEqual(a, [{ name: "w", online: true, color: "pink" }, { name: "x", online: true }]);
		assert.deepEqual(foldWolfRoster(a, undefined), [{ name: "w", online: false, color: "pink" }, { name: "x", online: false }]);
	});
	it("an offline wolf is listed after a fresh load with no threads", () => {
		const r = foldWolfRoster(null, [{ name: "1uk4", status: "online" }, { name: "hal2", status: "offline" }]);
		assert.deepEqual(r, [{ name: "1uk4", online: true }, { name: "hal2", online: false }]);
	});

	it("status flips online -> offline -> online", () => {
		const a = foldWolfRoster(null, [{ name: "w", status: "online" }]);
		const b = foldWolfRoster(a, [{ name: "w", status: "offline" }]);
		const c = foldWolfRoster(b, [{ name: "w", status: "online" }]);
		assert.deepEqual([a, b, c].map((x) => x[0]!.online), [true, false, true]);
	});

	it("a threads fetch failure keeps stale rows and never flips the roster status", () => {
		const rows = foldWolfThreads(null, [{ wolf: "w", threads: [t("w/home", "idle")] }]);
		assert.deepEqual(foldWolfThreads(rows, [{ wolf: "w" }]).map((r) => r.id), ["w/home"]);
		assert.deepEqual(foldWolfRoster(null, [{ name: "w", status: "online" }]), [{ name: "w", online: true }]);
	});

	it("a wolf removed from the roster drops out; a renamed wolf is the new name", () => {
		const a = foldWolfRoster(null, [{ name: "a", status: "online" }, { name: "b", status: "online" }]);
		assert.deepEqual(foldWolfRoster(a, [{ name: "b", status: "online" }]), [{ name: "b", online: true }]);
		assert.deepEqual(foldWolfRoster(a, [{ name: "a2", status: "online" }, { name: "b", status: "offline" }]), [{ name: "a2", online: true }, { name: "b", online: false }]);
	});

	it("server unreachable keeps the last roster, all offline", () => {
		const prev = foldWolfRoster(null, [{ name: "a", status: "online" }, { name: "b", status: "online" }]);
		assert.deepEqual(foldWolfRoster(prev, undefined), [{ name: "a", online: false }, { name: "b", online: false }]);
		assert.deepEqual(foldWolfRoster(null, undefined), []);
	});
});

describe("checkRoster (the 20s tick)", () => {
	const stub = (body: unknown, urls: string[], status = 200) => async (u: string) => {
		urls.push(u);
		return { ok: status >= 200 && status < 300, status, json: async () => body };
	};
	it("makes exactly one /api/wolves call and no thread fetches", async () => {
		const urls: string[] = [];
		const prev = foldWolfRoster(null, [{ name: "a", status: "online" }, { name: "b", status: "online" }]);
		const r = await checkRoster(stub({ wolves: [{ name: "a", status: "online" }, { name: "b", status: "online" }] }, urls), prev);
		assert.deepEqual(urls, ["/api/wolves"]);
		assert.deepEqual(r.recovered, []);
	});
	it("reports only offline->online wolves as recovered", async () => {
		const prev = foldWolfRoster(null, [{ name: "a", status: "online" }, { name: "b", status: "offline" }]);
		const r = await checkRoster(stub({ wolves: [{ name: "a", status: "online" }, { name: "b", status: "online" }] }, []), prev);
		assert.deepEqual(r.recovered, ["b"]);
	});
	it("unreachable server: last roster, all offline, nothing recovered", async () => {
		const prev = foldWolfRoster(null, [{ name: "a", status: "online" }]);
		const r = await checkRoster(async () => { throw new Error("down"); }, prev);
		assert.deepEqual(r.roster, [{ name: "a", online: false }]);
		assert.deepEqual(r.recovered, []);
	});
});

describe("checkRoster failures", () => {
	const prev = foldWolfRoster(null, [{ name: "a", status: "online" }]);
	it("a 401 is auth lost: the roster is untouched, nobody goes offline", async () => {
		const r = await checkRoster(async () => ({ ok: false, status: 401, json: async () => ({}) }), prev);
		assert.deepEqual(r.roster, prev);
		assert.equal(r.authLost, true);
		assert.deepEqual(r.recovered, []);
	});
	it("a 5xx keeps the last roster, all offline", async () => {
		const r = await checkRoster(async () => ({ ok: false, status: 503, json: async () => ({}) }), prev);
		assert.deepEqual(r.roster, [{ name: "a", online: false }]);
		assert.equal(r.authLost, undefined);
	});
});

describe("startVisibleTimer", () => {
	const fakeDoc = (state: string) => {
		const ls = new Set<() => void>();
		return { visibilityState: state, addEventListener: (_: "visibilitychange", f: () => void) => void ls.add(f), removeEventListener: (_: "visibilitychange", f: () => void) => void ls.delete(f), fire: () => ls.forEach((f) => f()), size: () => ls.size };
	};
	it("no tick while hidden, a tick each interval while visible, one on becoming visible, cleanup on unmount", () => {
		mock.timers.enable({ apis: ["setInterval"] });
		try {
			const doc = fakeDoc("hidden");
			let n = 0;
			const stop = startVisibleTimer(() => n++, 20_000, doc);
			mock.timers.tick(60_000);
			assert.equal(n, 0, "hidden: no fetch");
			doc.visibilityState = "visible";
			doc.fire();
			assert.equal(n, 1, "visible again: one check");
			mock.timers.tick(20_000);
			assert.equal(n, 2, "one tick per interval");
			stop();
			mock.timers.tick(100_000);
			assert.equal(n, 2, "stopped after unmount");
			assert.equal(doc.size(), 0, "listener removed");
		} finally {
			mock.timers.reset();
		}
	});
	it("each tick drives exactly one /api/wolves call", async () => {
		mock.timers.enable({ apis: ["setInterval"] });
		try {
			const urls: string[] = [];
			const prev = foldWolfRoster(null, [{ name: "a", status: "online" }, { name: "b", status: "online" }]);
			const stop = startVisibleTimer(() => void checkRoster(async (u) => (urls.push(u), { ok: true, status: 200, json: async () => ({ wolves: [{ name: "a", status: "online" }, { name: "b", status: "online" }] }) }), prev), 20_000, fakeDoc("visible"));
			mock.timers.tick(20_000);
			await new Promise((r) => setImmediate(r));
			assert.deepEqual(urls, ["/api/wolves"]);
			stop();
		} finally {
			mock.timers.reset();
		}
	});
});
