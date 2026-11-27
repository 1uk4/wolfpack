import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import type { ActivityEvent } from "@wolfpack/protocol";
import { LiveOverlay, LIVE_DEFAULTS } from "../../components/graph/live/live-overlay.ts";

let n = 0;
const ev = (verb: string, o: Record<string, unknown> = {}): ActivityEvent =>
	({ v: 1, id: `e${++n}`, pack: "p", ts: 0, ttlMs: 600_000, actor: { kind: "thread", wolf: "hal", threadId: "t1" }, verb, ...o }) as unknown as ActivityEvent;

describe("live overlay frame scheduling", () => {
	let frames = 0;
	let o: LiveOverlay;
	beforeEach(() => {
		mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
		frames = 0;
		o = new LiveOverlay(() => {
			frames++;
			o.needsFrames(0); // what the renderer's tick does after each frame
		});
		o.configure(LIVE_DEFAULTS);
		frames = 0;
	});
	afterEach(() => {
		o.stop();
		mock.timers.reset();
	});

	it("an unchanged state requests no frame and an idle overlay asks for none", () => {
		o.dispatch({ type: "event", event: ev("thread-active"), now: Date.now() });
		frames = 0;
		o.dispatch({ type: "event", event: ev("teleport"), now: Date.now() }); // unknown verb: state object unchanged
		o.dispatch({ type: "tick", now: Date.now() + 1000 }); // nothing expired
		assert.equal(frames, 0);
		o.needsFrames(0);
		assert.equal(o.frameNeed, "float"); // nothing but the idle float: no fast or slow need
		assert.equal(o.minFrameMs, 40);
	});

	it("a needs-you ring breathes on the idle float's 25 fps frame floor, never on a fast one", () => {
		o.start();
		o.dispatch({ type: "event", event: ev("needs-you"), now: Date.now() });
		assert.equal(o.needsFrames(0), true);
		assert.equal(o.frameNeed, "float");
		assert.equal(o.minFrameMs, 40);
	});

	it("frames stop once a trail has faded away", () => {
		o.start();
		o.dispatch({ type: "event", event: ev("kb-read", { target: { kind: "kb-entry", id: "kb-x", domain: "personal" } }), now: Date.now() });
		mock.timers.tick(LIVE_DEFAULTS.trailSec * 1000 + 3000);
		frames = 0;
		mock.timers.tick(5000);
		assert.equal(frames, 0);
		o.needsFrames(0);
		assert.equal(o.frameNeed, "float"); // the faded trail no longer asks for fast or slow frames
	});
});

