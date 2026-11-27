import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { KbLogRow } from "../../../src/core/index.ts";
import { KbLifeLog, detailLines, reasonsOf, seedRowsOf } from "../../../components/kb/kb-life-view.tsx";
import { lifeStrips } from "../../../components/kb/kb-activity-view.tsx";
import { kbActivityFixture } from "../../fixtures/kb-activity.ts";

const now = Date.parse("2026-11-05T10:00:00Z");
const row = (over: Partial<KbLogRow>): KbLogRow => ({ key: "k", verb: "merged", domain: "wolfpack", title: "Zod standard", at: now - 3 * 60_000, firstAt: now - 3 * 60_000, n: 1, fold: "merged|z", focus: {}, ids: ["id-1"], ...over });

describe("KB life log", () => {
	it("shows one row per folded group with ×n and age, grouped under its domain, with details hidden", () => {
		const html = renderToStaticMarkup(<KbLifeLog seed={[row({ n: 3 }), row({ key: "o", verb: "observe", domain: null, title: "1uk4 observed", fold: "observe|1uk4", reason: "secret-reason" })]} now={now} since="all" />);
		assert.match(html, /data-domain="wolfpack"/);
		assert.match(html, /data-domain="wolves"/);
		assert.match(html, /data-verb="merged" data-count="3"[\s\S]*×3 · 3m/);
		assert.doesNotMatch(html, /secret-reason|data-testid="kb-log-details"/);
	});

	it("says there is no activity when the range is empty, with no live events needed", () => {
		assert.match(renderToStaticMarkup(<KbLifeLog seed={[]} now={now} since="7d" />), /data-testid="kb-log-empty"/);
	});

	it("lists outcome, section, reason, timings, tokens and ids for the details panel", () => {
		assert.deepEqual(detailLines(row({ outcome: "reject", section: "memory", reason: "dup", ms: 40, tokens: 7 })), ["outcome reject", "section memory", "reason dup", "40 ms", "7 tokens", "ids id-1"]);
	});

	it("turns the ledger history into rows: entry titles, a sender label (never a topic id) for items with no entry, retired changes left out", () => {
		const rows = seedRowsOf(kbActivityFixture()).map((r) => [r.domain, r.verb, r.title, r.entryId ?? null, r.wolf ?? null]);
		assert.deepEqual(rows, [
			["personal", "created", "New entry", "ent-new", "ada"],
			["personal", "rejected", "ada → personal", null, "ada"],
			["wolfpack", "merged", "Merged entry", "ent-merge", "hal"],
		]);
	});

	it("takes the curator reason per topic from the ledger decisions, the only place it is kept", () => {
		assert.deepEqual(reasonsOf(kbActivityFixture()), { "t-old": "same subject", t3: "new subject", t2: "too vague", t1: "no domain" });
	});

	it("keeps Contributions always and Needs attention only when something needs a look, each with a count", () => {
		assert.deepEqual(lifeStrips(kbActivityFixture(), now).map((x) => [x.id, x.count]), [["contributions", 8], ["attention", 4]]);
		const calm = kbActivityFixture({ attention: [], incoming: { total: 0, wolves: [], bad: [] } });
		assert.deepEqual(lifeStrips(calm, now).map((x) => x.id), ["contributions"]);
	});
});
