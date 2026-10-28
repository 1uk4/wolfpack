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
const { createThreadApi } = await import("../src/server/thread-api.ts");
const { cardsOfThread, threadMessagesToNative } = await import("../src/core/index.ts");
const { SettingsDialogProvider } = await import("../components/settings/settings-dialog.tsx");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
const { ThreadChat } = await import("../components/thread-chat.tsx");
const { MemoryEventsProvider } = await import("../components/memory-events.tsx");
const { ServerEventsProvider } = await import("../components/server-events.tsx");
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

const { parseSubagentMessage } = await import("../src/core/subagent-message.ts");
const { SubagentModalProvider } = await import("../components/subagent-modal.tsx");

const RESULT = 'Sub-agent "task-a-multiply" completed (7s).\n\n## Result\n\n6 x 7 = 42\n\n[delivery task-a.1234abcd]';
const msg = (id: string, role: "user" | "assistant", text: string) => ({ id, role, text, at: "2026-10-27T10:00:00.000Z" });

describe("parseSubagentMessage", () => {
	it("recognises result, question, failure, merge and warning deliveries", () => {
		const r = parseSubagentMessage(RESULT)!;
		assert.deepEqual([r.event, r.name, r.duration, r.summary], ["result", "task-a-multiply", "7s", "Result"]);
		assert.ok(!r.body.includes("[delivery"));
		const q = parseSubagentMessage('Sub-agent "c" asks (3s):\n\nWhich branch?\n\nReply with x\n\n[delivery c.1]')!;
		assert.deepEqual([q.event, q.duration, q.summary], ["question", "3s", "Which branch?"]);
		const f = parseSubagentMessage('Sub-agent "c" failed after 9s (provider/agent error).\n\nError: boom\n\n[delivery c.2]')!;
		assert.deepEqual([f.event, f.duration], ["error", "9s"]);
		const nm = parseSubagentMessage('Sub-agent "c" merge: Merged a into b (2 commits); done.\n\n[delivery c.9]')!;
		assert.deepEqual([nm.event, nm.name, nm.summary], ["merge", "c", "Merged a into b (2 commits); done."]);
		const m = parseSubagentMessage('Not merged: dirty. Nothing was changed. then call subagent_merge({ name: "c", action: "retry" }).\n\n[delivery c.3]')!;
		assert.deepEqual([m.event, m.name], ["merge", "c"]);
		const w = parseSubagentMessage('WARNING: the main checkout /x changed while this child ran.\n\nSub-agent "c" completed (1s).\n\ndone\n\n[delivery c.4]')!;
		assert.deepEqual([w.event, w.warned, w.summary], ["result", true, "done"]);
	});
	it("leaves owner text alone, even when it quotes the pattern", () => {
		assert.equal(parseSubagentMessage("hello"), undefined);
		assert.equal(parseSubagentMessage('Sub-agent "x" completed (1s).\n\nsure'), undefined);
	});
});

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
		const url = String(input);
		if (url.endsWith("/children")) return Response.json({ threads: [{ id: "1uk4/task-a", title: "task-a-multiply", parentThreadId: "1uk4/home", agent: "worker", state: "done" }] });
		return new Response("{}", { status: 404 });
	}) as typeof fetch;
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(
			<AppRouterContext.Provider value={{ push() {} } as never}>
				<SettingsDialogProvider>
					<ServerEventsProvider connect={eventsSource}>
						<MemoryEventsProvider connect={inertSource}>
							<SubagentModalProvider>
								<ThreadChat wolf="1uk4" slug="home" threadId="1uk4/home" title="Home" initialMessages={threadMessagesToNative(messages as never)} />
							</SubagentModalProvider>
						</MemoryEventsProvider>
					</ServerEventsProvider>
				</SettingsDialogProvider>
			</AppRouterContext.Provider>,
		);
	});
	await act(async () => void (await new Promise((r) => setTimeout(r, 40))));
}

describe("ThreadChat subagent deliveries", () => {
	it("renders a result collapsed under the child's title, without the YOU label", async () => {
		await mount([msg("1", "user", "go"), msg("2", "user", RESULT)]);
		const card = q('[data-testid="subagent-message"]')!;
		assert.equal(card.getAttribute("data-open"), "false");
		assert.equal(q('[data-testid="subagent-message-title"]')!.textContent, "worker · task-a-multiply");
		assert.equal(q('[data-testid="subagent-message-status"]')!.textContent, "completed in 7s");
		assert.equal(q('[data-testid="subagent-message-summary"]')!.textContent, "Result");
		assert.ok(!card.textContent!.includes("6 x 7"));
		assert.ok(!card.textContent!.includes("[delivery"));
		assert.equal(document.querySelectorAll('[data-testid="user-message"]').length, 1); // only the owner's "go"
		assert.ok(!card.textContent!.toLowerCase().includes("you"));
	});
	it("expands on click, and the title opens the child's modal", async () => {
		await mount([msg("2", "user", RESULT)]);
		await act(async () => q('[data-testid="subagent-message-toggle"]')!.dispatchEvent(new dom.window.CustomEvent("click", { bubbles: true })));
		assert.equal(q('[data-testid="subagent-message"]')!.getAttribute("data-open"), "true");
		assert.ok(q('[data-testid="subagent-message-body"]')!.textContent!.includes("6 x 7 = 42"));
		await act(async () => q('[data-testid="subagent-message-toggle"]')!.dispatchEvent(new dom.window.CustomEvent("click", { bubbles: true })));
		assert.equal(q('[data-testid="subagent-message"]')!.getAttribute("data-open"), "false");
		assert.equal(q('[data-testid="subagent-modal"]'), null);
		await act(async () => q('[data-testid="subagent-message-title"]')!.dispatchEvent(new dom.window.CustomEvent("click", { bubbles: true })));
		assert.ok(q('[data-testid="subagent-modal"]'));
	});
	it("still renders the owner's messages as YOU", async () => {
		await mount([msg("1", "user", 'Sub-agent "task-a-multiply" completed (7s).\n\nquoted by me')]);
		assert.equal(q('[data-testid="subagent-message"]'), null);
		assert.ok(q('[data-testid="user-message"]')!.textContent!.includes("You"));
	});
});
