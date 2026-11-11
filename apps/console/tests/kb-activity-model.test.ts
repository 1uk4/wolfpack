import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	applyHubEvent,
	contributionList,
	contributionRows,
	attentionGroups,
	hubIsOlder,
	domainBlocks,
	curatorNote,
	curatorStuck,
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
		assert.equal(needsRefetch({ type: "sweep_item" }), true);
		assert.equal(needsRefetch({ type: "sweep_started" }), true);
		assert.equal(needsRefetch({ type: "wolf.presence" }), false);
		assert.equal(needsRefetch({ type: "sweep_progress" }), false); // folded in optimistically
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
		const all = kbActivityFixture();
		delete all.decisions.nextCursor; // everything is loaded: the counts are exact
		const g = attentionGroups(all);
		assert.deepEqual(g.map((x) => [x.wolf, x.count]), [["hal", 3], ["ada", 1]]);
		const hal = g[0]!;
		assert.match(hal.summary, /3 contributions need attention/);
		assert.deepEqual(hal.items.map((i) => i.kind), ["decision", "bad", "bad"]);
		assert.equal(hal.items[1]!.domainHint, "nope");
		assert.equal(g[1]!.summary, "1 contribution: too vague");
		assert.deepEqual(attentionGroups(kbActivityFixture({ attention: [], decisions: { items: [], total: 0, counts: kbActivityFixture().decisions.counts }, incoming: { total: 0, wolves: [] } })), []);
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

	it("domainBlocks reads the hub's per-domain recent, so a domain is not empty when the overall page is full of others", () => {
		const d = kbActivityFixture({
			domains: [{ domain: "quiet", entries: 3, waiting: 0, contributors: [{ wolf: "w", count: 1 }], decided: 1, recent: [{ id: "q1", at: "2026-10-01T00:00:00Z", from: "w", denTopicId: "old", hash: "h", outcome: "create", domain: "quiet", title: "Quiet one", entryId: "e-q" }] }],
			decisions: { items: [{ id: "o1", at: "2026-11-05T09:00:00Z", from: "w", denTopicId: "x", hash: "x", outcome: "create", domain: "busy" }], total: 1, counts: kbActivityFixture().decisions.counts },
			changes: { domains: [] },
		});
		const b = domainBlocks(d)[0]!;
		assert.deepEqual(b.rows.map((r) => r.title), ["Quiet one"]);
		assert.equal(b.more, false);
	});
	it("a hub without domains: counts are unknown (undefined), not zero, and hubIsOlder says so", () => {
		const d = kbActivityFixture();
		delete (d as { domains?: unknown }).domains;
		assert.equal(hubIsOlder(d), true);
		assert.equal(hubIsOlder(kbActivityFixture()), false);
		const b = domainBlocks(d)[0]!;
		assert.equal(b.entries, undefined);
		assert.equal(b.waiting, undefined);
	});
	it("attentionGroups uses the hub's per-wolf totals, marks a truncated list, and keys rows by stable ids", () => {
		const d = kbActivityFixture({
			attention: [{ wolf: "hal", reject: 30, parked: 5, unclassified: 0, bad: 2, items: [{ id: "r1", at: "2026-11-05T09:00:00Z", from: "hal", denTopicId: "t1", hash: "h", outcome: "reject", reason: "vague" }] }],
		});
		const g = attentionGroups(d);
		assert.equal(g[0]!.wolf, "hal");
		assert.equal(g[0]!.count, 37); // 35 decisions + 2 bad as the hub counted, not just the loaded rows
		assert.equal(g[0]!.truncated, true);
		assert.match(g[0]!.summary, /37 contributions need attention/);
		assert.deepEqual(g[0]!.items.map((i) => i.key).sort(), ["bad/hal/sha-1", "bad/hal/sha-2", "r1"]);
		// the same input in a different order yields the same keys
		d.incoming.bad = [...d.incoming.bad!].reverse();
		assert.deepEqual(attentionGroups(d)[0]!.items.map((i) => i.key).sort(), ["bad/hal/sha-1", "bad/hal/sha-2", "r1"]);
	});
	it("attentionGroups without hub totals (older hub) does not present a lower bound as exact", () => {
		const d = kbActivityFixture();
		delete (d as { attention?: unknown }).attention;
		const lower = attentionGroups(d).find((g) => g.wolf === "ada")!;
		assert.equal(lower.summary, "1+ contributions need attention");
		assert.equal(lower.truncated, true); // the fixture has a nextCursor: more pages exist
		delete d.decisions.nextCursor;
		const exact = attentionGroups(d).find((g) => g.wolf === "ada")!;
		assert.equal(exact.summary, "1 contribution: too vague");
		assert.equal(exact.truncated, false);
	});
	it("backfill-shaped data (old dates, one decision per item) renders per domain with the right wolves", () => {
		const mk = (id: string, from: string, domain: string, outcome: "create" | "reject", entryId?: string) => ({ id, at: "2025-01-02T00:00:00Z", from, denTopicId: `t-${id}`, hash: id, outcome, domain, ...(entryId ? { entryId, title: `Title ${id}` } : {}) });
		const recent = [mk("bf-d3", "hal2", "beta", "reject"), mk("bf-d2", "1uk4", "beta", "create", "kb-beta-1"), mk("bf-d1", "hal2", "alpha", "create", "kb-alpha-1")];
		const d = kbActivityFixture({
			incoming: { total: 0, wolves: [] },
			attention: [],
			domains: [
				{ domain: "alpha", entries: 1, waiting: 0, contributors: [{ wolf: "hal2", count: 1 }], decided: 1, recent: [recent[2]!] },
				{ domain: "beta", entries: 1, waiting: 0, contributors: [{ wolf: "1uk4", count: 1 }], decided: 2, recent: [recent[0]!, recent[1]!] },
			],
			decisions: { items: recent, total: 3, counts: kbActivityFixture().decisions.counts },
			changes: { domains: [{ domain: "beta", items: [{ at: "2025-01-02T00:00:01Z", entryId: "kb-beta-1", title: "Title bf-d2", action: "create", from: "1uk4", denTopicId: "t-bf-d2" }] }] },
		});
		const [alpha, beta] = domainBlocks(d);
		assert.deepEqual(alpha!.contributors, [{ wolf: "hal2", count: 1 }]);
		assert.deepEqual(beta!.contributors, [{ wolf: "1uk4", count: 1 }]);
		assert.deepEqual(beta!.rows.map((r) => [r.label, r.wolf]), [["rejected", "hal2"], ["created", "1uk4"]]); // the change folded into its decision
		assert.equal(alpha!.rows[0]!.wolf, "hal2");
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

	describe("contributionRows", () => {
		const NOW = Date.parse("2026-11-05T10:00:00Z");
		const base = () => {
			const d = kbActivityFixture();
			d.decisions.items = [];
			d.domains = [];
			d.incoming.wolves = [{ wolf: "hal", pending: 2, oldestAgeMs: 120_000, items: [{ denTopicId: "a", ageMs: 120_000, domain: "wolfpack" }, { denTopicId: "b", ageMs: 5_000 }] }];
			return d;
		};
		it("queued rows, oldest first, with wolf, topic, domain, age", () => {
			const rows = contributionRows(base(), NOW);
			assert.deepEqual(rows.map((r) => [r.state, r.wolf, r.denTopicId, r.domain]), [["queued", "hal", "a", "wolfpack"], ["queued", "hal", "b", undefined]]);
			assert.equal(NOW - rows[0]!.at, 120_000);
		});
		it("old hub (no sweep.current, no sweep): nothing is running", () => {
			const d = base();
			delete d.sweep;
			assert.ok(contributionRows(d, NOW).every((r) => r.state === "queued"));
			d.sweep = { running: true };
			assert.ok(contributionRows(d, NOW).every((r) => r.state === "queued"));
		});
		it("sweep.current marks its item in progress, first, with the route and the domain from the lane", () => {
			const d = base();
			d.sweep = { running: true, current: { from: "hal", denTopicId: "a", startedAt: NOW - 3000, route: "merge into kb-wolfpack-X (9391 chars)" } };
			const rows = contributionRows(d, NOW);
			assert.equal(rows.length, 2);
			assert.deepEqual([rows[0]!.state, rows[0]!.label, rows[0]!.route, rows[0]!.domain, rows[1]!.state], ["running", "in progress", "merge into kb-wolfpack-X (9391 chars)", "wolfpack", "queued"]);
		});
		it("a running item that is no longer listed in the lane still shows", () => {
			const d = base();
			d.sweep = { running: true, current: { from: "ada", denTopicId: "zz", startedAt: NOW - 1000 } };
			assert.equal(contributionRows(d, NOW)[0]!.denTopicId, "zz");
		});
		it("decided rows: created/merged with entry, 15 minute window; rejected and parked stay longer", () => {
			const d = base();
			d.incoming.wolves = [];
			const dec = (id: string, outcome: "create" | "merge" | "reject" | "parked", minsAgo: number, extra = {}) => ({ id, at: new Date(NOW - minsAgo * 60_000).toISOString(), from: "hal", denTopicId: id, hash: "h", outcome, ...extra });
			d.decisions.items = [dec("c1", "create", 2, { entryId: "kb-new", domain: "wolfpack" }), dec("m1", "merge", 20), dec("r1", "reject", 120, { reason: "too vague" }), dec("p1", "parked", 60)];
			const rows = contributionRows(d, NOW);
			assert.deepEqual(rows.map((r) => [r.denTopicId, r.state, r.label, r.entryId]), [["c1", "decided", "created", "kb-new"], ["p1", "decided", "parked", undefined], ["r1", "decided", "rejected", undefined]]);
			assert.equal(rows[2]!.reason, "too vague");
		});
		it("a parked item still in the lane stays, as parked, however old", () => {
			const d = base();
			d.decisions.items = [{ id: "p", at: new Date(NOW - 3 * 86_400_000).toISOString(), from: "hal", denTopicId: "a", hash: "h", outcome: "parked" }];
			d.incoming.wolves[0]!.items[0]!.ageMs = 4 * 86_400_000;
			assert.equal(contributionRows(d, NOW).find((r) => r.denTopicId === "a")!.label, "parked");
		});
		it("a resubmission after a decision is queued again", () => {
			const d = base();
			d.decisions.items = [{ id: "x", at: new Date(NOW - 600_000).toISOString(), from: "hal", denTopicId: "b", hash: "h", outcome: "reject" }];
			assert.equal(contributionRows(d, NOW).find((r) => r.denTopicId === "b")!.state, "queued");
		});
		it("empty", () => {
			const d = base();
			d.incoming = { total: 0, wolves: [] };
			assert.deepEqual(contributionRows(d, NOW), []);
		});
		it("applyHubEvent: sweep_item clears sweep.current for that item; sweep_finished clears it", () => {
			const d = base();
			d.sweep = { running: true, current: { from: "hal", denTopicId: "a", startedAt: NOW } };
			let st = initialActivityState(d);
			st = applyHubEvent(st, { type: "sweep_item", id: 1, at: "2026-11-05T10:00:01Z", from: "hal", denTopicId: "a", outcome: "create", entryId: "kb-n" } as never, NOW);
			assert.equal(st.data.sweep?.current, undefined);
			const rows = contributionRows(st.data, NOW);
			assert.equal(rows.find((r) => r.denTopicId === "a")!.state, "decided");
			const d2 = base();
			d2.sweep = { running: true, current: { from: "hal", denTopicId: "b", startedAt: NOW } };
			const fin = applyHubEvent(initialActivityState(d2), { type: "sweep_finished" } as never, NOW);
			assert.equal(fin.data.sweep?.current, undefined);
			assert.equal(fin.sweeping, false);
		});

		const frameAt = (o: object) => ({ id: 1, at: "2026-11-05T10:00:01Z", ...o }) as never;
		it("sweep_progress shows the item in progress at once, and the route when it arrives", () => {
			const d = base();
			let st = initialActivityState(d);
			st = applyHubEvent(st, frameAt({ type: "sweep_progress", from: "hal", denTopicId: "a", startedAt: NOW }), NOW);
			assert.equal(contributionRows(st.data, NOW)[0]!.state, "running");
			assert.equal(contributionRows(st.data, NOW)[0]!.route, undefined);
			st = applyHubEvent(st, frameAt({ type: "sweep_progress", from: "hal", denTopicId: "a", startedAt: NOW, route: "merge into kb-x" }), NOW);
			assert.equal(contributionRows(st.data, NOW)[0]!.route, "merge into kb-x");
			assert.equal(st.sweeping, true);
		});
		it("a duplicate sweep_item (provisional row already there) still clears sweep.current", () => {
			const d = base();
			let st = initialActivityState(d);
			const item = frameAt({ type: "sweep_item", id: 9, from: "hal", denTopicId: "a", outcome: "create", entryId: "kb-n" });
			st = applyHubEvent(st, item, NOW);
			st = applyHubEvent(st, frameAt({ type: "sweep_progress", from: "hal", denTopicId: "a", startedAt: NOW }), NOW); // current is back (e.g. reconciled state)
			st = applyHubEvent(st, item, NOW); // duplicate: early return path
			assert.equal(st.data.sweep?.current, undefined);
		});
		it("a refetch issued before a sweep_item cannot bring sweep.current back", () => {
			const d = base();
			d.sweep = { running: true, current: { from: "hal", denTopicId: "a", startedAt: NOW - 1000, route: "merge into kb-x" } };
			let st = initialActivityState(d); // the request goes out here (current present)
			st = applyHubEvent(st, frameAt({ type: "sweep_item", id: 3, from: "hal", denTopicId: "a", outcome: "merge", entryId: "kb-x" }), NOW);
			// ... and the stale response lands after the event
			st = reconcileActivity(st, structuredClone(d));
			assert.equal(st.data.sweep?.current, undefined);
			// a later item (another topic) is not affected
			const d2 = base();
			d2.sweep = { running: true, current: { from: "hal", denTopicId: "b", startedAt: NOW } };
			assert.equal(reconcileActivity(st, d2).data.sweep?.current?.denTopicId, "b");
			// the same item starting again (new sweep_progress) is shown again
			st = applyHubEvent(st, frameAt({ type: "sweep_progress", from: "hal", denTopicId: "a", startedAt: NOW + 5 }), NOW);
			assert.equal(reconcileActivity(st, structuredClone(d)).data.sweep?.current?.denTopicId, "a");
		});
		it("a refetch issued before sweep_finished cannot bring sweep.current back", () => {
			const d = base();
			d.sweep = { running: true, current: { from: "hal", denTopicId: "a", startedAt: NOW } };
			let st = initialActivityState(d);
			st = applyHubEvent(st, frameAt({ type: "sweep_finished" }), NOW);
			assert.equal(reconcileActivity(st, structuredClone(d)).data.sweep?.current, undefined);
			st = applyHubEvent(st, frameAt({ type: "sweep_started", pending: 1 }), NOW);
			assert.equal(reconcileActivity(st, structuredClone(d)).data.sweep?.current?.denTopicId, "a");
		});
		it("over the cap, rows for rejected / parked are kept and the rest is counted as +N more", () => {
			const d = base();
			d.incoming.wolves = [{ wolf: "hal", pending: 40, items: Array.from({ length: 40 }, (_, i) => ({ denTopicId: `q${i}`, ageMs: 1000 + i })) }];
			d.decisions.items = [
				{ id: "r1", at: new Date(NOW - 60_000).toISOString(), from: "hal", denTopicId: "rej1", hash: "h", outcome: "reject" },
				{ id: "p1", at: new Date(NOW - 90_000).toISOString(), from: "hal", denTopicId: "par1", hash: "h", outcome: "parked" },
			];
			const { rows, more } = contributionList(d, NOW, 30);
			assert.equal(rows.length, 30);
			assert.equal(more, 42 - 30);
			assert.deepEqual(rows.filter((r) => r.state === "decided").map((r) => r.denTopicId).sort(), ["par1", "rej1"]);
			assert.equal(contributionList(d, NOW, 100).more, 0);
		});
		it("a resubmission with the same key shows as running after sweep_started, even without a progress frame", () => {
			const d = base();
			d.sweep = { running: true, current: { from: "hal", denTopicId: "a", startedAt: NOW - 1000 } };
			let st = initialActivityState(d);
			st = applyHubEvent(st, frameAt({ type: "sweep_item", id: 3, from: "hal", denTopicId: "a", outcome: "parked" }), NOW);
			st = applyHubEvent(st, frameAt({ type: "sweep_finished" }), NOW);
			st = applyHubEvent(st, frameAt({ type: "sweep_started", pending: 1 }), NOW);
			assert.equal(st.ended, undefined);
			const again = base();
			again.sweep = { running: true, current: { from: "hal", denTopicId: "a", startedAt: NOW + 5000 } };
			const rows = contributionRows(reconcileActivity(st, again).data, NOW + 6000);
			assert.equal(rows.find((r) => r.denTopicId === "a")!.state, "running");
		});
		it("a reconnect (resync) during a running sweep: the refetch's sweep.current shows", () => {
			const d = base();
			d.sweep = { running: true, current: { from: "hal", denTopicId: "a", startedAt: NOW } };
			let st = initialActivityState(d);
			st = applyHubEvent(st, frameAt({ type: "sweep_item", id: 3, from: "hal", denTopicId: "a", outcome: "create", entryId: "kb-n" }), NOW);
			st = applyHubEvent(st, frameAt({ type: "sweep_finished" }), NOW); // idle + ended set; the next sweep_started was missed during the disconnect
			st = applyHubEvent(st, { type: "resync", id: 9 } as never, NOW);
			assert.equal(st.idle, undefined);
			assert.equal(st.ended, undefined);
			assert.equal(reconcileActivity(st, structuredClone(d)).data.sweep?.current?.denTopicId, "a");
		});
	});
});

