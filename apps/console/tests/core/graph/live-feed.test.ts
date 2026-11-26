import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { feedCountReducer, formatFeed, relativeTime, type FeedEvent } from "../../../src/core/graph/live/feed.ts";

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

	it("drops thread-active heartbeats and thread-idle", () => {
		assert.deepEqual(texts([ev("thread-active"), ev("thread-idle")]), []);
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
