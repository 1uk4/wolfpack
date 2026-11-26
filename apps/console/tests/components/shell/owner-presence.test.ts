/** Owner presence controller (work-wolfpack-BPwZ7wf): debounce, target change, heartbeat, hidden tab; fake scheduler, no DOM. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPresenceController, targetFromPath, targetFromView, type PresenceTarget, type Scheduler } from "../../../components/shell/owner-presence.ts";

function fake() {
	let now = 0;
	let seq = 0;
	const timers = new Map<number, { at: number; fn: () => void; every?: number }>();
	const sched: Scheduler = {
		setTimeout: (fn, ms) => (timers.set(++seq, { at: now + ms, fn }), seq),
		clearTimeout: (h) => void timers.delete(h as number),
		setInterval: (fn, ms) => (timers.set(++seq, { at: now + ms, fn, every: ms }), seq),
		clearInterval: (h) => void timers.delete(h as number),
	};
	const advance = (ms: number) => {
		const end = now + ms;
		for (;;) {
			const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
			if (!next) break;
			const [id, t] = next;
			now = t.at;
			if (t.every) t.at += t.every;
			else timers.delete(id);
			t.fn();
		}
		now = end;
	};
	const sent: PresenceTarget[] = [];
	const c = createPresenceController({ send: (t) => sent.push(t), sched });
	return { c, sent, advance };
}
const A: PresenceTarget = { kind: "thread", id: "a" };
const B: PresenceTarget = { kind: "work-item", id: "work-wolfpack-B" };

describe("owner presence controller", () => {
	it("debounces target changes by 1 s: rapid changes send only the last", () => {
		const { c, sent, advance } = fake();
		c.setTarget(A);
		advance(500);
		c.setTarget(B);
		advance(999);
		assert.equal(sent.length, 0);
		advance(1);
		assert.deepEqual(sent, [B]);
	});

	it("heartbeats every 60 s on the same target and not for an unchanged target", () => {
		const { c, sent, advance } = fake();
		c.setTarget(A);
		advance(1000);
		c.setTarget({ ...A });
		advance(60_000);
		assert.equal(sent.length, 2); // the change, one heartbeat at t=60s
	});

	it("stops the heartbeat while hidden and sends again once visible", () => {
		const { c, sent, advance } = fake();
		c.setTarget(A);
		advance(1000);
		c.setActive(false);
		advance(300_000);
		assert.equal(sent.length, 1);
		c.setActive(true);
		advance(1000);
		assert.equal(sent.length, 2);
	});

	it("holds a change made while hidden until the tab is active", () => {
		const { c, sent, advance } = fake();
		c.setActive(false);
		c.setTarget(A);
		advance(5000);
		assert.equal(sent.length, 0);
		c.setActive(true);
		advance(1000);
		assert.deepEqual(sent, [A]);
	});

	it("maps pages and viewer views to targets", () => {
		assert.deepEqual(targetFromPath("/wolf/hal/thread/t-1"), { kind: "thread", id: "hal/t-1" });
		assert.deepEqual(targetFromPath("/work/work-wolfpack-X"), { kind: "work-item", id: "work-wolfpack-X" });
		assert.deepEqual(targetFromPath("/kb/entry/kb-wolfpack-Y"), { kind: "kb-entry", id: "kb-wolfpack-Y" });
		assert.equal(targetFromPath("/graph"), null);
		assert.deepEqual(targetFromView({ kind: "kb", id: "k", title: "T" }), { kind: "kb-entry", id: "k", title: "T" });
		assert.equal(targetFromView({ kind: "frame", id: "f" }), null);
	});
});
