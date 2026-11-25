/** KB entry hosted in the viewer shell: no page chrome, no Esc of its own, entry links push onto the viewer stack, title reported. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const ENTRY = {
	id: "e1",
	title: "Entry One",
	domain: "wolfpack",
	frontmatter: { maturity: "stable", authority: "curated", kind: "concept" },
	body: "Hello [[e2|Two]] and [raw](/kb/entry/e5) and [ext](https://e.com).\n",
	wikilinks: [{ target: "e2", exists: true }],
	backlinks: [],
};

const dom = parseHTML("<!doctype html><html><body></body></html>");
(globalThis as Record<string, unknown>).self ??= globalThis;
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	Event: dom.window.Event,
	IS_REACT_ACT_ENVIRONMENT: true,
	fetch: async () => ({ ok: true, status: 200, json: async () => ENTRY, text: async () => JSON.stringify(ENTRY) }),
});

const { FakeNav, navLog } = await import("../../helpers/fake-nav.tsx");
const { KbEntryViewRenderer } = await import("../../../components/viewer/renderers/kb-entry-view.tsx");

let root: Root | null = null;
afterEach(() => {
	act(() => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});

const pushed: unknown[] = [];
const titles: string[] = [];
async function mount() {
	pushed.length = 0;
	titles.length = 0;
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () =>
		root!.render(
			<FakeNav start="/wolf/hal/thread/t1">
				<KbEntryViewRenderer descriptor={{ kind: "kb", id: "e1" }} onPush={(d) => pushed.push(d)} onTitle={(t) => titles.push(t)} onClose={() => {}} />
			</FakeNav>,
		),
	);
}
const click = (a: Element, init: Record<string, unknown> = {}) => {
	const ev = new dom.window.Event("click", { bubbles: true, cancelable: true });
	Object.assign(ev, { button: 0, ...init });
	act(() => void a.dispatchEvent(ev));
	return ev;
};
const anchor = (href: string) => document.querySelector(`a[href="${href}"]`)!;

describe("KB entry hosted in the viewer", () => {
	it("renders the body without page chrome and reports the title", async () => {
		await mount();
		assert.equal(document.querySelector("h1"), null);
		assert.equal(document.querySelector('[data-testid="entry-open-in-graph"]'), null);
		assert.match(document.body.textContent ?? "", /Hello/);
		assert.deepEqual(titles, ["Entry One"]);
	});

	it("leaves Esc to the viewer: no router.back from the entry", async () => {
		await mount();
		const before = navLog.index;
		const ev = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
		Object.assign(ev, { key: "Escape" });
		act(() => void window.dispatchEvent(ev));
		assert.equal(navLog.index, before);
		assert.equal(ev.defaultPrevented, false);
	});

	it("pushes entry links onto the viewer stack instead of navigating; leaves external and modified clicks alone", async () => {
		await mount();
		const e = click(anchor("/kb/entry/e2"));
		click(anchor("/kb/entry/e5"));
		click(anchor("/kb/entry/e5"), { metaKey: true });
		const ext = click(anchor("https://e.com/"));
		assert.deepEqual(pushed, [{ kind: "kb", id: "e2" }, { kind: "kb", id: "e5" }]);
		assert.equal(e.defaultPrevented, true);
		assert.equal(ext.defaultPrevented, false);
		assert.equal(navLog.stack.length, 1);
	});
});
