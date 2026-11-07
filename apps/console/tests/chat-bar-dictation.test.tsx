/**
 * The floating chat's mic (real mount, fake Deepgram socket + mic): the run lives in ChatBar so it keeps listening while the
 * owner browses; docking by any route finishes it first so the words land in the draft; Cmd+D goes to the right input.
 */
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
	getComputedStyle: () => ({ animationName: "none" }),
});
Object.assign(dom.window.Element.prototype, { attachEvent() {}, detachEvent() {} });
// linkedom does not track focus: record it so document.activeElement answers like a browser.
let focused: Element | null = null;
(dom.window.HTMLElement.prototype as any).focus = function () { focused = this; };
Object.defineProperty(dom.document, "activeElement", { get: () => focused, configurable: true });

// ---- fake mic + Deepgram socket ----
class FakeWS {
	static OPEN = 1;
	static CONNECTING = 0;
	static last: FakeWS | null = null;
	static count = 0;
	readyState = 0;
	private ls = new Map<string, ((ev: unknown) => void)[]>();
	constructor() {
		FakeWS.last = this;
		FakeWS.count++;
	}
	addEventListener(t: string, f: (ev: unknown) => void) {
		this.ls.set(t, [...(this.ls.get(t) ?? []), f]);
	}
	sent: unknown[] = [];
	send(d: unknown) {
		this.sent.push(d);
	}
	close() {
		this.readyState = 3;
	}
	emit(t: string, ev: unknown = {}) {
		for (const f of this.ls.get(t) ?? []) f(ev);
	}
	open() {
		this.readyState = 1;
		this.emit("open");
	}
	final(text: string) {
		this.emit("message", { data: JSON.stringify({ type: "Results", is_final: true, channel: { alternatives: [{ transcript: text }] } }) });
	}
}
class FakeNode {
	port: { onmessage: unknown } = { onmessage: null };
	connect() {}
	disconnect() {}
}
class FakeCtx {
	state = "running";
	destination = {};
	audioWorklet = { addModule: async () => {} };
	createMediaStreamSource() {
		return new FakeNode();
	}
	async resume() {}
}
Object.assign(globalThis, { WebSocket: FakeWS, AudioContext: FakeCtx, AudioWorkletNode: FakeNode });
Object.defineProperty(globalThis, "navigator", {
	configurable: true,
	value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => void stops++ }] }) } },
});

const { usePathname } = await import("next/navigation");
const { AppRouterContext: navCtx } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
const { ServerEventsProvider } = await import("../components/server-events.tsx");
const { SettingsDialogProvider } = await import("../components/settings/settings-dialog.tsx");
const { FakeNav, navLog } = await import("./helpers/fake-nav.tsx");
const { useThreadDictation } = await import("../components/use-thread-dictation.ts");
const { useComposerDraft, appendToDraft, draftKey, writeDraft, useRereadDraftWhenShown } = await import("../lib/composer-draft.ts");
const { AttachedThreadProvider, useAttachedThread } = await import("../components/attached-thread.tsx");
const { ChatBar } = await import("../components/chat-bar.tsx");
const { useDictation, DictationBar, joinDictation, useBarShown } = await import("../components/dictation.tsx");
const { ATTACHED_KEY } = await import("../src/core/chat-bar.ts");

let posts: string[] = [];
let stops = 0;
let tokenFetches = 0;
const realFetch = globalThis.fetch;
const fakeSource = () => ({ close() {}, onOpen() {}, onEvent() {} });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = String(input);
	if (init?.method === "POST") {
		posts.push(url);
		return new Response("{}", { status: 200 });
	}
	if (url.includes("/api/stt/token")) tokenFetches++;
	if (url.includes("/api/stt/token")) return new Response(JSON.stringify({ token: "tok" }), { status: 200 });
	if (url === "/api/wolves") return Response.json({ wolves: [{ name: "w" }] });
	if (url === "/api/wolves/w/threads") return Response.json({ threads: [{ id: "w/a", title: "w/a", kind: "feature", status: "idle" }, { id: "w/b", title: "w/b", kind: "feature", status: "idle" }] });
	return new Response("{}", { status: 404 });
}) as typeof fetch;

/** A page composer as the thread page / new-session build it: the real hook (kind "page") beside a composer textarea. */
function PageComposer() {
	const [text, setText] = React.useState("");
	const d = useDictation({ append: (t) => setText((c) => joinDictation(c, t)) });
	return (
		<form data-testid="composer">
			<textarea data-testid="page-ta" value={text} onChange={(e) => setText(e.target.value)} />
			<div data-testid="page-dictation"><DictationBar dictation={d} /></div>
		</form>
	);
}

/** The composer only on thread pages, as in the app. */
function PageComposerOnThreads() {
	return usePathname()?.startsWith("/wolf/") ? <PageComposer /> : null;
}

