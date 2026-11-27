import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	Event: dom.window.Event,
	IS_REACT_ACT_ENVIRONMENT: true,
	ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
});
// linkedom does not track focus: record it so document.activeElement answers like a browser.
let focused: Element | null = null;
(dom.window.HTMLElement.prototype as any).focus = function () { focused = this; };
Object.defineProperty(dom.document, "activeElement", { get: () => focused, configurable: true });

const { BarSettings } = await import("../../../components/chat-bar/bar-settings.tsx");

let failGet = false;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
	if (init?.method === "PUT") return Response.json({ tier: "main", autoShip: true });
	return failGet ? new Response("{}", { status: 500 }) : Response.json({ tier: "main", autoShip: false });
}) as typeof fetch;

let root: Root | null = null;
const flush = () => act(async () => void (await Promise.all([1, 2, 3, 4].map(() => new Promise((r) => setImmediate(r))))));
const q = (s: string) => document.querySelector(s) as HTMLElement | null;
const props = (el: HTMLElement, name: string) => (el as any)[Object.keys(el).find((k) => k.startsWith("__reactProps$"))!][name];
async function mount(phone = false) {
	const host = document.body.appendChild(document.createElement("div"));
	root = createRoot(host);
	await act(async () => root!.render(<BarSettings wolf="1uk4" slug="home" phone={phone} buttonClass="gear" />));
	await act(async () => void props(q('[data-testid="chat-bar-settings"]')!, "onClick")({}));
	await flush();
}
const fire = (target: EventTarget, type: string, extra: object = {}) =>
	act(async () => {
		const ev = new dom.window.Event(type, { bubbles: true, cancelable: true });
		Object.assign(ev, extra);
		target.dispatchEvent(ev);
	});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
	failGet = false;
	focused = null;
});
after(() => void (globalThis.fetch = realFetch));

describe("the floating chat's settings menu", () => {
	it("moves focus into the dialog on open, and Escape closes it and gives focus back to the gear", async () => {
		await mount();
		const menu = q('[data-testid="chat-bar-settings-menu"]')!;
		assert.ok(menu.contains(focused), "focus is inside the dialog");
		await fire(document, "keydown", { key: "Escape" });
		assert.equal(q('[data-testid="chat-bar-settings-menu"]'), null);
		assert.equal(focused, q('[data-testid="chat-bar-settings"]'));
	});

	it("a press outside closes it and gives focus back to the gear", async () => {
		await mount();
		await fire(document.body, "pointerdown");
		assert.equal(q('[data-testid="chat-bar-settings-menu"]'), null);
		assert.equal(focused, q('[data-testid="chat-bar-settings"]'));
	});

	it("says it couldn't load the settings when the wolf can't be read, instead of a disabled switch", async () => {
		failGet = true;
		await mount();
		assert.equal(q('[data-testid="bar-settings-load-failed"]')?.textContent?.trim(), "Couldn't load settings");
		assert.equal(q('[data-testid="toggle-auto-ship-tasks"]'), null);
	});

	it("on the phone sheet, Tab from the last control wraps to the first instead of leaving the sheet", async () => {
		await mount(true);
		const sw = q('[data-testid="toggle-auto-ship-tasks"]')!;
		focused = sw;
		let prevented = false;
		await act(async () => void props(q('[data-testid="chat-bar-settings-menu"]')!, "onKeyDown")({ key: "Tab", shiftKey: false, preventDefault: () => void (prevented = true) }));
		assert.equal(prevented, true);
		assert.equal(focused, sw, "the switch is the only control: Tab lands back on it");
	});
});
