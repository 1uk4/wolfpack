import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ActivityEvent } from "@wolfpack/protocol";
import { formatLiveSeconds, liveSecondsFromPosition, liveSecondsToPosition, sanitizeLiveSettings } from "../../../src/core/graph/render-settings.ts";
import { DEFAULT_LIVE_OPTIONS, emptyLiveState, reduceLive } from "../../../src/core/graph/live/live-state.ts";
import { EFFECTS } from "../../../components/graph/live/live-effects.ts";
import { liveSettingsOf } from "../../../components/graph/live/live-overlay.ts";

describe("live seconds slider scale", () => {
	it("maps the ends and the 60 s knee, with 0-60 s taking most of the travel", () => {
		assert.equal(liveSecondsFromPosition(0), 0);
		assert.equal(liveSecondsFromPosition(75), 60);
		assert.equal(liveSecondsFromPosition(100), 300);
		assert.equal(liveSecondsToPosition(15), 18.75);
	});
	it("is monotonic, clamped and round-trips", () => {
		let prev = -1;
		for (let p = 0; p <= 100; p++) {
			const s = liveSecondsFromPosition(p);
			assert.ok(s >= prev, `not monotonic at ${p}`);
			prev = s;
			assert.ok(Math.abs(liveSecondsToPosition(s) - p) <= 1.2, `round trip at ${p}`);
		}
		assert.equal(liveSecondsFromPosition(-20), 0);
		assert.equal(liveSecondsFromPosition(400), 300);
		assert.equal(liveSecondsToPosition(9999), 100);
		for (const sec of [0, 15, 60, 120, 300]) assert.equal(liveSecondsFromPosition(liveSecondsToPosition(sec)), sec);
	});
	it("formats seconds and minutes", () => {
		assert.equal(formatLiveSeconds(15), "15s");
		assert.equal(formatLiveSeconds(120), "2m");
		assert.equal(formatLiveSeconds(0), "0s");
	});
});

describe("live settings sanitizer", () => {
	it("clamps fade and trail to 0-300 s and intensity to a 1-5 integer", () => {
		assert.deepEqual(sanitizeLiveSettings({ subagentFadeSec: 900, trailSec: -4, intensity: 9 }), { enabled: true, subagentFadeSec: 300, trailSec: 0, intensity: 5, motion: "follow", memory: true, homeSpring: 1, subPull: 1 });
		assert.equal(sanitizeLiveSettings({ intensity: 2.6 }).intensity, 3);
		assert.equal(sanitizeLiveSettings({ intensity: 0 }).intensity, 1);
		assert.equal(sanitizeLiveSettings({ trailSec: 200 }).trailSec, 200);
	});
	it("live map motion defaults to following the system and keeps only 'always' as the other value", () => {
		assert.equal(sanitizeLiveSettings(undefined).motion, "follow");
		assert.equal(sanitizeLiveSettings({ motion: "always" }).motion, "always");
		assert.equal(sanitizeLiveSettings({ motion: "bogus" as never }).motion, "follow");
		assert.equal(liveSettingsOf({ live: { motion: "always" } }).motion, "always");
	});
	it("memory defaults to on; only an explicit false turns it off", () => {
		assert.equal(sanitizeLiveSettings(undefined).memory, true);
		assert.equal(sanitizeLiveSettings({ memory: false }).memory, false);
		assert.equal(sanitizeLiveSettings({ memory: "no" as never }).memory, true);
		assert.equal(liveSettingsOf({ live: { memory: false } }).memory, false);
	});
	it("homeSpring and subPull default to 1 for old files and clamp to 0.1-5", () => {
		const d = sanitizeLiveSettings(undefined);
		assert.deepEqual([d.homeSpring, d.subPull], [1, 1]);
		const c = sanitizeLiveSettings({ homeSpring: 99, subPull: -2 });
		assert.deepEqual([c.homeSpring, c.subPull], [5, 0.1]);
		assert.equal(sanitizeLiveSettings({ subPull: "x" as never }).subPull, 1);
	});
	it("the overlay reads the same range", () => {
		const l = liveSettingsOf({ live: { trailSec: 0, subagentFadeSec: 250, intensity: 4 } });
		assert.deepEqual([l.trailSec, l.subagentFadeSec, l.intensity], [0, 250, 4]);
	});
});

let n = 0;
const ev = (verb: string, o: Record<string, unknown> = {}): ActivityEvent =>
	({ v: 1, id: `c${++n}`, pack: "p", ts: 0, ttlMs: 600_000, actor: { kind: "thread", wolf: "hal", threadId: "t1" }, verb, ...o }) as unknown as ActivityEvent;

describe("reducer follows changed live settings mid-stream", () => {
	it("a changed trailSec applies to trails already on screen at the next tick", () => {
		let s = reduceLive(emptyLiveState(), { type: "event", event: ev("kb-read", { target: { kind: "kb-entry", id: "kb-x", domain: "personal" } }), now: 1000 });
		assert.equal(s.trails.length, 1);
		assert.equal(reduceLive(s, { type: "tick", now: 21_000 }, { ...DEFAULT_LIVE_OPTIONS, trailSec: 15 }).trails.length, 0);
		s = reduceLive(s, { type: "tick", now: 11_000 }, { ...DEFAULT_LIVE_OPTIONS, trailSec: 60 });
		assert.equal(s.trails.length, 1);
		assert.equal(reduceLive(s, { type: "tick", now: 21_000 }, { ...DEFAULT_LIVE_OPTIONS, trailSec: 5 }).trails.length, 0);
	});
	it("a changed subagentFadeSec applies to a subagent that already finished", () => {
		const actor = { kind: "subagent", wolf: "hal", subagent: "w1", parentThreadId: "t1" };
		let s = reduceLive(emptyLiveState(), { type: "event", event: ev("subagent-spawned", { actor }), now: 0 });
		s = reduceLive(s, { type: "event", event: ev("subagent-finished", { actor }), now: 1000 }, { ...DEFAULT_LIVE_OPTIONS, subagentFadeSec: 15 });
		const keep = (sec: number, now: number) => Object.keys(reduceLive(s, { type: "tick", now }, { ...DEFAULT_LIVE_OPTIONS, subagentFadeSec: sec }).subagents).length;
		assert.equal(keep(15, 31_000), 0);
		assert.equal(keep(120, 31_000), 1);
		assert.equal(keep(5, 11_000), 0);
	});
});

describe("intensity reaches the effect parameters", () => {
	const radius = (intensity: number, t: number, reduced: boolean) => {
		const out: number[] = [];
		const ctx = {
			beginPath() {},
			arc(_x: number, _y: number, r: number) {
				out.push(r);
			},
			fill() {},
			stroke() {},
			set fillStyle(_v: string) {},
			set strokeStyle(_v: string) {},
			set lineWidth(_v: number) {},
		} as unknown as CanvasRenderingContext2D;
		EFFECTS.pulse!({ ctx, x: 0, y: 0, r: 10, k: 1, t, color: "#112233", intensity, reduced });
		return out[0]!;
	};
	it("a higher intensity draws a bigger pulse", () => {
		assert.ok(radius(5, 0.5, false) > radius(1, 0.5, false));
	});
	it("reduced motion is static whatever the progress", () => {
		assert.equal(radius(5, 0.1, true), radius(5, 0.9, true));
	});
});
