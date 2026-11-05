import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	applyHubEvent,
	attentionGroups,
	domainBlocks,
	curatorNote,
	decisionOutcome,
	decisionRows,
	groupIncoming,
	initialActivityState,
	kbAge,
	kbRelativeTime,
	mergeDecisionPages,
	needsRefetch,
	reconcileActivity,
	sinceCutoff,
	routingSummary,
} from "../src/core/kb-activity-model.ts";
import { kbActivityFixture } from "./fixtures/kb-activity.ts";

describe("kb-activity model", () => {
	it("decisionOutcome normalises spellings", () => {
		assert.equal(decisionOutcome("created"), "create");
		assert.equal(decisionOutcome("merged"), "merge");
		assert.equal(decisionOutcome("updated"), "unclassified");
		assert.equal(decisionOutcome("park"), "unclassified");
		assert.equal(decisionOutcome("rejected"), "reject");
		assert.equal(decisionOutcome("unchanged"), "unchanged");
		assert.equal(decisionOutcome("???"), "unclassified");
		assert.equal(decisionOutcome(null), "unclassified");
	});
	it("groupIncoming sorts by pending desc and drops empty wolves, keeps bad-only", () => {
		const d = kbActivityFixture();
		assert.deepEqual(groupIncoming(d).map((w) => w.wolf), ["hal", "ada"]);
		d.incoming.wolves.push({ wolf: "bad-only", pending: 0, bad: 2, items: [] });
		assert.ok(groupIncoming(d).some((w) => w.wolf === "bad-only"));
	});
	it("decisionRows labels and filterDecisions filters", () => {
		const rows = decisionRows(kbActivityFixture().decisions.items);
		assert.equal(rows[0]!.label, "merged");
		assert.equal(rows[0]!.superseded, 1);
		assert.equal(rows[1]!.superseded, 0);
		assert.equal(rows[0]!.provisional, false);
	});
	it("routingSummary lists route, top-3 candidates by score, subject, confirm, warning", () => {
		const lines = routingSummary(kbActivityFixture().decisions.items[0]!.routing);
		assert.equal(lines[0], "route: similarity · band high");
		assert.equal(lines[1], "candidates: c-top 0.93, c-mid 0.60, c-4th 0.50");
		assert.match(lines[2]!, /^subject: same \(valid\)/);
		assert.match(lines[3]!, /^confirm: c-top 0.93 · merge \(valid\)/);
		assert.equal(lines[4], "warning: close call");
		assert.deepEqual(routingSummary(undefined), []);
	});
	it("curatorNote", () => {
		assert.equal(curatorNote(kbActivityFixture()), null);
		assert.match(curatorNote(kbActivityFixture({ source: { lane: "hub", hasDecisions: true, curator: "off" } }))!, /curator is off/);
		assert.match(curatorNote(kbActivityFixture({ source: { lane: "hub", hasDecisions: false, curator: "on" } }))!, /hasn't decided anything yet/);
	});
	it("needsRefetch", () => {
		assert.equal(needsRefetch({ type: "sweep_finished" }), true);
		assert.equal(needsRefetch({ type: "kb.changed" }), true);
		assert.equal(needsRefetch({ type: "resync" }), true);
		assert.equal(needsRefetch({ type: "sweep_item" }), false);
		assert.equal(needsRefetch({ type: "sweep_started" }), false);
	});
	it("mergeDecisionPages dedupes by id and takes cursor/totals from the newer page", () => {
		const a = kbActivityFixture().decisions;
		const next = { items: [a.items[3]!, { id: "d0", at: "2026-11-05T09:00:00Z", from: "x", denTopicId: "t0", hash: "h0", outcome: "create" as const }], total: 9, counts: a.counts };
		const m = mergeDecisionPages(a, next);
		assert.deepEqual(m.items.map((d) => d.id), ["d4", "d3", "d2", "d1", "d0"]);
		assert.equal(m.nextCursor, undefined);
	});
	it("sinceCutoff", () => {
		const now = Date.parse("2026-11-05T00:00:00Z");
		assert.equal(sinceCutoff("all", now), null);
		assert.equal(sinceCutoff("7d", now), now - 7 * 86_400_000);
		assert.equal(sinceCutoff("2026-11-01T00:00:00Z", now), Date.parse("2026-11-01T00:00:00Z"));
		assert.equal(sinceCutoff("junk", now), null);
	});
	describe("reconcileActivity", () => {
		it("a refetch replaces the data and drops provisional rows", () => {
			const base = kbActivityFixture();
			base.decisions.items.unshift({ id: "live:1", at: "2026-11-05T09:00:00Z", from: "w", denTopicId: "z", hash: "", outcome: "create" });
			const next = reconcileActivity(initialActivityState(base, { since: "30d" }), kbActivityFixture(), { since: "30d" });
			assert.deepEqual(next.data.decisions.items.map((d) => d.id), ["d4", "d3", "d2", "d1"]);
		});
		it("sweeping follows the response when it says, else the previous state", () => {
			const prev = { ...initialActivityState(kbActivityFixture(), { since: "30d" }), sweeping: true };
			const d = kbActivityFixture();
			delete (d as { sweep?: unknown }).sweep;
			assert.equal(reconcileActivity(prev, d, { since: "30d" }).sweeping, true);
			assert.equal(reconcileActivity(prev, { ...d, sweep: { running: false } }, { since: "30d" }).sweeping, false);
		});
	});
	it("domainBlocks: one block per domain (even empty), one row per item, summary and contributors", () => {
		const blocks = domainBlocks(kbActivityFixture());
		assert.deepEqual(blocks.map((b) => b.domain), ["empty", "personal", "wolfpack"]);
		const wp = blocks[2]!;
		assert.equal(wp.entries, 167);
		assert.equal(wp.waiting, 2);
		assert.deepEqual(wp.contributors, [{ wolf: "hal", count: 1 }]);
		// the merge decision and the entry change it produced are ONE row; the unmatched retire stays
		assert.deepEqual(wp.rows.map((r) => [r.label, r.title, r.wolf]), [["merged", "Merged entry", "hal"], ["retired", "ent-old", undefined]]);
		const personal = blocks[1]!;
		assert.deepEqual(personal.rows.map((r) => [r.mark, r.label, r.title]), [["+", "created", "New entry"], ["×", "rejected", "t2"]]);
		assert.equal(blocks[0]!.rows.length, 0);
		assert.equal(blocks[0]!.more, false);
	});
	it("domainBlocks: caps rows, offers show all, and an expanded domain lists its further page", () => {
		const items = Array.from({ length: 12 }, (_, i) => ({ id: `x${i}`, at: `2026-11-05T09:${String(10 + i)}:00Z`, from: "w", denTopicId: `t${i}`, hash: `h${i}`, outcome: "reject" as const, domain: "alpha" }));
		const d = kbActivityFixture({ domains: [{ domain: "alpha", entries: 3, waiting: 0, contributors: [{ wolf: "w", count: 30 }] }], decisions: { items, total: 12, counts: { create: 0, merge: 0, unchanged: 0, reject: 12, parked: 0, unclassified: 0 } }, changes: { domains: [] } });
		const b = domainBlocks(d)[0]!;
		assert.equal(b.rows.length, 8);
		assert.equal(b.rows[0]!.title, "t11");
		assert.equal(b.more, true);
		assert.equal(b.decided, 30);
		const more = { id: "y0", at: "2026-11-04T09:00:00Z", from: "w", denTopicId: "old", hash: "o", outcome: "reject" as const, domain: "alpha" };
		const e = domainBlocks(d, { alpha: { items: [more, items[0]!], changes: [], nextCursor: "c" } })[0]!;
		assert.equal(e.rows.length, 13); // deduped by id
		assert.equal(e.expanded, true);
		assert.equal(e.more, true);
		assert.equal(domainBlocks(d, { alpha: { items: [], changes: [] } })[0]!.more, false);
	});
	it("domainBlocks falls back to domains seen in the data when the hub sends no summary", () => {
		const d = kbActivityFixture();
		delete (d as { domains?: unknown }).domains;
		const blocks = domainBlocks(d);
		assert.deepEqual(blocks.map((b) => b.domain), ["personal", "wolfpack"]);
		assert.deepEqual(blocks[0]!.contributors, [{ wolf: "ada", count: 2 }]);
	});
	it("attentionGroups: bad items and rejected/parked decisions by wolf, with reasons", () => {
		const g = attentionGroups(kbActivityFixture());
		assert.deepEqual(g.map((x) => [x.wolf, x.count]), [["hal", 3], ["ada", 1]]);
		const hal = g[0]!;
		assert.match(hal.summary, /3 contributions need attention/);
		assert.deepEqual(hal.items.map((i) => i.kind), ["decision", "bad", "bad"]);
		assert.equal(hal.items[1]!.domainHint, "nope");
		assert.equal(g[1]!.summary, "1 contribution: too vague");
		assert.deepEqual(attentionGroups(kbActivityFixture({ decisions: { items: [], total: 0, counts: kbActivityFixture().decisions.counts }, incoming: { total: 0, wolves: [] } })), []);
	});
	it("mergeDecisionPages takes total/counts from the newer snapshot", () => {
		const a = kbActivityFixture().decisions;
		const next = { items: [], total: 99, counts: { ...a.counts, create: 50 } };
		const newer = mergeDecisionPages(a, next, "2026-11-05T10:00:00Z", "2026-11-05T10:00:05Z");
		assert.equal(newer.total, 99);
		assert.equal(newer.counts.create, 50);
		const older = mergeDecisionPages(a, next, "2026-11-05T10:00:05Z", "2026-11-05T10:00:00Z");
		assert.equal(older.total, a.total);
		assert.equal(older.counts.create, a.counts.create);
		assert.equal(mergeDecisionPages(a, next).total, a.total);
	});
	it("formatters", () => {
		assert.equal(kbAge(5_000), "just now");
		assert.equal(kbAge(120_000), "2m");
		assert.equal(kbRelativeTime("2026-11-05T09:55:00Z", Date.parse("2026-11-05T10:00:00Z")), "5m ago");
	});

	describe("applyHubEvent", () => {
		const base = () => initialActivityState(kbActivityFixture());
		const at = "2026-11-05T10:01:00Z";
		it("sweep_started / sweep_finished toggle sweeping", () => {
			const s = applyHubEvent(base(), { type: "sweep_started", id: 1, at, pending: 4 });
			assert.equal(s.sweeping, true);
			assert.equal(applyHubEvent(s, { type: "sweep_started", id: 2, at, pending: 4 }), s);
			assert.equal(applyHubEvent(s, { type: "sweep_finished", id: 3, at }).sweeping, false);
		});
		it("sweep_item decrements pending and prepends a provisional row", () => {
			const s = applyHubEvent(base(), { type: "sweep_item", id: 7, at, from: "hal", denTopicId: "t-hal-1", outcome: "create", entryId: "ent-x" });
			const hal = s.data.incoming.wolves.find((w) => w.wolf === "hal")!;
			assert.equal(hal.pending, 2);
			assert.deepEqual(hal.items.map((i) => i.denTopicId), ["t-hal-2", "t-hal-3"]);
			assert.equal(s.data.incoming.total, 3);
			const top = s.data.decisions.items[0]!;
			assert.equal(top.id, "live:7");
			assert.equal(top.outcome, "create");
			assert.equal(top.entryId, "ent-x");
			assert.equal(top.domain, undefined);
			assert.equal(s.data.decisions.counts.create, 4);
			assert.equal(s.data.decisions.total, 10);
			assert.equal(s.sweeping, true);
			assert.equal(decisionRows(s.data.decisions.items)[0]!.provisional, true);
			// the same frame twice changes nothing more
			assert.equal(applyHubEvent(s, { type: "sweep_item", id: 7, at, from: "hal", denTopicId: "t-hal-1", outcome: "create" }), s);
		});
		it("a provisional row inherits the domain of the row it replaces", () => {
			const s = applyHubEvent(base(), { type: "sweep_item", id: 40, at, from: "ada", denTopicId: "t2", outcome: "reject" });
			assert.equal(s.data.decisions.items[0]!.domain, "personal");
			assert.equal(domainBlocks(s.data).find((b) => b.domain === "personal")!.rows[0]!.provisional, true);
		});
		it("a parked item whose decision differs uses the committed decision", () => {
			const s = applyHubEvent(base(), {
				type: "sweep_item",
				id: 8,
				at,
				from: "ada",
				denTopicId: "t-ada-1",
				outcome: "parked",
				decision: { outcome: "merge", entryId: "ent-m", reason: "same subject", routing: { route: "alias", candidates: [] } },
			});
			const top = s.data.decisions.items[0]!;
			assert.equal(top.outcome, "merge");
			assert.equal(top.entryId, "ent-m");
			assert.equal(top.reason, "same subject");
			assert.equal(top.routing?.route, "alias");
			assert.equal(s.data.decisions.counts.merge, 3);
			assert.equal(s.data.decisions.counts.parked, 1);
			// its decision is a committed merge, so the item leaves the pending count
			assert.equal(s.data.incoming.wolves.find((w) => w.wolf === "ada")!.pending, 0);
			assert.equal(s.data.incoming.total, 3);
		});
		it("the last pending item clears the oldest age", () => {
			const s = applyHubEvent(base(), { type: "sweep_item", id: 8, at, from: "ada", denTopicId: "t-ada-1", outcome: "create" });
			const ada = s.data.incoming.wolves.find((w) => w.wolf === "ada")!;
			assert.equal(ada.pending, 0);
			assert.equal(ada.oldestAgeMs, undefined);
		});
		it("a plain parked item stays pending; a parked item with a committed decision leaves it", () => {
			const plain = applyHubEvent(base(), { type: "sweep_item", id: 30, at, from: "hal", denTopicId: "t-hal-1", outcome: "parked" });
			assert.equal(plain.data.incoming.wolves.find((w) => w.wolf === "hal")!.pending, 3);
			assert.equal(plain.data.incoming.total, 4);
			const done = applyHubEvent(base(), { type: "sweep_item", id: 31, at, from: "hal", denTopicId: "t-hal-1", outcome: "parked", decision: { outcome: "create", entryId: "e" } });
			assert.equal(done.data.incoming.wolves.find((w) => w.wolf === "hal")!.pending, 2);
			assert.equal(done.data.incoming.total, 3);
			// a parked decision (no commit) does not
			const still = applyHubEvent(base(), { type: "sweep_item", id: 32, at, from: "hal", denTopicId: "t-hal-1", outcome: "parked", decision: { outcome: "parked" } });
			assert.equal(still.data.incoming.total, 4);
		});
		it("live matching removes one item by from + denTopicId only", () => {
			const d = kbActivityFixture();
			d.incoming.wolves[0]!.pending = 2;
			d.incoming.wolves[0]!.items = [{ denTopicId: "t-ada-1", hash: "h1", ageMs: 5 }, { denTopicId: "t-ada-1", hash: "h2", ageMs: 9 }];
			const s = applyHubEvent(initialActivityState(d), { type: "sweep_item", id: 3, at, from: "ada", denTopicId: "t-ada-1", outcome: "create" });
			assert.deepEqual(s.data.incoming.wolves[0]!.items.map((i) => i.hash), ["h2"]);
		});
		it("an item that already has a row replaces it instead of counting twice", () => {
			const s1 = applyHubEvent(base(), { type: "sweep_item", id: 20, at, from: "hal", denTopicId: "t1", outcome: "create", entryId: "e9" });
			// d1 (hal / t1, parked) is replaced by the live create: total unchanged, counts moved
			assert.equal(s1.data.decisions.total, 9);
			assert.equal(s1.data.decisions.counts.parked, 0);
			assert.equal(s1.data.decisions.counts.create, 4);
			assert.equal(s1.data.decisions.items.filter((d) => d.from === "hal" && d.denTopicId === "t1").length, 1);
			assert.equal(s1.data.decisions.items[0]!.id, "live:20");
			// a second live frame for the same contribution replaces the provisional row
			const s2 = applyHubEvent(s1, { type: "sweep_item", id: 21, at, from: "hal", denTopicId: "t1", outcome: "merge" });
			assert.equal(s2.data.decisions.total, 9);
			assert.equal(s2.data.decisions.items.filter((d) => d.denTopicId === "t1").length, 1);
			assert.equal(s2.data.decisions.counts.create, 3);
			assert.equal(s2.data.decisions.counts.merge, 3);
		});
		it("rows outside the active range or domain are not added (incoming still moves)", () => {
			const d = kbActivityFixture();
			const iso = initialActivityState(d, { since: "2026-11-06T00:00:00Z" });
			const s = applyHubEvent(iso, { type: "sweep_item", id: 4, at, from: "hal", denTopicId: "t-hal-1", outcome: "create" });
			assert.equal(s.data.decisions.items.length, 4);
			assert.equal(s.data.decisions.total, 9);
			assert.equal(s.data.incoming.wolves.find((w) => w.wolf === "hal")!.pending, 2);
			const dom = applyHubEvent(initialActivityState(d, { since: "30d", domain: "wolfpack" }), { type: "sweep_item", id: 5, at, from: "hal", denTopicId: "z", outcome: "create" });
			assert.equal(dom.data.decisions.items.length, 4);
			const inside = applyHubEvent(initialActivityState(d, { since: "7d" }), { type: "sweep_item", id: 6, at: new Date().toISOString(), from: "hal", denTopicId: "z", outcome: "create" });
			assert.equal(inside.data.decisions.items.length, 5);
		});
		it("an unknown wolf only adds the row; other events are ignored", () => {
			const b = base();
			const s = applyHubEvent(b, { type: "sweep_item", id: 9, at, from: "ghost", denTopicId: "g", outcome: "reject" });
			assert.equal(s.data.incoming.total, 4);
			assert.equal(s.data.decisions.items[0]!.outcome, "reject");
			assert.equal(applyHubEvent(b, { type: "work.changed", id: 10, at }), b);
		});
	});
});
