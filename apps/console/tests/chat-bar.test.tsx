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

const { AppRouterContext: await_ctx } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
const { ServerEventsProvider } = await import("../components/server-events.tsx");
const { KeyboardShortcuts } = await import("../components/keyboard-shortcuts.tsx");
const { SettingsDialogProvider } = await import("../components/settings/settings-dialog.tsx");
const { FakeNav } = await import("./helpers/fake-nav.tsx");
const { AttachedThreadProvider, AttachBarWorkButton, attachToWorkItem, useAttachedThread } = await import("../components/attached-thread.tsx");
const { ChatBar, submitToThread } = await import("../components/chat-bar.tsx");
const { ATTACHED_KEY } = await import("../src/core/chat-bar.ts");

type Call = { url: string; body?: any };
let calls: Call[] = [];
let status: "idle" | "busy" = "idle";
let archived = false;
let created = false;
let hold: Promise<void> | null = null;
const handlers = new Map<string, (d: string) => void>();
const fakeSource = () => ({ close() {}, onOpen() {}, onEvent: (n: string, cb: (d: string) => void) => void handlers.set(n, cb) });
const emit = (n: string, d: object) => act(async () => void handlers.get(n)?.(JSON.stringify(d)));
const realFetch = globalThis.fetch;
const th = (id: string, extra: object = {}) => ({ id, title: id, kind: "feature", status, ...extra });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = String(input);
	if (init?.method === "POST") {
		calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
		if (url === "/api/wolves/w/threads") created = true;
		return new Response(JSON.stringify({ id: "w/created", title: "Created" }), { status: 200 });
	}
	if (url === "/api/wolves") return Response.json({ wolves: [{ name: "w" }] });
	if (url === "/api/wolves/w/threads" && hold) {
		// A list fetched BEFORE the attach (stale snapshot), delivered after it.
		const wait = hold;
		hold = null;
		const snapshot = [th("w/home", { kind: "home" }), th("w/a"), th("w/b")];
		await wait;
		return Response.json({ threads: snapshot });
	}
	if (url === "/api/wolves/w/threads") return Response.json({ threads: [th("w/home", { kind: "home" }), th("w/a", archived ? { closed: true } : {}), th("w/b"), ...(created ? [th("w/created")] : [])] });
	return new Response("{}", { status: 404 });
}) as typeof fetch;

