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
		assert.equal(o.needsFrames(0), false);
	});

	it("a needs-you ring pulses at about 8 fps without keeping the frame loop alive", () => {
		o.start();
		o.dispatch({ type: "event", event: ev("needs-you"), now: Date.now() });
		frames = 0;
		assert.equal(o.needsFrames(0), false); // the loop is not held; the throttle timer asks for frames
		for (let i = 0; i < 20; i++) mock.timers.tick(50); // one second of wall time
		assert.ok(frames >= 7 && frames <= 9, `frames in 1 s: ${frames}`);
	});

	it("frames stop once a trail has faded away", () => {
		o.start();
		o.dispatch({ type: "event", event: ev("kb-read", { target: { kind: "kb-entry", id: "kb-x", domain: "personal" } }), now: Date.now() });
		mock.timers.tick(LIVE_DEFAULTS.trailSec * 1000 + 3000);
		frames = 0;
		mock.timers.tick(5000);
		assert.equal(frames, 0);
		assert.equal(o.needsFrames(0), false);
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
		for (let x = -400; x <= 400; x += 5) {
			const hit = o.hitTest(x, 0, { x: 0, y: 0, k: 1 }, 1e6);
			if (hit?.item.kind === kind) return hit.item.alpha;
		}
		return undefined;
	};
	let o: LiveOverlay;
	beforeEach(() => {
		mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 5_000_000_000_000 });
		o = new LiveOverlay(() => {});
		o.configure(LIVE_DEFAULTS);
	});
	afterEach(() => {
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
		assert.ok(a !== undefined && Math.abs(a - 0.55 * 0.5) < 0.02, `thread alpha ${a}`);
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
