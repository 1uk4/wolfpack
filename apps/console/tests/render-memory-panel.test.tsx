import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryEventsProvider } from "../components/memory-events.tsx";
import { BoundOrFeed, MemoryPanel } from "../components/memory-panel.tsx";

describe("MemoryPanel SSR", () => {
	it("renders the open shell with the feed (unbound) and no banner before any fetch", () => {
		const html = renderToStaticMarkup(
			<MemoryEventsProvider>
				<MemoryPanel wolf="w" threadId="t" />
			</MemoryEventsProvider>,
		);
		assert.match(html, /data-testid="memory-panel"/);
		assert.match(html, /data-open="true"/);
		assert.match(html, /Collapse memory panel/);
		assert.match(html, /Nothing captured yet/);
		assert.doesNotMatch(html, /memory-banner/);
		assert.doesNotMatch(html, /memory-view-toggle/);
		assert.match(html, /Observations \(live\)/);
		assert.equal(html.match(/data-testid="memory-feed"/g)?.length, 1);
	});
	const bound = { workId: "work-1", title: "Item" } as never;
	const rec = { record: "### Decisions\n\n- one", inheritedFrom: null } as never;
	const feed = [{ key: "f0", summary: "saw it", count: 1, destination: "den" }] as never;
	const r = (view: "record" | "feed", b: unknown, unread = 0) =>
		renderToStaticMarkup(<BoundOrFeed view={view} bound={b as never} rec={rec} feed={feed} unread={unread} onToggle={() => {}} />);

	it("bound + record view: Record rendered as markdown with a Live observations toggle", () => {
		const html = r("record", bound, 3);
		assert.match(html, /Bound item/);
		assert.match(html, /Live observations »/);
		assert.match(html, /memory-unread/);
		assert.match(html, /<h3[^>]*>Decisions<\/h3>/);
		assert.doesNotMatch(html, /### Decisions/);
	});
	it("bound + feed view: feed shown with a back toggle", () => {
		const html = r("feed", bound);
		assert.match(html, /Observations \(live\)/);
		assert.match(html, /« Bound item/);
		assert.match(html, /saw it/);
	});
	it("unbound: feed shown, no toggle", () => {
		const html = r("record", null);
		assert.match(html, /saw it/);
		assert.doesNotMatch(html, /memory-view-toggle/);
	});
});
