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

	it("a queued KB flight or the curator's shimmer asks only for the low float rate, and nothing at all once idle", () => {
		o.needsFrames(0);
		assert.equal(o.frameNeed, "none");
		o.dispatch({ type: "event", event: ev("curate-start", { actor: { kind: "hub", title: "curator" }, detail: { topicIds: ["t9"] } }), now: Date.now() });
		o.needsFrames(0);
		assert.deepEqual([o.frameNeed, o.minFrameMs], ["float", 40]);
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

	it("wolf, thread-hub and subagent badges are world geometry: their on-screen size scales with the camera, 55% of the old size at 1:1", () => {
		o.dispatch({ type: "event", event: ev("thread-active", { actor: th("tw") }), now: Date.now() });
		o.dispatch({ type: "event", event: ev("subagent-spawned", { actor: th("tw", "sa") }), now: Date.now() });
		const screenR = (k: number): Record<string, number> => {
			o.step(1, 0.016, host, k);
			const out: Record<string, number> = {};
			for (const it of o.items(host, k, 1)) out[it.kind] = it.r * k;
			return out;
		};
		const full = screenR(1);
		const far = screenR(0.25);
		assert.ok(Math.abs(full.wolf! - 17 * 0.55) < 1e-9, `wolf radius at k=1: ${full.wolf}`); // home badge is 34 px across
		assert.ok(Math.abs(far.wolf! - full.wolf! * 0.25) < 1e-9, `wolf radius at k=0.25: ${far.wolf}`);
		assert.ok(far.subagent === undefined || Math.abs(far.subagent - full.subagent! * 0.25) < 1e-9);
	});

	it("never passes a negative or non-finite radius to ctx.arc at any zoom, so one bad value cannot disable the overlay", () => {
		const radii: { r: number; k: number }[] = [];
		let curK = 1;
		const rec = new Proxy({}, {
			get: (_t, p) => (p === "measureText" ? () => ({ width: 1 }) : p === "createRadialGradient" || p === "createLinearGradient" ? () => grad : p === "arc" ? (_x: number, _y: number, r: number) => radii.push({ r, k: curK }) : () => undefined),
			set: () => true,
		}) as unknown as CanvasRenderingContext2D;
		o.dispatch({ type: "event", event: ev("thread-active", { actor: th("tz") }), now: Date.now() });
		o.dispatch({ type: "event", event: ev("subagent-spawned", { actor: th("tz", "sa") }), now: Date.now() });
		o.dispatch({ type: "event", event: ev("needs-you", { actor: th("tz") }), now: Date.now() });
		let t = 1;
		for (const k of [1e-5, 1e-3, 0.02, 0.3, 1, 8, 0, -0.5]) {
			curK = k;
			o.step(t, 0.016, host, k);
			o.draw(rec, host, k, t);
			t += 400;
		}
		assert.ok(radii.length > 0);
		assert.deepEqual(radii.filter((a) => !(a.r >= 0 && Number.isFinite(a.r))), []);
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
			// The home wolf is a 34 px badge with the logo path at 62% of it (scale = px / k / 64); the subagent is an agent badge with its own glyph.
			const scales = logo().map((f) => f.scale);
			assert.equal(scales.length, 1);
			assert.ok(Math.abs(scales[0]! - (17 * 0.55 * 0.62) / 32) < 1e-9, `${scales}`); // world size, k-independent: the camera scales it
			assert.equal(logo()[0]?.alpha, 1);
			mock.timers.tick(3_600_000);
			o.dispatch({ type: "tick", now: Date.now() });
			fills.length = 0;
			o.step(2, 0.016, host, 2);
			o.draw(rec, host, 2, 2);
			assert.equal(logo()[0]?.alpha, 0.6);
		}
	});

	it("the home wolf badge (glyph 62% of it), the subagent badge with its bot glyph and the thread dots all scale with the camera, and the dots hide once they are specks", () => {
		const fills: { d?: string; scale: number }[] = [];
		let scale = 1;
		const radii: number[] = [];
		const strokes: string[] = [];
		let botGlyphs = 0;
		const rec = new Proxy({}, {
			get: (_t, p) => (p === "measureText" ? () => ({ width: 1 }) : p === "createRadialGradient" || p === "createLinearGradient" ? () => grad : p === "scale" ? (sx: number) => (scale = sx) : p === "arc" ? (_x: number, _y: number, r: number) => radii.push(r) : p === "stroke" ? (path?: { d?: string }) => path?.d && strokes.push(path.d) : p === "fill" ? (path?: { d?: string }) => fills.push({ d: path?.d, scale }) : () => undefined),
			set: () => true,
		}) as unknown as CanvasRenderingContext2D;
		o.dispatch({ type: "event", event: ev("thread-active", { actor: th("tz") }), now: Date.now() });
		o.dispatch({ type: "event", event: ev("subagent-spawned", { actor: th("tz", "sz") }), now: Date.now() });
		const frame = (k: number) => {
			fills.length = 0;
			radii.length = 0;
			strokes.length = 0;
			o.step(1, 0.016, host, k);
			o.draw(rec, host, k, 1);
			const px = fills.filter((f) => f.d?.startsWith("M8 2L24 18")).map((f) => f.scale * 64 * k);
			botGlyphs = strokes.filter((d) => d.startsWith("M4 10a2")).length;
			const dotPx = 3.2 * 0.55 * k;
			return { px, dot: radii.find((r) => Math.abs(r * k - dotPx) < 1e-6), sub: radii.find((r) => Math.abs(r * k - 7 * 0.55 * k) < 1e-6), badge: radii.find((r) => Math.abs(r * k - 17 * 0.55 * k) < 1e-6) };
		};
		const near = (a: number | undefined, b: number) => assert.ok(a !== undefined && Math.abs(a - b) < 1e-6, `${a} vs ${b}`);
		for (const k of [4, 0.8, 0.3]) {
			const f = frame(k);
			assert.equal(f.px.length, 1, "one wolf glyph (the subagent carries the bot glyph)");
			near(f.px[0], 34 * 0.62 * 0.55 * k);
			near(f.badge ? f.badge * k : undefined, 17 * 0.55 * k);
			near(f.sub ? f.sub * k : undefined, 7 * 0.55 * k);
			assert.equal(botGlyphs, 1, "the running subagent shows its bot glyph");
		}
		assert.ok(frame(0.8).dot !== undefined, "the thread dot keeps its reference proportion");
		assert.equal(frame(0.1).dot, undefined, "thread dots hide once the wolf is a speck");
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
