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
