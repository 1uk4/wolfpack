import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryEventsProvider } from "../components/memory-events.tsx";
import { MemoryPanel, ObservationsSection } from "../components/memory-panel.tsx";

describe("MemoryPanel SSR", () => {
	it("renders the open shell with the feed (unbound) and no banner before any fetch", () => {
		const html = renderToStaticMarkup(
			<MemoryEventsProvider>
				<MemoryPanel wolf="w" threadId="t" />
			</MemoryEventsProvider>,
		);
		assert.match(html, /data-testid="memory-panel"/);
		assert.match(html, /data-open="true"/);
		assert.match(html, /Collapse status panel/);
		assert.match(html, /Loading…/);
		assert.doesNotMatch(html, /memory-banner/);
		assert.doesNotMatch(html, /memory-view-toggle/);
		assert.match(html, />Observations</);
		assert.equal(html.match(/data-testid="memory-feed"/g)?.length, 1);
	});
	const poolObs = [{ id: "o1", timestamp: "2026-10-26 10:00", recordedAt: "2026-10-26T10:00:00Z", content: "saw it", tokenCount: 2 }];
	const obsProps = (list: unknown = poolObs, open: string | null = null) => ({ list: list as never, error: null, info: {}, open, onOpen: () => {} });

	it("shows memory only: no item viewer, bound plan, Record or bind button", () => {
		const html = renderToStaticMarkup(
			<MemoryEventsProvider>
				<MemoryPanel embedded wolf="w" threadId="t" slug="s" />
			</MemoryEventsProvider>,
		);
		assert.doesNotMatch(html, /memory-record|memory-bind|memory-work-link|memory-back-bound|memory-feed-back/);
	});
	it("observations: the Den group with its count, not the observation text", () => {
		const html = renderToStaticMarkup(<ObservationsSection observations={obsProps()} />);
		assert.match(html, />Observations</);
		assert.match(html, /memory-obs-group-den/);
		assert.match(html, /data-count="1"/);
		assert.doesNotMatch(html, /saw it/);
	});
});