describe("live overlay fade clock", () => {
	const host = {
		nodePos: () => null,
		hasNode: () => false,
		nodeColor: () => undefined,
		center: () => ({ x: 0, y: 0 }),
		colors: { node: "#888", edge: "#444", label: "#fff", hoverText: "#fff" },
		fontFamily: "sans-serif",
	};
	const grad = { addColorStop: () => undefined };
	const ctx = new Proxy({}, { get: (_t, p) => (p === "measureText" ? () => ({ width: 1 }) : p === "createRadialGradient" || p === "createLinearGradient" ? () => grad : () => undefined), set: () => true }) as unknown as CanvasRenderingContext2D;
	const alphaOf = (o: LiveOverlay, kind: string): number | undefined => {
		for (let y = -100; y <= 100; y += 2) {
			for (let x = -100; x <= 100; x += 2) {
				const hit = o.hitTest(x, y, { x: 0, y: 0, k: 1 }, 1e6);
				if (hit?.item.kind === kind) return hit.item.alpha;
			}
		}
		return undefined;
	};
	let o: LiveOverlay;
	const g = globalThis as unknown as { Path2D?: unknown };
	const hadPath2D = g.Path2D;
	beforeEach(() => {
		g.Path2D = class {
			d: string;
			constructor(d?: string) {
				this.d = d ?? "";
			}
		};
		mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 5_000_000_000_000 });
		o = new LiveOverlay(() => {});
		o.configure(LIVE_DEFAULTS);
	});
	afterEach(() => {
		g.Path2D = hadPath2D;
		o.stop();
		mock.timers.reset();
	});
	const th = (id: string, sub?: string) => ({ kind: "thread", wolf: "hal", threadId: id, ...(sub ? { subagent: sub } : {}) });

	it("an idle thread is half faded 7.5 s into a 15 s fade when the renderer passes its monotonic clock to step and draw", () => {
		const mono = 123_456; // performance.now(): tiny next to epoch ms
		o.dispatch({ type: "event", event: ev("thread-active", { actor: th("tf") }), now: Date.now() });
		o.dispatch({ type: "event", event: ev("thread-idle", { actor: th("tf") }), now: Date.now() });
		mock.timers.tick(7500);
		o.step(mono, 0.016, host, 1);
		o.draw(ctx, host, 1, mono);
		const a = alphaOf(o, "thread");
		assert.ok(a !== undefined && Math.abs(a - 0.45 * 0.5) < 0.02, `thread alpha ${a}`);
	});

	it("draws each wolf as a badge with the wolf-head logo path, dimmed when offline", () => {
		const fills: { d?: string; alpha: number; scale: number }[] = [];
		let alpha = 1;
		let scale = 1;
		const rec = new Proxy({}, {
			get: (_t, p) => (p === "measureText" ? () => ({ width: 1 }) : p === "createRadialGradient" || p === "createLinearGradient" ? () => grad : p === "scale" ? (sx: number) => (scale = sx) : p === "fill" ? (path?: { d?: string }) => fills.push({ d: path?.d, alpha, scale }) : () => undefined),
			set: (_t, p, v) => {
				if (p === "globalAlpha") alpha = v as number;
				return true;
			},
		}) as unknown as CanvasRenderingContext2D;
		const logo = () => fills.filter((f) => f.d?.startsWith("M8 2L24 18"));
		{
			o.dispatch({ type: "event", event: ev("thread-active", { actor: th("tw") }), now: Date.now() });
			o.dispatch({ type: "event", event: ev("subagent-spawned", { actor: th("tw", "sa") }), now: Date.now() });
			o.step(1, 0.016, host, 2);
			o.draw(rec, host, 2, 1);
			// The wolf is a 28 px badge with the logo path at 62% of it (scale = px / k / 64); the subagent is a plain dot.
			const scales = logo().map((f) => f.scale);
			assert.equal(scales.length, 1);
			assert.ok(Math.abs(scales[0]! - (28 * 0.62) / 2 / 64) < 1e-9, `${scales}`);
			assert.equal(logo()[0]?.alpha, 1);
			mock.timers.tick(3_600_000);
			o.dispatch({ type: "tick", now: Date.now() });
			fills.length = 0;
			o.step(2, 0.016, host, 2);
			o.draw(rec, host, 2, 2);
			assert.equal(logo()[0]?.alpha, 0.6);
		}
	});

	it("the wolf badge stays 28 px (glyph 62% of it) and a subagent dot 4.5 px at any zoom, while thread dots keep the old zoom scaling and hide at the floor", () => {
		const fills: { d?: string; scale: number }[] = [];
		let scale = 1;
		const radii: number[] = [];
		const rec = new Proxy({}, {
			get: (_t, p) => (p === "measureText" ? () => ({ width: 1 }) : p === "createRadialGradient" || p === "createLinearGradient" ? () => grad : p === "scale" ? (sx: number) => (scale = sx) : p === "arc" ? (_x: number, _y: number, r: number) => radii.push(r) : p === "fill" ? (path?: { d?: string }) => fills.push({ d: path?.d, scale }) : () => undefined),
			set: () => true,
		}) as unknown as CanvasRenderingContext2D;
		o.dispatch({ type: "event", event: ev("thread-active", { actor: th("tz") }), now: Date.now() });
		o.dispatch({ type: "event", event: ev("subagent-spawned", { actor: th("tz", "sz") }), now: Date.now() });
		const frame = (k: number) => {
			fills.length = 0;
			radii.length = 0;
			o.step(1, 0.016, host, k);
			o.draw(rec, host, k, 1);
			const px = fills.filter((f) => f.d?.startsWith("M8 2L24 18")).map((f) => f.scale * 64 * k);
			const dotPx = 3.2 * Math.min(36.4, Math.max(14, 34 * k)) / 36.4;
			return { px, dot: radii.find((r) => Math.abs(r * k - dotPx) < 1e-6), sub: radii.find((r) => Math.abs(r * k - 4.5) < 1e-6), badge: radii.find((r) => Math.abs(r * k - 14) < 1e-6) };
		};
		const near = (a: number | undefined, b: number) => assert.ok(a !== undefined && Math.abs(a - b) < 1e-6, `${a} vs ${b}`);
		for (const k of [4, 0.8, 0.1]) {
			const f = frame(k);
			assert.equal(f.px.length, 1, "one wolf glyph (the subagent is a plain dot)");
			near(f.px[0], 28 * 0.62);
			near(f.badge ? f.badge * k : undefined, 14);
			near(f.sub ? f.sub * k : undefined, 4.5);
		}
		assert.ok(frame(0.8).dot !== undefined, "the thread dot keeps its reference proportion");
		assert.equal(frame(0.1).dot, undefined, "thread dots hide at the floor");
	});

	it("a finished subagent is half faded 7.5 s after it finished when the renderer passes its monotonic clock to draw", () => {
		const mono = 123_456;
		o.dispatch({ type: "event", event: ev("thread-active", { actor: th("ts") }), now: Date.now() });
		o.dispatch({ type: "event", event: ev("subagent-spawned", { actor: th("ts", "sub1") }), now: Date.now() });
		o.dispatch({ type: "event", event: ev("subagent-finished", { actor: th("ts", "sub1") }), now: Date.now() });
		mock.timers.tick(7500);
		o.step(mono, 0.016, host, 1);
		o.draw(ctx, host, 1, mono);
		const a = alphaOf(o, "subagent");
		assert.ok(a !== undefined && a > 0.2 && a < 0.8, `subagent alpha ${a}`);
	});
});
