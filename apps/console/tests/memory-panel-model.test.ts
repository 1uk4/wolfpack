import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	FEED_CAP, PROMOTE_IDLE, latestOnly, focusRefetchDue, actionBlock, feedItemOf, pushFeed, refreshPlan, settlePromotePost, applyPromoteEvent, bannerOf, destinationLabel, parentToFetch, parseOpen, parseView, serializeView, MEMORY_PANEL_VIEW_KEY, poolSummary, triggerText,
	bindOffered, promoteBusy, promoteLine, recordStale, recordView, serializeOpen, groupObservations, blockedLabel, consolidateMessage, reconcilePromote, type MemoryEventFrame, type MemoryStatus, type WorkRecordResponse,
} from "../src/core/index.ts";

const base = { wolf: "w", timestamp: "2026-10-26T00:00:00Z", domain: "d" };
const obs = (threadId: string | undefined, target: unknown, summary = "s"): MemoryEventFrame =>
	({ ...base, type: "observation_captured", count: 1, summary, ...(threadId ? { threadId } : {}), target }) as MemoryEventFrame;
const st = (state: MemoryStatus["state"]): MemoryStatus => ({ state, reason: "why", pool: null, sessionTopics: [], denTopics: [], lastPromote: null });
const rec = (o: Partial<WorkRecordResponse>): WorkRecordResponse => ({ id: "a", title: "A", kind: "task", stage: "plan", plan: "", record: "", ...o });

import { pendingWarning } from "../src/core/memory-panel-model.ts";

describe("pending warning wording", () => {
	it("says the oldest observation has waited, not that all have", () => {
		assert.equal(pendingWarning({ count: 3, oldestAgeMs: 30 * 3_600_000 }), "3 observation(s) are waiting to be folded into a Record; the oldest has waited over 30 h");
		assert.equal(pendingWarning({ count: 3, oldestAgeMs: 3_600_000 }), null);
		assert.equal(pendingWarning(undefined), null);
	});
});