let root: Root | null = null;
let go: (u: string) => void = () => {};
function Nav() {
	const r = React.useContext(navCtx as any);
	go = (u) => (r as any).push(u);
	return <span data-testid="path">{usePathname()}</span>;
}
const wait = (ms = 40) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
async function mount(start: string, stored: object | null, extra?: React.ReactNode) {
	if (stored) mem.set(ATTACHED_KEY, JSON.stringify(stored));
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
							<Nav />
							{extra}
						</AttachedThreadProvider>
					</ServerEventsProvider>
				</SettingsDialogProvider>
			</FakeNav>,
		);
	});
	await wait(80);
}
const q = (s: string) => document.querySelector(s) as HTMLElement | null;
const barTa = () => q('[data-testid="chat-bar"] textarea') as HTMLTextAreaElement | null;
const pageTa = () => q('[data-testid="page-ta"]') as HTMLTextAreaElement;
const fire = (el: Element, name: string, init: object = {}) =>
	act(async () => void el.dispatchEvent(Object.assign(new dom.window.Event(name, { bubbles: true, cancelable: true }), init)));
const barToggle = () => q('[data-testid="chat-bar"] [data-testid="dictation-toggle"]')!;
const key = () => act(async () => void window.dispatchEvent(new dom.window.CustomEvent("lh:kbd-toggle-dictation")));
const A = { wolf: "w", slug: "a", threadId: "w/a" };

/** After the run is recording: deliver a final, then the socket closes (the run ends and its transcript flushes). */
async function say(text: string) {
	const ws = FakeWS.last!;
	await act(async () => ws.open());
	await act(async () => ws.final(text));
	return ws;
}
const endRun = (ws: FakeWS) => act(async () => ws.emit("close", { code: 1000 }));

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
	mem.clear();
	posts = [];
	FakeWS.last = null;
	FakeWS.count = 0;
	stops = 0;
	tokenFetches = 0;
	focused = null;
});
after(() => void (globalThis.fetch = realFetch));

describe("floating chat dictation", () => {
	it("keeps listening across a page change and the transcript lands in the floating chat's input, unsent", async () => {
		await mount("/kb", A);
		await fire(barToggle(), "click", { detail: 1 });
		await wait();
		const ws = await say("hello from the graph");
		await act(async () => go("/graph"));
		await wait();
		assert.ok(q('[data-testid="chat-bar-listening"]') ?? q('[data-testid="chat-bar"] [data-testid="dictation-toggle"]'), "bar still there");
		assert.equal(FakeWS.count, 1, "no second run started");
		await fire(barToggle(), "click", { detail: 1 }); // Stop
		await endRun(ws);
		await wait();
		assert.equal(barTa()!.value, "hello from the graph");
		await wait(400); // the draft write is debounced
		assert.equal(mem.get("wolfpack:draft:w:w/a"), "hello from the graph");
		assert.deepEqual(posts, []);
	});

	it("Enter while dictating finishes the run then sends the spoken text", async () => {
		await mount("/kb", A);
		await fire(barToggle(), "click", { detail: 1 });
		await wait();
		const ws = await say("send this");
		await fire(q('[data-testid="chat-bar"] form')!, "submit");
		await endRun(ws);
		await wait();
		assert.ok(posts.some((u) => u.endsWith("/threads/a/submit")));
		assert.equal(barTa()!.value, "");
	});

	describe("docking while dictating finishes the run first, so the words land in the draft", () => {
		async function dictating() {
			await fire(barToggle(), "click", { detail: 1 });
			await wait();
			return say("spoken words");
		}
		const docked = () => {
			assert.equal(q('[data-testid="chat-bar"]'), null);
			assert.equal(mem.get(ATTACHED_KEY), undefined);
			assert.equal(mem.get("wolfpack:draft:w:w/a"), "spoken words");
			assert.deepEqual(posts, []);
		};

		it("the Dock button", async () => {
			await mount("/kb", A);
			const ws = await dictating();
			await fire(q('[data-testid="chat-bar-dock"]')!, "click");
			assert.ok(q('[data-testid="chat-bar"]'), "still there until the run has ended");
			await endRun(ws);
			await wait();
			docked();
		});

		it("clicking into another thread's composer", async () => {
			await mount("/wolf/w/thread/b", A, <PageComposer />);
			const ws = await dictating();
			await fire(pageTa(), "pointerdown");
			await endRun(ws);
			await wait();
			docked();
		});

		it("the chip, which opens the thread page", async () => {
			await mount("/kb", A);
			const ws = await dictating();
			await fire(q('[data-testid="chat-bar-chip"]')!, "click");
			await endRun(ws);
			await wait();
			assert.equal(q('[data-testid="path"]')!.textContent, "/wolf/w/thread/a");
			docked();
		});
	});

	describe("Cmd+D goes to the right input", () => {
		async function dictateByKey(text: string) {
			await key();
			await wait();
			const ws = await say(text);
			await key(); // stop
			await endRun(ws);
			await wait();
		}

		it("focus in the floating chat → the floating chat, even on a page with its own composer", async () => {
			await mount("/wolf/w/thread/b", A, <PageComposer />);
			barTa()!.focus();
			await dictateByKey("to the bar");
			assert.equal(barTa()!.value, "to the bar");
			assert.equal(pageTa().value, "");
		});

		it("a page with its own composer and focus elsewhere → that page's composer", async () => {
			await mount("/wolf/w/thread/b", A, <PageComposer />);
			pageTa().focus();
			await dictateByKey("to the page");
			assert.equal(pageTa().value, "to the page");
			assert.equal(barTa()!.value, "");
		});

		it("any other page → the floating chat; and a run in progress is not stolen by navigation", async () => {
			await mount("/graph", A, <PageComposerOnThreads />);
			await dictateByKey("to the bar from the graph");
			assert.equal(barTa()!.value, "to the bar from the graph");
			// A live run keeps its owner when a page with a composer mounts: the next Cmd+D stops it, it does not start a second.
			await key();
			await wait();
			const ws = await say("still the bar");
			await act(async () => go("/wolf/w/thread/b"));
			await wait();
			await key();
			await endRun(ws);
			await wait();
			assert.equal(FakeWS.count, 2, "one run per toggle pair");
			await wait(400);
			assert.match(mem.get("wolfpack:draft:w:w/a") ?? "", /still the bar/);
			assert.equal(pageTa().value, "", "the page composer got nothing");
		});

		it("with nothing popped out Cmd+D starts nothing", async () => {
			await mount("/graph", null);
			await key();
			await wait();
			assert.equal(FakeWS.count, 0);
		});
	});
});

