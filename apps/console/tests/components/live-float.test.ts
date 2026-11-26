import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import type { ActivityEvent } from "@wolfpack/protocol";
import { floatOffset, nameHash } from "../../components/graph/live/live-float.ts";
import { LIVE_DEFAULTS, LiveOverlay } from "../../components/graph/live/live-overlay.ts";

describe("idle float (pure function of time)", () => {
	it("gives the same offset for the same time, stays inside the amplitude, and actually moves", () => {
		const h = nameHash("hal");
		const a = floatOffset(h, 123_456, 3.5);
		assert.deepEqual(floatOffset(h, 123_456, 3.5), a);
		let moved = 0;
		let prev = floatOffset(h, 0, 3.5);
		for (let t = 0; t <= 60_000; t += 250) {
			const o = floatOffset(h, t, 3.5);
			assert.ok(Math.abs(o.dx) <= 3.5 && Math.abs(o.dy) <= 3.5, `bounded at ${t}: ${o.dx},${o.dy}`);
			assert.ok(Math.hypot(o.dx - prev.dx, o.dy - prev.dy) < 2, "smooth: no jumps between 250 ms samples");
			moved += Math.hypot(o.dx - prev.dx, o.dy - prev.dy);
			prev = o;
		}
		assert.ok(moved > 10, `it drifts (${moved})`);
		assert.notDeepEqual(floatOffset(nameHash("scout"), 5000, 3.5), floatOffset(h, 5000, 3.5), "each entity has its own phase");
	});

	it("is zero under reduced motion or with no amplitude", () => {
		assert.deepEqual(floatOffset(nameHash("hal"), 9999, 3.5, { reduced: true }), { dx: 0, dy: 0 });
		assert.deepEqual(floatOffset(nameHash("hal"), 9999, 0), { dx: 0, dy: 0 });
	});
});

describe("floating wolves in the overlay", () => {
	const host = {
		nodePos: () => null,
		hasNode: () => false,
		nodeColor: () => undefined,
		center: () => ({ x: 0, y: 0 }),
		colors: { node: "#888", edge: "#444", label: "#fff", hoverText: "#fff" },
		fontFamily: "sans-serif",
	};
	const ev = (verb: string, actor: Record<string, unknown>): ActivityEvent => ({ v: 1, id: `e${Math.random()}`, pack: "p", ts: 0, ttlMs: 600_000, actor, verb }) as unknown as ActivityEvent;
	const g = globalThis as unknown as { Path2D?: unknown };
	let o: LiveOverlay;
	beforeEach(() => {
		g.Path2D = class {};
		mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 5_000_000_000_000 });
		o = new LiveOverlay(() => {});
		o.configure(LIVE_DEFAULTS);
		o.dispatch({ type: "event", event: ev("thread-active", { kind: "thread", wolf: "hal", threadId: "t1" }), now: Date.now() });
		o.step(0, 0.016, host, 1);
	});
	afterEach(() => {
		delete g.Path2D;
		o.stop();
		mock.timers.reset();
	});
	const wolfAt = (t: number) => o.items(host, 1, t).find((i) => i.kind === "wolf")!;

	it("the wolf drifts within ~3.5 reference px of its body, and its thread dot, link anchor and hit-test follow the floated position", () => {
		const t0 = wolfAt(5_000_000_000_000);
		const t1 = wolfAt(5_000_000_002_000);
		assert.ok(Math.hypot(t1.x - t0.x, t1.y - t0.y) > 0.3, "it moved");
		const xs: number[] = [];
		for (let t = 0; t < 60_000; t += 500) xs.push(wolfAt(5_000_000_000_000 + t).x);
		assert.ok(Math.max(...xs) - Math.min(...xs) <= 2 * 3.5 * (24 / 26) + 1e-9, "the drift stays inside the amplitude around the body");
		const items = o.items(host, 1, 5_000_000_002_000);
		const dot = items.find((i) => i.kind === "thread")!;
		const wolf = items.find((i) => i.kind === "wolf")!;
		assert.ok(Math.abs(Math.hypot(dot.x - wolf.x, dot.y - wolf.y) - 25 * (24 / 26)) < 1e-6, "the dot orbits the floated wolf");
		const hit = o.hitTest(wolf.x, wolf.y, { x: 0, y: 0, k: 1 }, 1);
		assert.equal(hit?.item.kind, "wolf");
		assert.ok(Math.hypot(hit!.sx - wolf.x, hit!.sy - wolf.y) < 1e-9, "the hit is reported at the floated position");
	});

	it("holds the frame loop only at the float rate when nothing else moves", () => {
		assert.equal(o.needsFrames(1_000_000), true);
		assert.equal(o.frameNeed, "float");
		assert.equal(o.minFrameMs, 40);
	});
});
