import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ActivityEvent } from "@wolfpack/protocol";
import { emptyKbLife, reduceKbLife } from "../../src/core/index.ts";
import { flightPos, ITEM_TRAVEL_MS, itemPos } from "../../components/graph/live/kb-life-draw.ts";
import { LIVE_TUNING } from "../../components/graph/live/live-tuning.ts";

describe("memory items orbit Home on the inner ring", () => {
	it("a flight's slot lies between the Home disc and the wolves' rest orbit", () => {
		const home = { x: 100, y: 50 };
		const f = { id: "f", wolf: "hal", stage: "hold", slot: 2, at: 0, endAt: 1 } as never;
		const p = flightPos(f, home, home, null, 0, 1, true, 1);
		const r = Math.hypot(p.x - home.x, p.y - home.y);
		assert.ok(Math.abs(r - 40) < 1e-6, `radius ${r}`);
		assert.ok(r > LIVE_TUNING.denRadiusPx && r < LIVE_TUNING.restRadiusPx);
	});
});

describe("a promoted item keeps its place on the ring", () => {
	const ev = (verb: string, detail: object): ActivityEvent => ({ v: 1, id: `e-${verb}-${Math.random()}`, pack: "p", ts: 0, ttlMs: 60_000, actor: { kind: "wolf", wolf: "hal" }, verb, target: verb === "memory-promote" ? { kind: "domain", id: "d" } : undefined, detail }) as unknown as ActivityEvent;
	const home = { x: 0, y: 0 };
	const wolf = { x: 200, y: 0 };
	it("the flight is where its topic dot was at the promote, not back at the wolf", () => {
		const T0 = 10_000;
		let s = reduceKbLife(emptyKbLife(T0), ev("memory-consolidate", { count: 5, topicIds: ["t1", "t2"] }), T0);
		const t2 = s.topics[1]!;
		const at = T0 + 5000;
		const before = itemPos(wolf, home, t2.slot, t2.born, at, 1, false);
		s = reduceKbLife(s, ev("memory-promote", { ref: "c2", topicIds: ["t2"] }), at);
		const p = flightPos(s.flights[0]!, wolf, home, null, at, 1, false, 1);
		assert.ok(Math.hypot(p.x - before.x, p.y - before.y) < 0.5, `jumped to ${p.x},${p.y} from ${before.x},${before.y}`);
	});
	it("a promote with no earlier topic starts at the wolf", () => {
		const s = reduceKbLife(emptyKbLife(10_000), ev("memory-promote", { ref: "c9", topicIds: ["t9"] }), 10_000);
		assert.deepEqual(flightPos(s.flights[0]!, wolf, home, null, 10_000, 1, false, 1), wolf);
	});
});

describe("a memory item travels from its wolf to the ring", () => {
	const home = { x: 0, y: 0 };
	const wolf = { x: 200, y: 0 };
	const dist = (p: { x: number; y: number }) => Math.hypot(p.x - home.x, p.y - home.y);
	it("is born at its wolf, then lands on the ring round Home and stays there", () => {
		const born = 1000;
		assert.deepEqual(itemPos(wolf, home, 3, born, born, 1, false), wolf);
		const mid = dist(itemPos(wolf, home, 3, born, born + ITEM_TRAVEL_MS / 2, 1, false));
		assert.ok(mid > 40 && mid < 200, `mid-flight ${mid}`);
		assert.ok(Math.abs(dist(itemPos(wolf, home, 3, born, born + ITEM_TRAVEL_MS, 1, false)) - 40) < 1e-6);
		assert.ok(Math.abs(dist(itemPos(wolf, home, 3, born, born + 60_000, 1, false)) - 40) < 1e-6);
	});
	it("under reduced motion appears on the ring with no travel", () => {
		assert.ok(Math.abs(dist(itemPos(wolf, home, 3, 1000, 1000, 1, true)) - 40) < 1e-6);
	});
});