/** A thread page's composer as thread-chat builds it: draft restored from storage at mount, text kept in a ref. */
function PageDraftComposer() {
	const api = useAttachedThread();
	const barShown = useBarShown();
	const [text, setText] = React.useState("");
	const textRef = React.useRef("");
	const schedule = useComposerDraft("w", "w/a", textRef, (v) => {
		textRef.current = v;
		setText(v);
	});
	// The floating chat replaces this composer while it owns the input (as ThreadChat does).
	const hidden = api?.attached?.threadId === "w/a" && barShown;
	useRereadDraftWhenShown(hidden, "w", "w/a", textRef, (v) => {
		textRef.current = v;
		setText(v);
	});
	if (hidden) return null;
	return (
		<form data-testid="composer">
			<textarea data-testid="page-ta" value={text} onChange={(e) => (textRef.current = e.target.value, setText(e.target.value), schedule(e.target.value))} />
		</form>
	);
}
const OnThreadA = () => (usePathname() === "/wolf/w/thread/a" ? <PageDraftComposer /> : null);

describe("floating chat dictation: docking details", () => {
	it("Dock finishes only the bar's run: a page composer's live run keeps going", async () => {
		await mount("/wolf/w/thread/b", A, <PageComposer />);
		await fire(q('[data-testid="page-dictation"] [data-testid="dictation-toggle"]')!, "click", { detail: 1 });
		await wait();
		const ws = FakeWS.last!;
		await act(async () => ws.open());
		await fire(q('[data-testid="chat-bar-dock"]')!, "click");
		await wait();
		assert.equal(q('[data-testid="chat-bar"]'), null, "docked");
		assert.equal(ws.sent.some((m) => typeof m === "string" && m.includes("CloseStream")), false, "the page run was not told to stop");
		assert.equal(ws.readyState, 1);
	});

	it("a second dock-path click while the first waits for the run does nothing", async () => {
		await mount("/kb", A);
		await fire(barToggle(), "click", { detail: 1 });
		await wait();
		const ws = await say("words");
		const before = navLog.stack.length;
		await fire(q('[data-testid="chat-bar-chip"]')!, "click");
		await fire(q('[data-testid="chat-bar-chip"]')!, "click");
		await endRun(ws);
		await wait();
		assert.equal(navLog.stack.length, before + 1, "one navigation");
	});

	it("landing on the thread's page while the bar dictates keeps the run; stopping there returns the page composer with the words", async () => {
		await mount("/kb", A, <OnThreadA />);
		await fire(barToggle(), "click", { detail: 1 });
		await wait();
		const ws = await say("the tail");
		await act(async () => go("/wolf/w/thread/a"));
		await wait();
		assert.equal(ws.readyState, 1, "landing did not stop the run");
		assert.equal(document.querySelectorAll('[data-testid="page-ta"]').length, 0, "the floating chat replaces the page composer");
		await fire(barToggle(), "click", { detail: 1 });
		await endRun(ws);
		await wait();
		assert.equal(q('[data-testid="chat-bar"]'), null, "docked");
		assert.equal(pageTa().value, "the tail");
		assert.equal(mem.get("wolfpack:draft:w:w/a"), "the tail");
	});
});

