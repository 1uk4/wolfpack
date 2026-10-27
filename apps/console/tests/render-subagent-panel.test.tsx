/** The Subagent panel (real mount): header, ledger, read-only transcript, steer vs resume, Stop. Over a fake ConsoleClient via the thread API handlers. */
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

type ConsoleClient = import("@wolfpack/client").ConsoleClient;
type ThreadSummary = import("@wolfpack/client").ThreadSummary;
type LedgerEntry = import("@wolfpack/client").LedgerEntry;
const { threadFetch } = await import("./helpers/thread-fetch.ts");
const { SubagentPanel, ledgerSender, messageHint, formatElapsed, formatTokens } = await import("../components/subagent-panel.tsx");
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
	const running = () => state.summary.state === "running";
	const client = {
		listThreads: async () => [state.summary],
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
		abort: async () => void calls.aborts++,
		submit: async (_id: string, input: string, opts?: { whenBusy?: string }) => {
			calls.submits.push({ input, whenBusy: opts?.whenBusy });
			return { disposition: running() ? "steered" : "started" };
		},
		watch: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }) }),
	} as unknown as ConsoleClient;
	return { client, calls, state };
}

let root: Root | null = null;
const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const qa = (sel: string) => [...document.querySelectorAll(sel)] as HTMLElement[];
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 30))));
/** linkedom does not deliver `input` to React's change plugin: call the field's onChange prop with the new value. */
const type = (ta: HTMLTextAreaElement, v: string) =>
	act(async () => {
		const key = Object.keys(ta).find((k) => k.startsWith("__reactProps$"))!;
		(ta as unknown as Record<string, { onChange: (e: unknown) => void }>)[key]!.onChange({ target: { value: v } });
	});
const inert = () => ({ close() {}, onOpen() {}, onEvent() {} });
async function mount(f: ReturnType<typeof fake>) {
	(globalThis as Record<string, unknown>).fetch = threadFetch(f.client);
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(
			<ServerEventsProvider connect={inert}>
				<SubagentPanel wolf="w" childThreadId={CHILD} />
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

describe("subagent panel", () => {
	it("is available only with a childThreadId", () => {
		const def = PANELS.find((p) => p.id === "subagent")!;
		assert.equal(def.available({ wolf: "w", threadId: "t", props: {} }), false);
		assert.equal(def.available({ wolf: "w", threadId: "t", props: { childThreadId: CHILD } }), true);
	});

	it("pure helpers", () => {
		assert.equal(ledgerSender({ from: "owner", to: "child" }), "you → child");
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
		assert.match(rows[0]!.textContent!, /parent → child · brief/);
		assert.match(rows[1]!.textContent!, /you → child · steer/);
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

	it("an unknown child shows a quiet failure", async () => {
		const f = fake({});
		f.client.listThreads = async () => [];
		await mount(f);
		assert.match(q('[data-testid="subagent-failed"]')!.textContent!, /no longer exists/);
	});
});
