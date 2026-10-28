import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryEventsProvider } from "../components/memory-events.tsx";
import { MemoryPanel, StatusSection } from "../components/memory-panel.tsx";

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
	const bound = { workId: "work-1", title: "Item" } as never;
	const item = { id: "work-1", title: "Item", kind: "task", stage: "in_build", domain: "wolfpack", plan: "# Item\n\n## Plan\n\nDo it.\n\n## Notes\n", successCriteria: "- it works", record: "" } as never;
	const shown = { item, rec: { record: "### Decisions\n\n- one", inheritedFrom: null } } as never;
	const poolObs = [{ id: "o1", timestamp: "2026-10-26 10:00", recordedAt: "2026-10-26T10:00:00Z", content: "saw it", tokenCount: 2 }];
	const obsProps = (list: unknown = poolObs, open: string | null = null) => ({ list: list as never, error: null, info: {}, open, onOpen: () => {} });
	const r = (view: "item" | "feed", b: unknown, o: { otherState?: "loading" | "error"; shown?: unknown; viewingOther?: boolean; bind?: { id: string; busy: boolean; error: string | null; onBind: () => void } | null } = {}) =>
		renderToStaticMarkup(
			<StatusSection view={view} bound={b as never} shown={("shown" in o ? o.shown : shown) as never} viewingOther={o.viewingOther} otherState={o.otherState} bind={o.bind} observations={obsProps()} onToggleFeed={() => {}} onSelect={() => {}} onBack={() => {}} />,
		);

	it("the item view has no task graph, no graph/list toggle and no feature-graph back link", () => {
		const html = r("item", bound);
		assert.doesNotMatch(html, /task-graph|memory-graph|memory-back-graph|Back to feature graph|memory-view-toggle|data-testid="task-node/);
		assert.match(html, /data-testid="memory-record"/);
	});
	it("item view: title, badges, Record as markdown, then the plan; back link only for another task", () => {
		const html = r("item", bound);
		assert.match(html, /data-testid="memory-record"/);
		assert.match(html, /work-badges/);
		assert.match(html, /<h3[^>]*>Decisions<\/h3>/);
		assert.doesNotMatch(html, /### Decisions/);
		// one document: Done when → plan → Record; no duplicate title heading, no empty Notes, no separate PLAN block
		assert.match(html, /<h2[^>]*>Done when<\/h2>/);
		assert.match(html, /<h2[^>]*>Record<\/h2>/);
		assert.ok(html.indexOf("Done when") < html.indexOf("Do it."));
		assert.ok(html.indexOf("Do it.") < html.indexOf("Decisions"));
		assert.doesNotMatch(html, /<h1|>Notes<|memory-plan/);
		// child items get the ↳ arrow; the way back to the bound item shows only for another task
		assert.doesNotMatch(html, /memory-back-bound/);
		assert.match(r("item", bound, { viewingOther: true }), /memory-back-bound/);
		assert.doesNotMatch(html, /memory-child-arrow/);
		const child = { item: { ...(item as object), partOf: "F" }, rec: { record: "", inheritedFrom: null } };
		assert.match(r("item", bound, { shown: child }), /memory-child-arrow/);
	});
	it("viewing another task: Loading… / Couldn't load + Retry, never the bound item's title or link", () => {
		const loading = r("item", bound, { viewingOther: true, shown: null, otherState: "loading" });
		assert.match(loading, /memory-other-loading/);
		assert.match(loading, /memory-back-bound/);
		assert.doesNotMatch(loading, />Item<\/a>|work-1/);
		const failed = r("item", bound, { viewingOther: true, shown: null, otherState: "error" });
		assert.match(failed, /Couldn&#x27;t load this task/);
		assert.match(failed, /memory-other-retry/);
		assert.doesNotMatch(failed, />Item<\/a>|work-1/);
	});
	it("bind button: rendered with its label when offered, with the route's error under it; absent otherwise", () => {
		const offered = { id: "work-2", busy: false, error: null, onBind: () => {} };
		const html = r("item", bound, { viewingOther: true, bind: offered });
		assert.match(html, /data-testid="memory-bind-button"[^>]*>Bind this thread to this task</);
		assert.doesNotMatch(html, /memory-bind-error/);
		assert.match(r("item", bound, { viewingOther: true, bind: { ...offered, error: "work-2 is archived or graduated and cannot be bound" } }), /data-testid="memory-bind-error"[^>]*>work-2 is archived/);
		assert.match(r("item", bound, { viewingOther: true, bind: { ...offered, busy: true } }), /disabled=""[^>]*>Binding…/);
		assert.doesNotMatch(r("item", bound, { viewingOther: true }), /memory-bind/);
	});
	it("feed view: feed shown with a back button", () => {
		const html = r("feed", bound);
		assert.match(html, />Observations</);
		assert.match(html, /memory-feed-back/);
		assert.match(html, /‹ back/);
		assert.doesNotMatch(html, /« Status|memory-view-toggle/);
		// the list shows the Den group with its count, not the observation text
		assert.match(html, /memory-obs-group-den/);
		assert.match(html, /data-count="1"/);
	});
	it("unbound: observations shown, no toggle or back button", () => {
		const html = r("item", null);
		assert.match(html, /memory-obs-group-den/);
		assert.doesNotMatch(html, /memory-feed-back/);
	});
});
