/** SessionsSidebar refresh triggers (real mount, stubbed fetch): open and events refresh the list; navigating does not. */
import React, { act, useEffect } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
const mem = new Map<string, string>();
const localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
Object.assign(globalThis, {
	window: Object.assign(dom.window, { localStorage, location: { search: "" } }),
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
	ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
	self: globalThis,
});
Object.assign(dom.window.Element.prototype, { attachEvent() {}, detachEvent() {} });

const { ServerEventsProvider } = await import("../../../components/shell/server-events.tsx");
const { SidebarProvider, SessionsSidebar } = await import("../../../components/shell/sidebar.tsx");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
const { PathnameContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime.js");
const { kbdEventForAction } = await import("../../../src/core/index.ts");

let gets: string[] = [];
const handlers = new Map<string, (d: string) => void>();
const fakeSource = () => ({ close() {}, onOpen() {}, onEvent: (n: string, cb: (d: string) => void) => void handlers.set(n, cb) });
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL) => {
	const url = String(input);
	gets.push(url);
	if (url === "/api/wolves") return Response.json({ wolves: [{ name: "w" }] });
	if (url === "/api/wolves/w/threads") return Response.json({ threads: [{ id: "w/a", title: "a", kind: "feature", status: "idle" }] });
	return new Response("{}", { status: 404 });
}) as typeof fetch;
after(() => void (globalThis.fetch = realFetch));

/* Like Next's real router, the router object is stable across navigations (the shared FakeNav rebuilds it every render, which
   would re-run router-keyed effects such as the needs-you loader and mask what this test checks). */
let push: (h: string) => void = () => {};
function Nav({ children }: { children: React.ReactNode }) {
	const [path, setPath] = React.useState("/");
	const router = React.useRef({ push: (h: string) => setPath(h), replace: (h: string) => setPath(h), prefetch() {}, back() {}, forward() {}, refresh() {} }).current;
	useEffect(() => void (push = router.push), [router]);
	return (
		<AppRouterContext.Provider value={router as never}>
			<PathnameContext.Provider value={path}>{children}</PathnameContext.Provider>
		</AppRouterContext.Provider>
	);
}

let root: Root | null = null;
const wait = (ms = 60) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const listFetches = () => gets.filter((u) => u === "/api/wolves" || u.endsWith("/threads")).length;
async function mount() {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(
			<Nav>
				<ServerEventsProvider connect={fakeSource}>
					<SidebarProvider>
						<SessionsSidebar />
					</SidebarProvider>
				</ServerEventsProvider>
			</Nav>,
		);
	});
	await wait();
}
const toggle = () => act(async () => void window.dispatchEvent(new dom.window.CustomEvent(kbdEventForAction("toggle-sidebar"))));

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
	mem.clear();
	gets = [];
	handlers.clear();
});

describe("SessionsSidebar refresh", () => {
	it("navigating between pages does not refetch the wolves roster or threads lists", async () => {
		await mount();
		assert.ok(listFetches() >= 2, "the list loads on first open");
		gets = [];
		for (const to of ["/graph", "/kb-activity", "/work", "/"]) {
			await act(async () => push(to));
			await wait(20);
		}
		assert.deepEqual(gets, []);
	});

	it("a turn-settled event refreshes the list once", async () => {
		await mount();
		gets = [];
		await act(async () => void handlers.get("turn-settled")?.("{}"));
		await wait(100);
		assert.deepEqual(gets, ["/api/wolves", "/api/wolves/w/threads"]);
	});

	it("opening the closed sidebar refreshes the list once", async () => {
		await mount();
		await toggle(); // close
		await wait(20);
		gets = [];
		await toggle(); // open
		await wait(60);
		assert.deepEqual(gets, ["/api/wolves", "/api/wolves/w/threads"]);
	});
});
