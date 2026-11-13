/**
 * Messages a sub-agent delivered to its parent: parsed from the steer text, rendered collapsed with their own title.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
	ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
	getComputedStyle: () => ({ animationName: "none" }),
});

const { MockConsoleClient, FIXTURE_THREAD, NotFoundError } = await import("@wolfpack/client");
type Card = import("@wolfpack/client").Card;
type CardAnswers = import("@wolfpack/client").CardAnswers;
type ThreadDetail = import("@wolfpack/client").ThreadDetail;
const { createThreadApi } = await import("../../../src/server/thread/thread-api.ts");
const { cardsOfThread, threadMessagesToNative } = await import("../../../src/core/index.ts");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
const { ThreadChat } = await import("../../../components/thread/thread-chat.tsx");
const { MemoryEventsProvider } = await import("../../../components/memory/memory-events.tsx");
const { ServerEventsProvider } = await import("../../../components/shell/server-events.tsx");
/** The notification channel's source: tests fire named frames through `frames`. */
const frames = new Map<string, (data: string) => void>();
const eventsSource = () => ({
	close() {},
	onOpen() {},
	onEvent(name: string, cb: (data: string) => void) {
		frames.set(name, cb);
	},
});
const inertSource = () => ({ close() {}, onOpen() {}, onMessage() {}, onError() {} });

const { SubagentModalProvider } = await import("../../../components/thread/subagent-modal.tsx");
const msg = (id: string, role: "user" | "assistant", text: string, extra: object = {}) => ({ id, role, text, at: "2026-10-27T10:00:00.000Z", ...extra });
const SUMMARY = "## Goal\n\nShip the **divider**";
const compacted = msg("entry-9", "assistant", "", { compaction: { summary: SUMMARY, reason: "manual" } });

let root: Root | null = null;
const realFetch = globalThis.fetch;
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	globalThis.fetch = realFetch;
	document.body.innerHTML = "";
});
after(() => {
	globalThis.fetch = realFetch;
});
const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;

async function mount(messages: unknown[]) {
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		void input;
		return new Response("{}", { status: 404 });
	}) as typeof fetch;
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(
			<AppRouterContext.Provider value={{ push() {} } as never}>
				<>
					<ServerEventsProvider connect={eventsSource}>
						<MemoryEventsProvider connect={inertSource}>
							
								<ThreadChat wolf="1uk4" slug="home" threadId="1uk4/home" title="Home" initialMessages={threadMessagesToNative(messages as never)} />
							
						</MemoryEventsProvider>
					</ServerEventsProvider>
				</>
			</AppRouterContext.Provider>,
		);
	});
	await act(async () => void (await new Promise((r) => setTimeout(r, 40))));
}


describe("ThreadChat compaction divider", () => {
	it("shows a collapsed divider where the thread was compacted", async () => {
		await mount([compacted, msg("1", "user", "go on")]);
		const d = q('[data-testid="thread-compaction"]')!;
		assert.ok(d.textContent!.includes("Context compacted"));
		assert.equal(q('[data-testid="thread-compaction-summary"]'), null);
		assert.equal(document.querySelectorAll('[data-testid="user-message"]').length, 1);
	});
	it("expands to the markdown summary and collapses again", async () => {
		await mount([compacted]);
		const toggle = () => q('[data-testid="thread-compaction"] button')!;
		await act(async () => toggle().dispatchEvent(new dom.window.CustomEvent("click", { bubbles: true })));
		const s = q('[data-testid="thread-compaction-summary"]')!;
		assert.ok(s.textContent!.includes("Ship the"));
		assert.ok(s.querySelector("strong"), "markdown rendered");
		await act(async () => toggle().dispatchEvent(new dom.window.CustomEvent("click", { bubbles: true })));
		assert.equal(q('[data-testid="thread-compaction-summary"]'), null);
	});
	it("older servers (no compaction field) show no divider", async () => {
		await mount([msg("1", "user", "hi"), msg("2", "assistant", "hello")]);
		assert.equal(q('[data-testid="thread-compaction"]'), null);
	});
});
