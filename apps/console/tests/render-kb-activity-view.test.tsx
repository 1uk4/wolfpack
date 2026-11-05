import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChangesPanel, DecisionFeed, IncomingPanel, KbActivityBody, KbActivityUnavailable } from "../components/kb-activity-view.tsx";
import { initialActivityState } from "../src/core/kb-activity-model.ts";
import { kbActivityFixture } from "./fixtures/kb-activity.ts";

const now = Date.parse("2026-11-05T10:00:00Z");

describe("KbActivityBody", () => {
	const html = renderToStaticMarkup(<KbActivityBody state={initialActivityState(kbActivityFixture())} now={now} />);
	it("renders the incoming panel by wolf, most pending first", () => {
		assert.match(html, /data-testid="kb-activity-view"/);
		assert.match(html, /4 waiting/);
		assert.ok(html.indexOf('data-wolf="hal"') < html.indexOf('data-wolf="ada"'));
		assert.match(html, /3 pending/);
		assert.match(html, /oldest 2h/);
		assert.match(html, /1 bad/);
		assert.match(html, /t-hal-2/);
		assert.doesNotMatch(html, /data-wolf="idle"/);
	});
	it("renders decisions with chips, entry links, reasons, routing and filter counts", () => {
		assert.match(html, /data-outcome="merge"/);
		assert.match(html, /href="\/kb\/entry\/ent-merge"/);
		assert.match(html, /same subject/);
		assert.match(html, /too vague/);
		assert.match(html, /candidates: c-top 0\.93, c-mid 0\.60, c-4th 0\.50/);
		assert.match(html, /warning: close call/);
		assert.match(html, /data-filter="reject"[^>]*>rejected 2</);
		assert.match(html, /data-since="30d"/);
		assert.match(html, /data-testid="kb-load-more"/);
		assert.match(html, /replaced 1/);
		assert.doesNotMatch(html, /data-testid="kb-curator-note"/);
	});
	it("renders a column per domain with linked titles, wolf and relative time", () => {
		assert.match(html, /data-domain="personal"/);
		assert.match(html, /data-domain="wolfpack"/);
		assert.match(html, /href="\/kb\/entry\/ent-new"[^>]*>New entry</);
		assert.match(html, /retired/);
		assert.match(html, /hal · 2m ago/);
	});
	it("shows sweeping and a filtered feed", () => {
		const s = { ...initialActivityState(kbActivityFixture()), sweeping: true };
		const h = renderToStaticMarkup(<KbActivityBody state={s} now={now} outcome="reject" />);
		assert.match(h, /data-testid="kb-sweeping"/);
		assert.doesNotMatch(h, /data-outcome="create"/);
		assert.match(h, /data-outcome="reject"/);
		assert.match(renderToStaticMarkup(<KbActivityBody state={s} now={now} outcome="unclassified" />), /No decisions match this filter/);
	});
	it("provisional rows are marked", () => {
		const d = kbActivityFixture();
		d.decisions.items.unshift({ id: "live:1", at: "2026-11-05T09:59:00Z", from: "hal", denTopicId: "t", hash: "", outcome: "create" });
		assert.match(renderToStaticMarkup(<DecisionFeed data={d} now={now} outcome="all" since="30d" />), /data-provisional="true"/);
	});
});

describe("empty and degraded states", () => {
	const empty = kbActivityFixture({
		incoming: { total: 0, wolves: [] },
		decisions: { items: [], total: 0, counts: { create: 0, merge: 0, unchanged: 0, reject: 0, parked: 0, unclassified: 0 } },
		changes: { domains: [] },
	});
	it("empty panels", () => {
		assert.match(renderToStaticMarkup(<IncomingPanel data={empty} />), /Nothing is waiting/);
		const feed = renderToStaticMarkup(<DecisionFeed data={empty} now={now} outcome="all" since="30d" />);
		assert.match(feed, /No decisions in this range/);
		assert.doesNotMatch(feed, /kb-load-more/);
		assert.match(renderToStaticMarkup(<ChangesPanel data={empty} now={now} />), /No changes yet/);
	});
	it("curator off: note shown and incoming still renders", () => {
		const d = kbActivityFixture({ source: { lane: "hub", hasDecisions: false, curator: "off" } });
		const h = renderToStaticMarkup(<KbActivityBody state={initialActivityState(d)} now={now} />);
		assert.match(h, /data-testid="kb-curator-note"[^>]*>The hub curator is off/);
		assert.match(h, /data-wolf="hal"/);
	});
	it("no decisions yet note", () => {
		const d = kbActivityFixture({ source: { lane: "hub", hasDecisions: false, curator: "on" } });
		assert.match(renderToStaticMarkup(<DecisionFeed data={d} now={now} outcome="all" since="30d" />), /hasn&#x27;t decided anything yet/);
	});
	it("unavailable", () => {
		assert.match(renderToStaticMarkup(<KbActivityUnavailable message="needs a hub" />), /data-testid="kb-activity-unavailable"[\s\S]*needs a hub/);
	});
});