describe("a mounted composer keeps both the owner's edit and the dictated tail", () => {
	it("phone (no dock on thread pages): an edited page composer ends with its text plus the tail, and the store keeps both after the next debounced write", async () => {
		const w = window as unknown as { matchMedia?: unknown };
		w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
		try {
			await mount("/kb", A, <OnThreadA />);
			await fire(barToggle(), "click", { detail: 1 });
			await wait();
			const ws = await say("the tail");
			await act(async () => go("/wolf/w/thread/a"));
			await wait();
			const type = (v: string) =>
				act(async () => {
					const el = pageTa();
					el.value = v;
					const k = Object.keys(el).find((x) => x.startsWith("__reactProps$"))!;
					(el as any)[k].onChange({ target: el, currentTarget: el });
				});
			await type("typed meanwhile");
			await endRun(ws);
			await wait();
			assert.equal(pageTa().value, "typed meanwhile the tail");
			assert.equal(mem.get("wolfpack:draft:w:w/a"), "typed meanwhile the tail", "store updated at once");
			await type("typed meanwhile the tail, and more");
			await wait(400);
			assert.equal(mem.get("wolfpack:draft:w:w/a"), "typed meanwhile the tail, and more");
		} finally {
			delete w.matchMedia;
		}
	});
});

describe("useDictation lifecycle", () => {
	it("unmounting mid-run stops the mic and closes the socket, and sends the received words to onOrphan (never to append)", async () => {
		const appended: string[] = [];
		const orphaned: string[] = [];
		function Probe() {
			const d = useDictation({ append: (t) => void appended.push(t), onOrphan: (t) => void orphaned.push(t) });
			return <DictationBar dictation={d} />;
		}
		await mount("/kb", null);
		const host = document.createElement("div");
		document.body.appendChild(host);
		const probe = createRoot(host);
		await act(async () => probe.render(<SettingsDialogProvider><Probe /></SettingsDialogProvider>));
		await fire(host.querySelector('[data-testid="dictation-toggle"]')!, "click", { detail: 1 });
		await wait();
		const ws = await say("never lands");
		await act(async () => probe.unmount());
		assert.equal(ws.readyState, 3, "socket closed");
		assert.ok(stops >= 1, "mic track stopped");
		assert.deepEqual(appended, []);
		assert.deepEqual(orphaned, ["never lands"]);
	});

	it("the bar unmounting mid-run saves the received words into the popped-out thread's draft", async () => {
		await mount("/kb", A);
		await fire(barToggle(), "click", { detail: 1 });
		await wait();
		const ws = await say("bar words");
		await act(async () => root?.unmount());
		root = null;
		assert.equal(ws.readyState, 3, "socket closed");
		assert.ok(stops >= 1, "mic stopped");
		assert.equal(mem.get("wolfpack:draft:w:w/a"), "bar words");
	});

	it("the page hook pre-mints the token at mount; the bar's only once something is popped out", async () => {
		await mount("/kb", null, <AttachBtn />);
		assert.equal(tokenFetches, 0, "bar hook idle with nothing popped out");
		await fire(q('[data-testid="test-attach"]')!, "click");
		await wait();
		assert.ok(tokenFetches >= 1, "pre-minted once popped out");
		await act(async () => root?.unmount());
		root = null;
		tokenFetches = 0;
		document.body.innerHTML = "";
		await mount("/wolf/w/thread/b", null, <PageComposer />);
		assert.ok(tokenFetches >= 1, "a page composer's hook pre-mints at mount");
	});
});

/** Test stand-in for "something got popped out" (the product has no Pop out button; dictation does it). */
function AttachBtn() {
	const api = useAttachedThread();
	return <button type="button" data-testid="test-attach" onClick={() => api!.attach({ wolf: "w", threadId: "w/a", slug: "a" })} />;
}

/** A thread page as ThreadChat wires it: draft composer + the page's dictation hook (the page's dictation bar hides while the floating chat shows the run). */
function ThreadPage({ slug }: { slug: "a" | "b" }) {
	const id = `w/${slug}`;
	const [text, setText] = React.useState("");
	const textRef = React.useRef("");
	const schedule = useComposerDraft("w", id, textRef, (v) => {
		textRef.current = v;
		setText(v);
	});
	const api = useAttachedThread();
	const barShown = useBarShown();
	const barOwns = api?.attached?.threadId === id && barShown;
	const d = useThreadDictation(
		"w",
		slug,
		id,
		(t) => {
			const v = joinDictation(textRef.current, t);
			textRef.current = v;
			setText(v);
			schedule(v);
		},
		(t) => appendToDraft(draftKey("w", id), t),
		() => writeDraft(draftKey("w", id), textRef.current),
	);
	// The floating chat replaces the composer while it owns the input; on return the composer re-reads the draft.
	useRereadDraftWhenShown(barOwns, "w", id, textRef, (v) => {
		textRef.current = v;
		setText(v);
	});
	if (barOwns) return null;
	return (
		<form data-testid="composer">
			<textarea data-testid="page-ta" value={text} onChange={(e) => (textRef.current = e.target.value, setText(e.target.value), schedule(e.target.value))} />
			<div data-testid="page-dictation"><DictationBar dictation={d} /></div>
		</form>
	);
}
const OnPageA = () => (usePathname() === "/wolf/w/thread/a" ? <ThreadPage slug="a" /> : null);
const OnPages = () => {
	const p = usePathname();
	return p === "/wolf/w/thread/a" ? <ThreadPage slug="a" /> : p === "/wolf/w/thread/b" ? <ThreadPage slug="b" /> : p === "/chat/new" ? <NewPage /> : null;
};
/** /chat/new: no thread yet, a plain page hook that saves orphaned words to a draft. */
function NewPage() {
	const d = useDictation({ append: () => {}, onOrphan: (t) => appendToDraft(draftKey("w", "new"), t) });
	return (
		<form data-testid="composer">
			<textarea data-testid="page-ta" />
			<div data-testid="page-dictation"><DictationBar dictation={d} /></div>
		</form>
	);
}
/** Microtask ticks between two presses: lands after the handoff started but before the bar run is live. */
const TICKS = 2;
const pageComposerCount = () => document.querySelectorAll('form[data-testid="composer"]').length - document.querySelectorAll('[data-testid="chat-bar"] form[data-testid="composer"]').length;
const typeInBar = (v: string) =>
	act(async () => {
		const el = barTa()!;
		el.value = v;
		const k = Object.keys(el).find((x) => x.startsWith("__reactProps$"))!;
		(el as any)[k].onChange({ target: el, currentTarget: el });
	});
