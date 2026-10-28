/** The Subagent modal (real mount): header, ledger, read-only transcript, steer vs resume, Stop. Over a fake ConsoleClient via the thread API handlers. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
	ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
	getComputedStyle: () => ({ animationName: "none" }),
});

// linkedom has no focus model: track it (the overlay's trap and restore read document.activeElement).
let focused: Element | null = null;
(dom.window.Element.prototype as unknown as { focus: () => void }).focus = function (this: Element) {
	focused = this;
};
Object.defineProperty(dom.document, "activeElement", { get: () => focused ?? dom.document.body, configurable: true });

type ConsoleClient = import("@wolfpack/client").ConsoleClient;
type ThreadSummary = import("@wolfpack/client").ThreadSummary;
type LedgerEntry = import("@wolfpack/client").LedgerEntry;
const { BusyError } = await import("@wolfpack/client");
const { threadFetch } = await import("./helpers/thread-fetch.ts");
const { SubagentModal, SubagentModalProvider, useSubagentModal, ledgerSender, userMessageSenders, messageHint, formatElapsed, formatTokens } = await import("../components/subagent-modal.tsx");
const { ServerEventsProvider } = await import("../components/server-events.tsx");
const { PANELS } = await import("../components/panel-host.tsx");

const CHILD = "w/sub-1";
const base: ThreadSummary = { id: CHILD, wolf: "w", kind: "subagent", title: "Audit the routes", agent: "scout", parentThreadId: "w/home", state: "running", startedAt: new Date(Date.now() - 65_000).toISOString(), tokens: 12_345, taskId: "work-w-abc" };
const LEDGER: LedgerEntry[] = [
	{ id: 2, at: "2026-10-27T10:01:00.000Z", from: "owner", to: "child", kind: "steer", text: "look at /v1 too" },
	{ id: 1, at: "2026-10-27T10:00:00.000Z", from: "parent", to: "child", kind: "brief", text: "audit it" },
];

function fake(summary: Partial<ThreadSummary>) {
	const calls = { aborts: 0, submits: [] as { input: string; whenBusy?: string }[] };
	const state = { summary: { ...base, ...summary }, ledger: LEDGER };
	// The child's real state, which the summary may lag behind (stale-state tests flip it without the summary).
	const live = { running: summary.state === undefined || summary.state === "running", submitError: false };
	const running = () => live.running;
	const client = {
		listThreads: async () => [{ id: "w/home", wolf: "w", kind: "home", title: "Home" }, state.summary],
		listChildren: async () => [state.summary],
		getThread: async () => ({
			...state.summary,
			busy: false,
			lastEventId: 0,
			messages: [
				{ id: "m1", role: "user", text: "audit it", at: "2026-10-27T10:00:00.000Z" },
				{ id: "m2", role: "assistant", text: "Found two routes.", at: "2026-10-27T10:00:05.000Z" },
			],
		}),
		getLedger: async () => state.ledger,
		abort: async () => {
			calls.aborts++;
			if (live.submitError) throw new Error("stop refused");
		},
		submit: async (_id: string, input: string, opts?: { whenBusy?: string }) => {
			calls.submits.push({ input, whenBusy: opts?.whenBusy });
			if (live.submitError) throw new Error("wolf unreachable");
			// reject on a running child and steer on an idle one are both 409s
			if ((opts?.whenBusy === "reject" && running()) || (opts?.whenBusy === "steer" && !running())) throw new BusyError("busy");
			return { disposition: running() ? "steered" : "started" };
		},
		watch: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }) }),
	} as unknown as ConsoleClient;
	return { client, calls, state, live };
}

let root: Root | null = null;
const closed: number[] = [];
const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const qa = (sel: string) => [...document.querySelectorAll(sel)] as HTMLElement[];
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 30))));
/** linkedom does not deliver `input` to React's change plugin: call the field's onChange prop with the new value. */
const type = (ta: HTMLTextAreaElement, v: string) =>
	act(async () => {
		const key = Object.keys(ta).find((k) => k.startsWith("__reactProps$"))!;
		(ta as unknown as Record<string, { onChange: (e: unknown) => void }>)[key]!.onChange({ target: { value: v } });
	});
