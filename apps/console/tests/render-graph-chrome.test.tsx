/**
 * Graph chrome pins: the search box renders only when there are nodes to
 * search (dead controls are lies — the honesty principle); the settings gear
 * stays — the layer toggles and the domain filter are how an empty view gets
 * un-emptied. GraphChromeRow is the pure seam: SSR of both states pins it. Fetches don't run under renderToStaticMarkup
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
	it("EMPTY view: no search, but the settings gear stays (the filter lives there)", () => {
		const html = renderToStaticMarkup(createElement(GraphChromeRow, { ...PROPS, isEmpty: true }));
		assert.ok(!html.includes("Search nodes…"), "search is a lie on an empty graph");
		// the settings gear is the lucide-settings svg (tooltip wave: its old
		// native title is gone — the styled tooltip carries the label now)
		assert.ok(html.includes("lucide-settings"), "settings stays reachable");
		assert.equal(html.split("graph-chrome-fade-in").length - 1, 1, "one fade carrier: the gear");
	});

	it("POPULATED graph: search + settings render, both carrying the fade", () => {
		const html = renderToStaticMarkup(createElement(GraphChromeRow, { ...PROPS, isEmpty: false }));
		assert.ok(html.includes("Search nodes…"));
		assert.ok(html.includes("lucide-settings"), "the settings gear renders");
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