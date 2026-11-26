/** "More details" of a graduation opens the Viewer panel when the host allows kind graduation, and keeps its link otherwise. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
const mem = new Map<string, string>();
Object.assign(dom.window, { localStorage: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) } });
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	Node: dom.window.Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const { MultiRenderer } = await import("../../../components/ask/card-fields/multi.tsx");
const { ViewerProvider } = await import("../../../components/viewer/viewer-context.tsx");
const { pageHost } = await import("../../../components/viewer/viewer-host.ts");
const { getViewerState, resetViewerCache } = await import("../../../components/viewer/viewer-store.ts");

const HREF = "/work/work-wolfpack-F1?view=graduation&wolf=hal";
const field = { kind: "multi", options: [{ label: "Graduate F1", value: "F1", href: HREF }] } as never;
let root: Root | null = null;
beforeEach(() => {
	mem.clear();
	resetViewerCache();
});
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});

async function clickMore(kinds: readonly string[]) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	const props = { field, value: { value: [] }, onChange: () => {}, labelledBy: "x", typed: "", onType: () => {} } as unknown as Parameters<typeof MultiRenderer>[0];
	await act(async () =>
		root!.render(
			<ViewerProvider host={pageHost("work", kinds)}>
				<MultiRenderer {...props} />
			</ViewerProvider>,
		),
	);
	const a = document.querySelector('[data-testid="card-option-link"]') as HTMLElement;
	const e = new dom.window.Event("click", { bubbles: true, cancelable: true });
	Object.assign(e, { button: 0 });
	await act(async () => void a.dispatchEvent(e));
	return e.defaultPrevented;
}

describe("graduation More details link", () => {
	it("opens the graduation view (id item@wolf) in a host that allows it", async () => {
		assert.equal(await clickMore(["work", "graduation"]), true);
		assert.deepEqual(getViewerState("page", "work").stack.map((d) => `${d.kind}:${d.id}`), ["graduation:work-wolfpack-F1@hal"]);
	});

	it("keeps the link's own navigation in a host that does not allow it", async () => {
		assert.equal(await clickMore(["work", "kb"]), false);
		assert.deepEqual(getViewerState("page", "work").stack, []);
	});
});
