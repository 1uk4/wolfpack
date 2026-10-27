import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryEventsProvider } from "../components/memory-events.tsx";
import { buildTaskGraph } from "../src/core/index.ts";
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
		assert.match(html, /Nothing captured yet/);
		assert.doesNotMatch(html, /memory-banner/);
		assert.doesNotMatch(html, /memory-view-toggle/);
		assert.match(html, /Observations \(live\)/);
		assert.equal(html.match(/data-testid="memory-feed"/g)?.length, 1);
	});
	const bound = { workId: "work-1", title: "Item" } as never;
	const item = { id: "work-1", title: "Item", kind: "task", stage: "in_build", domain: "wolfpack", plan: "## Plan\n\nDo it.", record: "" } as never;
	const shown = { item, rec: { record: "### Decisions\n\n- one", inheritedFrom: null } } as never;
	const feed = [{ key: "f0", summary: "saw it", count: 1, destination: "den" }] as never;
	const kid = (id: string, stage: string, dependsOn: string[] = []) => ({ id, title: `Task ${id}`, kind: "task", stage, dependsOn });
	const feat = { id: "F", kind: "feature", title: "Feat", stage: "in_build", plan: "", record: "", children: [kid("a", "shipped"), kid("b", "in_build", ["a"]), kid("c", "idea", ["b"])] };
	const graphOf = (boundId: string) => buildTaskGraph({ id: boundId, kind: "task", title: "", stage: "", plan: "", record: "", partOf: "F" }, feat as never);
	const r = (view: "graph" | "item" | "feed", b: unknown, o: { unread?: number; graph?: ReturnType<typeof buildTaskGraph>; viewingOther?: boolean } = {}) =>
		renderToStaticMarkup(
			<StatusSection view={view} bound={b as never} graph={o.graph ?? graphOf("b")} shown={shown} viewingOther={o.viewingOther} feed={feed} unread={o.unread ?? 0} onView={() => {}} onToggleFeed={() => {}} onSelect={() => {}} onBack={() => {}} />,
		);

	it("graph view: Feature/Item tabs, feature link with progress, and the graph SVG", () => {
		const html = r("graph", bound, { unread: 3 });
		assert.match(html, /data-testid="memory-graph"/);
		assert.match(html, /data-testid="memory-tab-graph"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-testid="memory-tab-graph"/);
		assert.match(html, /Live observations »/);
		assert.match(html, /memory-unread/);
		assert.match(html, /href="\/kb\/work\/F"[^>]*>Feat</);
		assert.match(html, /1\/3 shipped/);
		assert.match(html, /data-testid="task-graph-svg"/);
		assert.doesNotMatch(html, /Decisions/);
	});
	it("graph SVG: statuses map to data attributes, check, dash, glow on the bound task only", () => {
		const html = r("graph", bound);
		assert.match(html, /data-testid="task-node-a" data-status="shipped" data-bound="false"/);
		assert.match(html, /data-testid="task-node-b" data-status="building" data-bound="true"/);
		assert.match(html, /data-testid="task-node-c" data-status="blocked" data-bound="false"/);
		assert.equal(html.match(/data-glow="true"/g)?.length, 1);
		assert.equal(html.match(/data-check="true"/g)?.length, 1);
		assert.match(html, /stroke-sky-400/);
		assert.equal(html.match(/stroke-dasharray="4 3"/g)?.length, 1);
		assert.match(html, /data-edge="a-&gt;b"/);
		assert.match(html, /data-edge="b-&gt;c"/);
		assert.doesNotMatch(html, /data-edge="b-&gt;a"/);
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
		assert.ok(html.indexOf("Decisions") < html.indexOf("Do it."));
		assert.match(html, /memory-plan/);
		assert.doesNotMatch(html, /memory-back-bound/);
		assert.match(r("item", bound, { viewingOther: true }), /memory-back-bound/);
	});
	it("feed view: feed shown with a back toggle", () => {
		const html = r("feed", bound);
		assert.match(html, /Observations \(live\)/);
		assert.match(html, /« Status/);
		assert.match(html, /saw it/);
	});
	it("unbound: feed shown, no toggle or tabs", () => {
		const html = r("graph", null);
		assert.match(html, /saw it/);
		assert.doesNotMatch(html, /memory-view-toggle|memory-tabs/);
	});
});