const pageToggle = () => q('[data-testid="page-dictation"] [data-testid="dictation-toggle"]')!;

describe("dictation for a thread follows the owner, and stopping decides where the chat goes", () => {
	it("the mic on a thread page pops it out; the floating chat replaces the page composer, with its input and the one meter", async () => {
		await mount("/wolf/w/thread/a", null, <OnPageA />);
		await fire(pageToggle(), "click", { detail: 1 });
		await wait();
		assert.equal(JSON.parse(mem.get(ATTACHED_KEY)!).threadId, "w/a", "popped out");
		assert.equal(FakeWS.count, 1);
		assert.ok(q('[data-testid="chat-bar"]'), "the floating chat is visible on its own thread's page while dictating");
		assert.equal(pageComposerCount(), 0, "the page composer is gone: the floating chat replaces it");
		assert.ok(barTa(), "the floating chat shows its input");
		assert.equal(document.querySelectorAll('[data-testid="dictation-bar"]').length, 1, "one meter");
		assert.equal(q('[data-testid="page-dictation"]'), null);
	});

	it("dictate, leave, come back to the page: still dictating, the floating chat visible, not docked", async () => {
		await mount("/wolf/w/thread/a", null, <OnPageA />);
		await fire(pageToggle(), "click", { detail: 1 });
		await wait();
		const ws = await say("round trip");
		await act(async () => go("/graph"));
		await wait();
		assert.equal(ws.readyState, 1, "still live after leaving");
		await act(async () => go("/wolf/w/thread/a"));
		await wait();
		assert.equal(ws.readyState, 1, "still live after coming back");
		assert.equal(ws.sent.some((m) => typeof m === "string" && m.includes("CloseStream")), false, "coming back did not ask the run to finish");
		assert.ok(q('[data-testid="chat-bar"]'), "visible on the page");
		assert.ok(JSON.parse(mem.get(ATTACHED_KEY)!), "not docked");
		assert.equal(FakeWS.count, 1);
	});

	it("stopped on the thread's own page, it docks and the words are in the page composer, unsent", async () => {
		await mount("/wolf/w/thread/a", null, <OnPageA />);
		await fire(pageToggle(), "click", { detail: 1 });
		await wait();
		const ws = await say("on the page");
		await fire(barToggle(), "click", { detail: 1 }); // the meter is the floating chat's; stop there
		await endRun(ws);
		await wait();
		assert.equal(q('[data-testid="chat-bar"]'), null, "docked");
		assert.equal(mem.get(ATTACHED_KEY), undefined);
		assert.equal(pageTa().value, "on the page");
		assert.deepEqual(posts, []);
	});

	it("the floating input holds the existing draft; typing in it while dictating, then stopping on the page, returns the composer with typed plus dictated, unsent", async () => {
		mem.set("wolfpack:draft:w:w/a", "earlier draft");
		await mount("/wolf/w/thread/a", null, <OnPageA />);
		assert.equal(pageTa().value, "earlier draft");
		await fire(pageToggle(), "click", { detail: 1 });
		await wait();
		assert.equal(barTa()!.value, "earlier draft", "the chat's input reads the page draft");
		const ws = await say("dictated");
		await typeInBar("earlier draft, typed");
		await fire(barToggle(), "click", { detail: 1 });
		await endRun(ws);
		await wait();
		assert.equal(q('[data-testid="chat-bar"]'), null, "docked");
		assert.equal(pageTa().value, "earlier draft, typed dictated");
		assert.equal(mem.get("wolfpack:draft:w:w/a"), "earlier draft, typed dictated");
		assert.deepEqual(posts, []);
	});

	it("started on the page, stopped after leaving: the floating chat stays with the words in its input, unsent", async () => {
		await mount("/wolf/w/thread/a", null, <OnPageA />);
		await fire(pageToggle(), "click", { detail: 1 });
		await wait();
		const ws = await say("carried along");
		await act(async () => go("/graph"));
		await wait();
		assert.ok(q('[data-testid="chat-bar-listening"]'), "the floating chat shows it listening");
		await key(); // Cmd+D stops it
		await endRun(ws);
		await wait();
		assert.ok(q('[data-testid="chat-bar"]'), "stays");
		assert.equal(barTa()!.value, "carried along");
		assert.deepEqual(posts, []);
	});

	it("Cmd+J on the own page while dictating focuses the floating input", async () => {
		await mount("/wolf/w/thread/a", null, <OnPageA />);
		await fire(pageToggle(), "click", { detail: 1 });
		await wait();
		assert.ok(barTa());
		await act(async () => window.dispatchEvent(new dom.window.CustomEvent("lh:kbd-focus-chat-bar", { detail: {} })));
		await wait();
		assert.equal(document.activeElement, barTa());
	});

	it("Esc cancel on the thread's own page docks and the composer returns with only the typed text; elsewhere the chat stays", async () => {
		await mount("/wolf/w/thread/a", null, <OnPageA />);
		await fire(pageToggle(), "click", { detail: 1 });
		await wait();
		await say("thrown away");
		await typeInBar("typed only");
		await act(async () => window.dispatchEvent(new dom.window.CustomEvent("lh:kbd-cancel-dictation")));
		await wait();
		assert.equal(q('[data-testid="chat-bar"]'), null, "docked");
		assert.equal(pageTa().value, "typed only", "the composer returns with only the typed text");
		await act(async () => root?.unmount());
		root = null;
		mem.clear();
		document.body.innerHTML = "";
		await mount("/kb", A);
		await fire(barToggle(), "click", { detail: 1 });
		await wait();
		await say("also thrown away");
		await act(async () => window.dispatchEvent(new dom.window.CustomEvent("lh:kbd-cancel-dictation")));
		await wait();
		assert.ok(q('[data-testid="chat-bar"]'), "stays elsewhere");
		assert.equal(barTa()!.value, "");
	});

	it("not dictating, popped out: landing on the thread's page docks it, as before", async () => {
		await mount("/kb", A, <OnPageA />);
		assert.ok(q('[data-testid="chat-bar"]'));
		await act(async () => go("/wolf/w/thread/a"));
		await wait();
		assert.equal(q('[data-testid="chat-bar"]'), null);
		assert.equal(mem.get(ATTACHED_KEY), undefined);
	});

	it("phone: on a thread page the dock stays off, so the page keeps the one meter; stopping there docks, and elsewhere the dock stays", async () => {
		const w = window as unknown as { matchMedia?: unknown };
		w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
		try {
			await mount("/wolf/w/thread/a", null, <OnPageA />);
			await fire(pageToggle(), "click", { detail: 1 });
			await wait();
			assert.equal(q('[data-testid="chat-bar"]'), null, "no dock over the page composer");
			assert.equal(document.querySelectorAll('[data-testid="dictation-bar"]').length, 1, "the page keeps the one meter");
			const ws = await say("phone words");
			await act(async () => go("/graph"));
			await wait();
			assert.equal(q('[data-testid="chat-bar"]')?.getAttribute("data-layout"), "dock", "the dock follows elsewhere");
			assert.equal(ws.readyState, 1);
			await act(async () => go("/wolf/w/thread/a"));
			await wait();
			assert.equal(q('[data-testid="chat-bar"]'), null);
			assert.equal(ws.readyState, 1, "coming back does not stop it");
			await fire(pageToggle(), "click", { detail: 1 });
			await endRun(ws);
			await wait();
			assert.equal(mem.get(ATTACHED_KEY), undefined, "stopped on its own page: docked");
			assert.equal(pageTa().value, "phone words");
		} finally {
			delete w.matchMedia;
		}
	});

	it("phone: a live run for another thread on a thread page shows a minimal listening pill with Stop", async () => {
		const w = window as unknown as { matchMedia?: unknown };
		w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
		try {
			await mount("/kb", A, <OnPages />);
			await fire(barToggle(), "click", { detail: 1 });
			await wait();
			const ws = await say("phone words for A");
			await act(async () => go("/wolf/w/thread/b"));
			await wait();
			assert.equal(q('[data-testid="chat-bar"]'), null, "no dock over B's composer");
			assert.ok(q('[data-testid="chat-bar-listening-pill"]'), "a pill shows the live run");
			assert.equal(document.querySelectorAll('[data-testid="dictation-meter"]').length, 1, "the pill carries one live meter");
			assert.ok(q('[data-testid="chat-bar-listening-pill"] [data-testid="dictation-meter"]'));
			await fire(q('[data-testid="chat-bar-listening-stop"]')!, "click");
			await endRun(ws);
			await wait(400);
			assert.equal(q('[data-testid="chat-bar-listening-pill"]'), null);
			assert.equal(mem.get("wolfpack:draft:w:w/a"), "phone words for A", "words saved to A's draft");
			assert.equal(document.querySelectorAll('[data-testid="dictation-meter"]').length, 0, "no meter once stopped");
		} finally {
			delete w.matchMedia;
		}
	});

	it("desktop minimized pill: one live meter while dictating, none when idle", async () => {
		await mount("/kb", A);
		await fire(q('[data-testid="chat-bar-minimize"]')!, "click");
		await wait();
		assert.equal(q('[data-testid="chat-bar"]')?.getAttribute("data-state"), "minimized");
		assert.equal(document.querySelectorAll('[data-testid="dictation-meter"]').length, 0, "idle: no meter");
		await act(async () => window.dispatchEvent(new dom.window.CustomEvent("lh:kbd-toggle-dictation")));
		await wait();
		await say("words");
		assert.equal(document.querySelectorAll('[data-testid="dictation-meter"]').length, 1, "dictating: exactly one meter");
		assert.ok(q('[data-testid="chat-bar"] [data-testid="dictation-meter"]'));
		await act(async () => window.dispatchEvent(new dom.window.CustomEvent("lh:kbd-toggle-dictation")));
		await endRun(FakeWS.last!);
		await wait();
		assert.equal(document.querySelectorAll('[data-testid="dictation-meter"]').length, 0, "stopped: no meter");
	});

	it("phone minimized dock: one live meter while dictating, none when idle", async () => {
		const w = window as unknown as { matchMedia?: unknown };
		w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
		try {
			await mount("/kb", A);
			await fire(q('[data-testid="chat-bar-minimize"]')!, "click");
			await wait();
			assert.equal(q('[data-testid="chat-bar"]')?.getAttribute("data-state"), "minimized");
			assert.equal(document.querySelectorAll('[data-testid="dictation-meter"]').length, 0);
			await act(async () => window.dispatchEvent(new dom.window.CustomEvent("lh:kbd-toggle-dictation")));
			await wait();
			await say("words");
			assert.equal(document.querySelectorAll('[data-testid="dictation-meter"]').length, 1);
			await act(async () => window.dispatchEvent(new dom.window.CustomEvent("lh:kbd-toggle-dictation")));
			await endRun(FakeWS.last!);
			await wait();
			assert.equal(document.querySelectorAll('[data-testid="dictation-meter"]').length, 0);
		} finally {
			delete w.matchMedia;
		}
	});

	it("there is no Pop out button on a thread page", async () => {
		await mount("/wolf/w/thread/a", null, <OnPageA />);
		assert.equal(q('[data-testid="pop-out"]'), null);
		assert.equal(q('[aria-label="Pop out this chat"]'), null);
	});

	it("the mic on a thread page that is not popped out pops it out, and leaving keeps the run live", async () => {
		await mount("/wolf/w/thread/a", null, <OnPageA />);
		await fire(pageToggle(), "click", { detail: 1 });
		await wait();
		const ws = await say("popped by the mic");
		await act(async () => go("/graph"));
		await wait();
		assert.equal(ws.readyState, 1, "still live");
		assert.ok(q('[data-testid="chat-bar-listening"]'));
	});

	it("Cmd+D on a thread page that is not popped out does the same", async () => {
		await mount("/wolf/w/thread/a", null, <OnPageA />);
		await key();
		await wait();
		assert.equal(JSON.parse(mem.get(ATTACHED_KEY)!).threadId, "w/a");
		const ws = await say("popped by keyboard");
		await act(async () => go("/graph"));
		await wait();
		assert.equal(ws.readyState, 1);
		assert.equal(FakeWS.count, 1, "one run");
	});

	it("with thread A popped out, dictating on B's page pops out B and A's words land in A's draft", async () => {
		await mount("/kb", A, <OnPages />);
		await fire(barToggle(), "click", { detail: 1 });
		await wait();
		const wsA = await say("words for A");
		await act(async () => go("/wolf/w/thread/b"));
		await wait();
		await fire(pageToggle(), "click", { detail: 1 });
		await wait();
		await endRun(wsA);
		await wait(400);
		assert.equal(mem.get("wolfpack:draft:w:w/a"), "words for A");
		assert.equal(JSON.parse(mem.get(ATTACHED_KEY)!).threadId, "w/b");
		assert.equal(FakeWS.count, 2, "a new run for B");
		assert.equal(FakeWS.last!.readyState, 0, "B's run was started");
		await act(async () => FakeWS.last!.open());
		assert.ok(q('[data-testid="chat-bar"]'), "B's chat shows on B's own page while it dictates: A's stop did not dock B");
		assert.ok(q('[data-testid="chat-bar-listening"]'));
	});

	it("handoff A to B on B's own page: B's run goes live even when A's stop and B's attach land together", async () => {
		await mount("/wolf/w/thread/b", A, <OnPages />);
		await fire(barToggle(), "click", { detail: 1 });
		await wait();
		const wsA = await say("words for A");
		await act(async () => {
			pageToggle().dispatchEvent(Object.assign(new dom.window.Event("click", { bubbles: true, cancelable: true }), { detail: 1 }));
			wsA.emit("close", { code: 1000 });
			for (let i = 0; i < 10; i++) await Promise.resolve(); // keep the finish + attach inside this one batch
		});
		await wait();
		await wait();
		assert.equal(mem.get("wolfpack:draft:w:w/a"), "words for A");
		assert.equal(JSON.parse(mem.get(ATTACHED_KEY)!).threadId, "w/b", "B popped out, not docked");
		assert.equal(FakeWS.count, 2, "B's run started");
		const wsB = FakeWS.last!;
		await act(async () => wsB.open());
		assert.ok(q('[data-testid="chat-bar-listening"]'));
	});

	it("a handoff whose bar run never goes live is dropped after the timeout, so it cannot start a surprise run later", async () => {
		// No ChatBar mounted: the page's start attaches the thread and waits for a bar that never publishes.
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		const realSet = globalThis.setTimeout;
		(globalThis as any).setTimeout = ((fn: () => void, ms?: number, ...a: unknown[]) => realSet(fn, ms === 4000 ? 30 : ms, ...a)) as typeof setTimeout;
		try {
			const tree = (withBar: boolean) => (
				<FakeNav start="/wolf/w/thread/a">
					<SettingsDialogProvider>
						<ServerEventsProvider connect={fakeSource}>
							<AttachedThreadProvider>
								{withBar ? <ChatBar /> : null}
								<Nav />
								<OnPageA />
							</AttachedThreadProvider>
						</ServerEventsProvider>
					</SettingsDialogProvider>
				</FakeNav>
			);
			await act(async () => root!.render(tree(false)));
			await wait(80);
			await fire(pageToggle(), "click", { detail: 1 });
			await wait(200);
			await act(async () => root!.render(tree(true)));
			await wait(200);
			assert.equal(FakeWS.count, 0, "no surprise run once the bar appears");
		} finally {
			globalThis.setTimeout = realSet;
		}
	});

	it("Cmd+D stopping on the thread's own page docks it, with the words in the page composer", async () => {
		await mount("/wolf/w/thread/a", null, <OnPageA />);
		await fire(pageToggle(), "click", { detail: 1 });
		await wait();
		const ws = await say("by keyboard stop");
		await key();
		await endRun(ws);
		await wait();
		assert.equal(q('[data-testid="chat-bar"]'), null, "docked");
		assert.equal(mem.get(ATTACHED_KEY), undefined);
		assert.equal(pageTa().value, "by keyboard stop");
	});

	it("on its own page the floating chat reserves its height so it never covers the page composer", async () => {
		await mount("/wolf/w/thread/a", null, <OnPageA />);
		assert.equal(document.documentElement.style.getPropertyValue("--chat-bar-reserve"), "");
		await fire(pageToggle(), "click", { detail: 1 });
		await wait();
		assert.notEqual(document.documentElement.style.getPropertyValue("--chat-bar-reserve"), "", "reserved while dictating on its page");
		const ws = FakeWS.last!;
		await act(async () => ws.open());
		await fire(barToggle(), "click", { detail: 1 });
		await endRun(ws);
		await wait();
		assert.equal(document.documentElement.style.getPropertyValue("--chat-bar-reserve"), "", "released once docked");
	});

	it("a double press of the mic during the pop-out handoff gives one run", async () => {
		await mount("/wolf/w/thread/a", null, <OnPageA />);
		await act(async () => {
			const el = pageToggle();
			el.dispatchEvent(Object.assign(new dom.window.Event("click", { bubbles: true, cancelable: true }), { detail: 1 }));
			for (let i = 0; i < TICKS; i++) await Promise.resolve();
			el.dispatchEvent(Object.assign(new dom.window.Event("click", { bubbles: true, cancelable: true }), { detail: 1 }));
		});
		await wait();
		await wait();
		assert.equal(FakeWS.count, 1, "one run");
		const ws = FakeWS.last!;
		await act(async () => ws.open());
		await endRun(ws);
		await wait();
		assert.equal(FakeWS.count, 1, "no surprise second run after the first ends");
	});

	it("Cmd+D right after the pop-out (before the page hook is disabled) gives one run", async () => {
		await mount("/wolf/w/thread/a", null, <OnPageA />);
		await act(async () => {
			pageToggle().dispatchEvent(Object.assign(new dom.window.Event("click", { bubbles: true, cancelable: true }), { detail: 1 }));
			for (let i = 0; i < TICKS; i++) await Promise.resolve();
			window.dispatchEvent(new dom.window.CustomEvent("lh:kbd-toggle-dictation"));
		});
		await wait();
		await wait();
		assert.equal(FakeWS.count, 1, "one run");
		const ws = FakeWS.last!;
		await act(async () => ws.open());
		await endRun(ws);
		await wait();
		assert.equal(FakeWS.count, 1, "no surprise second run after the first ends");
	});

	it("/chat/new has no thread to pop out: its own run, and leaving saves the words and stops the mic", async () => {
		await mount("/chat/new", null, <OnPages />);
		await fire(pageToggle(), "click", { detail: 1 });
		await wait();
		const ws = await say("new chat words");
		assert.equal(mem.get(ATTACHED_KEY), undefined, "nothing popped out");
		await act(async () => go("/graph"));
		await wait();
		assert.equal(ws.readyState, 3, "socket closed");
		assert.equal(mem.get("wolfpack:draft:w:new"), "new chat words");
	});
});
