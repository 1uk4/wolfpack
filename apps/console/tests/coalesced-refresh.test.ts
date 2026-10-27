/** The sidebar's refresh: a poke during a fetch must not be lost — the final state matches the last server state. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { coalescedRefresh } from "../src/core/coalesced-refresh.ts";

describe("coalescedRefresh", () => {
	it("a poke mid-fetch triggers exactly one more fetch; the end state is the last server state", async () => {
		let server = "needs-you";
		let shown = "";
		const gates: (() => void)[] = [];
		let fetches = 0;
		const refresh = coalescedRefresh(async () => {
			fetches++;
			const snapshot = server; // the server state is read at fetch start
			await new Promise<void>((r) => gates.push(r));
			shown = snapshot;
		});
		const first = refresh();
		server = "busy";
		void refresh(); // mid-fetch
		server = "idle";
		void refresh(); // mid-fetch, coalesces with the previous one
		gates.shift()!(); // first fetch completes with the stale "needs-you"
		await new Promise((r) => setImmediate(r));
		assert.equal(fetches, 2, "exactly one follow-up fetch");
		gates.shift()!();
		await first;
		assert.equal(shown, "idle");
		assert.equal(fetches, 2);
	});

	it("no poke mid-fetch means no extra fetch; a later call runs fresh", async () => {
		let n = 0;
		const refresh = coalescedRefresh(async () => {
			n++;
		});
		await refresh();
		assert.equal(n, 1);
		await refresh();
		assert.equal(n, 2);
	});

	it("a throwing run does not wedge later refreshes", async () => {
		let n = 0;
		const refresh = coalescedRefresh(async () => {
			n++;
			throw new Error("boom");
		});
		await refresh();
		await refresh();
		assert.equal(n, 2);
	});
});
