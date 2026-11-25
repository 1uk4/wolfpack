/**
 * Seam: the Pack page (components/pack/pack-page.tsx), work-wolfpack-oz3wvq3: /pack/<section> as a full page with the section row on top.
 * Covers: row + active tab + badges, tab and close navigation, the pack-of-one filter, the health-stream hold, and no modal left.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

class FakeEventSource {
	static all: FakeEventSource[] = [];
	onmessage: ((e: { data: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	closed = false;
	constructor(readonly url: string) {
		FakeEventSource.all.push(this);
	}
	close() {
		this.closed = true;
	}
}
const dom = parseHTML("<html><body></body></html>");
const session = new Map<string, string>();
Object.assign(dom.window, {
	setInterval, clearInterval, setTimeout, clearTimeout,
	location: { search: "?healthFixture=issues", pathname: "/pack/machines", origin: "http://localhost:3210" },
	sessionStorage: { getItem: (k: string) => session.get(k) ?? null, setItem: (k: string, v: string) => void session.set(k, v), removeItem: (k: string) => void session.delete(k) },
});
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	Node: dom.window.Node,
	EventSource: FakeEventSource,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
	ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
	fetch: async () => Response.json({}),
});

const { PackPage } = await import("../../../components/pack/pack-page.tsx");
const { getPackHealth } = await import("../../../components/pack/pack-health-store.ts");
const { SingleMacContext } = await import("../../../components/shell/single-mac.tsx");
const { FakeNav, currentUrl } = await import("../../helpers/fake-nav.tsx");

let root: Root | null = null;
const q = (s: string) => document.querySelector(s) as HTMLElement | null;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });
const click = (el: HTMLElement) => act(async () => void el.dispatchEvent(Object.assign(new dom.window.Event("click", { bubbles: true, cancelable: true }), { button: 0 })));
async function mount(section: string, singleMac: boolean | null = null, start = `/pack/${section}`) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () =>
		root!.render(
			<SingleMacContext.Provider value={singleMac}>
				<FakeNav start={start}>
					<PackPage section={section as never} />
				</FakeNav>
			</SingleMacContext.Provider>,
		),
	);
	await flush();
}
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
	session.clear();
});
const openStreams = () => FakeEventSource.all.filter((s) => !s.closed).length;

describe("the Pack page", () => {
	it("shows the section row with the open section marked, its body below, and no modal or side menu", async () => {
		await mount("this-device");
		const labels = [...document.querySelectorAll('[data-testid="pack-tabs"] a')].map((a) => a.textContent?.replace(/\d+( need attention)?$/, ""));
		assert.deepEqual(labels, ["Machines", "Devices", "Wolves", "Domains", "Keys", "This device"]);
		assert.equal(q('[data-testid="pack-tab-this-device"]')!.getAttribute("aria-current"), "page");
		assert.equal(q('[data-testid="pack-tab-machines"]')!.getAttribute("aria-current"), null);
		assert.notEqual(q('[data-testid="this-device-keyboard"]'), null);
		assert.equal(q('[data-testid="pack-health-modal"]'), null);
		assert.equal(q('[data-testid^="pack-menu-"]'), null);
	});

	it("shows the machines badge in the row when a machine has a problem", async () => {
		await mount("keys");
		await flush();
		assert.match(q('[data-testid="pack-badge-machines"]')?.textContent ?? "", /^2/); // the issues fixture has two problem machines
	});

	it("the badge's accessible name is hidden text inside the link, e.g. \"2 need attention\"", async () => {
		await mount("keys");
		const badge = q('[data-testid="pack-badge-machines"]')!;
		assert.equal(badge.getAttribute("aria-label"), null);
		assert.match(badge.querySelector(".sr-only")?.textContent ?? "", /^\d+ need attention$/);
	});

	const esc = (target: Element = document.body) => act(async () => void target.dispatchEvent(Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), { key: "Escape" })));
	it("Escape goes to the return path, but not while typing, with a dialog open, or with a viewer panel open; the close button's title says Esc", async () => {
		session.set("wp.pack.return", "/work?x=1");
		await mount("machines");
		assert.equal(q('[data-testid="pack-close"]')!.getAttribute("title"), "Close (Esc)");
		const input = document.createElement("input");
		document.body.appendChild(input);
		await esc(input);
		assert.equal(currentUrl(), "/pack/machines");
		input.remove();
		const dialog = document.createElement("div");
		dialog.setAttribute("role", "dialog");
		document.body.appendChild(dialog);
		await esc();
		assert.equal(currentUrl(), "/pack/machines");
		dialog.remove();
		const viewer = document.createElement("div");
		viewer.setAttribute("data-testid", "viewer-panel");
		document.body.appendChild(viewer);
		await esc();
		assert.equal(currentUrl(), "/pack/machines");
		viewer.remove();
		await esc();
		assert.equal(currentUrl(), "/work?x=1");
	});

	it("a tab navigates to /pack/<section> as a new history entry", async () => {
		await mount("machines");
		await click(q('[data-testid="pack-tab-keys"]')!);
		assert.equal(currentUrl(), "/pack/keys");
	});

	it("the active section's tab goes back to the section list from a page below it, such as a wolf page", async () => {
		await mount("wolves", null, "/pack/wolves/mac/hal");
		assert.equal(q('[data-testid="pack-tab-wolves"]')!.getAttribute("aria-current"), "page");
		await click(q('[data-testid="pack-tab-wolves"]')!);
		assert.equal(currentUrl(), "/pack/wolves");
		await click(q('[data-testid="pack-tab-wolves"]')!);
		assert.equal(currentUrl(), "/pack/wolves");
	});

	it("the close button goes back to the page you came from, or / when there is none", async () => {
		session.set("wp.pack.return", "/work?x=1");
		await mount("machines");
		await click(q('[data-testid="pack-close"]')!);
		assert.equal(currentUrl(), "/work?x=1");
		await act(async () => root?.unmount());
		document.body.innerHTML = "";
		session.clear();
		await mount("machines");
		await click(q('[data-testid="pack-close"]')!);
		assert.equal(currentUrl(), "/");
	});

	it("stores a same-origin ?from= as the close-button return path and strips it from the URL; a foreign from is ignored", async () => {
		await mount("keys", null, "/pack/keys?from=%2Fwork%3Fx%3D1");
		assert.equal(session.get("wp.pack.return"), "/work?x=1");
		assert.equal(currentUrl(), "/pack/keys");
		await act(async () => root?.unmount());
		document.body.innerHTML = "";
		session.clear();
		await mount("keys", null, "/pack/keys?from=%2F%2Fevil.com");
		assert.equal(session.get("wp.pack.return"), undefined);
		assert.equal(currentUrl(), "/pack/keys");
	});

	it("the desktop app's pack of one has no Devices or This device, and a link to one of them shows Machines", async () => {
		await mount("devices", true);
		assert.equal(q('[data-testid="pack-tab-devices"]'), null);
		assert.equal(q('[data-testid="pack-tab-this-device"]'), null);
		assert.equal(currentUrl(), "/pack/machines");
	});

	it("holds the health stream while the page is mounted and releases it on unmount", async () => {
		(window.location as { search: string }).search = ""; // live stream, not the fixture
		try {
			const before = openStreams();
			await mount("machines");
			assert.equal(openStreams(), before + 1);
			assert.equal(getPackHealth().held, true);
			await act(async () => root?.unmount());
			root = null;
			assert.equal(openStreams(), before);
			assert.equal(getPackHealth().held, false);
		} finally {
			(window.location as { search: string }).search = "?healthFixture=issues";
		}
	});
});
