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
const { threadFetch } = await import("./helpers/thread-fetch.ts");
const { SubagentModal } = await import("../components/subagent-modal.tsx");
const { ServerEventsProvider } = await import("../components/server-events.tsx");
const { withoutEchoes } = await import("../components/session-core.ts");

const CHILD = "w/sub-1";
const RESULT = "## Commits\n033c9ff Add reverse string helper";
const at = "2026-10-27T10:00:05.000Z";
const SUMMARY = { id: CHILD, wolf: "w", kind: "subagent", title: "task", parentThreadId: "w/home", agent: "worker", state: "running", startedAt: at };

/** A child whose record already holds its result (entry ids), while the stream replays the same turn (no ids). */
function fake(opts: { busy: boolean; state: string; frames: boolean }) {
	const events = [
		{ type: "turn-start", at },
		{ type: "text-delta", at, text: RESULT },
		{ type: "turn-end", at, reason: "complete" },
	];
	return {
		listThreads: async () => [SUMMARY],
		listChildren: async () => [{ ...SUMMARY, state: "done" }],
		getThread: async () => ({
			...SUMMARY,
			state: opts.state,
			busy: opts.busy,
			lastEventId: 3,
			messages: [
				{ id: "entry-1173", role: "user", text: "brief", at },
				{ id: "entry-1185", role: "assistant", text: RESULT, at },
			],
		}),
		getLedger: async () => [],
		abort: async () => {},
		submit: async () => ({ disposition: "started" }),
		watch: () =>
			opts.frames
				? (async function* () {
						for (const e of events) yield e;
					})()
				: { [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }) },
	} as unknown as ConsoleClient;
}

let root: Root | null = null;
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 60))));
async function mount(client: ConsoleClient) {
	(globalThis as Record<string, unknown>).fetch = threadFetch(client);
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	const inert = () => ({ close() {}, onOpen() {}, onEvent() {} });
	await act(async () => {
		root!.render(
			<ServerEventsProvider connect={inert}>
				<SubagentModal wolf="w" childThreadId={CHILD} onClose={() => {}} />
			</ServerEventsProvider>,
		);
	});
	await settle();
	await settle();
}
const results = () => [...document.querySelectorAll('[data-testid="subagent-child-text"]')].filter((e) => e.textContent!.includes("033c9ff"));
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});

describe("subagent modal: a settled result shows once", () => {
	it("opened after the child finished (record idle, summary stale 'running')", async () => {
		await mount(fake({ busy: false, state: "running", frames: true }));
		assert.equal(results().length, 1);
	});
	it("the turn ended between the record fetch and the stream attach (record busy, replay follows)", async () => {
		await mount(fake({ busy: true, state: "running", frames: true }));
		assert.equal(results().length, 1);
	});
	it("opened on a plain finished child", async () => {
		await mount(fake({ busy: false, state: "done", frames: false }));
		assert.equal(results().length, 1);
	});
});

describe("withoutEchoes", () => {
	const a = (id: string, text: string) => ({ id, role: "assistant", content: [{ type: "text", text }], timestamp: 1 }) as never;
	const u = (id: string, content: string) => ({ id, role: "user", content, timestamp: 1 }) as never;
	it("drops a streamed copy of a record message; keeps a new turn repeating an earlier reply", () => {
		assert.equal(withoutEchoes([u("e1", "hi"), a("e2", "OK")], [a("c_1", "OK")]).length, 0);
		assert.equal(withoutEchoes([u("e1", "hi"), a("e2", "OK")], [u("c_0", "again"), a("c_1", "OK")]).length, 2);
		assert.equal(withoutEchoes([u("e1", "hi"), a("e2", "OK")], [a("c_1", "partial")]).length, 1);
	});
});
