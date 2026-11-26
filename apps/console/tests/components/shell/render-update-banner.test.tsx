/**
 * Update-banner render tests (Wave C, 2026-10-10): the banner is a pure
 * function of the last wolfpack:update-status push — hidden without one (the
 * browser/dev world: no desktop bridge at all), visible with the downloaded
 * status, Restart wired to the bridge. The subscribe effect only runs
 * client-side, so the SSR pass pins the hidden state; the pushed state is
 * exercised by mounting with the bridge stubbed (classic-JSX shim as in
 * render-sidebar.test.tsx).
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import * as ReactDOMClient from "react-dom/client";
import { flushSync } from "react-dom";
import { parseHTML } from "linkedom";
import UpdateBanner from "../../../components/shell/update-banner.tsx";
import { AppBridgeContext } from "../../../components/settings/app-bridge.ts";

// linkedom as the DOM for the interactive pass (first createRoot test in
// the repo — the banner's push→render→click flow needs real effects).
// The window.wolfpack bridge type is declared globally by components/shell/sidebar.tsx.
const dom = parseHTML("<html><body></body></html>");
(globalThis as Record<string, unknown>).window = dom.window;
(globalThis as Record<string, unknown>).document = dom.document;

describe("update banner (Wave C)", () => {
	afterEach(() => {
		delete (window as { wolfpack?: unknown }).wolfpack;
	});

	it("renders nothing with no bridge (browser / SSR)", () => {
		const html = renderToStaticMarkup(<UpdateBanner />);
		assert.equal(html, "");
	});

	it("renders nothing when the bridge exists but no status has arrived", () => {
		const listeners: Array<(s: { status: string; version: string | null }) => void> = [];
		(window as { wolfpack?: unknown }).wolfpack = {
			onUpdateStatus: (cb: (s: { status: string; version: string | null }) => void) => {
				listeners.push(cb);
				return () => {};
			},
			installUpdate: () => {},
		};
		const html = renderToStaticMarkup(<UpdateBanner />);
		assert.equal(html, "");
		void listeners;
	});

	it("shows the version + Restart once the downloaded push arrives, and Restart installs", async () => {
		let pushed: ((s: { status: string; version: string | null }) => void) | null = null;
		let installed = 0;
		(window as { wolfpack?: unknown }).wolfpack = {
			onUpdateStatus: (cb: (s: { status: string; version: string | null }) => void) => {
				pushed = cb;
				return () => {};
			},
			installUpdate: () => {
				installed += 1;
			},
		};
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = ReactDOMClient.createRoot(host);
		flushSync(() => root.render(<UpdateBanner />));
		assert.equal(host.innerHTML, "", "hidden before the push");

		await new Promise((r) => setTimeout(r, 0));
		flushSync(() => pushed?.({ status: "downloaded", version: "0.3.1" }));
		assert.equal(host.querySelector("[data-testid='update-banner'] .text-sm")?.textContent, "Wolfpack 0.3.1 is ready, restart to update");
		assert.ok(host.innerHTML.includes("Restart"), "the restart affordance renders");

		const button = host.querySelector<HTMLButtonElement>("[data-testid='update-banner'] button");
		assert.ok(button, "restart button exists");
		button!.click();
		assert.equal(installed, 1, "Restart asks the shell to quit-and-install");
		root.unmount();
		host.remove();
	});

	// work-wolfpack-WIaZh5k: a window opened after the download never gets the push; the app's seeded state is `ready`.
	it("shows the restart banner from the app's seeded ready state when no downloaded push arrived", async () => {
		let installed = 0;
		const bridge = { onUpdateStatus: () => () => {}, getUpdateState: async () => ({ type: "downloaded", version: "0.3.2" }), installUpdate: () => void (installed += 1) };
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = ReactDOMClient.createRoot(host);
		flushSync(() => root.render(<AppBridgeContext.Provider value={bridge as never}><UpdateBanner /></AppBridgeContext.Provider>));
		await new Promise((r) => setTimeout(r, 0));
		await new Promise((r) => setTimeout(r, 0));
		assert.ok(host.innerHTML.includes("0.3.2"), "the version renders");
		host.querySelector<HTMLButtonElement>("[data-testid='update-banner'] button")!.click();
		assert.equal(installed, 1);
		root.unmount();
		host.remove();
	});
});
