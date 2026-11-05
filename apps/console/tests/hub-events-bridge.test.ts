import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConsoleClient } from "@wolfpack/client";
import { createHubEventsBridge } from "../src/server/hub-events-bridge.ts";

describe("hub events bridge", () => {
	it("forwards only the KB-relevant hub frames", async () => {
		const got: string[] = [];
		const frames = [{ type: "work.changed" }, { type: "sweep_started" }, { type: "sweep_item" }, { type: "wolf.presence" }, { type: "kb.changed" }, { type: "sweep_finished" }, { type: "resync" }];
		let bridge!: ReturnType<typeof createHubEventsBridge>;
		const client = {
			async *watchHubEvents() {
				yield* frames;
				bridge.stop();
			},
		} as unknown as ConsoleClient;
		bridge = createHubEventsBridge((f) => got.push(f.type));
		bridge.ensure(client);
		await new Promise((r) => setTimeout(r, 20));
		assert.deepEqual(got, ["sweep_started", "sweep_item", "kb.changed", "sweep_finished", "resync"]);
	});
	it("a hub 401 is terminal and reported once", async () => {
		let lost = 0;
		let calls = 0;
		const client = {
			// eslint-disable-next-line require-yield
			async *watchHubEvents() {
				calls++;
				throw Object.assign(new Error("no"), { hubAuth: true });
			},
		} as unknown as ConsoleClient;
		const bridge = createHubEventsBridge(() => {}, { onAuthLost: () => lost++, backoffMs: [1] });
		bridge.ensure(client);
		bridge.ensure(client);
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(lost, 1);
		assert.equal(calls, 1);
	});
	it("a client that cannot watch is ignored", () => {
		createHubEventsBridge().ensure({} as ConsoleClient);
	});
});
