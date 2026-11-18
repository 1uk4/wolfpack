/** "/" is a light page (logo + one button per wolf); the knowledge graph lives on "/graph". */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { WolfHome, WolfHomeView } from "../../../components/shell/wolf-home.tsx";
import { dataStore } from "../../../src/core/data-store.ts";
import GraphPage from "../../../app/graph/page.tsx";
import { GraphHome } from "../../../components/graph/graph-home.tsx";

const read = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");

describe("home page", () => {
	it("shows the logo and one stacked 44px+ link per wolf to /wolf/<name>, with no graph", () => {
		const html = renderToStaticMarkup(<WolfHomeView wolves={[{ name: "1uk4" }, { name: "hal" }]} />);
		assert.match(html, /<svg[^>]*viewBox="0 0 64 64"/);
		assert.deepEqual([...html.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1]), ["/wolf/1uk4", "/wolf/hal"]);
		assert.match(html, /flex-col/);
		assert.match(html, /min-h-11/);
		assert.doesNotMatch(html, /graph/i);
		// nothing graph-related is imported by the "/" route
		for (const f of ["../../../app/page.tsx", "../../../components/shell/wolf-home.tsx"]) assert.doesNotMatch(read(f), /graph-home|graph-view/);
	});
	it("a warm store renders the wolf links on the first render; a cold one renders none", async () => {
		dataStore.clear();
		const links = () => [...renderToStaticMarkup(<WolfHome />).matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1]);
		assert.deepEqual(links(), []);
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async () => Response.json({ wolves: [{ name: "1uk4" }, { name: "hal" }] })) as typeof fetch;
		try {
			await dataStore.load("/api/wolves", { maxAgeMs: 0 });
		} finally {
			globalThis.fetch = realFetch;
		}
		assert.deepEqual(links(), ["/wolf/1uk4", "/wolf/hal"]);
		dataStore.clear();
	});
	it("/graph renders the graph component", () => {
		assert.equal((GraphPage() as React.ReactElement).type, GraphHome);
	});
	it("the sidebar Graph item and the ⌘G shortcut point at /graph", () => {
		assert.match(read("../../../components/shell/sidebar.tsx"), /href="\/graph"[\s\S]{0,120}data-testid="nav-graph"/);
		assert.match(read("../../../components/shell/keyboard-shortcuts.tsx"), /case "jump-graph":\s*handlersRef\.current\.router\.push\("\/graph"\)/);
	});
});