const frames = new Map<string, (d: string) => void>();
let resync: () => void = () => {};
const inert = () => ({ close() {}, onOpen: (cb: () => void) => void (resync = cb), onEvent: (n: string, cb: (d: string) => void) => void frames.set(n, cb) });
const fire = (thread: Partial<ThreadSummary>) => act(async () => frames.get("thread-updated")!(JSON.stringify({ wolf: "w", thread: { ...base, ...thread } })));
async function mount(f: ReturnType<typeof fake>) {
	(globalThis as Record<string, unknown>).fetch = threadFetch(f.client);
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(
			<ServerEventsProvider connect={inert}>
				<SubagentModal wolf="w" childThreadId={CHILD} onClose={() => void closed.push(1)} />
			</ServerEventsProvider>,
		);
	});
	await settle();
}
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});

describe("subagent modal", () => {
	it("is no longer a side panel", () => {
		assert.equal(PANELS.some((p) => p.id === "subagent"), false);
	});

	it("pure helpers", () => {
		assert.equal(ledgerSender({ from: "owner", to: "child" }), "you → child");
		assert.deepEqual(userMessageSenders(["a", "b", "a"], [
			{ id: 1, at: "", from: "parent", to: "child", kind: "brief", text: "a" },
			{ id: 2, at: "", from: "owner", to: "child", kind: "steer", text: "b" },
			{ id: 3, at: "", from: "child", to: "parent", kind: "result", text: "a" },
		]), ["parent", "owner", "parent"]);
		assert.equal(messageHint("running").mode, "steer");
		assert.equal(messageHint("done").mode, "resume");
		assert.equal(formatElapsed(65_000), "1m 5s");
		assert.equal(formatTokens(12_345), "12k");
	});

	it("running: header facts, Stop aborts, transcript, ledger in order", async () => {
		const f = fake({});
		await mount(f);
		assert.equal(q('[data-testid="subagent-title"]')!.textContent, "Audit the routes");
		assert.equal(q('[data-testid="subagent-agent"]')!.textContent, "scout");
		assert.equal(q('[data-testid="subagent-state"]')!.getAttribute("data-state"), "running");
		assert.match(q('[data-testid="subagent-tokens"]')!.textContent!, /12k tokens/);
		assert.match(q('[data-testid="subagent-elapsed"]')!.textContent!, /^1m/);
		assert.match(q('[data-testid="subagent-task"]')!.getAttribute("href")!, /work-w-abc/);
		assert.match(q('[data-testid="subagent-transcript"]')!.textContent!, /Found two routes/);
		assert.equal(q('[data-testid="subagent-transcript"] textarea'), null);
		const rows = qa('[data-testid="ledger-entry"]');
		assert.deepEqual(rows.map((r) => r.getAttribute("data-kind")), ["brief", "steer"]);
		assert.match(rows[0]!.textContent!, /Parentbrief/);
		assert.match(rows[1]!.textContent!, /Yousteer/);
		await act(async () => void q('[data-testid="subagent-stop"]')!.dispatchEvent(new dom.window.Event("click", { bubbles: true })));
		await settle();
		assert.equal(f.calls.aborts, 1);
	});

	it("running: the message field steers", async () => {
		const f = fake({});
		await mount(f);
		assert.equal(q('[data-testid="subagent-hint"]')!.getAttribute("data-mode"), "steer");
		const ta = q('[data-testid="subagent-input"]') as HTMLTextAreaElement;
		await type(ta, "go left");
		await act(async () => void q('[data-testid="subagent-send"]')!.dispatchEvent(new dom.window.Event("click", { bubbles: true })));
		await settle();
		assert.deepEqual(f.calls.submits.map((s) => [s.input, s.whenBusy]), [["go left", "steer"]]);
	});

	it("finished: no Stop, the hint says resume and the message resumes", async () => {
		const f = fake({ state: "done", finishedAt: new Date().toISOString() });
		await mount(f);
		assert.equal(q('[data-testid="subagent-stop"]'), null);
		assert.equal(q('[data-testid="subagent-state"]')!.textContent, "done");
		assert.equal(q('[data-testid="subagent-hint"]')!.getAttribute("data-mode"), "resume");
		const ta = q('[data-testid="subagent-input"]') as HTMLTextAreaElement;
		await type(ta, "one more thing");
		await act(async () => void q('[data-testid="subagent-send"]')!.dispatchEvent(new dom.window.Event("click", { bubbles: true })));
		await settle();
		assert.deepEqual(f.calls.submits.map((s) => [s.input, s.whenBusy]), [["one more thing", "reject"]]);
	});

	const send = async (f: ReturnType<typeof fake>, v: string) => {
		await type(q('[data-testid="subagent-input"]') as HTMLTextAreaElement, v);
		await act(async () => void q('[data-testid="subagent-send"]')!.dispatchEvent(new dom.window.Event("click", { bubbles: true })));
		await settle();
	};

	it("stale summary 'done' but the child runs: the resume is retried as a steer", async () => {
		const f = fake({ state: "done", finishedAt: new Date().toISOString() });
		f.live.running = true;
		await mount(f);
		await send(f, "hello");
		assert.deepEqual(f.calls.submits.map((s) => s.whenBusy), ["reject", "steer"]);
		assert.equal((q('[data-testid="subagent-input"]') as HTMLTextAreaElement).value, "");
	});

	it("stale summary 'running' but the child is idle: the steer is retried as a resume", async () => {
		const f = fake({});
		f.live.running = false;
		await mount(f);
		await send(f, "hello");
		assert.deepEqual(f.calls.submits.map((s) => s.whenBusy), ["steer", "reject"]);
	});

	it("a failed send keeps the text and shows the error", async () => {
		const f = fake({});
		f.live.submitError = true;
		await mount(f);
		await send(f, "keep me");
		assert.match(q('[data-testid="subagent-send-error"]')!.textContent!, /wolf unreachable/);
		assert.equal((q('[data-testid="subagent-input"]') as HTMLTextAreaElement).value, "keep me");
	});

	it("Enter sends, Shift+Enter does not", async () => {
		const f = fake({});
		await mount(f);
		const ta = q('[data-testid="subagent-input"]') as HTMLTextAreaElement;
		await type(ta, "via enter");
		const key = (shiftKey: boolean) =>
			act(async () => {
				const rp = Object.keys(ta).find((k) => k.startsWith("__reactProps$"))!;
				(ta as unknown as Record<string, { onKeyDown: (e: unknown) => void }>)[rp]!.onKeyDown({ key: "Enter", shiftKey, preventDefault() {} });
			});
		await key(true);
		await settle();
		assert.equal(f.calls.submits.length, 0);
		await key(false);
		await settle();
		assert.deepEqual(f.calls.submits.map((s) => [s.input, s.whenBusy]), [["via enter", "steer"]]);
	});

	it("a failed Stop shows the error; queued children get Stop too", async () => {
		const f = fake({ state: "queued", queuePosition: 2 });
		f.live.submitError = true;
		await mount(f);
		assert.match(q('[data-testid="subagent-state"]')!.textContent!, /queued #2/);
		await act(async () => void q('[data-testid="subagent-stop"]')!.dispatchEvent(new dom.window.Event("click", { bubbles: true })));
		await settle();
		assert.match(q('[data-testid="subagent-note"]')!.textContent!, /stop refused/);
		assert.ok(q('[data-testid="subagent-header"]'));
	});

	it("a transient refresh error after load keeps the view with a note; a send refetches the ledger", async () => {
		const f = fake({});
		await mount(f);
		let ledgerGets = 0;
		const orig = f.client.getLedger!;
		f.client.getLedger = async (id: string) => (ledgerGets++, orig(id));
		await send(f, "again");
		assert.ok(ledgerGets >= 1);
		f.client.listChildren = async () => {
			throw new Error("blip");
		};
		await send(f, "again");
		assert.ok(q('[data-testid="subagent-transcript"]'));
		assert.ok(q('[data-testid="subagent-note"]'));
		assert.equal(q('[data-testid="subagent-failed"]'), null);
	});

	it("no ledger support (501) is told apart from an empty ledger", async () => {
		const f = fake({});
		f.client.getLedger = undefined;
		await mount(f);
		assert.ok(q('[data-testid="subagent-ledger-missing"]'));
		const g = fake({});
		g.state.ledger = [];
		await act(async () => root?.unmount());
		document.body.innerHTML = "";
		await mount(g);
		assert.equal(q('[data-testid="subagent-ledger-missing"]'), null);
	});

	it("an unknown child shows a quiet failure", async () => {
		const f = fake({});
		f.client.listThreads = async () => [];
		await mount(f);
		assert.match(q('[data-testid="subagent-failed"]')!.textContent!, /no longer exists/);
	});

	it("thread-updated patches the header in place without refetching; the ledger refetches only on a state change", async () => {
		const f = fake({});
		await mount(f);
		let threadGets = 0;
		let ledgerGets = 0;
		const getThread = f.client.getThread;
		const getLedger = f.client.getLedger!;
		f.client.getThread = async (id: string) => (threadGets++, getThread(id));
		f.client.getLedger = async (id: string) => (ledgerGets++, getLedger(id));
		await fire({ tokens: 99_000 });
		await settle();
		assert.match(q('[data-testid="subagent-tokens"]')!.textContent!, /99k/);
		assert.equal(ledgerGets, 0);
		await fire({ id: "w/other", tokens: 1 }); // another thread: ignored
		assert.match(q('[data-testid="subagent-tokens"]')!.textContent!, /99k/);
		await fire({ state: "done", finishedAt: new Date().toISOString() });
		await settle();
		assert.equal(q('[data-testid="subagent-state"]')!.textContent, "done");
		assert.equal(q('[data-testid="subagent-stop"]'), null);
		assert.equal(ledgerGets, 1);
		assert.equal(threadGets, 0);
	});

	it("the wolf baseline refetches the summary and ledger without the messages", async () => {
		const f = fake({});
		await mount(f);
		f.state.summary = { ...f.state.summary, tokens: 500 };
		let threadGets = 0;
		const getThread = f.client.getThread;
		f.client.getThread = async (id: string) => (threadGets++, getThread(id));
		await act(async () => frames.get("needs-you-changed")!(JSON.stringify({ wolf: "w" })));
		await settle();
		assert.match(q('[data-testid="subagent-tokens"]')!.textContent!, /^500 tokens/);
		assert.equal(threadGets, 0);
	});

	const key = (k: string, extra: Record<string, unknown> = {}) =>
		act(async () => void document.dispatchEvent(Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), { key: k }, extra)));

	it("closes with Esc and the close button; is a labelled aria-modal dialog", async () => {
		const f = fake({});
		await mount(f);
		closed.length = 0;
		const dlg = q('[data-testid="subagent-modal"]')!;
		assert.equal(dlg.getAttribute("aria-modal"), "true");
		assert.equal(document.getElementById(dlg.getAttribute("aria-labelledby")!)!.textContent, "Audit the routes");
		await key("Escape");
		assert.equal(closed.length, 1);
		await act(async () => void q('[data-testid="subagent-modal-close"]')!.dispatchEvent(new dom.window.Event("click", { bubbles: true })));
		assert.equal(closed.length, 2);
	});

	it("the header row is title, then Stop, then close", async () => {
		await mount(fake({}));
		const row = q('[data-testid="subagent-title"]')!.parentElement!;
		assert.deepEqual([...row.children].map((c) => c.getAttribute("data-testid")), ["subagent-title", "subagent-meta", "subagent-stop", "subagent-modal-close"]);
		assert.match(q('[data-testid="subagent-title"]')!.className, /truncate/);
		assert.match(q('[data-testid="subagent-meta"]')!.className, /flex-wrap/);
		assert.match(q('[data-testid="subagent-modal-close"]')!.className, /shrink-0/);
	});

	it("the header carries the traffic-lights gutter and drag classes (inert in the browser)", async () => {
		await mount(fake({}));
		const h = q('[data-testid="subagent-header"]')!;
		assert.ok(h.classList.contains("lh-lights-gutter"));
		assert.ok(h.classList.contains("lh-drag"));
		assert.ok(h.contains(q('[data-testid="subagent-modal-close"]')));
	});

	it("two columns: the ledger is always present, the transcript and steer field share the right column", async () => {
		await mount(fake({}));
		const cols = q('[data-testid="subagent-columns"]')!;
		assert.match(cols.className, /min-\[900px\]:flex-row/);
		const ledger = q('[data-testid="subagent-ledger"]')!;
		const right = q('[data-testid="subagent-transcript-column"]')!;
		assert.equal(ledger.parentElement, cols);
		assert.equal(right.parentElement, cols);
		assert.equal(ledger.querySelectorAll('[data-testid="ledger-entry"]').length, 2);
		assert.ok(ledger.querySelector("details") === null);
		assert.ok(right.contains(q('[data-testid="subagent-transcript"]')));
		assert.ok(right.contains(q('[data-testid="subagent-input"]')));
		assert.ok(!ledger.contains(q('[data-testid="subagent-input"]')));
		assert.ok(q('[data-testid="subagent-ledger-scroll"]') && q('[data-testid="subagent-transcript-scroll"]'));
	});

	it("an empty ledger still shows the column; a ledger entry expands on click", async () => {
		const g = fake({});
		g.state.ledger = [];
		await mount(g);
		assert.ok(q('[data-testid="subagent-ledger"]'));
		assert.ok(q('[data-testid="subagent-ledger-empty"]'));
		await act(async () => root?.unmount());
		document.body.innerHTML = "";
		await mount(fake({}));
		const t = q('[data-testid="ledger-entry-text"]')!;
		assert.match(t.className, /line-clamp-3/);
		await act(async () => void t.dispatchEvent(new dom.window.Event("click", { bubbles: true })));
		assert.doesNotMatch(q('[data-testid="ledger-entry-text"]')!.className, /line-clamp/);
		assert.equal(q('[data-testid="ledger-entry-text"]')!.getAttribute("aria-expanded"), "true");
	});

	it("ledger entries are titled by sender and coloured per speaker; no Expand tooltip", async () => {
		const g = fake({});
		g.state.ledger = [
			...LEDGER,
			{ id: 3, at: "2026-10-27T10:02:00.000Z", from: "child", to: "parent", kind: "result", text: "done" },
			{ id: 4, at: "2026-10-27T10:03:00.000Z", from: "system", to: "parent", kind: "stop", text: "stopped" },
		];
		await mount(g);
		const rows = qa('[data-testid="ledger-entry"]');
		assert.deepEqual(rows.map((r) => r.querySelector('[data-testid="ledger-entry-sender"]')!.textContent), ["Parent", "You", "Child", "System"]);
		assert.deepEqual(rows.map((r) => r.querySelector('[data-testid="ledger-entry-kind"]')!.textContent), ["brief", "steer", "result", "stop"]);
		for (const [i, c] of ["violet", "emerald", "sky"].entries()) assert.match(rows[i]!.className, new RegExp(`border-l-${c}-500.*bg-${c}-500/10`));
		assert.match(rows[3]!.className, /bg-muted/);
		assert.equal(new Set(rows.map((r) => r.className)).size, 4);
		assert.equal(q('[data-testid="ledger-entry-text"]')!.getAttribute("title"), null);
	});

	it("transcript messages are highlighted by speaker: parent brief, owner steer, child output", async () => {
		const g = fake({});
		g.state.ledger = LEDGER;
		const client = g.client as unknown as { getThread: () => Promise<Record<string, unknown>> };
		const orig = client.getThread;
		client.getThread = async () => ({
			...(await orig()),
			messages: [
				{ id: "m1", role: "user", text: "audit it", at: "2026-10-27T10:00:00.000Z" },
				{ id: "m2", role: "assistant", text: "Found two routes.", at: "2026-10-27T10:00:05.000Z" },
				{ id: "m3", role: "user", text: "look at /v1 too", at: "2026-10-27T10:01:00.000Z" },
				{ id: "m4", role: "user", text: "unmatched steer", at: "2026-10-27T10:02:00.000Z" },
			],
		});
		await mount(g);
		const users = qa('[data-testid="subagent-user-message"]');
		assert.deepEqual(users.map((u) => u.getAttribute("data-speaker")), ["parent", "owner", "parent"]); // unmatched defaults to parent
		assert.deepEqual(users.map((u) => u.querySelector("div")!.textContent), ["Parent", "You", "Parent"]);
		assert.match(users[0]!.className, /bg-violet-500\/10/);
		assert.match(users[1]!.className, /bg-emerald-500\/10/);
		const child = q('[data-testid="subagent-child-text"]')!;
		assert.match(child.className, /border-l-sky-500.*bg-sky-500\/10/);
		assert.match(child.textContent!, /Child/);
	});

	it("Tab wraps within the dialog, focus starts on close", async () => {
		await mount(fake({}));
		const dlg = q('[data-testid="subagent-modal"]')!;
		const close = q('[data-testid="subagent-modal-close"]')!;
		assert.equal(document.activeElement === close, true);
		const focusables = [...dlg.querySelectorAll<HTMLElement>('button, a[href], textarea, input, select, summary, [tabindex="0"]')].filter((el) => {
			if ((el as HTMLButtonElement).disabled) return false; // the empty Send button
			const d = el.closest("details");
			return !d || d.open || (el.tagName === "SUMMARY" && el.parentElement === d);
		});
		const last = focusables[focusables.length - 1]!;
		last.focus();
		let prevented = false;
		await key("Tab", { preventDefault: () => (prevented = true) });
		assert.equal(prevented, true);
		assert.equal(document.activeElement === focusables[0], true);
		prevented = false;
		await key("Tab", { shiftKey: true, preventDefault: () => (prevented = true) });
		assert.equal(prevented, true);
		assert.equal(document.activeElement === last, true);
	});

	it("locks the page's scroll while open and restores it, and returns focus to the opener, on close", async () => {
		const f = fake({});
		(globalThis as Record<string, unknown>).fetch = threadFetch(f.client);
		const opener = document.createElement("button");
		document.body.appendChild(opener);
		opener.focus();
		document.body.style.overflow = "auto";
		let open: (id: string, wolf?: string) => void = () => {};
		function Opener() {
			open = useSubagentModal().openSubagent;
			return null;
		}
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		await act(async () => {
			root!.render(
				<ServerEventsProvider connect={inert}>
					<SubagentModalProvider>
						<Opener />
					</SubagentModalProvider>
				</ServerEventsProvider>,
			);
		});
		await act(async () => open(CHILD, "w"));
		assert.equal(document.body.style.overflow, "hidden");
		assert.equal(document.activeElement !== opener, true);
		await key("Escape");
		assert.equal(q('[data-testid="subagent-modal"]'), null);
		assert.equal(document.body.style.overflow, "auto");
		assert.equal(document.activeElement === opener, true);
		document.body.style.overflow = "";
	});

	it("uses the wolf it is given; falls back to the id prefix only without one", async () => {
		const f = fake({});
		const urls: string[] = [];
		const tf = threadFetch(f.client);
		(globalThis as Record<string, unknown>).fetch = ((i: RequestInfo | URL, init?: RequestInit) => (urls.push(String(i)), tf(i, init))) as typeof fetch;
		let open: (id: string, wolf?: string) => void = () => {};
		function Opener() {
			open = useSubagentModal().openSubagent;
			return null;
		}
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		await act(async () => {
			root!.render(
				<ServerEventsProvider connect={inert}>
					<SubagentModalProvider>
						<Opener />
					</SubagentModalProvider>
				</ServerEventsProvider>,
			);
		});
		await act(async () => open("pfx/sub-9", "given"));
		await settle();
		assert.ok(urls.some((u) => u.includes("/api/wolves/given/threads/")), urls.join());
		assert.ok(!urls.some((u) => u.includes("/api/wolves/pfx/")));
		await key("Escape");
		urls.length = 0;
		await act(async () => open("pfx/sub-9"));
		await settle();
		assert.ok(urls.some((u) => u.includes("/api/wolves/pfx/threads/sub-9")), urls.join());
	});

	it("the provider opens the modal from anywhere over the current page and closes it", async () => {
		const f = fake({});
		(globalThis as Record<string, unknown>).fetch = threadFetch(f.client);
		let open: (id: string) => void = () => {};
		function Opener() {
			open = useSubagentModal().openSubagent;
			return <div data-testid="page">current page</div>;
		}
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		await act(async () => {
			root!.render(
				<ServerEventsProvider connect={inert}>
					<SubagentModalProvider>
						<Opener />
					</SubagentModalProvider>
				</ServerEventsProvider>,
			);
		});
		assert.equal(q('[data-testid="subagent-modal"]'), null);
		await act(async () => open(CHILD));
		await settle();
		assert.equal(q('[data-testid="subagent-view"]')!.getAttribute("data-child"), CHILD);
		assert.ok(q('[data-testid="page"]'));
		assert.equal(q('[data-testid="subagent-title"]')!.textContent, "Audit the routes");
		await act(async () => void document.dispatchEvent(Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), { key: "Escape" })));
		assert.equal(q('[data-testid="subagent-modal"]'), null);
	});

	it("a strip row opens the modal instead of navigating", async () => {
		const { SubagentStrip } = await import("../components/subagent-strip.tsx");
		const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
		const f = fake({});
		(globalThis as Record<string, unknown>).fetch = threadFetch(f.client);
		const pushed: string[] = [];
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		await act(async () => {
			root!.render(
				<AppRouterContext.Provider value={{ push: (h: string) => void pushed.push(h) } as never}>
					<ServerEventsProvider connect={inert}>
						<SubagentModalProvider>
							<SubagentStrip wolf="w" slug="home" items={[f.state.summary as never]} now={Date.now()} />
						</SubagentModalProvider>
					</ServerEventsProvider>
				</AppRouterContext.Provider>,
			);
		});
		await act(async () => void q('[data-testid="subagent-open"]')!.dispatchEvent(new dom.window.Event("click", { bubbles: true })));
		await settle();
		assert.deepEqual(pushed, []);
		assert.equal(q('[data-testid="subagent-view"]')!.getAttribute("data-child"), CHILD);
		assert.equal(q('[data-testid="subagent-modal"]')!.getAttribute("role"), "dialog");
	});
});
