/** The /work page hosts a page viewer (scope "work", kinds work + kb): row clicks open the viewer, modified clicks navigate, ?view= restores. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<!doctype html><html><body></body></html>");
(globalThis as Record<string, unknown>).self ??= globalThis;
const ls = new Map<string, string>();
const storage = { getItem: (k: string) => ls.get(k) ?? null, setItem: (k: string, v: string) => void ls.set(k, v), removeItem: (k: string) => void ls.delete(k) };
Object.assign(globalThis, {
	window: Object.assign(dom.window, { localStorage: storage, location: { pathname: "/work", search: "", href: "/work" } }),
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	HTMLInputElement: dom.window.HTMLInputElement,
	HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
	KeyboardEvent: dom.window.KeyboardEvent,
	Node: dom.window.Node,
	Event: dom.window.Event,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	localStorage: storage,
	requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
	ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
});

const { default: WorkPage } = await import("../../../app/work/page.tsx");
const { default: KbWorkPage } = await import("../../../app/kb/work/[id]/page.tsx");
const { WorkList } = await import("../../../components/work/work-view.tsx");
const { PageViewer } = await import("../../../components/viewer/page-viewer.tsx");
const { registerViewRenderer } = await import("../../../components/viewer/registry.tsx");
const vs = await import("../../../components/viewer/viewer-store.ts");
const { FakeNav, currentUrl } = await import("../../helpers/fake-nav.tsx");
import type { WorkClient } from "../../../components/work/work-client.ts";

registerViewRenderer("work", () => <div>work body</div>);
registerViewRenderer("kb", () => <div>kb body</div>);

const client: WorkClient = {
	domains: async () => [{ name: "wolfpack", label: "Wolfpack" }],
	list: async () => ({ ok: true, data: { items: [{ id: "i1", title: "Phase 1", kind: "initiative", stage: "plan", domain: "wolfpack", dependsOn: [] }] } }) as never,
};

let root: Root | null = null;
const q = (s: string) => document.querySelector(s) as HTMLElement | null;
const ev = (type: string, init: Record<string, unknown> = {}) => Object.assign(new dom.window.Event(type, { bubbles: true, cancelable: true }), { button: 0, detail: 1, ...init });
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
async function mount(start: string, node: React.ReactNode) {
	const el = document.createElement("div");
	document.body.appendChild(el);
	root = createRoot(el);
	await act(async () => root!.render(<FakeNav start={start}>{node}</FakeNav>));
	await settle();
}
const page = (
	<PageViewer scope="work" allowedKinds={["work", "kb"]}>
		<WorkList client={client} />
	</PageViewer>
);

beforeEach(() => {
	(dom.window as unknown as Record<string, unknown>).matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
	(globalThis as Record<string, unknown>).fetch = async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => "" });
});
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
	ls.clear();
	vs.resetViewerCache();
});

describe("the /work page viewer", () => {
	it("a plain click on a row opens the item in the viewer instead of the ?item= reader", async () => {
		await mount("/work", page);
		await act(async () => void q('[data-testid="work-open-i1"]')!.dispatchEvent(ev("click")));
		assert.deepEqual(vs.getViewerState("page", "work").stack, [{ kind: "work", id: "i1" }]);
		assert.equal(currentUrl().includes("item="), false);
	});

	it("a ctrl/cmd-click on a row navigates to the full page and opens nothing", async () => {
		await mount("/work", page);
		await act(async () => void q('[data-testid="work-open-i1"]')!.dispatchEvent(ev("click", { ctrlKey: true })));
		assert.equal(currentUrl(), "/kb/work/i1");
		assert.deepEqual(vs.getViewerState("page", "work").stack, []);
	});

	it("?view=work:<id> on load opens the viewer on that item", async () => {
		await mount("/work?view=work%3Ai1", page);
		assert.equal(q('[data-testid="viewer-title"]')!.textContent, "i1");
	});

	it("the /work route mounts a page viewer with scope work that allows work and kb but nothing else", async () => {
		await mount("/work?view=kb%3Ae1", <WorkPage />);
		assert.equal(q('[data-testid="viewer-title"]')!.textContent, "e1");
		assert.deepEqual(vs.getViewerState("page", "work").stack, [{ kind: "kb", id: "e1" }]);
		await act(async () => root!.unmount());
		document.body.innerHTML = "";
		vs.resetViewerCache();
		await mount("/work?view=prompt%3Ap1", <WorkPage />);
		assert.equal(q('[data-testid="viewer-panel"]'), null);
	});

	it("the full work page route still renders the item page", async () => {
		await mount("/kb/work/i1", await KbWorkPage({ params: Promise.resolve({ id: "i1" }) }));
		assert.notEqual(document.body.innerHTML, "");
	});
});
