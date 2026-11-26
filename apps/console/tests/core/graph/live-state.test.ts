import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ActivityEvent, PresenceSnapshot } from "@wolfpack/protocol";
import { threadKey } from "../../../src/core/graph/live/thread-key.ts";
import { emptyLiveState, homeDomainOf, reduceLive, subagentAlpha, threadAlpha, visibleThreads, type LiveState } from "../../../src/core/graph/live/live-state.ts";

let n = 0;
const ev = (verb: string, o: Record<string, unknown> = {}): ActivityEvent =>
	({ v: 1, id: `e${++n}`, pack: "p", ts: 0, ttlMs: 60_000, actor: { kind: "thread", wolf: "hal", threadId: "t1" }, verb, ...o }) as unknown as ActivityEvent;
const feed = (s: LiveState, e: ActivityEvent, now: number) => reduceLive(s, { type: "event", event: e, now });
const tick = (s: LiveState, now: number) => reduceLive(s, { type: "tick", now });
const kb = { kind: "kb-entry", id: "kb-x", domain: "personal" };
const sub = { kind: "subagent", wolf: "hal", subagent: "w1", parentThreadId: "t1" };

describe("live overlay reducer", () => {
	it("keys a wolf-prefixed thread id once: roster row and subagent parent (either form) join the same hub", () => {
		const id = "1uk4/feature-work-wolfpack-X";
		let s = feed(emptyLiveState(), ev("thread-active", { actor: { kind: "thread", wolf: "1uk4", threadId: id } }), 0);
		assert.deepEqual(Object.keys(s.threads), [id]);
		s = reduceLive(s, { type: "threads", threads: [{ wolf: "1uk4", id: "feature-work-wolfpack-X" }], now: 1 } as never);
		assert.deepEqual(Object.keys(s.threads), [id]);
		for (const [i, parentThreadId] of [id, "feature-work-wolfpack-X"].entries()) {
			const sa = { kind: "subagent", wolf: "1uk4", subagent: `w${i}`, parentThreadId, threadId: `1uk4/sub-${i}` };
			s = feed(s, ev("subagent-spawned", { actor: sa, ttlMs: 600_000 }), 2);
		}
		s = tick(s, 3);
		assert.deepEqual(Object.keys(s.threads), [id]);
		assert.deepEqual(Object.values(s.subagents).map((a) => threadKey(a.wolf, a.parentThreadId!)), [id, id]);
	});

	it("threadKey prefixes a bare slug, keeps a prefixed id, is idempotent, and treats another wolf's prefix as a slug", () => {
		assert.equal(threadKey("1uk4", "feature-x"), "1uk4/feature-x");
		assert.equal(threadKey("1uk4", "1uk4/feature-x"), "1uk4/feature-x");
		assert.equal(threadKey("1uk4", threadKey("1uk4", "hal/x")), "1uk4/hal/x");
	});

	it("thread-active brings the wolf online with a visible thread; thread-idle fades an unbound thread out over the fade window", () => {
		let s = feed(emptyLiveState(), ev("thread-active", { actor: { kind: "thread", wolf: "hal", threadId: "t1", title: "Plan" } }), 1000);
		assert.equal(s.wolves.hal!.online, true);
		assert.deepEqual(visibleThreads(s).map((t) => [t.id, t.title]), [["t1", "Plan"]]);
		s = feed(s, ev("thread-idle"), 2000);
		assert.deepEqual(visibleThreads(s, 15, 10_000).map((t) => t.id), ["t1"]); // still there, dimmed, 8 s into the 15 s fade
		assert.equal(threadAlpha(s, s.threads["hal/t1"]!, 9500, 15), 0.5);
		assert.deepEqual(visibleThreads(s, 15, 17_000), []);
		s = tick(s, 17_100);
		assert.deepEqual(Object.keys(s.threads), []);
	});

	it("an idle thread stays visible as long as its subagent runs, and fades after the subagent finished", () => {
		let s = feed(emptyLiveState(), ev("thread-active"), 0);
		s = feed(s, ev("subagent-spawned", { actor: sub, ttlMs: 600_000 }), 100);
		s = feed(s, ev("thread-idle"), 200);
		s = tick(s, 100_000);
		assert.deepEqual(visibleThreads(s, 15, 100_000).map((t) => t.id), ["t1"]);
		assert.equal(threadAlpha(s, s.threads["hal/t1"]!, 100_000, 15), 1);
		s = feed(s, ev("subagent-finished", { actor: sub }), 100_000);
		assert.deepEqual(visibleThreads(s, 15, 110_000).map((t) => t.id), ["t1"]);
		assert.deepEqual(visibleThreads(s, 15, 116_000), []);
	});

	it("a bound thread stays visible while idle, carrying its work item; unbound hides it", () => {
		let s = feed(emptyLiveState(), ev("bound", { target: { kind: "work-item", id: "work-x-1" } }), 0);
		s = feed(s, ev("thread-idle"), 10);
		assert.equal(visibleThreads(s)[0]!.bound?.id, "work-x-1");
		s = feed(s, ev("unbound"), 20);
		assert.equal(visibleThreads(s, 15, 15_011).length, 0); // idle since 10 ms: gone once the fade is over
	});

	it("kb-read sets the wolf's last target and adds a pulse and a trail; unknown verbs are ignored", () => {
		const s = feed(emptyLiveState(), ev("kb-read", { target: kb }), 5);
		assert.equal(s.wolves.hal!.lastTarget?.id, "kb-x");
		assert.equal(s.trails.length, 1);
		assert.equal(s.pulses.length, 1);
		assert.equal(feed(s, ev("teleport"), 6), s);
	});

	it("expires a wolf by its event ttl but keeps it on the roster, offline", () => {
		let s = feed(emptyLiveState(), ev("thread-active", { ttlMs: 1000 }), 0);
		s = tick(s, 1500);
		assert.equal(s.wolves.hal!.online, false);
		assert.deepEqual(visibleThreads(s), []);
	});

	it("a subagent's thread-active heartbeat creates or refreshes it, attached to its parent thread; only subagent-finished ends it", () => {
		const beat = { kind: "subagent", wolf: "hal", threadId: "hal/sub-1", subagent: "w1", parentThreadId: "t1" };
		const snapshot = { v: 1, at: 1000, wolves: [], threads: [], subagents: [{ event: ev("thread-active", { actor: beat }), expiresAt: 61_000 }], owner: [] } as unknown as PresenceSnapshot;
		let s = reduceLive(emptyLiveState(), { type: "snapshot", snapshot, now: 5000 });
		assert.deepEqual(Object.values(s.subagents).map((a) => [a.name, a.parentThreadId, a.finishedAt]), [["w1", "t1", undefined]]);
		assert.deepEqual(Object.keys(s.threads), []); // the sub's own thread id is not a thread on the map
		const live = feed(emptyLiveState(), ev("thread-active", { actor: beat }), 0);
		assert.deepEqual(Object.values(live.subagents).map((a) => a.parentThreadId), ["t1"]);
		s = feed(s, ev("thread-active", { actor: beat }), 30_000);
		assert.equal(Object.values(s.subagents)[0]!.expiresAt, 90_000);
		s = feed(s, ev("subagent-finished", { actor: beat }), 31_000);
		assert.equal(Object.values(s.subagents)[0]!.finishedAt, 31_000);
	});

	it("keeps a finished subagent for the fade window, then drops it", () => {
		let s = feed(emptyLiveState(), ev("subagent-spawned", { actor: sub }), 0);
		s = feed(s, ev("subagent-finished", { actor: sub }), 1000);
		s = tick(s, 9000);
		const a = Object.values(s.subagents)[0]!;
		assert.equal(subagentAlpha(a, 8500, 15), 0.5); // finished at 1000, 7500 ms into the 15 s fade
		assert.equal(Object.keys(tick(s, 16_001).subagents).length, 0);
	});

	it("caps trails at 200 (oldest dropped) and fades them after trailSec", () => {
		let s = emptyLiveState();
		for (let i = 0; i < 230; i++) s = feed(s, ev("kb-read", { target: { ...kb, id: `k${i}` } }), i);
		assert.equal(s.trails.length, 200);
		assert.equal(s.trails[0]!.target.id, "k30");
		assert.equal(tick(s, 15_000 + 229).trails.length, 0);
	});

	it("clears the wolf's needs-you flag once its needs-you thread expires", () => {
		let s = feed(emptyLiveState(), ev("needs-you", { ttlMs: 1000 }), 0);
		assert.equal(s.wolves.hal!.needsYou, true);
		s = feed(s, ev("thread-active", { actor: { kind: "thread", wolf: "hal", threadId: "t2" }, ttlMs: 60_000 }), 500);
		s = tick(s, 1500);
		assert.equal(s.threads["hal/t1"], undefined);
		assert.equal(s.wolves.hal!.online, true);
		assert.equal(s.wolves.hal!.needsYou, false);
	});

	it("answered clears the wolf flag even when the thread is not in state", () => {
		let s = feed(emptyLiveState(), ev("needs-you", { actor: { kind: "thread", wolf: "hal" } }), 0);
		assert.equal(s.wolves.hal!.needsYou, true);
		s = feed(s, ev("answered", { actor: { kind: "thread", wolf: "hal", threadId: "gone" } }), 5);
		assert.equal(s.wolves.hal!.needsYou, false);
	});

	it("a thread-less needs-you sticks on a wolf that already has threads", () => {
		let s = feed(emptyLiveState(), ev("thread-active"), 0);
		s = feed(s, ev("needs-you", { actor: { kind: "thread", wolf: "hal" } }), 5);
		assert.equal(s.wolves.hal!.needsYou, true);
		s = tick(s, 10);
		assert.equal(s.wolves.hal!.needsYou, true);
	});

	it("a snapshot holding only a wolf heartbeat marks the wolf online; wolf-offline and an expired heartbeat dim it, without threads or trails", () => {
		const beat = ev("wolf-online", { actor: { kind: "wolf", wolf: "hal" }, ttlMs: 180_000 });
		const snapshot = { v: 1, at: 1000, wolves: [{ event: beat, expiresAt: 181_000 }], threads: [], subagents: [], owner: [] } as unknown as PresenceSnapshot;
		let s = reduceLive(emptyLiveState(), { type: "snapshot", snapshot, now: 5000 });
		assert.equal(s.wolves.hal!.online, true);
		assert.deepEqual([Object.keys(s.threads), s.trails.length], [[], 0]);
		s = feed(s, ev("wolf-offline", { actor: { kind: "wolf", wolf: "hal" } }), 6000);
		assert.equal(tick(s, 6001).wolves.hal!.online, false);
		s = reduceLive(emptyLiveState(), { type: "snapshot", snapshot, now: 5000 });
		assert.equal(tick(s, 5000 + 180_001).wolves.hal!.online, false);
	});

	it("a hub actor's kb-write draws a trail from the hub origin and creates no wolf", () => {
		const hub = ev("kb-write", { actor: { kind: "hub", title: "curator" }, target: kb });
		const s = feed(emptyLiveState(), hub, 1000);
		assert.deepEqual(Object.keys(s.wolves), []);
		assert.deepEqual(s.trails.map((t) => [t.wolf, t.verb, t.target.id]), [["@hub", "kb-write", "kb-x"]]);
		assert.equal(s.pulses.length, 1);
	});

	it("restores a finished subagent from a snapshot with its real remaining life", () => {
		const fin = { v: 1, id: "s1", pack: "p", ts: 0, ttlMs: 60_000, actor: { kind: "subagent", wolf: "hal", subagent: "w1", parentThreadId: "t1" }, verb: "subagent-finished" } as unknown as ActivityEvent;
		const snapshot = { v: 1, at: 1000, wolves: [], threads: [], subagents: [{ event: fin, expiresAt: 4000 }], owner: [] } as unknown as PresenceSnapshot;
		const s = reduceLive(emptyLiveState(), { type: "snapshot", snapshot, now: 50_000 });
		assert.equal(Object.keys(tick(s, 52_900).subagents).length, 1);
		assert.equal(Object.keys(tick(s, 53_100).subagents).length, 0);
	});

	it("needs-you rings the thread and its wolf until answered", () => {
		let s = feed(emptyLiveState(), ev("needs-you"), 0);
		assert.equal(s.threads["hal/t1"]!.needsYou, true);
		assert.equal(s.wolves.hal!.needsYou, true);
		s = feed(s, ev("answered"), 5);
		assert.equal(s.threads["hal/t1"]!.needsYou, false);
		assert.equal(s.wolves.hal!.needsYou, false);
	});

	it("roster wolves stay, offline, with a home domain guess", () => {
		const s = reduceLive(emptyLiveState(), { type: "roster", wolves: ["jack", "zed"], now: 0 });
		assert.equal(s.wolves.jack!.online, false);
		assert.equal(homeDomainOf(s.wolves.jack, "jack"), "snapjack");
		assert.equal(homeDomainOf(s.wolves.zed, "zed"), undefined);
	});

	it("owner-viewing sets the you-node target until it expires", () => {
		let s = feed(emptyLiveState(), ev("owner-viewing", { actor: { kind: "owner" }, ttlMs: 1000, target: { kind: "thread", id: "hal/t1" } }), 0);
		assert.equal(s.owner?.viewing?.id, "hal/t1");
		s = tick(s, 1001);
		assert.equal(s.owner, null);
	});

	it("a presence snapshot rebuilds state; resync clears event-derived state but keeps wolves", () => {
		const snap = {
			v: 1, pack: "p", at: 1_000_000, owner: [], subagents: [],
			wolves: [{ event: ev("kb-read", { target: kb }), expiresAt: 1_030_000 }],
			threads: [{ event: ev("needs-you"), expiresAt: 1_060_000 }],
		} as unknown as PresenceSnapshot;
		let s = feed(emptyLiveState(), ev("thread-active", { actor: { kind: "thread", wolf: "old", threadId: "z" } }), 0);
		s = reduceLive(s, { type: "snapshot", snapshot: snap, now: 50 });
		assert.deepEqual(Object.keys(s.threads), ["hal/t1"]);
		assert.equal(s.threads["hal/t1"]!.expiresAt, 50 + 60_000);
		assert.equal(s.wolves.hal!.needsYou, true);
		assert.equal(s.wolves.old!.online, false);
		assert.equal(s.trails.length, 0);
		s = reduceLive(s, { type: "resync", now: 60 });
		assert.deepEqual([Object.keys(s.threads).length, s.wolves.hal!.online], [0, false]);
	});

	it("a subagent kb-read arriving before its subagent-spawned draws from the subagent and creates it under its parent", () => {
		const a = { kind: "subagent", wolf: "hal", subagent: "w1", parentThreadId: "t1", threadId: "hal/sub-1" };
		let s = feed(emptyLiveState(), ev("kb-read", { actor: a, target: kb }), 10);
		const [key] = Object.keys(s.subagents);
		assert.deepEqual(Object.values(s.subagents).map((x) => [x.name, x.parentThreadId]), [["w1", "t1"]]);
		assert.equal((s.trails[0] as unknown as { subagentKey?: string }).subagentKey, key);
		s = feed(s, ev("subagent-spawned", { actor: a }), 20);
		assert.deepEqual(Object.keys(s.subagents), [key]);
	});
});
