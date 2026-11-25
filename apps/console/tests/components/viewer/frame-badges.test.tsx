/**
 * Frame badges: one eye + title badge per frame the wolf showed (kind "frame" only), above the page composer and above the floating bar's
 * input. Tap enters visualization mode on that frame; the chat icon leaves it; × hides the badge for the thread (persisted).
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
const { FakeNav, currentUrl } = await import("../../helpers/fake-nav.tsx");
const { ServerEventsProvider } = await import("../../../components/shell/server-events.tsx");
const { AttachedThreadProvider } = await import("../../../components/chat-bar/attached-thread.tsx");
const { ChatBar } = await import("../../../components/chat-bar/chat-bar.tsx");
const vs = await import("../../../components/viewer/viewer-store.ts");
const { ATTACHED_KEY } = await import("../../../src/core/thread/chat-bar.ts");
const { setVizActive, vizKey } = await import("../../../components/viewer/viz-mode.ts");
const { registerViewRenderer } = await import("../../../components/viewer/registry.tsx");

registerViewRenderer("frame", () => <div>frame body</div>);
registerViewRenderer("kb", () => <div>kb body</div>);

const inertSource = () => ({ close() {}, onOpen() {}, onMessage() {}, onError() {} });
const realFetch = globalThis.fetch;
let root: Root | null = null;
const TID = FIXTURE_THREAD.id;
const VIZ = vizKey("1uk4", TID);

const framePart = (objectId: string, rev: number, path: string, title?: string) => ({
	type: "object",
	objectId,
	objectType: "view",
	rev,
	data: { kind: "frame", path, wolf: "1uk4", ...(title ? { title } : {}) },
});
const kbPart = { type: "object", objectId: "k1", objectType: "view", rev: 1, data: { kind: "kb", id: "e1", title: "An entry" } };

async function mount(parts: unknown[], opts: { chat?: boolean; start?: string } = {}) {
	globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
	const client = new MockConsoleClient({ delayMs: 0, script: [{ kind: "text", text: "ok" }] });
	const detail = await client.getThread(TID);
	// One native assistant message per object block, like threadMessagesToNative emits for show_view objects.
	const blocks = (parts as Array<{ objectId: string; objectType: string; rev: number; data: unknown }>).map((p) => ({ type: "object", objectId: p.objectId, objectType: p.objectType, rev: p.rev, data: p.data }));
	const initial = [...threadMessagesToNative(detail.messages), ...(blocks.length ? [{ id: "m-views", role: "assistant", content: blocks, api: "x", provider: "x", model: "x", usage: {}, stopReason: "stop", timestamp: 1 }] : [])] as never;
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(
			<FakeNav start={opts.start ?? "/wolf/1uk4/thread/home"}>
				<ServerEventsProvider connect={() => ({ close() {}, onOpen() {}, onEvent() {} })}>
					<AttachedThreadProvider>
						<ChatBar />
						<MemoryEventsProvider connect={inertSource}>
							{opts.chat === false ? null : <ThreadChat wolf="1uk4" slug="home" threadId={TID} title="Home" initialMessages={initial} initialCards={cardsOfThread(detail)} />}
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
const qa = (sel: string) => [...document.querySelectorAll(sel)] as HTMLElement[];
const click = (el: Element) => act(async () => void el.dispatchEvent(Object.assign(new dom.window.Event("click", { bubbles: true, cancelable: true }), { detail: 1 })));
const labels = () => qa('[data-testid="frame-badge"]').map((b) => b.textContent?.trim());
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

describe("frame badges", () => {
	it("only frames get a badge: one per objectId with the latest rev's title, file name when untitled, none for other views", async () => {
		await mount([kbPart, framePart("f1", 1, "a.html", "Old"), framePart("f1", 2, "a.html", "New"), framePart("f2", 1, "notes/plan.html")]);
		assert.deepEqual(labels(), ["New", "plan"]);
	});

	it("the row sits directly above the page composer", async () => {
		await mount([framePart("f1", 1, "a.html", "A")]);
		const row = q('[data-testid="thread-main"] [data-testid="frame-badges"]')!;
		assert.ok(row);
		assert.equal(row.parentElement, q('[data-testid="thread-composer-card"]')!.parentElement);
		const kids = [...row.parentElement!.children];
		assert.ok(kids.indexOf(row) < kids.indexOf(q('[data-testid="thread-composer-card"]')!));
	});

	it("tapping a badge turns viz mode on with that frame open and highlighted; the chat icon shows only then and leaves the mode", async () => {
		await mount([framePart("f1", 1, "a.html", "A"), framePart("f2", 1, "b.html", "B")]);
		assert.equal(q('[data-testid="frame-badges-chat"]'), null);
		await click(qa('[data-testid="frame-badge-open"]')[1]!);
		await settle(60);
		assert.equal(store.get(VIZ), "1");
		assert.equal(mainHidden(), true);
		assert.deepEqual(vs.getViewerState("1uk4", TID).stack.map((d) => d.id), ["b.html"]);
		assert.deepEqual(qa('[data-testid="frame-badge-open"]').map((b) => b.getAttribute("aria-pressed")), ["false", "true"]);
		assert.equal(q('[data-testid="viz-toggle"]'), null, "the header eye is hidden for a frame");
		const bar = q('[data-testid="chat-bar"]')!;
		assert.equal(bar.querySelector('[data-testid="frame-badges-chat"]')?.parentElement, bar.querySelector('[data-testid="frame-badges"]'));
		assert.equal(bar.querySelector('[data-testid="frame-badges"]')!.nextElementSibling?.querySelector("textarea") !== null, true, "the row is right above the bar's input");
		await click(bar.querySelector('[data-testid="frame-badges-chat"]')!);
		await settle(60);
		assert.equal(mainHidden(), false);
		assert.equal(store.get(VIZ), undefined);
		assert.equal(q('[data-testid="frame-badges-chat"]'), null);
	});

	it("× hides the badge, keeps it hidden across a remount and a new rev, and leaves viz mode when that frame was shown", async () => {
		await mount([framePart("f1", 1, "a.html", "A"), framePart("f2", 1, "b.html", "B")]);
		await click(qa('[data-testid="frame-badge-open"]')[0]!);
		await settle(60);
		await click(qa('[data-testid="frame-badge-dismiss"]')[0]!);
		await settle(60);
		assert.equal(store.get(VIZ), undefined);
		assert.equal(mainHidden(), false);
		assert.deepEqual(labels(), ["B"]);
		await act(async () => root?.unmount());
		root = null;
		setVizActive(null);
		document.body.innerHTML = "";
		await mount([framePart("f1", 2, "a.html", "A v2"), framePart("f2", 1, "b.html", "B")]);
		assert.deepEqual(labels(), ["B"]);
	});

	it("a badge in the bar on another page navigates to the thread with that frame open", async () => {
		store.set(ATTACHED_KEY, JSON.stringify({ wolf: "1uk4", slug: "home", threadId: TID }));
		store.set(`wolfpack:frames:${TID}`, JSON.stringify([{ objectId: "f1", path: "a.html", title: "A", rev: 1 }]));
		await mount([], { chat: false, start: "/kb" });
		await settle(60);
		const badge = q('[data-testid="chat-bar"] [data-testid="frame-badge-open"]')!;
		assert.ok(badge, "the bar lists the thread's frame");
		await click(badge);
		assert.equal(currentUrl(), "/wolf/1uk4/thread/home?view=frame%3Aa.html");
		assert.equal(store.get(VIZ), undefined, "viz mode is left to the thread page on arrival, so a failed navigation hides nothing");
	});

	it("stored frames: malformed JSON gives no badges, hostile paths are dropped, and only the newest 50 are kept with older dismissals cleared", async () => {
		store.set(ATTACHED_KEY, JSON.stringify({ wolf: "1uk4", slug: "home", threadId: TID }));
		store.set(`wolfpack:frames:${TID}`, "{not json");
		await mount([], { chat: false, start: "/kb" });
		assert.deepEqual(labels(), []);
		await act(async () => root?.unmount());
		root = null;
		document.body.innerHTML = "";
		const ok = { objectId: "ok", path: "ok.html", title: "Fine" };
		const bad = ["../x.html", "/etc/p.html", "a\\b.html", "a\u0000.html", "notes.txt"].map((path, i) => ({ objectId: `bad${i}`, path }));
		store.set(`wolfpack:frames:${TID}`, JSON.stringify([...bad, ok]));
		store.set(`wolfpack:frame-dismissed:${TID}:old0`, "1");
		await mount([], { chat: false, start: "/kb" });
		assert.deepEqual(labels(), ["Fine"]);
		await act(async () => root?.unmount());
		root = null;
		document.body.innerHTML = "";
		store.set(`wolfpack:frames:${TID}`, JSON.stringify(Array.from({ length: 50 }, (_, i) => ({ objectId: `old${i}`, path: `o${i}.html` }))));
		await mount([], { chat: false, start: "/kb" });
		const { recordFrames } = await import("../../../components/viewer/frame-store.ts");
		await act(async () => recordFrames("1uk4", TID, [{ role: "assistant", parts: [framePart("new1", 1, "n.html", "Newest")] }]));
		const kept = JSON.parse(store.get(`wolfpack:frames:${TID}`)!) as Array<{ objectId: string }>;
		assert.equal(kept.length, 50);
		assert.equal(kept[0]!.objectId, "old1");
		assert.equal(kept[49]!.objectId, "new1");
		assert.equal(store.get(`wolfpack:frame-dismissed:${TID}:old0`), undefined);
	});
});
