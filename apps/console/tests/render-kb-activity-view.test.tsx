import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { KbActivityBody, KbActivityUnavailable } from "../components/kb-activity-view.tsx";
import { initialActivityState } from "../src/core/kb-activity-model.ts";
import { kbActivityFixture } from "./fixtures/kb-activity.ts";

const now = Date.parse("2026-11-05T10:00:00Z");

describe("KbActivityBody", () => {
	const html = renderToStaticMarkup(<KbActivityBody state={initialActivityState(kbActivityFixture())} now={now} />);
	it("renders one block per domain, even an empty one, with entries / waiting / last change", () => {
		assert.match(html, /data-testid="kb-activity-view"/);
		for (const d of ["empty", "personal", "wolfpack"]) assert.match(html, new RegExp(`data-testid="kb-domain" data-domain="${d}"`));
		assert.match(html, /167 entries · 2 waiting · last change 2m ago/);
		assert.match(html, /0 entries · 0 waiting/);
		assert.match(html, /No activity in this range/);
	});
	it("lists contributors and one row per item with the wolf and outcome label", () => {
		assert.match(html, /Contributors<\/span>ada 5/);
		assert.match(html, /none in range/);
		assert.match(html, /href="\/kb\/entry\/ent-merge"[^>]*>Merged entry</);
		assert.match(html, /~ merged/);
		assert.match(html, /\+ created/);
		assert.match(html, /× rejected/);
		assert.match(html, /replaced 1/);
		assert.match(html, /retired/);
		assert.equal((html.match(/Merged entry/g) ?? []).length, 1); // decision + change are one row
		assert.doesNotMatch(html, /data-filter=/);
	});
	it("has the range toggle and show-all only where more decisions exist", () => {
		for (const s of ["7d", "30d", "all"]) assert.match(html, new RegExp(`data-since="${s}"`));
		assert.match(html, /data-testid="kb-show-all" data-domain="personal"[^>]*>show all 5 →/);
		assert.doesNotMatch(html, /data-testid="kb-show-all" data-domain="empty"/);
	});
	it("renders Needs attention grouped by wolf with bad contributions' reason and hint", () => {
		assert.match(html, /data-testid="kb-attention"/);
		assert.match(html, /3 contributions need attention/);
		assert.match(html, /t-bad-1[\s\S]*hint nope[\s\S]*domain_hint is not subscribed/);
		assert.match(html, /1 contribution: too vague/);
		assert.ok(html.indexOf('data-domain="wolfpack"') < html.indexOf('data-testid="kb-attention"'));
	});
	it("shows sweeping; provisional rows are marked", () => {
		const s = { ...initialActivityState(kbActivityFixture()), sweeping: true };
		assert.match(renderToStaticMarkup(<KbActivityBody state={s} now={now} />), /data-testid="kb-sweeping"/);
		const d = kbActivityFixture();
		d.decisions.items.unshift({ id: "live:1", at: "2026-11-05T09:59:00Z", from: "hal", denTopicId: "t", hash: "", outcome: "create", domain: "wolfpack" });
		assert.match(renderToStaticMarkup(<KbActivityBody state={initialActivityState(d)} now={now} />), /data-provisional="true"/);
	});
});

describe("empty and degraded states", () => {
	it("no domains and nothing to attend to", () => {
		const empty = kbActivityFixture({
			incoming: { total: 0, wolves: [] },
			domains: [],
			decisions: { items: [], total: 0, counts: { create: 0, merge: 0, unchanged: 0, reject: 0, parked: 0, unclassified: 0 } },
			changes: { domains: [] },
		});
		const h = renderToStaticMarkup(<KbActivityBody state={initialActivityState(empty)} now={now} />);
		assert.match(h, /No domains yet/);
		assert.doesNotMatch(h, /kb-attention/);
	});
	it("curator off: the note is shown once at the top and blocks still render", () => {
		const d = kbActivityFixture({ source: { lane: "hub", hasDecisions: false, curator: "off" } });
		const h = renderToStaticMarkup(<KbActivityBody state={initialActivityState(d)} now={now} />);
		assert.equal((h.match(/data-testid="kb-curator-note"/g) ?? []).length, 1);
		assert.match(h, /data-testid="kb-curator-note"[^>]*>The hub curator is off/);
		assert.match(h, /data-domain="wolfpack"/);
	});
	it("no decisions yet note", () => {
		const d = kbActivityFixture({ source: { lane: "hub", hasDecisions: false, curator: "on" } });
		assert.match(renderToStaticMarkup(<KbActivityBody state={initialActivityState(d)} now={now} />), /hasn&#x27;t decided anything yet/);
	});
	it("an older hub without domains still renders blocks from the data", () => {
		const d = kbActivityFixture();
		delete (d as { domains?: unknown }).domains;
		assert.match(renderToStaticMarkup(<KbActivityBody state={initialActivityState(d)} now={now} />), /data-domain="wolfpack"/);
	});
	it("an older hub: dashes instead of zeros and a note", () => {
		const d = kbActivityFixture();
		delete (d as { domains?: unknown }).domains;
		const h = renderToStaticMarkup(<KbActivityBody state={initialActivityState(d)} now={now} />);
		assert.match(h, /data-testid="kb-hub-older"/);
		assert.match(h, /– entries · – waiting/);
		assert.doesNotMatch(h, /0 entries/);
	});
	it("a truncated attention list says latest N", () => {
		const d = kbActivityFixture({ attention: [{ wolf: "hal", reject: 40, parked: 0, unclassified: 0, bad: 0, items: [] }] });
		const h = renderToStaticMarkup(<KbActivityBody state={initialActivityState(d)} now={now} />);
		assert.match(h, /40 contributions need attention/);
		assert.match(h, /latest 2/);
	});
	it("unavailable", () => {
		assert.match(renderToStaticMarkup(<KbActivityUnavailable message="needs a hub" />), /data-testid="kb-activity-unavailable"[\s\S]*needs a hub/);
	});
});
