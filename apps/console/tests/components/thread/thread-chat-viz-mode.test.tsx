/**
 * Visualization mode on the thread page (real ThreadChat + ChatBar + AttachedThreadProvider): a button shows only while a view is
 * open; on, the transcript and page composer hide, the viewer fills the width and the floating chat bar shows; the choice is kept
 * per thread; the view closing leaves the mode; a draft typed in the bar is in the page composer after leaving.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
const store = new Map<string, string>();
Object.assign(globalThis, {
	window: Object.assign(dom.window, { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } }),
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
const { ThreadChat } = await import("../../../components/thread/thread-chat.tsx");
const { MemoryEventsProvider } = await import("../../../components/memory/memory-events.tsx");
const { FakeNav } = await import("../../helpers/fake-nav.tsx");
const { ServerEventsProvider } = await import("../../../components/shell/server-events.tsx");
const { AttachedThreadProvider } = await import("../../../components/chat-bar/attached-thread.tsx");
const { ChatBar } = await import("../../../components/chat-bar/chat-bar.tsx");
const { registerViewRenderer } = await import("../../../components/viewer/registry.tsx");
const vs = await import("../../../components/viewer/viewer-store.ts");
const { setVizActive, vizKey } = await import("../../../components/viewer/viz-mode.ts");

registerViewRenderer("kb", () => <div>kb body</div>);

/** Lets a test unmount only the thread page (the bar and providers stay), like navigating away. */
let hideChat: (() => void) | null = null;
function Gate({ children }: { children: React.ReactNode }) {
	const [shown, setShown] = React.useState(true);
	hideChat = () => setShown(false);
	return shown ? <>{children}</> : null;
}

const inertSource = () => ({ close() {}, onOpen() {}, onMessage() {}, onError() {} });
const realFetch = globalThis.fetch;
let root: Root | null = null;
const TID = FIXTURE_THREAD.id;
const VIZ = vizKey("1uk4", TID);
const DRAFT = `wolfpack:draft:1uk4:${TID}`;

async function mount() {
	globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
	const client = new MockConsoleClient({ delayMs: 0, script: [{ kind: "text", text: "ok" }] });
	const detail = await client.getThread(TID);
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(
			<FakeNav start="/wolf/1uk4/thread/home">
				<ServerEventsProvider connect={() => ({ close() {}, onOpen() {}, onEvent() {} })}>
					<AttachedThreadProvider>
						<ChatBar />
						<MemoryEventsProvider connect={inertSource}>
							<Gate>
								<ThreadChat wolf="1uk4" slug="home" threadId={TID} title="Home" initialMessages={threadMessagesToNative(detail.messages)} initialCards={cardsOfThread(detail)} />
							</Gate>
						</MemoryEventsProvider>
					</AttachedThreadProvider>
				</ServerEventsProvider>
			</FakeNav>,
		);
	});
	await settle(60);
}

const settle = (ms = 30) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const click = (el: Element) => act(async () => void el.dispatchEvent(Object.assign(new dom.window.Event("click", { bubbles: true, cancelable: true }), { detail: 1 })));
const typeIn = (el: HTMLTextAreaElement, v: string) =>
	act(async () => {
		el.value = v;
		const k = Object.keys(el).find((x) => x.startsWith("__reactProps$"))!;
		(el as any)[k].onChange({ target: el, currentTarget: el });
	});
const openKb = () => act(async () => vs.openView("1uk4", TID, { kind: "kb", id: "e1" }));
const mainHidden = () => (q('[data-testid="thread-main"]')!.getAttribute("class") ?? "").split(" ").includes("hidden");

after(() => {
	globalThis.fetch = realFetch;
});
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	setVizActive(null);
	vs.resetViewerCache();
	store.clear();
	document.body.innerHTML = "";
});

describe("thread visualization mode", () => {
	it("the button is hidden with no open view and shown once a view is open", async () => {
		await mount();
		assert.equal(q('[data-testid="viz-toggle"]'), null);
		await openKb();
		assert.ok(q('[data-testid="viz-toggle"]'));
	});

	it("turning it on hides the transcript and page composer, fills the width and shows the chat bar; turning it off restores them", async () => {
		await mount();
		await openKb();
		assert.equal(q('[data-testid="chat-bar"]'), null, "bar is off on the thread's own page normally");
		await click(q('[data-testid="viz-toggle"]')!);
		await settle(60);
		assert.equal(mainHidden(), true);
		assert.equal(q('[data-testid="viewer-panel"]')!.getAttribute("data-fill"), "true");
		assert.ok(q('[data-testid="chat-bar"]'), "bar shows");
		assert.equal(q('[data-testid="thread-main"] [data-testid="composer"]'), null, "no page composer");
		assert.ok(q('[data-testid="chat-bar"] [data-testid="composer"]'), "the bar has the input");
		await click(q('[data-testid="viz-toggle"]')!);
		await settle(60);
		assert.equal(mainHidden(), false);
		assert.equal(q('[data-testid="chat-bar"]'), null);
	});

	it("the choice is kept per thread across a reload", async () => {
		await mount();
		await openKb();
		await click(q('[data-testid="viz-toggle"]')!);
		assert.equal(store.get(VIZ), "1");
		await act(async () => root?.unmount());
		root = null;
		setVizActive(null);
		document.body.innerHTML = "";
		await mount();
		await settle(60);
		assert.equal(mainHidden(), true);
	});

	it("the open view closing leaves the mode and shows the transcript again", async () => {
		await mount();
		await openKb();
		await click(q('[data-testid="viz-toggle"]')!);
		await settle(60);
		await act(async () => vs.closeViewer("1uk4", TID));
		await settle(60);
		assert.equal(mainHidden(), false);
		assert.equal(store.get(VIZ), undefined);
		assert.equal(q('[data-testid="viz-toggle"]'), null);
	});

	it("leaving the page while the mode is on docks the bar, so it does not stay attached to this thread", async () => {
		await mount();
		await openKb();
		await click(q('[data-testid="viz-toggle"]')!);
		await settle(60);
		assert.ok(q('[data-testid="chat-bar"]'));
		await act(async () => hideChat!());
		await settle(60);
		assert.equal(q('[data-testid="chat-bar"]'), null);
	});

	it("a draft typed in the bar during the mode is in the page composer after leaving it", async () => {
		await mount();
		await openKb();
		await click(q('[data-testid="viz-toggle"]')!);
		await settle(80);
		await typeIn(q('[data-testid="chat-bar"] textarea') as HTMLTextAreaElement, "half a thought");
		await click(q('[data-testid="viz-toggle"]')!);
		await settle(80);
		const page = q('[data-testid="thread-main"] [data-testid="composer"] textarea') as HTMLTextAreaElement;
		assert.equal(page.value, "half a thought");
		assert.equal(store.get(DRAFT), "half a thought");
	});
});
