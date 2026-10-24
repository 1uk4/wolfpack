/**
 * Empty-graph chrome pins (empty-graph chrome wave, owner 2026-09-25):
 * search + settings render only when the snapshot has nodes (dead controls
 * are lies — the honesty principle); an empty graph renders no chrome.
 * GraphChromeRow is the pure seam (the DeleteNodeBody pattern): SSR of
 * both states pins the ruling. Fetches don't run under renderToStaticMarkup
 * (effects never fire), so these pins exercise the component directly.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GraphChromeRow } from "../components/graph-view.tsx";
import type { GraphRenderSettings } from "../components/graph-canvas.ts";

/** Ref doubles — the SSR harness never attaches them. */
const ref = { current: null };

const PROPS = {
	query: "",
	onQuery: () => {},
	noMatch: false,
	searchInputRef: ref,
	settings: {} as GraphRenderSettings,
	changeSettings: () => {},
};

describe("GraphChromeRow — the empty-graph ruling (owner, 2026-09-25)", () => {
	it("EMPTY graph: nothing renders — search + settings absent", () => {
		const html = renderToStaticMarkup(createElement(GraphChromeRow, { ...PROPS, isEmpty: true }));
		assert.ok(!html.includes("import-notes"), "the import entry point retired with the extraction pipeline");
		assert.ok(!html.includes("Search nodes…"), "search is a lie on an empty graph");
		// the settings gear is the lucide-settings svg (tooltip wave: its old
		// native title is gone — the styled tooltip carries the label now)
		assert.ok(!html.includes("lucide-settings"), "settings is a lie on an empty graph");
		assert.ok(!html.includes("graph-chrome-fade-in"), "nothing gated = nothing fading in");
	});

	it("POPULATED graph: search + settings render, both carrying the fade", () => {
		const html = renderToStaticMarkup(createElement(GraphChromeRow, { ...PROPS, isEmpty: false }));
		assert.ok(html.includes("Search nodes…"));
		assert.ok(html.includes("lucide-settings"), "the settings gear renders");
		// the appear-once fade rides exactly the two gated controls
		assert.equal(html.split("graph-chrome-fade-in").length - 1, 2, "two fade carriers: search + settings");
	});

	it("the no-match note renders only when the wrapper says so (its truth stays upstream)", () => {
		const html = renderToStaticMarkup(
			createElement(GraphChromeRow, { ...PROPS, isEmpty: false, query: "zzz", noMatch: true }),
		);
		assert.ok(html.includes("No matching nodes."));
		const quiet = renderToStaticMarkup(
			createElement(GraphChromeRow, { ...PROPS, isEmpty: false, query: "zzz", noMatch: false }),
		);
		assert.ok(!quiet.includes("No matching nodes."));
	});
});