/** ChatBar + AttachedThreadProvider (real mount, stubbed fetch): send/steer/stop, per-thread drafts, collapse on the thread's own page, switcher, work-item attach. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
const mem = new Map<string, string>();
const localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
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
});
Object.assign(dom.window.Element.prototype, { attachEvent() {}, detachEvent() {} });

const { FakeNav } = await import("./helpers/fake-nav.tsx");
const { AttachedThreadProvider, AttachBarWorkButton, attachToWorkItem, useAttachedThread } = await import("../components/attached-thread.tsx");
const { ChatBar, submitToThread } = await import("../components/chat-bar.tsx");
const { ATTACHED_KEY } = await import("../src/core/chat-bar.ts");

type Call = { url: string; body?: any };
let calls: Call[] = [];
let status: "idle" | "busy" = "idle";
const realFetch = globalThis.fetch;
const th = (id: string, extra: object = {}) => ({ id, title: id, kind: "feature", status, ...extra });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = String(input);
	if (init?.method === "POST") {
		calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
		return new Response(JSON.stringify({ id: "w/created", title: "Created" }), { status: 200 });
	}
	if (url === "/api/wolves") return Response.json({ wolves: [{ name: "w" }] });
	if (url === "/api/wolves/w/threads") return Response.json({ threads: [th("w/home", { kind: "home" }), th("w/a"), th("w/b")] });
	return new Response("{}", { status: 404 });
}) as typeof fetch;

let root: Root | null = null;
const wait = (ms = 30) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
async function mount(start: string, stored?: object, extra?: React.ReactNode) {
	if (stored) mem.set(ATTACHED_KEY, JSON.stringify(stored));
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(
			<FakeNav start={start}>
				<AttachedThreadProvider>
					<ChatBar />
					{extra}
				</AttachedThreadProvider>
			</FakeNav>,
		);
	});
	await wait();
}
const q = (s: string) => document.querySelector(s) as HTMLElement | null;
const ta = () => q('[data-testid="composer"] textarea') as HTMLTextAreaElement;
const type = (v: string) =>
	act(async () => {
		const el = ta();
		el.value = v;
		const key = Object.keys(el).find((k) => k.startsWith("__reactProps$"))!;
		(el as any)[key].onChange({ target: el, currentTarget: el });
	});
const click = (el: HTMLElement | null) =>
	act(async () => {
		const key = Object.keys(el!).find((k) => k.startsWith("__reactProps$"))!;
		(el as any)[key].onClick({ currentTarget: el, target: el, preventDefault() {}, stopPropagation() {} });
	});
const submit = () => act(async () => void ta().closest("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
	mem.clear();
	calls = [];
	status = "idle";
});
after(() => void (globalThis.fetch = realFetch));

const A = { wolf: "w", slug: "a", threadId: "w/a" };

describe("ChatBar", () => {
	it("falls back to the home thread with no stored target; navigation never re-targets", async () => {
		await mount("/kb");
		assert.equal(q('[data-testid="chat-bar"]')?.getAttribute("data-state"), "open");
		assert.equal(JSON.parse(mem.get(ATTACHED_KEY)!).threadId, "w/home");
	});

	it("an idle send POSTs reject; a busy send steers; Stop aborts", async () => {
		await mount("/kb", A);
		await type("hello");
		await submit();
		await wait();
		const sub = calls.find((c) => c.url.endsWith("/threads/a/submit"))!;
		assert.equal(sub.body.whenBusy, "reject");
		assert.equal(sub.body.input, "hello");
		assert.ok(q('[data-testid="chat-bar-working"]'), "working shown after send");
		calls = [];
		await type("more");
		await submit();
		await wait();
		assert.equal(calls[0]!.body.whenBusy, "steer");
		await type("");
		const stop = document.querySelector('button[aria-label="Stop"]') as HTMLElement;
		assert.ok(stop);
		await submit();
		await wait();
		assert.ok(calls.some((c) => c.url.endsWith("/threads/a/abort")));
	});

	it("each thread keeps its own draft across switches", async () => {
		await mount("/kb", A);
		await type("draft for a");
		await click(q('[data-testid="chat-bar-chip"]'));
		const b = [...document.querySelectorAll('[data-testid="switcher-entry"]')].find((e) => e.getAttribute("data-thread") === "w/b") as HTMLElement;
		await click(b);
		await wait();
		assert.equal(ta().value, "");
		assert.equal(mem.get("wolfpack:draft:w:w/a"), "draft for a");
		await type("draft for b");
		await click(q('[data-testid="chat-bar-chip"]'));
		const a = [...document.querySelectorAll('[data-testid="switcher-entry"]')].find((e) => e.getAttribute("data-thread") === "w/a") as HTMLElement;
		await click(a);
		await wait();
		assert.equal(ta().value, "draft for a");
	});

	it("collapses to the chip on the attached thread's own page; the draft key is shared", async () => {
		mem.set("wolfpack:draft:w:w/a", "carried");
		await mount("/wolf/w/thread/a", A);
		assert.equal(q('[data-testid="chat-bar"]')?.getAttribute("data-state"), "collapsed");
		assert.equal(q('[data-testid="composer"]'), null);
		assert.equal(mem.get("wolfpack:draft:w:w/a"), "carried");
	});

	it("the switcher groups by wolf and leaves out subagents", async () => {
		await mount("/kb", A);
		await click(q('[data-testid="chat-bar-chip"]'));
		assert.equal(document.querySelectorAll('[data-testid="switcher-group"]').length, 1);
		assert.equal(document.querySelectorAll('[data-testid="switcher-entry"]').length, 3);
	});

	it("minimized state persists", async () => {
		await mount("/kb", A);
		await click(q('[data-testid="chat-bar-minimize"]'));
		assert.equal(mem.get("wolfpack:chatbar:minimized"), "1");
		assert.equal(q('[data-testid="chat-bar"]')?.getAttribute("data-state"), "minimized");
	});
});

describe("Attach bar here (work item)", () => {
	it("creates the item's thread, then attaches", async () => {
		await mount("/work/x", A, <AttachBarWorkButton wolf="w" workItemId="work-w-1" />);
		await click(q('[data-testid="attach-bar-work"]'));
		await wait();
		const create = calls.find((c) => c.url === "/api/wolves/w/threads")!;
		assert.deepEqual(create.body, { kind: "feature", workItemId: "work-w-1" });
		assert.equal(JSON.parse(mem.get(ATTACHED_KEY)!).threadId, "w/created");
	});
	it("surfaces a failed open without attaching", async () => {
		let attached = false;
		const msg = await attachToWorkItem("w", "x", async () => ({ ok: false, reason: "error", message: "nope" }) as never, () => void (attached = true));
		assert.equal(msg, "nope");
		assert.equal(attached, false);
	});
});

describe("submitToThread", () => {
	it("retries a 409 on an optimistic idle send as a steer", async () => {
		const seen: string[] = [];
		const f = (async (_u: string, init: RequestInit) => {
			const b = JSON.parse(String(init.body));
			seen.push(b.whenBusy);
			return new Response("{}", { status: b.whenBusy === "reject" ? 409 : 200 });
		}) as unknown as typeof fetch;
		assert.equal(await submitToThread({ wolf: "w", slug: "a" }, "x", false, [], f), true);
		assert.deepEqual(seen, ["reject", "steer"]);
	});
});
void useAttachedThread;
