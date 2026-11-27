/**
 * The graph page's "Open sidebar" button: shown only while the app sidebar is
 * closed, and a click opens it through the shell's own SidebarProvider state.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
const store = new Map<string, string>();
Object.assign(globalThis, {
	window: Object.assign(dom.window, { innerWidth: 1600 }),
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	Event: dom.window.Event,
	IS_REACT_ACT_ENVIRONMENT: true,
	localStorage: {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
	},
});

const { GraphSidebarOpen } = await import("../../../components/graph/graph-home.tsx");
const { SidebarProvider } = await import("../../../components/shell/sidebar.tsx");

async function mount() {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
			<SidebarProvider>
				<GraphSidebarOpen />
			</SidebarProvider>,
		);
	});
	return host;
}

const button = (host: Element) => host.querySelector('button[aria-label="Open sidebar"]');

describe("graph Open sidebar button", () => {
	beforeEach(() => {
		store.clear();
		document.body.innerHTML = "";
	});

	it("sidebar closed: the button shows, and a click opens the sidebar and hides it", async () => {
		store.set("wolfpack:sidebar-open", "0");
		const host = await mount();
		const btn = button(host);
		assert.ok(btn, "button is shown while the sidebar is closed");
		await act(async () => {
			btn.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
		});
		assert.equal(button(host), null, "hidden once the sidebar is open");
		assert.equal(store.get("wolfpack:sidebar-open"), "1", "the shell persists the open state");
	});

	it("sidebar open: no button", async () => {
		store.set("wolfpack:sidebar-open", "1");
		const host = await mount();
		assert.equal(button(host), null);
	});
});
