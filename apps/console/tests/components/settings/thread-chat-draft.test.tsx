/**
 * ThreadChat draft wiring (real mount, stubbed fetch): typing persists the composer text after the debounce, a send
 * clears the key (and it stays clear), a failed send puts text + key back, a remount restores the draft.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { after, afterEach, describe, it, mock } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
const mem = new Map<string, string>();
const localStorage = {
	getItem: (k: string) => mem.get(k) ?? null,
	setItem: (k: string, v: string) => void mem.set(k, v),
	removeItem: (k: string) => void mem.delete(k),
};
Object.assign(globalThis, {
	window: Object.assign(dom.window, { localStorage }),
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
Object.assign(dom.window.Element.prototype, { attachEvent() {}, detachEvent() {} });

const { MockConsoleClient, FIXTURE_THREAD } = await import("@wolfpack/client");
const { cardsOfThread, threadMessagesToNative } = await import("../../../src/core/index.ts");
const { SettingsDialogProvider } = await import("../../../components/settings/settings-dialog.tsx");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
const { ThreadChat } = await import("../../../components/thread-chat.tsx");
const { MemoryEventsProvider } = await import("../../../components/memory/memory-events.tsx");
const inertSource = () => ({ close() {}, onOpen() {}, onMessage() {}, onError() {} });

const KEY = `wolfpack:draft:1uk4:${FIXTURE_THREAD.id}`;
const realFetch = globalThis.fetch;
let root: Root | null = null;
let submitStatus = 200;
let posts = 0;

async function mount() {
	globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
		if (init?.method === "POST") {
			posts++;
			return new Response(submitStatus === 200 ? JSON.stringify({ disposition: "queued" }) : "boom", { status: submitStatus });
		}
		if (String(_input).includes("/stream")) return new Response("", { status: 200 }); // an attach to a finished turn
		return new Response("{}", { status: 404 });
	}) as typeof fetch;
	const client = new MockConsoleClient({ delayMs: 0, script: [{ kind: "text", text: "ok" }] });
	const detail = await client.getThread(FIXTURE_THREAD.id);
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(
			<AppRouterContext.Provider value={{ push() {} } as never}>
				<SettingsDialogProvider>
					<MemoryEventsProvider connect={inertSource}>
						<ThreadChat
							wolf="1uk4"
							slug="home"
							threadId={FIXTURE_THREAD.id}
							title="Home"
							initialMessages={threadMessagesToNative(detail.messages)}
							initialCards={cardsOfThread(detail)}
						/>
					</MemoryEventsProvider>
				</SettingsDialogProvider>
			</AppRouterContext.Provider>,
		);
	});
}
const unmount = async () => {
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
};
const composer = () => document.querySelector('[data-testid="composer"] textarea') as HTMLTextAreaElement;
// linkedom cannot type: call the textarea's React onChange the way the browser event would.
const type = (v: string) =>
	act(async () => {
		const ta = composer();
		ta.value = v;
		const key = Object.keys(ta).find((k) => k.startsWith("__reactProps$"))!;
		(ta as any)[key].onChange({ target: ta, currentTarget: ta });
	});
const submit = () =>
	act(async () => {
		composer().closest("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
	});
const wait = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

after(() => {
	globalThis.fetch = realFetch;
});
afterEach(async () => {
	await unmount();
	mem.clear();
	submitStatus = 200;
	posts = 0;
});

describe("ThreadChat composer draft", () => {
	it("persists typed text after the debounce, clears on send and stays clear", async () => {
		await mount();
		await type("hi");
		assert.equal(composer().value, "hi", "typing reached the composer");
		assert.equal(mem.get(KEY), undefined, "not written before the delay");
		await wait(350);
		assert.equal(mem.get(KEY), "hi");
		await submit();
		await wait(50);
		assert.equal(posts, 1);
		assert.equal(mem.has(KEY), false);
		await wait(350);
		assert.equal(mem.has(KEY), false, "no late debounce write resurrects it");
	});

	it("a failed send puts the text and the draft back", async () => {
		submitStatus = 500;
		await mount();
		await type("keep me");
		await wait(350);
		await submit();
		await wait(100);
		assert.equal(composer().value, "keep me");
		await wait(350); // the restored draft is written through the normal debounce
		assert.equal(mem.get(KEY), "keep me");
	});

	it("a failed send does not overwrite text typed meanwhile", async () => {
		submitStatus = 500;
		await mount();
		await type("first");
		await submit(); // the failure lands after this act; type before it settles
		await type("second");
		await wait(350);
		assert.equal(composer().value, "second");
		assert.equal(mem.get(KEY), "second");
	});

	it("restores the draft on remount", async () => {
		await mount();
		await type("later");
		await unmount(); // flush on unmount
		assert.equal(mem.get(KEY), "later");
		await mount();
		assert.equal(composer().value, "later");
	});
});
