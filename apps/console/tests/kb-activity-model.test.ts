import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	applyHubEvent,
	changeColumns,
	curatorNote,
	decisionOutcome,
	decisionRows,
	filterDecisions,
	groupIncoming,
	initialActivityState,
	kbAge,
	kbRelativeTime,
	mergeDecisionPages,
	needsRefetch,
	outcomeFilters,
	routingSummary,
} from "../src/core/kb-activity-model.ts";
import { kbActivityFixture } from "./fixtures/kb-activity.ts";

describe("kb-activity model", () => {
	it("decisionOutcome normalises spellings", () => {
		assert.equal(decisionOutcome("created"), "create");
		assert.equal(decisionOutcome("updated"), "merge");
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
		assert.deepEqual(filterDecisions(rows, "reject").map((r) => r.id), ["d2"]);
		assert.equal(filterDecisions(rows, "all").length, 4);
	});
	it("outcomeFilters carries counts, all first", () => {
		const f = outcomeFilters(kbActivityFixture());
		assert.deepEqual(f[0], { key: "all", label: "all", count: 9 });
		assert.equal(f.find((x) => x.key === "reject")?.count, 2);
		assert.equal(f.length, 7);
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
	it("changeColumns: one per domain by name, newest first, capped, action labels", () => {
		const cols = changeColumns(kbActivityFixture());
		assert.deepEqual(cols.map((c) => c.domain), ["personal", "wolfpack"]);
		assert.deepEqual(cols[1]!.rows.map((r) => r.label), ["merged", "retired"]);
		assert.equal(cols[1]!.rows[1]!.title, "ent-old"); // no title: falls back to the id
		assert.equal(cols[1]!.rows[0]!.wolf, "hal");
		const many = kbActivityFixture({ changes: { domains: [{ domain: "x", items: Array.from({ length: 15 }, (_, i) => ({ at: `2026-11-05T09:${String(10 + i)}:00Z`, entryId: `e${i}`, action: "supersede" as const })) }] } });
		const rows = changeColumns(many)[0]!.rows;
		assert.equal(rows.length, 10);
		assert.equal(rows[0]!.entryId, "e14");
		assert.equal(rows[0]!.label, "superseded");
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
			assert.equal(s.data.decisions.counts.create, 4);
			assert.equal(s.data.decisions.total, 10);
			assert.equal(s.sweeping, true);
			assert.equal(decisionRows(s.data.decisions.items)[0]!.provisional, true);
			// the same frame twice changes nothing more
			assert.equal(applyHubEvent(s, { type: "sweep_item", id: 7, at, from: "hal", denTopicId: "t-hal-1", outcome: "create" }), s);
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
			const ada = s.data.incoming.wolves.find((w) => w.wolf === "ada")!;
			assert.equal(ada.pending, 0);
			assert.equal(ada.oldestAgeMs, undefined);
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
