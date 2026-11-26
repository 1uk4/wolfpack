import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import type { ActivityEvent } from "@wolfpack/protocol";
import { floatOffset, nameHash, roamOffset } from "../../components/graph/live/live-float.ts";
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

describe("wolf roam (pure function of time)", () => {
	it("stays inside the radius, is smooth over 40 ms, wanders more than 15% of the radius in 10 s, and is zero under reduced motion", () => {
		const h = nameHash("hal");
		const R = 100;
		for (let t = 0; t <= 120_000; t += 500) {
			const o = roamOffset(h, t, R);
			assert.ok(Math.abs(o.dx) <= R && Math.abs(o.dy) <= R, `bounded at ${t}`);
			const n = roamOffset(h, t + 40, R);
			assert.ok(Math.hypot(n.dx - o.dx, n.dy - o.dy) < 0.05 * R, "smooth over 40 ms");
		}
		const a = roamOffset(h, 0, R);
		const b = roamOffset(h, 10_000, R);
		assert.ok(Math.hypot(b.dx - a.dx, b.dy - a.dy) > 0.15 * R, "noticeable move in 10 s");
		assert.deepEqual(roamOffset(h, 7000, R, true), { dx: 0, dy: 0 });
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
		assert.ok(Math.max(...xs) - Math.min(...xs) <= 2 * 3.5 * (34 / 36.4) + 1e-9, "the drift stays inside the amplitude around the body");
		const items = o.items(host, 1, 5_000_000_002_000);
		const dot = items.find((i) => i.kind === "thread")!;
		const wolf = items.find((i) => i.kind === "wolf")!;
		assert.ok(Math.abs(Math.hypot(dot.x - wolf.x, dot.y - wolf.y) - 25 * (34 / 36.4)) < 1e-6, "the dot orbits the floated wolf");
		const hit = o.hitTest(wolf.x, wolf.y, { x: 0, y: 0, k: 1 }, 1);
		assert.equal(hit?.item.kind, "wolf");
		assert.ok(Math.hypot(hit!.sx - wolf.x, hit!.sy - wolf.y) < 1e-9, "the hit is reported at the floated position");
	});

	it("a wolf roams freely over the whole graph extent (not a domain): it wanders within bounds, hit-testing follows it, and reduced motion keeps it at the centre", () => {
		const rhost = { ...host, extentRadius: () => 1000 };
		const pos: { x: number; y: number }[] = [];
		for (let t = 0; t <= 60_000; t += 40) {
			o.step(t, 0.04, rhost, 1);
			if (t % 1000 === 0) {
				const w = wolfAt(t);
				pos.push({ x: w.x, y: w.y });
			}
		}
		let far = 0;
		for (const p of pos) far = Math.max(far, Math.hypot(p.x - pos[0]!.x, p.y - pos[0]!.y));
		assert.ok(far > 150, `it wandered across the graph, far beyond a domain-sized roam (${far})`);
		assert.ok(far < 2 * (550 + 36 + 4) * Math.SQRT2, `and stayed within 0.55 of the extent (${far})`);
		for (const p of pos) assert.ok(Math.hypot(p.x, p.y) < 550 * Math.SQRT2 + 36 + 4, `inside the graph (${p.x},${p.y})`);
		const w = wolfAt(60_000);
		const hit = o.hitTest(w.x, w.y, { x: 0, y: 0, k: 1 }, 1);
		assert.equal(hit?.item.kind, "wolf");
		assert.ok(Math.hypot(hit!.sx - w.x, hit!.sy - w.y) < 1e-9);
		const win = globalThis as unknown as { window?: unknown };
		win.window = { matchMedia: () => ({ matches: true }), innerWidth: 1280 };
		try {
			const still = new LiveOverlay(() => {});
			still.configure(LIVE_DEFAULTS);
			still.dispatch({ type: "event", event: ev("thread-active", { kind: "thread", wolf: "hal", threadId: "t1" }), now: Date.now() });
			const xs: number[] = [];
			for (let t = 0; t <= 30_000; t += 40) {
				still.step(t, 0.04, rhost, 1);
				if (t % 5000 === 0) xs.push(still.items(rhost, 1, t).find((i) => i.kind === "wolf")!.x);
			}
			assert.ok(Math.max(...xs) - Math.min(...xs) < 1e-9, "reduced motion: the wolf stays at its anchor");
			still.stop();
		} finally {
			delete win.window;
		}
	});

	it("an active thread and its wolf read as working; an idle one is dimmer and not working", () => {
		const now = Date.now();
		const at = () => o.items(host, 1, now);
		const active = at();
		assert.equal(active.find((i) => i.kind === "wolf")!.working, true);
		const busy = active.find((i) => i.kind === "thread")!;
		assert.equal(busy.working, true);
		o.dispatch({ type: "event", event: ev("thread-idle", { kind: "thread", wolf: "hal", threadId: "t1" }), now });
		const idle = at();
		assert.equal(idle.find((i) => i.kind === "wolf")!.working, false);
		const dim = idle.find((i) => i.kind === "thread")!;
		assert.equal(dim.working, false);
		assert.ok(dim.alpha < busy.alpha, `idle ${dim.alpha} < active ${busy.alpha}`);
	});

	it("holds the frame loop only at the float rate when nothing else moves", () => {
		assert.equal(o.needsFrames(1_000_000), true);
		assert.equal(o.frameNeed, "float");
		assert.equal(o.minFrameMs, 40);
	});
});

