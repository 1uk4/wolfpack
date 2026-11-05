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
	reconcileActivity,
	sinceCutoff,
	outcomeFilters,
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
	it("changeColumns keeps the hub's order for unparseable times and keys are unique", () => {
		const d = kbActivityFixture({ changes: { domains: [{ domain: "x", items: [{ at: "bad", entryId: "e1", action: "create" }, { at: "bad", entryId: "e1", action: "create" }, { at: "also-bad", entryId: "e2", action: "merge" }] }] } });
		const rows = changeColumns(d)[0]!.rows;
		assert.deepEqual(rows.map((r) => r.entryId), ["e1", "e1", "e2"]);
		assert.equal(new Set(rows.map((r) => r.key)).size, 3);
	});
	it("sinceCutoff", () => {
		const now = Date.parse("2026-11-05T00:00:00Z");
		assert.equal(sinceCutoff("all", now), null);
		assert.equal(sinceCutoff("7d", now), now - 7 * 86_400_000);
		assert.equal(sinceCutoff("2026-11-01T00:00:00Z", now), Date.parse("2026-11-01T00:00:00Z"));
		assert.equal(sinceCutoff("junk", now), null);
	});
	describe("reconcileActivity / refreshDecisions", () => {
		const page = (ids: string[], cursor?: string) => {
			const d = kbActivityFixture();
			return { ...d, decisions: { ...d.decisions, items: ids.map((id) => ({ id, at: "2026-11-05T09:00:00Z", from: "w", denTopicId: id, hash: id, outcome: "create" as const })), ...(cursor ? { nextCursor: cursor } : { nextCursor: undefined }) } };
		};
		it("keeps deeper pages and the deepest cursor when the first page overlaps", () => {
			const prev = initialActivityState(page(["a", "b", "c", "d"], "deep"), { since: "30d" });
			const next = reconcileActivity(prev, page(["n", "a", "b"], "shallow"), { since: "30d" });
			assert.deepEqual(next.data.decisions.items.map((d) => d.id), ["n", "a", "b", "c", "d"]);
			assert.equal(next.data.decisions.nextCursor, "deep");
		});
		it("drops provisional rows", () => {
			const base = page(["a", "b"], "c1");
			base.decisions.items.unshift({ id: "live:1", at: "2026-11-05T09:00:00Z", from: "w", denTopicId: "z", hash: "", outcome: "create" });
			const next = reconcileActivity(initialActivityState(base, { since: "30d" }), page(["a", "b"], "c1"), { since: "30d" });
			assert.deepEqual(next.data.decisions.items.map((d) => d.id), ["a", "b"]);
		});
		it("restarts paging when there is no overlap (a gap) or the range changed", () => {
			const prev = initialActivityState(page(["a", "b"], "deep"), { since: "30d" });
			assert.deepEqual(reconcileActivity(prev, page(["x", "y"], "s"), { since: "30d" }).data.decisions.items.map((d) => d.id), ["x", "y"]);
			assert.equal(reconcileActivity(prev, page(["a", "x"], "s"), { since: "7d" }).data.decisions.items.length, 2);
		});
		it("sweeping follows the response when it says, else the previous state", () => {
			const prev = { ...initialActivityState(page(["a"]), { since: "30d" }), sweeping: true };
			const d = page(["a"]);
			delete (d as { sweep?: unknown }).sweep;
			assert.equal(reconcileActivity(prev, d, { since: "30d" }).sweeping, true);
			assert.equal(reconcileActivity(prev, { ...d, sweep: { running: false } }, { since: "30d" }).sweeping, false);
		});
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
			// a parked item does not touch the pending count
			assert.equal(s.data.incoming.wolves.find((w) => w.wolf === "ada")!.pending, 1);
			assert.equal(s.data.incoming.total, 4);
		});
		it("the last pending item clears the oldest age", () => {
			const s = applyHubEvent(base(), { type: "sweep_item", id: 8, at, from: "ada", denTopicId: "t-ada-1", outcome: "create" });
			const ada = s.data.incoming.wolves.find((w) => w.wolf === "ada")!;
			assert.equal(ada.pending, 0);
			assert.equal(ada.oldestAgeMs, undefined);
		});
		it("removes only the item with the matching hash from incoming", () => {
			const d = kbActivityFixture();
			d.incoming.wolves[0]!.pending = 2;
			d.incoming.wolves[0]!.items = [{ denTopicId: "t-ada-1", hash: "h1", ageMs: 5 }, { denTopicId: "t-ada-1", hash: "h2", ageMs: 9 }];
			const s = applyHubEvent(initialActivityState(d), { type: "sweep_item", id: 3, at, from: "ada", denTopicId: "t-ada-1", outcome: "create", hash: "h2" } as never);
			assert.deepEqual(s.data.incoming.wolves[0]!.items.map((i) => i.hash), ["h1"]);
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
