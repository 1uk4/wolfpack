import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryEventsProvider } from "../components/memory-events.tsx";
import { MemoryPanel } from "../components/memory-panel.tsx";

describe("MemoryPanel SSR", () => {
	it("renders the open shell with empty feed before any fetch", () => {
		const html = renderToStaticMarkup(
			<MemoryEventsProvider>
				<MemoryPanel wolf="w" threadId="t" />
			</MemoryEventsProvider>,
		);
		assert.match(html, /data-testid="memory-panel"/);
		assert.match(html, /data-open="true"/);
		assert.match(html, /Collapse memory panel/);
		assert.match(html, /Nothing captured yet/);
		assert.match(html, /Consolidate/);
		assert.doesNotMatch(html, /memory-banner/);
	});
});