describe("wolf spacing: ring anchors, activity bias, soft separation", () => {
	const g = globalThis as unknown as { Path2D?: unknown; window?: unknown };
	const nodes = new Map<string, { x: number; y: number }>();
	const mk = (extent: number) => ({
		nodePos: (id: string) => nodes.get(id) ?? null,
		hasNode: (id: string) => nodes.has(id),
		nodeColor: () => undefined,
		center: () => ({ x: 0, y: 0 }),
		extentRadius: () => extent,
		colors: { node: "#888", edge: "#444", label: "#fff", hoverText: "#fff" },
		fontFamily: "sans-serif",
	});
	const ev = (verb: string, actor: Record<string, unknown>): ActivityEvent => ({ v: 1, id: `s${Math.random()}`, pack: "p", ts: 0, ttlMs: 600_000, actor, verb }) as unknown as ActivityEvent;
	const T0 = 5_000_000_000_000;
	const DIAM = 34; // wolf diameter in world units at k=1
	let o: LiveOverlay;
	const spawn = (names: string[]) => {
		for (const n of names) o.dispatch({ type: "event", event: ev("thread-active", { kind: "thread", wolf: n, threadId: `${n}/home` }), now: Date.now() });
	};
	const wolves = (host: ReturnType<typeof mk>, t = T0) => o.items(host, 1, t).filter((i) => i.kind === "wolf");
	const gap = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
	const reduce = () => {
		g.window = { matchMedia: () => ({ matches: true }), innerWidth: 1280 };
	};
	beforeEach(() => {
		g.Path2D = class {};
		nodes.clear();
		mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: T0 });
		o = new LiveOverlay(() => {});
		o.configure(LIVE_DEFAULTS);
	});
	afterEach(() => {
		delete g.Path2D;
		delete g.window;
		o.stop();
		mock.timers.reset();
	});

	it("three wolves seeded at t=0 start at least two wolf-diameters apart", () => {
		const host = mk(1000);
		spawn(["1uk4", "hal", "jack"]);
		o.step(0, 0.016, host, 1);
		const w = wolves(host);
		assert.equal(w.length, 3);
		for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) assert.ok(gap(w[i]!, w[j]!) >= 2 * DIAM, `${w[i]!.key} vs ${w[j]!.key}`);
	});

	it("reduced motion: no float, anchors are stable across frames, and the spacing stays", () => {
		reduce();
		const host = mk(1000);
		spawn(["1uk4", "hal", "jack"]);
		o.step(0, 0.016, host, 1);
		const first = wolves(host, T0).map((i) => [i.key, i.x, i.y]);
		for (let t = 40; t < 20_000; t += 40) o.step(t, 0.04, host, 1);
		const later = wolves(host, T0 + 17_000).map((i) => [i.key, i.x, i.y]);
		assert.deepEqual(later, first);
		const w = wolves(host);
		for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) assert.ok(gap(w[i]!, w[j]!) >= 2 * DIAM);
	});

	it("two wolves whose anchors coincide are pushed apart over a few steps", () => {
		reduce();
		const host = mk(10); // a ring of radius 4: the anchors coincide to within a fraction of a wolf
		spawn(["hal", "jack"]);
		o.step(0, 0.016, host, 1);
		for (let t = 40; t < 6000; t += 40) o.step(t, 0.04, host, 1);
		const w = wolves(host);
		assert.ok(gap(w[0]!, w[1]!) >= 2 * DIAM, `pushed apart (${gap(w[0]!, w[1]!)})`);
	});

	it("a wolf with one feature hub settles about halfway toward it, never all the way", () => {
		reduce();
		const host = mk(1000);
		const pos = (threadId: string) => {
			o.stop();
			o = new LiveOverlay(() => {});
			o.configure(LIVE_DEFAULTS);
			o.dispatch({ type: "event", event: ev("thread-active", { kind: "thread", wolf: "hal", threadId, title: "f" }), now: Date.now() });
			for (let t = 0; t <= 20_000; t += 40) o.step(t, 0.04, host, 1);
			return wolves(host)[0]!;
		};
		const plain = pos("hal/home");
		nodes.set("work:ELzLSkV", { x: -900, y: 700 });
		const hub = nodes.get("work:ELzLSkV")!;
		const biased = pos("hal/feature-work-wolfpack-ELzLSkV");
		const frac = 1 - gap(biased, hub) / gap(plain, hub);
		// One hub's invisible spring pulls the anchor half the way (wolfSpringAnchor: n / (1 + n)).
		assert.ok(Math.abs(frac - 0.5) < 0.05, `moved ${(frac * 100).toFixed(0)}% toward the hub`);
	});
});
