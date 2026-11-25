/** WorkItemView hosted in the viewer shell: the shell owns the chrome, the page keeps badges and body and reports its title. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<!doctype html><html><body></body></html>");
(globalThis as Record<string, unknown>).self ??= globalThis;
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	Event: dom.window.Event,
	IS_REACT_ACT_ENVIRONMENT: true,
	fetch: async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => "" }),
});

const { FakeNav } = await import("../../helpers/fake-nav.tsx");
const { WorkItemView } = await import("../../../components/work/work-item-page.tsx");

let root: Root | null = null;
afterEach(() => {
	act(() => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});

const item = { id: "t1", title: "Real title", kind: "task", stage: "plan", domain: "wolfpack", plan: "p", record: "body text", children: [] } as never;

async function mount(el: React.ReactElement) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => root!.render(<FakeNav start="/wolf/hal/thread/t1">{el}</FakeNav>));
}

describe("WorkItemView hosted with chrome none", () => {
	it("draws no title bar, Full page link or page-level close, keeps the body", async () => {
		await mount(<WorkItemView id="t1" chrome="none" state={{ kind: "ready", item, parent: null }} onClose={() => {}} />);
		assert.equal(document.querySelector('[data-testid="work-reader-full"]'), null);
		assert.equal(document.querySelector('[data-testid="work-reader-close"]'), null);
		assert.equal(document.querySelector("h1"), null);
		assert.match(document.body.textContent ?? "", /body text/);
	});

	it("reports the loaded item title through onTitle, and again when it changes", async () => {
		const titles: string[] = [];
		const view = (title: string) => <WorkItemView id="t1" chrome="none" onTitle={(t) => titles.push(t)} state={{ kind: "ready", item: { ...(item as object), title } as never, parent: null }} />;
		await mount(view("Real title"));
		await act(async () => root!.render(<FakeNav start="/wolf/hal/thread/t1">{view("Renamed")}</FakeNav>));
		assert.deepEqual(titles, ["Real title", "Renamed"]);
	});
});
