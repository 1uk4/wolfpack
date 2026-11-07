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

const { usePathname } = await import("next/navigation");
const { AppRouterContext: await_ctx } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
const { ServerEventsProvider } = await import("../components/server-events.tsx");
const { KeyboardShortcuts } = await import("../components/keyboard-shortcuts.tsx");
const { SettingsDialogProvider } = await import("../components/settings/settings-dialog.tsx");
const { FakeNav } = await import("./helpers/fake-nav.tsx");
const { AttachedThreadProvider, useAttachedThread } = await import("../components/attached-thread.tsx");
const { ChatBar, submitToThread } = await import("../components/chat-bar.tsx");
const { ATTACHED_KEY, BAR_EXTRAS } = await import("../src/core/chat-bar.ts");

type Call = { url: string; body?: any };
let calls: Call[] = [];
let status: "idle" | "busy" = "idle";
let archived = false;
let gets: string[] = [];
const handlers = new Map<string, (d: string) => void>();
const fakeSource = () => ({ close() {}, onOpen() {}, onEvent: (n: string, cb: (d: string) => void) => void handlers.set(n, cb) });
const emit = (n: string, d: object) => act(async () => void handlers.get(n)?.(JSON.stringify(d)));
const realFetch = globalThis.fetch;
const th = (id: string, extra: object = {}) => ({ id, title: id, kind: "feature", status, ...extra });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = String(input);
	if (init?.method === "POST") {
		calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
		return new Response("{}", { status: 200 });
	}
	if (init?.method !== "POST") gets.push(url);
	if (url === "/api/wolves") return Response.json({ wolves: [{ name: "w" }] });
	if (url === "/api/wolves/w/threads") return Response.json({ threads: [th("w/home", { kind: "home" }), th("w/a", archived ? { closed: true } : {}), th("w/b")] });
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
	gets = [];
	handlers.clear();
});
after(() => void (globalThis.fetch = realFetch));

const A = { wolf: "w", slug: "a", threadId: "w/a" };

/** Test stand-in for whatever attaches a thread (the product has no Pop out button); the dock/landing rules are what is under test. */
function AttachHere() {
	const api = useAttachedThread();
	return <button type="button" data-testid="test-attach" onClick={() => api!.attach({ wolf: "w", threadId: "w/a", slug: "a" })} />;
}