describe("memory panel model", () => {
	it("bindOffered: shown for another live task; hidden for the bound item, a feature, an archived item, a container, and without a slug", () => {
		const t = rec({ id: "t" });
		assert.equal(bindOffered(t, "other", true), true);
		assert.equal(bindOffered(t, "t", true), false);
		assert.equal(bindOffered(rec({ id: "f", kind: "feature" }), "other", true), false);
		assert.equal(bindOffered(rec({ id: "x", stage: "archived" }), "other", true), false);
		assert.equal(bindOffered(rec({ id: "c", container: true }), "other", true), false);
		assert.equal(bindOffered(t, "other", false), false);
		assert.equal(bindOffered(null, "other", true), false);
	});
	it("open flag persists, default open", () => {
		assert.equal(parseOpen(null), true);
		assert.equal(parseOpen(serializeOpen(false)), false);
		assert.equal(parseOpen(serializeOpen(true)), true);
	});
	it("view key helper: defaults to item, round-trips both, reads the legacy record and the retired graph as item", () => {
		assert.equal(MEMORY_PANEL_VIEW_KEY, "wolfpack.memory-panel.view.v1");
		assert.equal(parseView(null), "item");
		assert.equal(parseView("junk"), "item");
		assert.equal(parseView(serializeView("feed")), "feed");
		assert.equal(parseView(serializeView("item")), "item");
		assert.equal(parseView("graph"), "item");
		assert.equal(parseView("record"), "item");
	});
	it("view persistence: chosen view survives a serialize/parse round-trip through storage-shaped strings", () => {
		for (const v of ["item", "feed"] as const) assert.equal(parseView(serializeView(v)), v);
		assert.equal(parseView(undefined), "item");
	});
	it("latestOnly: a stale (earlier-started) response is never current", () => {
		const g = latestOnly();
		const first = g.start();
		const second = g.start(); // the user clicked another task before the first fetch returned
		assert.equal(g.isCurrent(first), false);
		assert.equal(g.isCurrent(second), true);
		g.start(); // selection cleared
		assert.equal(g.isCurrent(second), false);
	});
	it("focusRefetchDue: visible only, at most once per 5s", () => {
		assert.equal(focusRefetchDue(false, 100_000, 0), false);
		assert.equal(focusRefetchDue(true, 100_000, 0), true);
		assert.equal(focusRefetchDue(true, 103_000, 100_000), false);
		assert.equal(focusRefetchDue(true, 105_000, 100_000), true);
	});
	it("banner only for off/inert, none for live or sandbox", () => {
		assert.equal(bannerOf(st("live")), null);
		assert.equal(bannerOf(st("off"))?.reason, "why");
		assert.equal(bannerOf(st("inert"))?.tone, "inert");
		assert.equal(bannerOf(st("sandbox")), null);
	});
	it("poolSummary clamps and marks target", () => {
		const p = poolSummary({ count: 2, tokens: 3000, consolidateAtTokens: 2000, poolTarget: 500, trigger: "hybrid" });
		assert.equal(p?.fill, 1);
		assert.equal(p?.targetMark, 0.25);
		assert.equal(p?.observationsText, "2 observations");
		assert.equal(p?.tokensText, "3,000 / 2,000 tokens");
		assert.equal(poolSummary({ count: 1, tokens: 1, consolidateAtTokens: 2, poolTarget: 0, trigger: "manual" })?.observationsText, "1 observation");
		assert.equal(poolSummary(null), null);
		assert.equal(poolSummary({ count: 0, tokens: 5, consolidateAtTokens: 0, poolTarget: 0, trigger: "manual" })?.fill, 0);
	});
	it("triggerText shows the effective trigger and interval", () => {
		const base = { consolidateAtTokens: 20000 };
		assert.equal(triggerText({ ...base, trigger: "hybrid", interval: "2h" }), "hybrid: at 20,000 tokens or every 2h");
		assert.equal(triggerText({ ...base, trigger: "hybrid" }), "hybrid: at 20,000 tokens or every 4h");
		assert.equal(triggerText({ ...base, trigger: "timer", interval: "30m" }), "timer: every 30m");
		assert.equal(triggerText({ ...base, trigger: "threshold" }), "threshold: at 20,000 tokens");
		assert.equal(triggerText({ ...base, trigger: "manual" }), "manual: only on Promote");
	});
	it("destination labels", () => {
		assert.equal(destinationLabel({ kind: "den", topicId: "t1" }), "den topic t1");
		assert.equal(destinationLabel({ kind: "work", workId: "w1" }, { w1: "Item" }), "Record of Item");
		assert.equal(destinationLabel({ kind: "work", workId: "w1" }), "Record of w1");
		assert.equal(destinationLabel({ kind: "den" }), "den pool");
	});
	it("feed: thread-scoped, newest first, capped", () => {
		let n = 0;
		const add = (f: ReturnType<typeof pushFeed>, e: MemoryEventFrame) => {
			const it = feedItemOf(e, "t", `k${n++}`);
			return it ? pushFeed(f, it) : f;
		};
		let f = add([], obs("t", { kind: "den", topicId: "x" }));
		f = add(f, obs("other", { kind: "den" }));
		f = add(f, obs(undefined, { kind: "den" }));
		f = add(f, { ...base, type: "promote_started", jobId: "j", target: { kind: "den" } } as MemoryEventFrame);
		assert.equal(f.length, 1);
		f = add(f, obs("t", { kind: "work", workId: "w" }, "second"));
		assert.equal(f[0]?.summary, "second");
		assert.equal(f[0]?.destination, "Record of w");
		for (let i = 0; i < FEED_CAP + 20; i++) f = add(f, obs("t", { kind: "den" }));
		assert.equal(f.length, FEED_CAP);
	});
	it("a promote POST answer only applies while still starting", () => {
		const running = { phase: "running", jobId: "j" } as const;
		assert.deepEqual(settlePromotePost({ phase: "starting" }, running), running);
		const fin = { phase: "finished", jobId: "j", consolidated: 1, contributions: 0, pending: 0 } as const;
		assert.equal(settlePromotePost(fin, running), fin);
		assert.equal(settlePromotePost(fin, PROMOTE_IDLE), fin);
	});
	it("refreshPlan: observations refresh status; record_written refreshes the shown Record", () => {
		assert.deepEqual(refreshPlan(obs("t", { kind: "den" }), ["a"]), { status: true, record: false });
		const rw = { ...base, type: "record_written", observationCount: 1, target: { kind: "work", workId: "a" } } as MemoryEventFrame;
		assert.deepEqual(refreshPlan(rw, ["a"]), { status: false, record: true });
		assert.deepEqual(refreshPlan({ ...base, type: "sweep_started" } as MemoryEventFrame, ["a"]), { status: false, record: false });
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
	it("a group counts every blocked observation and says who blocks it", () => {
		const o = (id: string, extra: object) => ({ id, timestamp: "t", recordedAt: `2026-11-0${id}`, content: "c", tokenCount: 1, work: "w1", feature: "f1", ...extra });
		const blocked = { blocked: "forbidden" as const, blockedKey: "f1", assignee: "hal" };
		const g = groupObservations([o("1", blocked), o("2", blocked), o("3", {})])[0]!;
		assert.equal(g.blockedCount, 2);
		assert.equal(g.assignee, "hal");
		assert.equal(blockedLabel(g, { f1: { title: "Polish (November)" } }), "not allowed: assigned to hal · waiting on Polish (November)'s Record");
		assert.equal(blockedLabel({ ...g, assignee: undefined, blockedKey: g.key }, {}), "not allowed (another host)");
		assert.equal(blockedLabel({ ...g, blocked: "work-api-unavailable", blockedKey: g.key }, {}), "waiting for Work API");
	});
	it("the consolidate result reports pending observations and the retry time", () => {
		const r = { observationsProcessed: 4, topicsCreated: 1, topicsMerged: 2, topicsSkipped: 0, claimsSubmitted: 0, topicIds: [] };
		assert.equal(consolidateMessage({ ...r, recordsWritten: 1, observationsPending: 3 }), "Consolidated 4 observations → 1 new, 2 merged topics, 1 Record written, 3 still pending");
		assert.match(consolidateMessage({ ...r, observationsPending: 3, retryAt: Date.now() + 600_000 }), /3 still pending, retrying at \d\d:\d\d$/);
	});
	it("a promote running in wolfd shows as running on mount, and its result when it ends", () => {
		const running = { ...st("live"), promoting: { jobId: "j1" } };
		const s = reconcilePromote(PROMOTE_IDLE, running);
		assert.deepEqual(s, { phase: "running", jobId: "j1" });
		const done = { ...st("live"), lastPromote: { jobId: "j1", at: "x", result: "finished" as const, consolidated: 3, contributions: 2 } };
		assert.match(promoteLine(reconcilePromote(s, done)) ?? "", /3 consolidated, 2 contributed/);
		assert.deepEqual(reconcilePromote(PROMOTE_IDLE, st("live")), PROMOTE_IDLE);
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
