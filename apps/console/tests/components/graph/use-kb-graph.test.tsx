/**
 * useKbGraph against the client store: a page mounted while the store holds a young graph renders it on the first
 * render (no loading flash, no request); a stale one shows the old graph and sends one revalidating request.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });

const { useKbGraph } = await import("../../../components/graph/use-kb-graph.ts");
const { dataStore } = await import("../../../src/core/data-store.ts");

const graph = { nodes: [{ id: "dom:d", kind: "domain", label: "D", depth: 0, domain: "d" }], edges: [] };
let urls: string[] = [];
const realFetch = globalThis.fetch;
let root: Root | null = null;
const firstRender: string[] = [];

function Probe() {
	const g = useKbGraph(false, {});
	if (firstRender.length === 0) firstRender.push(`${g.status}:${g.graph?.nodes.length ?? 0}`);
	return <div data-testid="s">{g.status}</div>;
}

beforeEach(() => {
	dataStore.clear();
	urls = [];
	firstRender.length = 0;
	globalThis.fetch = (async (input: string) => {
		urls.push(input);
		return Response.json(graph);
	}) as typeof fetch;
});
afterEach(async () => {
	globalThis.fetch = realFetch;
	if (root) await act(async () => root!.unmount());
	root = null;
	document.body.innerHTML = "";
});

const mount = async () => {
	root = createRoot(document.body.appendChild(document.createElement("div")));
	await act(async () => root!.render(<Probe />));
};

describe("useKbGraph with the client store", () => {
	it("a warm mount renders the stored graph on the first render and sends no request", async () => {
		await dataStore.load("/api/kb/graph", { maxAgeMs: 0 });
		urls = [];
		await mount();
		assert.deepEqual(firstRender, ["ready:1"]);
		assert.deepEqual(urls, []);
	});

	it("a cold mount starts loading and sends one request", async () => {
		await mount();
		assert.deepEqual(firstRender, ["loading:0"]);
		assert.equal(urls.length, 1);
	});
});
