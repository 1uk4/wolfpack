import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryEventsProvider } from "../components/memory-events.tsx";
import { buildTaskGraph } from "../src/core/index.ts";
import { isActivateKey } from "../components/task-graph.tsx";
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
	const kid = (id: string, stage: string, dependsOn: string[] = []) => ({ id, title: `Task ${id}`, kind: "task", stage, dependsOn });
	const feat = { id: "F", kind: "feature", title: "Feat", stage: "in_build", plan: "", record: "", children: [kid("a", "shipped"), kid("b", "in_build", ["a"]), kid("c", "idea", ["b"])] };
	const graphOf = (boundId: string) => buildTaskGraph({ id: boundId, kind: "task", title: "", stage: "", plan: "", record: "", partOf: "F" }, feat as never);
	const r = (view: "graph" | "item" | "feed", b: unknown, o: { otherState?: "loading" | "error"; shown?: unknown; graph?: ReturnType<typeof buildTaskGraph>; viewingOther?: boolean } = {}) =>
		renderToStaticMarkup(
			<StatusSection view={view} bound={b as never} graph={o.graph ?? graphOf("b")} shown={("shown" in o ? o.shown : shown) as never} viewingOther={o.viewingOther} otherState={o.otherState} observations={obsProps()} onGraph={() => {}} onToggleFeed={() => {}} onSelect={() => {}} onBack={() => {}} />,
		);

	it("graph view: Feature label, feature link with progress, and the graph SVG", () => {
		const html = r("graph", bound);
		assert.match(html, /data-testid="memory-graph"/);
		assert.match(html, /memory-graph-label/);
		assert.doesNotMatch(html, /memory-back-graph/);
		assert.doesNotMatch(html, /Live observations|memory-view-toggle/);
		assert.match(html, /href="\/kb\/work\/F"[^>]*>Feat</);
		assert.match(html, /1\/3 shipped/);
		assert.match(html, /data-testid="task-graph-svg"/);
		assert.doesNotMatch(html, /Decisions/);
	});
	it("graph: statuses map to data attributes on the cards, the bound task flagged", () => {
		const html = r("graph", bound);
		assert.match(html, /data-testid="task-node-a" data-status="shipped" data-bound="false"/);
		assert.match(html, /data-testid="task-node-b" data-status="building" data-bound="true"/);
		assert.match(html, /data-testid="task-node-c" data-status="blocked" data-bound="false"/);
		assert.equal(html.match(/>current</g)?.length, 1);
		assert.equal(html.match(/data-check="true"/g)?.length, 1);
	});
	it("graph view for an Inbox parent: count, no svg", () => {
		const inbox = buildTaskGraph({ id: "t", kind: "task", title: "", stage: "", plan: "", record: "", partOf: "I" }, { ...feat, id: "I", title: "Inbox", container: true } as never);
		const html = r("graph", bound, { graph: inbox });
		assert.match(html, /Inbox<\/a> · 3 items/);
		assert.doesNotMatch(html, /task-graph-svg/);
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
		// header: back to the feature graph by its title; child items get the ↳ arrow
		assert.match(html, /aria-label="Back to feature graph"[^>]*>.*Feat<\/span><\/button>/);
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
		assert.match(loading, /aria-label="Back to feature graph"[^>]*>.*Feat<\/span><\/button><button[^>]*data-testid="memory-back-bound">Bound item/);
		assert.doesNotMatch(loading, />Item<\/a>|work-1/);
		const failed = r("item", bound, { viewingOther: true, shown: null, otherState: "error" });
		assert.match(failed, /Couldn&#x27;t load this task/);
		assert.match(failed, /memory-other-retry/);
		assert.doesNotMatch(failed, />Item<\/a>|work-1/);
	});
	it("graph a11y: group role, current task named in the node label, activation keys", () => {
		const html = r("graph", bound);
		assert.match(html, /role="group" aria-label="Task graph: Feat, 1\/3 shipped"/);
		assert.match(html, /aria-label="Task b \(in build, current task\)"/);
		assert.match(html, /aria-label="Task a \(shipped\)"/);
		assert.match(html, /tabindex="0"/);
		assert.equal(isActivateKey("Enter"), true);
		assert.equal(isActivateKey(" "), true);
		assert.equal(isActivateKey("a"), false);
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
		const html = r("graph", null);
		assert.match(html, /memory-obs-group-den/);
		assert.doesNotMatch(html, /memory-feed-back|memory-back-graph/);
	});
});