describe("zone-less ledger times (run under TZ=America/Los_Angeles)", () => {
	it("reads 'YYYY-MM-DD HH:MM' as UTC, so it is not 'just now' and not in the future", () => {
		const now = Date.parse("2026-11-06T03:00:00Z");
		assert.equal(kbRelativeTime("2026-11-06 00:49", now), "2h ago");
		assert.equal(kbRelativeTime("2026-11-06T00:49:00.000Z", now), "2h ago");
	});
	it("a genuinely future time still clamps to just now", () => {
		assert.equal(kbRelativeTime("2026-11-06 04:00", Date.parse("2026-11-06T03:00:00Z")), "just now");
	});
});

describe("curatorStuck", () => {
	const stuck = () => kbActivityFixture({ sweep: { running: true, stuckSince: "2026-11-05T09:45:00.000Z" } });
	it("returns the stuck-since time when the hub reports it", () => {
		assert.equal(curatorStuck(stuck()), "2026-11-05T09:45:00.000Z");
	});
	it("is null when the hub does not report it (older hub, or a healthy sweep)", () => {
		assert.equal(curatorStuck(kbActivityFixture()), null);
		assert.equal(curatorStuck(kbActivityFixture({ sweep: { running: true } })), null);
	});
	it("clears when a later response has no stuckSince", () => {
		const first = reconcileActivity(null, stuck());
		assert.equal(curatorStuck(first.data), "2026-11-05T09:45:00.000Z");
		const later = reconcileActivity(first, kbActivityFixture({ sweep: { running: false } }));
		assert.equal(curatorStuck(later.data), null);
	});
});
