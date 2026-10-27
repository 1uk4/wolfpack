/**
 * The graph's detail cards and the unavailable state (SSR pins — effects
 * never fire under renderToStaticMarkup, so these exercise the components
 * directly from their pure card models).
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GraphCard } from "../components/graph-card.tsx";
import { GraphUnavailable } from "../components/graph-home.tsx";
import { describeNode } from "../src/core/kb-graph-model.ts";
import type { KbGraph } from "../src/core/kb.ts";

const graph: KbGraph = {
	nodes: [
		{ id: "dom:wolfpack", kind: "domain", label: "Wolfpack", depth: 0, domain: "wolfpack" },
		{ id: "sec:arch", kind: "section", label: "Architecture", depth: 1, domain: "wolfpack", sectionId: "arch", summary: "How it fits" },
		{ id: "ent:e1", kind: "entry", label: "Entry one", depth: 2, domain: "wolfpack", sectionId: "arch", summary: "First", maturity: "stable" },
		{ id: "ent:e2", kind: "entry", label: "Entry two", depth: 2, domain: "wolfpack" },
		{ id: "work:w1", kind: "work", label: "Feature", depth: 3, domain: "wolfpack", stage: "in_build" },
		{ id: "work:w2", kind: "work", label: "Task", depth: 3, domain: "wolfpack", stage: "plan" },
		{ id: "den:hal:t", kind: "den-topic", label: "Topic", depth: 4, wolf: "hal", summary: "private notes" },
	],
	edges: [
		{ source: "sec:arch", target: "ent:e1", kind: "hierarchy" },
		{ source: "ent:e1", target: "ent:e2", kind: "related", relation: "see_also" },
		{ source: "work:w2", target: "work:w1", kind: "partOf" },
		{ source: "work:w2", target: "ent:e1", kind: "dependsOn" },
	],
	layers: { archivedWork: false, wikilinks: false, denTopics: true },
	domain: null,
	domains: [{ name: "wolfpack", label: "Wolfpack" }],
	generated: "2026-10-27T00:00:00.000Z",
};

const html = (id: string) =>
	renderToStaticMarkup(createElement(GraphCard, { card: describeNode(graph, id)!, onFocus: () => {}, onSelectNode: () => {} }));

describe("GraphCard", () => {
	it("entry: title, summary, domain, section, maturity, related, and an Open link to the reader", () => {
		const h = html("ent:e1");
		for (const text of ["Entry one", "First", "Wolfpack", "Architecture", "stable", "Entry two", "see also"]) assert.ok(h.includes(text), text);
		assert.ok(h.includes('href="/kb/entry/e1"'), "open → the entry reader");
		assert.ok(h.includes(">Open<"));
		assert.ok(!h.includes(">Focus<"));
	});

	it("work: stage, parent and dependencies, and an Open link to the work page", () => {
		const h = html("work:w2");
		assert.ok(h.includes("plan") && h.includes("Part of") && h.includes("Feature"));
		assert.ok(h.includes("Depends on") && h.includes("Entry one"));
		assert.ok(h.includes('href="/kb/work/w2"'));
	});

	it("section: summary and a Focus button, no Open link", () => {
		const h = html("sec:arch");
		assert.ok(h.includes("How it fits") && h.includes(">Focus<"));
		assert.ok(!h.includes(">Open<"));
	});

	it("den topic: minimal — wolf and summary only", () => {
		const h = html("den:hal:t");
		assert.ok(h.includes("hal") && h.includes("private notes"));
		assert.ok(!h.includes(">Open<") && !h.includes(">Focus<"));
	});

	it("domain: counts", () => {
		const h = html("dom:wolfpack");
		assert.ok(h.includes("Wolfpack") && h.includes("Entry") && h.includes("Work"));
	});
});

describe("GraphUnavailable (no librarian online)", () => {
	it("says so plainly and carries the server's message", () => {
		const h = renderToStaticMarkup(createElement(GraphUnavailable, { message: "kb not served" }));
		assert.ok(h.includes("Knowledge graph unavailable"));
		assert.ok(h.includes("librarian"));
		assert.ok(h.includes("kb not served"));
		assert.ok(h.includes('data-testid="graph-placeholder"'));
	});
});