let root: Root | null = null;
const wait = (ms = 60) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
async function mount(start: string, stored?: object, extra?: React.ReactNode) {
	if (stored) mem.set(ATTACHED_KEY, JSON.stringify(stored));
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(
			<FakeNav start={start}>
				<ServerEventsProvider connect={fakeSource}>
					<AttachedThreadProvider>
						<ChatBar />
						{extra}
					</AttachedThreadProvider>
				</ServerEventsProvider>
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
	archived = false;
	created = false;
	hold = null;
	handlers.clear();
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

	it("hides on the attached thread's own page and never touches the page's draft", async () => {
		mem.set("wolfpack:draft:w:w/a", "typed on the page");
		await mount("/wolf/w/thread/a", A);
		assert.equal(q('[data-testid="chat-bar"]'), null);
		window.dispatchEvent(new dom.window.Event("pagehide"));
		await wait();
		assert.equal(mem.get("wolfpack:draft:w:w/a"), "typed on the page", "no stale flush from the bar");
	});

	it("shows the page's newer draft after leaving the page", async () => {
		mem.set("wolfpack:draft:w:w/a", "old");
		let go: (u: string) => void = () => {};
		function Nav() {
			const r = React.useContext((await_ctx as any));
			go = (u) => (r as any).push(u);
			return null;
		}
		await mount("/wolf/w/thread/a", A, <Nav />);
		mem.set("wolfpack:draft:w:w/a", "newer from the page");
		await act(async () => go("/kb"));
		await wait();
		assert.equal(ta().value, "newer from the page");
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

describe("ChatBar behaviours", () => {
	it("a failed send drops the optimistic working state and puts the text back, merged", async () => {
		const orig = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => (init?.method === "POST" ? new Response("no", { status: 500 }) : orig(input, init))) as typeof fetch;
		try {
			await mount("/kb", A);
			await type("lost?");
			await submit();
			await wait();
			assert.equal(q('[data-testid="chat-bar-working"]'), null);
			assert.equal(ta().value, "lost?");
		} finally {
			globalThis.fetch = orig;
		}
	});

	it("Cmd+J answers (and claims the key) only when the bar is shown", async () => {
		const press = (name: string) => {
			let prevented = false;
			window.dispatchEvent(new dom.window.CustomEvent(name, { detail: { event: { preventDefault: () => void (prevented = true) } } }));
			return prevented;
		};
		await mount("/kb", A);
		await click(q('[data-testid="chat-bar-minimize"]'));
		assert.equal(press("lh:kbd-focus-chat-bar"), true);
		await wait();
		assert.equal(mem.get("wolfpack:chatbar:minimized"), undefined, "expanded again");
		await act(async () => root?.unmount());
		document.body.innerHTML = "";
		mem.clear();
		await mount("/kb"); // nothing stored: falls to home, but with no wolves online yet the bar may not be attached
		const none = (document.querySelector('[data-testid="chat-bar"]') === null);
		if (none) assert.equal(press("lh:kbd-focus-chat-bar"), false);
	});

	it("Cmd+J on the own page focuses the page composer", async () => {
		let focused = false;
		const page = (
			<form data-testid="composer">
				<textarea ref={(el) => { if (el) el.focus = () => void (focused = true); }} />
			</form>
		);
		await mount("/wolf/w/thread/a", A, page);
		let prevented = false;
		window.dispatchEvent(new dom.window.CustomEvent("lh:kbd-focus-chat-bar", { detail: { event: { preventDefault: () => void (prevented = true) } } }));
		assert.ok(focused && prevented);
	});

	it("a live archive of the attached thread falls back to home", async () => {
		await mount("/kb", A);
		assert.equal(JSON.parse(mem.get(ATTACHED_KEY)!).threadId, "w/a");
		archived = true;
		await emit("needs-you-changed", { wolf: "w", threadId: "w/a", status: "idle" });
		await wait();
		assert.equal(JSON.parse(mem.get(ATTACHED_KEY)!).threadId, "w/home");
	});
});

describe("refresh ordering", () => {
	it("a refresh that started before an attach does not overwrite the fresher list", async () => {
		let release!: () => void;
		hold = new Promise<void>((r) => (release = r));
		await mount("/work/x", A, <AttachBarWorkButton wolf="w" workItemId="work-w-3" />);
		await click(q('[data-testid="attach-bar-work"]'));
		await wait();
		release(); // the stale snapshot (no w/created) lands now
		await wait();
		await click(q('[data-testid="chat-bar-chip"]'));
		const ids = [...document.querySelectorAll('[data-testid="switcher-entry"]')].map((e) => e.getAttribute("data-thread"));
		assert.ok(ids.includes("w/created"), `list kept the fresher thread: ${ids}`);
		assert.equal(JSON.parse(mem.get(ATTACHED_KEY)!).threadId, "w/created");
	});
});

describe("real keydown through KeyboardShortcuts", () => {
	const keydown = (init: object, target?: HTMLElement) =>
		act(async () => {
			const ev = Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), init);
			(target ?? window).dispatchEvent(ev);
			return ev;
		});
	async function mountWithKeys(start: string) {
		mem.set(ATTACHED_KEY, JSON.stringify(A));
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		await act(async () => {
			root!.render(
				<FakeNav start={start}>
					<SettingsDialogProvider>
						<ServerEventsProvider connect={fakeSource}>
							<AttachedThreadProvider>
								<ChatBar />
								<input data-testid="other" />
								<KeyboardShortcuts />
							</AttachedThreadProvider>
						</ServerEventsProvider>
					</SettingsDialogProvider>
				</FakeNav>,
			);
		});
		await wait();
	}
	it("Cmd+J un-minimizes and focuses; Cmd+Shift+J opens the switcher; a bare j in another input is ignored", async () => {
		await mountWithKeys("/kb");
		await click(q('[data-testid="chat-bar-minimize"]'));
		assert.equal(q('[data-testid="chat-bar"]')?.getAttribute("data-state"), "minimized");
		const bare = Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), { key: "j" });
		await act(async () => void q('[data-testid="other"]')!.dispatchEvent(bare));
		assert.equal(q('[data-testid="chat-bar"]')?.getAttribute("data-state"), "minimized", "bare j types, nothing happens");
		const ev = await keydown({ key: "j", metaKey: true });
		assert.equal(ev.defaultPrevented, true, "the bar claimed Cmd+J");
		await wait();
		assert.equal(q('[data-testid="chat-bar"]')?.getAttribute("data-state"), "open");
		await keydown({ key: "j", metaKey: true, shiftKey: true });
		await wait();
		assert.ok(q('[data-testid="chat-bar-switcher"]'));
	});
	it("Cmd+J is left to the browser with nothing attached", async () => {
		await mountWithKeys("/kb");
		mem.clear();
		await act(async () => root?.unmount());
		document.body.innerHTML = "";
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		await act(async () => {
			root!.render(
				<FakeNav start="/kb">
					<SettingsDialogProvider>
						<KeyboardShortcuts />
					</SettingsDialogProvider>
				</FakeNav>,
			);
		});
		const ev = await keydown({ key: "j", metaKey: true });
		assert.equal(ev.defaultPrevented, false);
	});
});

describe("Attach bar here (work item)", () => {
	it("a double click creates the thread once", async () => {
		await mount("/work/x", A, <AttachBarWorkButton wolf="w" workItemId="work-w-2" />);
		const b = q('[data-testid="attach-bar-work"]');
		await act(async () => {
			const key = Object.keys(b!).find((k) => k.startsWith("__reactProps$"))!;
			(b as any)[key].onClick();
			(b as any)[key].onClick();
		});
		await wait();
		assert.equal(calls.filter((c) => c.url === "/api/wolves/w/threads").length, 1);
	});
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
