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
	it("warns that the curator is stuck only when the hub reports stuckSince, and drops it once a later response omits it", () => {
		const render = (d: ReturnType<typeof kbActivityFixture>) => renderToStaticMarkup(<KbActivityBody state={initialActivityState(d)} now={now} />);
		const stuck = render(kbActivityFixture({ sweep: { running: true, stuckSince: "2026-11-05T09:45:00.000Z" } }));
		assert.match(stuck, /data-testid="kb-curator-stuck"/);
		assert.match(stuck, /Curator stuck since .*\(15m ago\)/);
		assert.match(stuck, /new sweeps are skipped until it does/);
		assert.doesNotMatch(render(kbActivityFixture()), /kb-curator-stuck/);
		assert.doesNotMatch(render(kbActivityFixture({ sweep: { running: false } })), /kb-curator-stuck/);
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
			attention: [],
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

describe("Contributions list", () => {
	it("shows queued, in progress with route, and decided with entry link", () => {
		const d = kbActivityFixture();
		d.sweep = { running: true, current: { from: "hal", denTopicId: "t-hal-3", startedAt: now - 4000, route: "merge into kb-wolfpack-X (9391 chars)" } };
		const html = renderToStaticMarkup(<KbActivityBody state={initialActivityState(d)} now={now} />);
		assert.match(html, /data-testid="kb-contributions"/);
		assert.match(html, /data-state="running"[^>]*data-wolf="hal" data-topic="t-hal-3"/);
		assert.match(html, /merge into kb-wolfpack-X \(9391 chars\)/);
		assert.match(html, /data-state="queued"[^>]*data-topic="t-ada-1"/);
		assert.match(html, /data-state="decided" data-outcome="merge"/);
		assert.match(html, /href="\/kb\/entry\/ent-merge"/);
	});
	it("empty state, and an old hub without sweep.current still renders", () => {
		const d = kbActivityFixture();
		d.incoming = { total: 0, wolves: [] };
		d.decisions.items = [];
		d.domains = [];
		delete d.sweep;
		assert.match(renderToStaticMarkup(<KbActivityBody state={initialActivityState(d)} now={now} />), /Nothing incoming\./);
	});
});

describe("Contributions list cap", () => {
	it("shows +N more when rows are cut", () => {
		const d = kbActivityFixture();
		d.incoming.wolves = [{ wolf: "hal", pending: 40, items: Array.from({ length: 40 }, (_, i) => ({ denTopicId: `q${i}`, ageMs: 1000 + i })) }];
		const html = renderToStaticMarkup(<KbActivityBody state={initialActivityState(d)} now={now} />);
		assert.match(html, /data-testid="kb-contributions-more">\+\d+ more</);
	});
});
