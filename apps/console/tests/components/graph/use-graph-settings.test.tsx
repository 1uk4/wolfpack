/**
 * useGraphSettings against the client store: a remount reads the stored render settings without a request,
 * and saving them (PUT) makes the next read go to the server again.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });

const { useGraphSettings } = await import("../../../components/graph/use-graph-settings.ts");
const { dataStore } = await import("../../../src/core/data-store.ts");

let calls: string[] = [];
let change: ReturnType<typeof useGraphSettings>["changeSettings"] | null = null;
let root: Root | null = null;
const realFetch = globalThis.fetch;

function Probe() {
	const s = useGraphSettings();
	change = s.changeSettings;
	return <div data-testid="loaded">{String(s.loaded)}</div>;
}
const mount = async () => {
	root = createRoot(document.body.appendChild(document.createElement("div")));
	await act(async () => root!.render(<Probe />));
	await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
};
const unmount = async () => {
	await act(async () => root!.unmount());
	root = null;
	document.body.innerHTML = "";
};

beforeEach(() => {
	dataStore.clear();
	calls = [];
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		calls.push(`${init?.method ?? "GET"} ${url}`);
		return Response.json({});
	}) as typeof fetch;
});
afterEach(async () => {
	globalThis.fetch = realFetch;
	if (root) await unmount();
});

describe("useGraphSettings with the client store", () => {
	it("a remount reads the stored settings and sends no request", async () => {
		await mount();
		await unmount();
		await mount();
		assert.deepEqual(calls, ["GET /api/graph/render-settings"]);
	});

	it("saving the settings makes the next read refetch them", async () => {
		await mount();
		await act(async () => change!((cur) => ({ ...cur })));
		await act(async () => { await new Promise((r) => setTimeout(r, 500)); });
		await unmount();
		await mount();
		assert.deepEqual(calls, ["GET /api/graph/render-settings", "PUT /api/graph/render-settings", "GET /api/graph/render-settings"]);
	});
});
