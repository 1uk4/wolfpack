/** The thread-row needs-you mark, the notify toggle, and the headless notifier (the sidebar has no Needs-you section). */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { NeedsYouNotifier, NotifyToggleView } from "../components/needs-you.tsx";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { ServerEventsProvider } from "../components/server-events.tsx";
import { SessionRow } from "../components/sidebar.tsx";
import { threadListItem, type NeedsYouItem } from "../src/core/index.ts";

const noop = () => {};

describe("thread row", () => {
	it("a needs-you thread shows the dot and says so; an idle one has none", () => {
		const row = (status: "idle" | "needs-you" | "busy") =>
			renderToStaticMarkup(<SessionRow chat={threadListItem("1uk4", { id: "1uk4/home", title: "Home", status })} active={false} onOpen={noop} />);
		const needs = row("needs-you");
		assert.ok(needs.includes('data-testid="needs-you-dot"'));
		assert.ok(needs.includes("needs you"));
		assert.ok(!row("idle").includes("needs-you-dot"));
		assert.ok(!row("busy").includes("needs-you-dot"), "busy shows the spinner instead");
	});
});

describe("NotifyToggleView", () => {
	const view = (state: "unsupported" | "off" | "on" | "denied") => renderToStaticMarkup(<NotifyToggleView state={state} onToggle={noop} />);
	it("is hidden where notifications are unsupported (Electron has its own)", () => {
		assert.equal(view("unsupported"), "");
	});
	it("offers 'Notify me' when off and shows on-state when on", () => {
		assert.ok(view("off").includes("Notify me") && !view("off").includes("disabled"));
		assert.match(view("on"), /aria-pressed="true"/);
	});
	it("explains a blocked permission and disables the button", () => {
		const html = view("denied");
		assert.ok(html.includes('data-testid="needs-you-notify-denied"') && html.includes("blocked in your browser"));
		assert.match(html, /disabled/);
	});
});

describe("sidebar without the pinned section", () => {
	// A cheap tripwire against the panel coming back; the notifier's behaviour is covered by its own mount test below.
	it("carries no Needs-you section markup", () => {
		const src = readFileSync(new URL("../components/sidebar.tsx", import.meta.url), "utf8");
		assert.ok(!src.includes("NeedsYouPanel") && !src.includes("NeedsYouSection"));
		assert.ok(!src.includes('data-testid="needs-you"') && !src.includes("needs-you-count"));
	});
});

describe("NeedsYouNotifier (headless)", () => {
	it("fetches /api/needs-you and notifies once per newly waiting card, refetching on a poke", async () => {
		const dom = parseHTML("<html><body></body></html>");
		const notified: { key: string; href: string }[] = [];
		const win = dom.window as unknown as Record<string, unknown>;
		win.lh = { notify: (n: { key: string; href: string }) => notified.push(n) };
		const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
		const saved = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch, IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT };
		Object.assign(globalThis, { window: dom.window, document: Object.assign(dom.document, { hasFocus: () => false }), IS_REACT_ACT_ENVIRONMENT: true });
		const waiting: NeedsYouItem = {
			wolf: "1uk4",
			threadId: "1uk4/home",
			threadTitle: "Home",
			slug: "home",
			href: "/wolf/1uk4/thread/home",
			callId: "c1",
			card: { tool: "ask_user_question", fields: [{ id: "answer", kind: "free-text", label: "Which branch?" }] },
			raisedAt: "2026-10-26T10:00:00.000Z",
		};
		let fetches = 0;
		let listed: NeedsYouItem[] = []; // the first snapshot only primes: nothing notifies until a card newly appears
		globalThis.fetch = (async () => {
			fetches++;
			return new Response(JSON.stringify({ items: listed, responded: ["1uk4"], wolves: ["1uk4"] }), { status: 200 });
		}) as typeof fetch;
		let poke: ((d: string) => void) | undefined;
		const source = () => ({ close() {}, onOpen() {}, onEvent: (name: string, cb: (d: string) => void) => void (name === "needs-you-changed" && (poke = cb)) });
		const host = dom.document.createElement("div");
		dom.document.body.appendChild(host);
		const root = createRoot(host as unknown as Element);
		const settle = (ms = 250) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
		try {
			await act(async () => {
				root.render(
					<AppRouterContext.Provider value={{ push() {} } as never}>
						<ServerEventsProvider connect={source}>
							<NeedsYouNotifier />
						</ServerEventsProvider>
					</AppRouterContext.Provider>,
				);
			});
			await settle();
			assert.equal(host.innerHTML, "", "no visible UI");
			assert.ok(fetches >= 1);
			assert.equal(notified.length, 0, "the first snapshot only primes");
			listed = [waiting];
			const before = fetches;
			await act(async () => poke!(JSON.stringify({ wolf: "1uk4" })));
			await settle();
			assert.ok(fetches > before, "a poke refetches");
			assert.equal(notified.length, 1);
			assert.equal(notified[0]!.href, waiting.href);
			await act(async () => poke!(JSON.stringify({ wolf: "1uk4" })));
			await settle();
			assert.equal(notified.length, 1, "the same card does not notify twice");
		} finally {
			await act(async () => root.unmount());
			Object.assign(globalThis, saved);
		}
	});
});
