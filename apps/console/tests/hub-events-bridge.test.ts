import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProtocolError, type ConsoleClient } from "@wolfpack/client";
import { createHubEventsBridge } from "../src/server/hub-events-bridge.ts";
import { eventsResponse } from "../src/server/events-stream.ts";

const at = "2026-11-05T10:00:00Z";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clientOf = (watch: (o: { signal?: AbortSignal }) => AsyncGenerator<unknown>) => ({ watchHubEvents: watch }) as unknown as ConsoleClient;

describe("hub events bridge", () => {
	it("forwards only the KB-relevant hub frames", async () => {
		const got: string[] = [];
		const frames = [{ type: "work.changed" }, { type: "sweep_started" }, { type: "sweep_item" }, { type: "wolf.presence" }, { type: "kb.changed" }, { type: "sweep_finished" }, { type: "resync" }];
		let bridge!: ReturnType<typeof createHubEventsBridge>;
		bridge = createHubEventsBridge((f) => got.push(f.type));
		bridge.ensure(
			clientOf(async function* () {
				yield* frames;
				bridge.stop();
			}),
		);
		await sleep(20);
		assert.deepEqual(got, ["sweep_started", "sweep_item", "kb.changed", "sweep_finished", "resync"]);
	});
	it("a hub 401 is terminal and reported once", async () => {
		let lost = 0;
		let calls = 0;
		const client = clientOf(async function* () {
			calls++;
			throw Object.assign(new Error("no"), { hubAuth: true });
		});
		const bridge = createHubEventsBridge(() => {}, { onAuthLost: () => lost++, backoffMs: [1] });
		bridge.ensure(client);
		bridge.ensure(client);
		await sleep(30);
		assert.equal(lost, 1);
		assert.equal(calls, 1);
	});
	it("unauthorized / version_mismatch / invalid_request / not_found are terminal (no retry loop)", async () => {
		for (const code of ["unauthorized", "version_mismatch", "invalid_request", "not_found"] as const) {
			let calls = 0;
			const bridge = createHubEventsBridge(() => {}, { backoffMs: [1] });
			bridge.ensure(
				clientOf(async function* () {
					calls++;
					throw new ProtocolError(code, "x", false);
				}),
			);
			await sleep(30);
			assert.equal(calls, 1, code);
			bridge.stop();
		}
	});
	it("a transient failure restarts with backoff and forwards a synthetic resync", async () => {
		const got: string[] = [];
		let calls = 0;
		const bridge = createHubEventsBridge((f) => got.push(f.type), { backoffMs: [1] });
		bridge.ensure(
			clientOf(async function* () {
				calls++;
				if (calls === 1) throw new Error("socket closed");
				yield { type: "kb.changed", id: 1, at, entryIds: [] };
				await sleep(1000);
			}),
		);
		await sleep(60);
		bridge.stop();
		assert.deepEqual(got, ["resync", "kb.changed"]);
		assert.equal(calls, 2);
	});
	it("the backoff resets only after a stream stayed up for stableMs", async () => {
		const gaps: number[] = [];
		let last = Date.now();
		let calls = 0;
		const bridge = createHubEventsBridge(() => {}, { backoffMs: [5, 400], stableMs: 10_000 });
		bridge.ensure(
			clientOf(async function* () {
				gaps.push(Date.now() - last);
				last = Date.now();
				calls++;
				yield { type: "kb.changed", id: calls, at, entryIds: [] }; // frames alone must not reset the backoff
				throw new Error("drop");
			}),
		);
		await sleep(150);
		bridge.stop();
		// 2nd restart would wait 400ms (not 5) because the first stream was short-lived despite delivering a frame
		assert.equal(calls, 2);
		assert.ok(gaps[1]! < 100);
	});
	it("stop mid-stream ends the loop and forwards nothing more", async () => {
		const got: string[] = [];
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const bridge = createHubEventsBridge((f) => got.push(f.type));
		bridge.ensure(
			clientOf(async function* (o) {
				yield { type: "sweep_started", id: 1, at, pending: 1 };
				await gate;
				if (!o.signal?.aborted) yield { type: "sweep_finished", id: 2, at };
			}),
		);
		await sleep(10);
		bridge.stop();
		release();
		await sleep(10);
		assert.deepEqual(got, ["sweep_started"]);
	});
});

// ── per-connection delivery (events-stream.ts) ──────────────────────────────

const decoder = new TextDecoder();
/** Collects the frames an SSE response writes until `done()` or `ms` passes. */
function collect(res: Response) {
	const reader = res.body!.getReader();
	const chunks: string[] = [];
	let ended = false;
	void (async () => {
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				chunks.push(decoder.decode(value));
			}
		} catch {
			/* cancelled */
		}
		ended = true;
	})();
	return {
		text: () => chunks.join(""),
		hubFrames: () => chunks.join("").split("\n\n").filter((c) => c.startsWith("event: hub-event")).map((c) => JSON.parse(c.split("data: ")[1]!).frame as { type: string; tag?: string }),
		ended: () => ended,
		close: () => reader.cancel(),
	};
}

describe("events-stream: hub frames stay on their own connection", () => {
	it("two connections on different tokens each get only their own bridge's frames, exactly once", async () => {
		const mk = (tag: string) =>
			clientOf(async function* (o) {
				yield { type: "sweep_item", id: 1, at, from: "hal", denTopicId: tag, outcome: "create", tag };
				yield { type: "work.changed", id: 2, at, itemId: "x", event: "e" };
				yield { type: "kb.changed", id: 3, at, entryIds: [tag], tag };
				await new Promise<void>((r) => o.signal?.addEventListener("abort", () => r()));
			});
		const a = collect(eventsResponse({ clientFor: async () => mk("A") }));
		const b = collect(eventsResponse({ clientFor: async () => mk("B") }));
		await sleep(50);
		assert.deepEqual(a.hubFrames().map((f) => `${f.type}:${f.tag}`), ["sweep_item:A", "kb.changed:A"]);
		assert.deepEqual(b.hubFrames().map((f) => `${f.type}:${f.tag}`), ["sweep_item:B", "kb.changed:B"]);
		await a.close();
		await b.close();
	});
	it("N connections on one token still deliver each browser the frame once", async () => {
		const mk = () =>
			clientOf(async function* (o) {
				yield { type: "sweep_finished", id: 1, at };
				await new Promise<void>((r) => o.signal?.addEventListener("abort", () => r()));
			});
		const conns = [collect(eventsResponse({ clientFor: async () => mk() })), collect(eventsResponse({ clientFor: async () => mk() })), collect(eventsResponse({ clientFor: async () => mk() }))];
		await sleep(50);
		for (const c of conns) assert.equal(c.hubFrames().length, 1);
		for (const c of conns) await c.close();
	});
	it("a hub 401 on the bridge ends that connection with auth-lost (and not the other)", async () => {
		const bad = collect(
			eventsResponse({
				clientFor: async () =>
					clientOf(async function* () {
						throw Object.assign(new ProtocolError("unauthorized", "revoked", false), { hubAuth: true });
					}),
			}),
		);
		const good = collect(eventsResponse({ clientFor: async () => clientOf(async function* (o) { await new Promise<void>((r) => o.signal?.addEventListener("abort", () => r())); }) }));
		await sleep(50);
		assert.match(bad.text(), /event: auth-lost/);
		assert.equal(bad.ended(), true);
		assert.equal(good.ended(), false);
		await good.close();
	});
});
