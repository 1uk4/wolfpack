/** Kind "frame": sandboxed iframe attributes, CSP-first srcdoc, reload, rev refetch, file-gone state, descriptor validation. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	Node: dom.window.Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const { FrameViewRenderer } = await import("../../../components/viewer/renderers/frame-view.tsx");
const { ViewerActionsContext } = await import("../../../components/viewer/viewer-actions.ts");
const { parseFrameDescriptor } = await import("../../../components/viewer/view-descriptor.ts");

let root: Root | null = null;
let calls: string[] = [];
let reply: { status: number; body: string } = { status: 200, body: "<p>hi</p>" };
const realFetch = globalThis.fetch;
beforeEach(() => {
	calls = [];
	reply = { status: 200, body: "<p>hi</p>" };
	globalThis.fetch = (async (url: string) => {
		calls.push(String(url));
		return new Response(reply.body, { status: reply.status });
	}) as typeof fetch;
});
afterEach(() => {
	act(() => root?.unmount());
	root = null;
	document.body.innerHTML = "";
	globalThis.fetch = realFetch;
});

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
const desc = (rev?: number) => ({ kind: "frame", id: "viz/a.html", wolf: "hal", ...(rev === undefined ? {} : { rev }) });
let reloadFn: (() => void) | null = null;
const actions = { setReload: (fn: (() => void) | null) => void (reloadFn = fn) };
async function mount(rev?: number) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	const render = (r?: number) =>
		act(async () =>
			root!.render(
				<ViewerActionsContext.Provider value={actions}>
					<FrameViewRenderer descriptor={desc(r)} onPush={() => {}} onTitle={() => {}} onClose={() => {}} />
				</ViewerActionsContext.Provider>,
			),
		);
	await render(rev);
	await flush();
	return render;
}
const iframe = () => document.querySelector("iframe") as HTMLElement | null;
// linkedom keeps the case React writes (srcDoc); a browser lowercases, so compare case-insensitively.
const attr = (el: HTMLElement, name: string) => Array.from((el as unknown as { attributes: ArrayLike<{ name: string; value: string }> }).attributes).find((a) => a.name.toLowerCase() === name)?.value ?? null;

describe("frame renderer", () => {
	it("loads the file in an iframe sandboxed to scripts only, with the CSP meta before the author's head and meta", async () => {
		reply.body = '<html><head><meta charset="utf-8"><script>1</script></head><body>x</body></html>';
		await mount();
		const f = iframe()!;
		assert.equal(f.getAttribute("sandbox"), "allow-scripts");
		assert.equal(attr(f, "referrerpolicy"), "no-referrer");
		const doc = attr(f, "srcdoc")!;
		assert.ok(
			doc.startsWith(`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:">`),
		);
		assert.ok(doc.endsWith(reply.body));
		assert.deepEqual(calls, ["/api/wolves/hal/frame-file?path=viz%2Fa.html"]);
	});

	it("Reload (the header action) refetches the file", async () => {
		await mount();
		reply.body = "<p>new</p>";
		await act(async () => reloadFn!());
		await flush();
		assert.equal(calls.length, 2);
		assert.ok(attr(iframe()!, "srcdoc")!.endsWith("<p>new</p>"));
	});

	it("a new show_view rev for the same object refetches", async () => {
		const render = await mount(1);
		await render(1);
		await flush();
		assert.equal(calls.length, 1);
		await render(2);
		await flush();
		assert.equal(calls.length, 2);
	});

	it("a missing file shows the file-gone state with a Reload that retries", async () => {
		reply = { status: 404, body: "{}" };
		await mount();
		const err = document.querySelector('[data-testid="frame-error"]')!;
		assert.equal(err.getAttribute("data-gone"), "true");
		assert.match(err.textContent ?? "", /gone/);
		assert.equal(iframe(), null);
		reply = { status: 200, body: "<p>back</p>" };
		await act(async () => (err.querySelector("button") as HTMLElement).click());
		await flush();
		assert.ok(attr(iframe()!, "srcdoc")!.endsWith("<p>back</p>"));
	});
});

describe("frame descriptor", () => {
	it("accepts wolf + path (or id), keeps title and rev, and fills a missing wolf from the host", () => {
		assert.deepEqual(parseFrameDescriptor({ kind: "frame", wolf: "hal", path: "a.html", title: "A", rev: 3 }), { kind: "frame", id: "a.html", wolf: "hal", title: "A", rev: 3 });
		assert.deepEqual(parseFrameDescriptor({ kind: "frame", id: "a.html" }, "jack"), { kind: "frame", id: "a.html", wolf: "jack" });
	});
	it("rejects other kinds, a missing path or wolf, and non-objects", () => {
		assert.equal(parseFrameDescriptor({ kind: "kb", wolf: "hal", path: "a.html" }), null);
		assert.equal(parseFrameDescriptor({ kind: "frame", wolf: "hal", path: "" }), null);
		assert.equal(parseFrameDescriptor({ kind: "frame", path: "a.html" }), null);
		assert.equal(parseFrameDescriptor("frame"), null);
	});
});
