import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	FEED_CAP, PROMOTE_IDLE, actionBlock, applyFeed, applyPromoteEvent, bannerOf, destinationLabel, parentToFetch, parseOpen, poolSummary,
	promoteBusy, promoteLine, recordStale, recordView, serializeOpen, type MemoryEventFrame, type MemoryStatus, type WorkRecordResponse,
} from "../src/core/index.ts";

const base = { wolf: "w", timestamp: "2026-10-26T00:00:00Z", domain: "d" };
const obs = (threadId: string | undefined, target: unknown, summary = "s"): MemoryEventFrame =>
	({ ...base, type: "observation_captured", count: 1, summary, ...(threadId ? { threadId } : {}), target }) as MemoryEventFrame;
const st = (state: MemoryStatus["state"]): MemoryStatus => ({ state, reason: "why", pool: null, sessionTopics: [], denTopics: [], lastPromote: null });
const rec = (o: Partial<WorkRecordResponse>): WorkRecordResponse => ({ id: "a", title: "A", kind: "task", stage: "plan", plan: "", record: "", ...o });

describe("memory panel model", () => {
	it("open flag persists, default open", () => {
		assert.equal(parseOpen(null), true);
		assert.equal(parseOpen(serializeOpen(false)), false);
		assert.equal(parseOpen(serializeOpen(true)), true);
	});
	it("banner for off/inert/sandbox, none for live", () => {
		assert.equal(bannerOf(st("live")), null);
		assert.equal(bannerOf(st("off"))?.reason, "why");
		assert.equal(bannerOf(st("inert"))?.tone, "inert");
		assert.equal(bannerOf(st("sandbox"))?.tone, "sandbox");
	});
	it("poolSummary clamps and marks target", () => {
		const p = poolSummary({ count: 2, tokens: 3000, consolidateAtTokens: 2000, poolTarget: 500, trigger: "hybrid" });
		assert.equal(p?.fill, 1);
		assert.equal(p?.targetMark, 0.25);
		assert.match(p?.label ?? "", /2 observations/);
		assert.equal(poolSummary(null), null);
		assert.equal(poolSummary({ count: 0, tokens: 5, consolidateAtTokens: 0, poolTarget: 0, trigger: "manual" })?.fill, 0);
	});
	it("destination labels", () => {
		assert.equal(destinationLabel({ kind: "den", topicId: "t1" }), "den topic t1");
		assert.equal(destinationLabel({ kind: "work", workId: "w1" }, { w1: "Item" }), "Record of Item");
		assert.equal(destinationLabel({ kind: "work", workId: "w1" }), "Record of w1");
		assert.equal(destinationLabel({ kind: "den" }), "den pool");
	});
	it("feed: thread-scoped, newest first, capped", () => {
		let f = applyFeed([], obs("t", { kind: "den", topicId: "x" }), "t");
		f = applyFeed(f, obs("other", { kind: "den" }), "t");
		f = applyFeed(f, obs(undefined, { kind: "den" }), "t");
		f = applyFeed(f, { ...base, type: "promote_started", jobId: "j", target: { kind: "den" } } as MemoryEventFrame, "t");
		assert.equal(f.length, 1);
		f = applyFeed(f, obs("t", { kind: "work", workId: "w" }, "second"), "t");
		assert.equal(f[0]?.summary, "second");
		assert.equal(f[0]?.destination, "Record of w");
		for (let i = 0; i < FEED_CAP + 20; i++) f = applyFeed(f, obs("t", { kind: "den" }), "t");
		assert.equal(f.length, FEED_CAP);
	});
	it("promote lifecycle and busy gating", () => {
		let s = applyPromoteEvent(PROMOTE_IDLE, { ...base, type: "promote_started", jobId: "j" } as MemoryEventFrame);
		assert.equal(promoteBusy(s), true);
		assert.equal(actionBlock({ status: st("live"), promote: s, consolidating: false }), "memory_busy");
		s = applyPromoteEvent(s, { ...base, type: "promote_finished", jobId: "j", consolidated: 3, contributions: 2, pending: 1 } as MemoryEventFrame);
		assert.equal(promoteBusy(s), false);
		assert.match(promoteLine(s) ?? "", /3 consolidated, 2 contributed, 1 pending/);
		s = applyPromoteEvent(s, { ...base, type: "promote_failed", jobId: "k", message: "boom" } as MemoryEventFrame);
		assert.equal(promoteLine(s), "Promote failed: boom");
		assert.equal(applyPromoteEvent(s, obs("t", { kind: "den" })), s);
		assert.equal(actionBlock({ status: st("off"), promote: PROMOTE_IDLE, consolidating: false }), "inactive");
		assert.equal(actionBlock({ status: st("live"), promote: PROMOTE_IDLE, consolidating: false }), null);
	});
	it("recordStale matches work id or feature id only on record_written", () => {
		const rw = (target: unknown) => ({ ...base, type: "record_written", observationCount: 1, target }) as MemoryEventFrame;
		assert.equal(recordStale(rw({ kind: "work", workId: "a" }), ["a"]), true);
		assert.equal(recordStale(rw({ kind: "work", workId: "x", featureId: "p" }), ["a", "p"]), true);
		assert.equal(recordStale(rw({ kind: "work", workId: "x" }), ["a", null]), false);
		assert.equal(recordStale(obs("t", { kind: "work", workId: "a" }), ["a"]), false);
	});
	it("record falls back to the parent's when empty", () => {
		const own = rec({ partOf: "p" });
		assert.equal(parentToFetch(own), "p");
		assert.equal(parentToFetch(rec({ record: "x", partOf: "p" })), null);
		assert.equal(parentToFetch(rec({})), null);
		const v = recordView(own, rec({ id: "p", title: "P", record: "R" }));
		assert.deepEqual(v.inheritedFrom, { id: "p", title: "P" });
		assert.equal(v.record, "R");
		assert.equal(recordView(rec({ record: "mine" }), null).inheritedFrom, null);
	});
});