describe("ChatBar", () => {
	it("renders nothing and reserves no space with nothing popped out, and clears the old home-wolf default", async () => {
		mem.set("wolfpack:chatbar:attached", JSON.stringify(A));
		mem.set("wolfpack:chatbar:home-wolf", "w");
		await mount("/kb");
		assert.equal(q('[data-testid="chat-bar"]'), null);
		assert.equal(document.documentElement.style.getPropertyValue("--chat-bar-reserve"), "");
		assert.equal(mem.get(ATTACHED_KEY), undefined);
		assert.equal(mem.get("wolfpack:chatbar:attached"), undefined);
		assert.equal(mem.get("wolfpack:chatbar:home-wolf"), undefined);
	});

	it("with the extras off the bar fetches no cards, reply peek or needs-you list", async () => {
		assert.equal(BAR_EXTRAS.cards || BAR_EXTRAS.peek || BAR_EXTRAS.badge || BAR_EXTRAS.switcher, false);
		await mount("/kb", A);
		assert.ok(q('[data-testid="chat-bar"]'));
		assert.deepEqual(gets.filter((u) => /\/threads\/a(\?|$)|needs-you/.test(u)), []);
		assert.equal(q('[data-testid="chat-bar-card-surface"]')?.children.length ?? 0, 0);
		assert.equal(q('[data-testid="chat-bar-needs-you"]'), null);
	});

	it("A thread attached while its page is open shows the bar once the owner leaves", async () => {
		let go: (u: string) => void = () => {};
		function Nav() {
			const r = React.useContext((await_ctx as any));
			go = (u) => (r as any).push(u);
			return null;
		}
		await mount("/wolf/w/thread/a", undefined, <><Nav /><AttachHere /></>);
		await click(q('[data-testid="test-attach"]'));
		assert.equal(q('[data-testid="chat-bar"]'), null, "hidden on its own page");
		assert.equal(JSON.parse(mem.get(ATTACHED_KEY)!).threadId, "w/a", "kept across reloads");
		await act(async () => go("/kb"));
		await wait();
		assert.equal(q('[data-testid="chat-bar"]')?.getAttribute("data-state"), "open");
	});

	it("Dock hides the bar and keeps the draft unsent", async () => {
		await mount("/kb", A);
		await type("half a thought");
		await click(q('[data-testid="chat-bar-dock"]'));
		await wait();
		assert.equal(q('[data-testid="chat-bar"]'), null);
		assert.equal(mem.get(ATTACHED_KEY), undefined);
		assert.equal(mem.get("wolfpack:draft:w:w/a"), "half a thought");
		assert.equal(calls.length, 0);
	});

	it("landing on the popped-out thread's own page docks it", async () => {
		let go: (u: string) => void = () => {};
		function Nav() {
			const r = React.useContext((await_ctx as any));
			go = (u) => (r as any).push(u);
			return null;
		}
		await mount("/kb", A, <Nav />);
		await type("kept");
		await act(async () => go("/wolf/w/thread/a"));
		await wait();
		assert.equal(q('[data-testid="chat-bar"]'), null);
		assert.equal(mem.get(ATTACHED_KEY), undefined);
		assert.equal(mem.get("wolfpack:draft:w:w/a"), "kept");
	});

	it("a reload on the popped-out thread's own page docks it and leaves the page's draft alone", async () => {
		mem.set("wolfpack:draft:w:w/a", "typed on the page");
		await mount("/wolf/w/thread/a", A);
		assert.equal(q('[data-testid="chat-bar"]'), null);
		assert.equal(mem.get(ATTACHED_KEY), undefined);
		window.dispatchEvent(new dom.window.Event("pagehide"));
		await wait();
		assert.equal(mem.get("wolfpack:draft:w:w/a"), "typed on the page", "no stale flush from the bar");
	});

	it("clicking the chip opens the thread page, which docks it", async () => {
		function Path() {
			return <span data-testid="path">{usePathname()}</span>;
		}
		await mount("/kb", A, <Path />);
		await click(q('[data-testid="chat-bar-chip"]'));
		await wait();
		assert.equal(q('[data-testid="path"]')?.textContent, "/wolf/w/thread/a");
		assert.equal(q('[data-testid="chat-bar"]'), null);
		assert.equal(mem.get(ATTACHED_KEY), undefined);
	});

	describe("using another thread's composer docks the bar (user actions only)", () => {
		const pageComposer = (
			<form data-testid="composer">
				<textarea data-testid="page-ta" />
			</form>
		);
		const fire = (el: HTMLElement | null, name: string, init: object = {}) =>
			act(async () => void el!.dispatchEvent(Object.assign(new dom.window.Event(name, { bubbles: true, cancelable: true }), init)));
		const page = () => q('[data-testid="page-ta"]');
		const popped = () => mem.get(ATTACHED_KEY) !== undefined;

		it("viewing B with an autofocused composer does not dock", async () => {
			await mount("/wolf/w/thread/b", A, pageComposer);
			await act(async () => {
				page()!.focus();
				page()!.dispatchEvent(new dom.window.Event("focusin", { bubbles: true }));
			});
			await wait();
			assert.ok(q('[data-testid="chat-bar"]'));
			assert.equal(popped(), true);
		});

		it("clicking B's composer docks, keeping the draft", async () => {
			await mount("/wolf/w/thread/b", A, pageComposer);
			await type("for a");
			await fire(page(), "pointerdown");
			await wait();
			assert.equal(q('[data-testid="chat-bar"]'), null);
			assert.equal(popped(), false);
			assert.equal(mem.get("wolfpack:draft:w:w/a"), "for a");
		});

		it("typing in B's composer docks; a shortcut chord does not", async () => {
			await mount("/wolf/w/thread/b", A, pageComposer);
			await fire(page(), "keydown", { key: "j", metaKey: true });
			assert.equal(popped(), true);
			await fire(page(), "beforeinput");
			await wait();
			assert.equal(popped(), false);
			assert.equal(q('[data-testid="chat-bar"]'), null);
		});

		it("the bar's own textarea and a textarea outside a composer do not dock", async () => {
			await mount("/kb", A, <textarea data-testid="loose" />);
			await fire(ta(), "pointerdown");
			await fire(ta(), "beforeinput");
			await fire(q('[data-testid="loose"]'), "pointerdown");
			await fire(q('[data-testid="loose"]'), "beforeinput");
			assert.equal(popped(), true);
			assert.ok(q('[data-testid="chat-bar"]'));
		});

		it("the popped-out thread's own page does not dock on use (popped out while there)", async () => {
			await mount("/wolf/w/thread/a", undefined, <>{pageComposer}<AttachHere /></>);
			await click(q('[data-testid="test-attach"]'));
			await fire(page(), "pointerdown");
			await fire(page(), "beforeinput");
			assert.equal(popped(), true);
		});

		it("/chat/new docks on a click", async () => {
			await mount("/chat/new", A, pageComposer);
			assert.equal(popped(), true);
			await fire(page(), "pointerdown");
			await wait();
			assert.equal(popped(), false);
		});
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
		await mount("/kb"); // nothing popped out: no bar, Cmd+J does nothing
		assert.equal(q('[data-testid="chat-bar"]'), null);
		assert.equal(press("lh:kbd-focus-chat-bar"), false);
	});

	it("Cmd+J on the popped-out thread's own page focuses the page composer", async () => {
		let focused = false;
		const page = (
			<form data-testid="composer">
				<textarea ref={(el) => { if (el) el.focus = () => void (focused = true); }} />
			</form>
		);
		await mount("/wolf/w/thread/a", undefined, <>{page}<AttachHere /></>);
		await click(q('[data-testid="test-attach"]')); // attached while still on its own page
		let prevented = false;
		window.dispatchEvent(new dom.window.CustomEvent("lh:kbd-focus-chat-bar", { detail: { event: { preventDefault: () => void (prevented = true) } } }));
		assert.ok(focused && prevented);
	});

	it("a live archive of the popped-out thread docks it", async () => {
		await mount("/kb", A);
		assert.equal(JSON.parse(mem.get(ATTACHED_KEY)!).threadId, "w/a");
		archived = true;
		await emit("needs-you-changed", { wolf: "w", threadId: "w/a", status: "idle" });
		await wait();
		assert.equal(mem.get(ATTACHED_KEY), undefined);
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
	it("Cmd+J un-minimizes and focuses; Cmd+Shift+J does nothing (switcher off); a bare j in another input is ignored", async () => {
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
		assert.equal(q('[data-testid="chat-bar-switcher"]'), null, "switcher is off");
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
