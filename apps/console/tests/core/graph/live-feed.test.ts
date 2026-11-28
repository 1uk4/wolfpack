import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PresenceSnapshot } from "@wolfpack/protocol";
import { feedCountReducer, feedPanelBottom, feedPillLabel, formatFeed, relativeTime, seedFeedFromSnapshot, type FeedEvent } from "../../../src/core/graph/live/feed.ts";

let n = 0;
const ev = (verb: string, o: Partial<FeedEvent> = {}): FeedEvent => ({ id: `e${++n}`, at: 1000, ts: 0, verb, actor: { kind: "thread", wolf: "1uk4", threadId: "t1" }, ...o });
const texts = (evs: FeedEvent[], priv = false) => formatFeed(evs, { private: priv }).map((l) => l.text);
const sub = { kind: "subagent", wolf: "1uk4", subagent: "scout", parentThreadId: "t1" } as FeedEvent["actor"];
const kb = { kind: "kb-entry", id: "kb-wolfpack-AbC1234", domain: "wolfpack", title: "Crawl Pipeline" };

describe("activity feed formatter", () => {
	it("writes one short line per verb", () => {
		const t = { kind: "work-item", id: "work-hal-X1", title: "Weekly fitness" };
		assert.deepEqual(texts([ev("kb-read", { actor: sub, target: kb })]), ["1uk4 · scout read Crawl Pipeline"]);
		assert.deepEqual(texts([ev("kb-write", { target: kb })]), ["1uk4 · wrote Crawl Pipeline"]);
		assert.deepEqual(texts([ev("contribution", { target: kb })]), ["1uk4 · updated Crawl Pipeline"]);
		assert.deepEqual(texts([ev("shipped", { actor: { kind: "thread", wolf: "hal" }, target: t })]), ["hal · shipped Weekly fitness"]);
		assert.deepEqual(texts([ev("bound", { actor: { kind: "thread", wolf: "jack" }, target: { ...t, title: "Zod-first P3" } })]), ["jack · bound to Zod-first P3"]);
		assert.deepEqual(texts([ev("unbound", { target: t })]), ["1uk4 · unbound from Weekly fitness"]);
		assert.deepEqual(texts([ev("subagent-spawned", { actor: sub })]), ["1uk4 · started scout"]);
		assert.deepEqual(texts([ev("subagent-finished", { actor: sub })]), ["1uk4 · scout finished"]);
		assert.deepEqual(texts([ev("answered")]), ["1uk4 · answered"]);
	});

	it("a hub actor's kb-write reads 'curator updated <title>' in a neutral colour, and the private view drops the title", () => {
		const hub = { kind: "hub", title: "curator" } as FeedEvent["actor"];
		assert.deepEqual(texts([ev("kb-write", { actor: hub, target: kb })]), ["curator · updated Crawl Pipeline"]);
		assert.deepEqual(texts([ev("kb-write", { actor: hub, target: kb })], true), ["curator · updated"]);
		assert.equal(formatFeed([ev("kb-write", { actor: hub, target: kb })], {})[0]!.color, "hsl(0 0% 62%)");
	});

	it("needs-you is amber and carries the thread; owner-viewing reads 'you'", () => {
		const [l] = formatFeed([ev("needs-you")], {});
		assert.equal(l!.text, "1uk4 · needs you");
		assert.equal(l!.tone, "amber");
		assert.deepEqual(l!.thread, { wolf: "1uk4", threadId: "t1" });
		const [v] = formatFeed([ev("owner-viewing", { actor: { kind: "owner" }, target: { kind: "work-item", id: "work-wolfpack-ELz", title: "Live pack map" } })], {});
		assert.equal(v!.text, "you · viewing Live pack map");
		assert.equal(v!.tone, "normal");
	});

	it("falls back to a short id when the target has no title", () => {
		assert.deepEqual(texts([ev("kb-read", { target: { kind: "kb-entry", id: "kb-wolfpack-AbC1234" } })]), ["1uk4 · read AbC1234"]);
	});

	it("private view drops titles", () => {
		assert.deepEqual(texts([ev("kb-read", { actor: sub, target: kb })], true), ["1uk4 · scout read"]);
		assert.deepEqual(texts([ev("owner-viewing", { actor: { kind: "owner" }, target: kb })], true), ["you · viewing"]);
	});

	it("shows a thread starting and going idle, but not the heartbeats of a thread already active", () => {
		const a = (title?: string) => ev("thread-active", { actor: { kind: "thread", wolf: "1uk4", threadId: "t1", title } });
		assert.deepEqual(texts([a("Fix the bug"), a("Fix the bug"), a("Fix the bug"), ev("thread-idle")]), ["1uk4 · started working Fix the bug", "1uk4 · idle"]);
		assert.deepEqual(texts([a("Fix the bug"), ev("thread-idle"), a("Fix the bug")]).length, 3); // started again after idle
		assert.deepEqual(texts([a("Fix the bug")], true), ["1uk4 · started working"]); // private view drops the title
	});

	it("seeds the feed from a presence snapshot: active threads and running subagents, newest last, at most 50", () => {
		const entry = (id: string, verb: string, ts: number, actor: Record<string, unknown>) => ({ expiresAt: 99_999, event: { v: 1, id, pack: "p", ts, ttlMs: 1000, actor, verb } });
		const snap = {
			v: 1, pack: "p", at: 10_000, owner: [],
			wolves: [entry("w1", "thread-active", 9000, { kind: "thread", wolf: "hal" })],
			threads: [entry("a", "thread-active", 9_500, { kind: "thread", wolf: "hal", threadId: "t9", title: "Plan" })],
			subagents: [entry("b", "subagent-spawned", 9_000, { kind: "subagent", wolf: "hal", subagent: "scout", parentThreadId: "t9" })],
		} as unknown as PresenceSnapshot;
		const seeded = seedFeedFromSnapshot(snap, 50_000);
		assert.deepEqual(seeded.map((e) => e.id), ["b", "a"]);
		assert.deepEqual(texts(seeded), ["hal · started scout", "hal · started working Plan"]);
		const many = { ...snap, threads: Array.from({ length: 80 }, (_, i) => entry(`m${i}`, "thread-active", 1000 + i, { kind: "thread", wolf: "hal", threadId: `x${i}` })), subagents: [] } as unknown as PresenceSnapshot;
		assert.deepEqual(seedFeedFromSnapshot(many, 0).map((e) => e.id).slice(-1), ["m79"]);
		assert.equal(seedFeedFromSnapshot(many, 0).length, 50);
	});

	it("the expanded panel stays 12px over the chat bar on desktop and, on a phone, ends at least 8px above the centred 48px chat icon", () => {
		assert.equal(feedPanelBottom(false), "calc(var(--chat-bar-top,0px) + 12px)");
		assert.equal(feedPanelBottom(true), "max(var(--chat-bar-top,0px) + 12px, env(safe-area-inset-bottom) + 64px)"); // icon top = 8 + 48 above the inset; + 8 gap
	});

	it("the collapsed pill always has a label: Quiet with no lines, Activity otherwise, with the new count", () => {
		assert.equal(feedPillLabel(0, 0), "Quiet");
		assert.equal(feedPillLabel(0, 3), "Activity");
		assert.equal(feedPillLabel(2, 3), "Activity · 2 new");
	});

	it("merges a consecutive duplicate within 30 s, keeps it apart after", () => {
		const a = ev("kb-read", { at: 1000, target: kb });
		const b = ev("kb-read", { at: 20_000, target: kb });
		const c = ev("kb-read", { at: 60_000, target: kb });
		const lines = formatFeed([a, b, c], {});
		assert.equal(lines.length, 2);
		assert.equal(lines[0]!.time, 20_000);
		assert.equal(lines[0]!.key, a.id);
		const other = formatFeed([a, ev("kb-write", { at: 2000, target: kb }), ev("kb-read", { at: 3000, target: kb })], {});
		assert.equal(other.length, 3);
	});
});

describe("relative time", () => {
	it("now, seconds, minutes, hours", () => {
		assert.equal(relativeTime(1000, 1000), "now");
		assert.equal(relativeTime(13_000, 1000), "12s");
		assert.equal(relativeTime(181_000, 1000), "3m");
		assert.equal(relativeTime(3_700_000, 0), "1h");
	});
});

describe("collapsed counter", () => {
	it("counts new events while collapsed, keeps rising, resets on expand", () => {
		let s = feedCountReducer({ collapsed: false, count: 0 }, { type: "new", n: 3 });
		assert.equal(s.count, 0);
		s = feedCountReducer(s, { type: "collapse" });
		s = feedCountReducer(s, { type: "new", n: 2 });
		s = feedCountReducer(s, { type: "new", n: 1 });
		assert.deepEqual(s, { collapsed: true, count: 3 });
		s = feedCountReducer(s, { type: "expand" });
		assert.deepEqual(s, { collapsed: false, count: 0 });
	});
});
