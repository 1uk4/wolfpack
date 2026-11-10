/**
 * The transcript's Q→A record of a paged `ask` (work-wolfpack-SmSTiJs): one line per question (answered / skipped /
 * unanswered / typed-not-sent), the context and diagram behind an expand control, the header saying how the set ended,
 * and the console's diagram relay. Seams: the record card mounted alone, ThreadChat over a mock client, createThreadApi.
 */
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
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
	ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
	getComputedStyle: () => ({ animationName: "none" }),
});

const { MockConsoleClient, FIXTURE_THREAD } = await import("@wolfpack/client");
type Card = import("@wolfpack/client").Card;
type ThreadDetail = import("@wolfpack/client").ThreadDetail;
const { createThreadApi } = await import("../src/server/thread-api.ts");
const { cardsOfThread, threadMessagesToNative } = await import("../src/core/index.ts");
const { AskRecordCard } = await import("../components/ask-record.tsx");
const { SettingsDialogProvider } = await import("../components/settings/settings-dialog.tsx");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
const { ThreadChat } = await import("../components/thread-chat.tsx");
const { MemoryEventsProvider } = await import("../components/memory-events.tsx");
const { ServerEventsProvider } = await import("../components/server-events.tsx");

const eventsSource = () => ({ close() {}, onOpen() {}, onEvent() {} });
const inertSource = () => ({ close() {}, onOpen() {}, onMessage() {}, onError() {} });

const ASK: Card = {
	tool: "ask",
	paged: true,
	fields: [
		{
			id: "db",
			kind: "single",
			label: "Which DB?",
			description: "Pick **one** of these. <script>alert(1)</script> <img src=\"https://evil.test/x.png\"> ![pixel](https://evil.test/y.png)",
			diagram: "dg-1",
			options: [{ label: "Postgres", value: "pg" }, { label: "SQLite", value: "sqlite" }],
		},
		{ id: "why", kind: "free-text", label: "Why?", optional: true },
		{ id: "ship", kind: "confirm", label: "Ship it?" },
		{ id: "n", kind: "slider", label: "How many?", min: 0, max: 10, step: 1 },
	],
	steps: [{ fields: ["db", "why"] }, { fields: ["ship"] }, { fields: ["n"] }],
};
const noop = () => {};
const base = { callId: "c1", card: ASK, pending: false, submitting: false, onAnswer: noop, diagramUrl: (id: string) => `/diag/${id}` };

let root: Root | null = null;
async function render(node: React.ReactElement) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => root!.render(node));
}
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});
const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const lines = () => [...document.querySelectorAll('[data-testid="ask-record-line"]')].map((l) => (l.querySelector('[data-testid="ask-record-text"]') ?? l).textContent!.replace(/\s+/g, " ").trim());
const click = (el: Element) => act(async () => void el.dispatchEvent(new dom.window.Event("click", { bubbles: true, cancelable: true })));

describe("ask record in the transcript", () => {
	it("a superseded set lists answered, skipped and unanswered questions under a replaced header", async () => {
		await render(<AskRecordCard {...base} closed="superseded" dismissed pageAnswers={{ db: { value: "pg" } }} pagesDone={1} />);
		assert.match(q('[data-testid="ask-record-header"]')!.textContent!, /replaced by your message/);
		assert.deepEqual(lines(), ["Which DB? → pg", "Why? → skipped", "Ship it? → unanswered", "How many? → unanswered"]);
	});

	it("an answered set says so and shows every answer, slider value included", async () => {
		await render(
			<AskRecordCard {...base} closed="answered" answer={{ n: { value: 7 } }} pageAnswers={{ db: { value: "pg" }, why: { value: "fast" }, ship: { value: true } }} pagesDone={3} />,
		);
		assert.match(q('[data-testid="ask-record-header"]')!.textContent!, /answered/);
		assert.deepEqual(lines(), ["Which DB? → pg", "Why? → fast", "Ship it? → yes", "How many? → 7"]);
	});

	it("an answer with images reads 'N image(s)' after its text, or alone for an images-only answer", async () => {
		await render(<AskRecordCard {...base} closed="answered" pageAnswers={{ db: { value: "pg", attachments: ["a"] }, why: { value: "", attachments: ["a", "b"] }, ship: { value: true } } as never} answer={{ n: { value: 7 } }} pagesDone={3} />);
		assert.deepEqual(lines(), ["Which DB? → pg · 1 image", "Why? → 2 images", "Ship it? → yes", "How many? → 7"]);
	});

	it("a submitted set shows every page's answers, then a Note with its text and thumbnails", async () => {
		await render(
			<AskRecordCard {...base} closed="answered" answer={{ n: { value: 7 } }} note={{ text: "mind the budget", attachments: ["a1", "a2"] }} attachmentUrl={(id: string) => `/att/${id}`} />,
		);
		const note = q('[data-testid="ask-record-note"]')!;
		assert.equal(note.textContent!.includes("mind the budget"), true);
		assert.deepEqual([...note.querySelectorAll("img")].map((i) => i.getAttribute("src")), ["/att/a1", "/att/a2"]);
	});

	it("no note, no Note section", async () => {
		await render(<AskRecordCard {...base} closed="answered" answer={{ n: { value: 7 } }} />);
		assert.equal(q('[data-testid="ask-record-note"]') === null, true);
	});

	it("a multi answer lists every custom answer, marked as custom", async () => {
		const multi: Card = { tool: "ask", paged: true, fields: [{ id: "t", kind: "multi", label: "Tags?", allowOther: true, options: [{ label: "A", value: "a" }] }], steps: [{ fields: ["t"] }] } as never;
		await render(<AskRecordCard {...base} card={multi} closed="answered" pageAnswers={{ t: { value: ["a", "red", "blue"], other: ["red", "blue"] } } as never} pagesDone={1} />);
		assert.deepEqual(lines(), ['Tags? → a, other: "red", other: "blue"']);
	});

	it("text typed but not submitted shows marked 'typed, not sent'; a pending set reads 'questions open'", async () => {
		await render(<AskRecordCard {...base} pending pageAnswers={{ db: { value: "pg" } }} pagesDone={1} draft={{ ship: { value: false } }} />);
		assert.match(q('[data-testid="ask-record-header"]')!.textContent!, /questions open/i);
		assert.deepEqual(lines().slice(2), ["Ship it? → no typed, not sent", "How many? → unanswered"]);
	});

	it("context and diagram stay collapsed until expanded; raw HTML in the context never renders; the diagram loads from the relay URL and shows a placeholder when it fails", async () => {
		await render(<AskRecordCard {...base} closed="superseded" dismissed pageAnswers={{ db: { value: "pg" } }} pagesDone={1} />);
		assert.equal(document.body.textContent!.includes("Pick one"), false);
		assert.equal(q("img"), null);
		await click(q('[data-testid="ask-record-expand"]')!);
		assert.match(document.body.textContent!, /Pick one of these\./);
		assert.equal(q("script"), null);
		assert.deepEqual([...document.querySelectorAll("img")].map((i) => i.getAttribute("src")), ["/diag/dg-1"]);
		await act(async () => void q("img")!.dispatchEvent(new dom.window.Event("error")));
		assert.equal(q("img"), null);
		assert.match(q('[data-testid="ask-record-diagram-missing"]')!.textContent!, /Diagram not available/);
	});

	it("context never loads an image or runs a script link: inline, reference-style and raw <img> all render no <img>; a javascript: link has no javascript: href", async () => {
		const card: Card = {
			...ASK,
			fields: [
				{
					id: "db",
					kind: "single",
					label: "Which DB?",
					description: "![a](https://evil.test/a.png) ![b][ref] ![c](https://evil.test/p(1).png) <img src=\"https://evil.test/d.png\"> [click](javascript:alert(1))\n\n[ref]: https://evil.test/b.png",
					options: [{ label: "Postgres", value: "pg" }],
				},
			],
			steps: [{ fields: ["db"] }],
		};
		await render(<AskRecordCard {...base} card={card} closed="superseded" dismissed />);
		await click(q('[data-testid="ask-record-expand"]')!);
		assert.equal(document.querySelectorAll("img").length, 0);
		const hrefs = [...document.querySelectorAll("a")].map((a) => (a.getAttribute("href") ?? "").toLowerCase());
		assert.equal(hrefs.some((h) => h.startsWith("javascript:")), false);
	});

	it("a pending paged card shows the 'Questions open' record", async () => {
		await render(<AskRecordCard {...base} pending />);
		assert.equal(q('[data-testid="ask-record-header"]')!.textContent, "Questions open");
		assert.equal(lines().length, 4);
	});

});

describe("pending card whose ask call left the history", () => {
	it("the record shows the answered pages and the draft from the pending card alone", async () => {
		const cards = cardsOfThread({ messages: [], pendingCards: [{ callId: "c9", tool: "ask", card: ASK, pageIndex: 0, reached: 1, pageAnswers: { db: { value: "pg" } }, draft: { ship: { value: false } } } as never] });
		const call = cards.calls.c9!;
		await render(<AskRecordCard {...base} callId="c9" card={call.card} pending pageAnswers={call.pageAnswers} pagesDone={call.pagesDone} draft={call.draft} />);
		assert.deepEqual(lines(), ["Which DB? → pg", "Why? → skipped", "Ship it? → no typed, not sent", "How many? → unanswered"]);
	});
});

/** A thread whose history holds an ask record, an ask_revise call (no card) and the operator's replacing message. */
class AskClient extends MockConsoleClient {
	constructor() {
		super({ delayMs: 0, script: [] });
	}
	override async getThread(id: string): Promise<ThreadDetail> {
		const base = await super.getThread(id);
		const at = new Date().toISOString();
		return {
			...base,
			messages: [
				{
					id: "m1",
					role: "assistant",
					text: "",
					at,
					tools: [
						{ callId: "ask-1", name: "ask", args: {}, result: "ok", card: ASK, dismissed: true, closed: "superseded", pageAnswers: { db: { value: "sqlite" } }, pagesDone: 1 },
						{ callId: "rev-1", name: "ask_revise", args: {}, result: "ok" },
					],
				},
				{ id: "m2", role: "user", text: "never mind, ship it", at },
				...base.messages,
			],
		};
	}
}

describe("ThreadChat renders the record", () => {
	it("a replaced ask shows one record whose diagram is relayed through the console; ask_revise draws no card", async () => {
		const client = new AskClient();
		const detail = await client.getThread(FIXTURE_THREAD.id);
		await render(
			<AppRouterContext.Provider value={{ push() {} } as never}>
				<SettingsDialogProvider>
					<ServerEventsProvider connect={eventsSource}>
						<MemoryEventsProvider connect={inertSource}>
							<ThreadChat wolf="1uk4" slug="home" threadId={FIXTURE_THREAD.id} title="Home" initialMessages={threadMessagesToNative(detail.messages)} initialCards={cardsOfThread(detail)} />
						</MemoryEventsProvider>
					</ServerEventsProvider>
				</SettingsDialogProvider>
			</AppRouterContext.Provider>,
		);
		assert.equal(document.querySelectorAll('[data-testid="ask-record"]').length, 1);
		assert.equal(document.querySelectorAll('[data-testid="dismissed-card"], [data-testid="pending-card"], [data-testid="answered-card"]').length, 0);
		assert.deepEqual(lines().slice(0, 2), ["Which DB? → sqlite", "Why? → skipped"]);
		assert.match(document.body.textContent!, /never mind, ship it/);
		await click(q('[data-testid="ask-record-expand"]')!);
		assert.equal(q("img")!.getAttribute("src"), "/api/wolves/1uk4/threads/home/diagrams/dg-1");
	});
});

describe("console diagram relay", () => {
	const ref = { wolf: "1uk4", slug: "home" };
	class DiagramClient extends MockConsoleClient {
		async getDiagram(_t: string, id: string) {
			if (id === "viz-gone-1.png") throw new (await import("@wolfpack/client")).NotFoundError("diagram");
			if (id === "viz-evil-1700000000000.png") return { bytes: new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"), mimeType: "image/svg+xml" };
			return { bytes: new Uint8Array([137, 80, 78, 71]), mimeType: "image/png" };
		}
	}
	it("serves a wolfd-shaped diagram id as a sandboxed, cacheable png; refuses svg, a missing one, a path-like id and a bare file name", async () => {
		const api = createThreadApi(() => new DiagramClient({ delayMs: 0, script: [] }));
		const ok = await api.diagram(ref, "viz-db-choice-1700000000000.png");
		assert.equal(ok.status, 200);
		assert.equal(ok.headers.get("content-type"), "image/png");
		assert.equal(ok.headers.get("x-content-type-options"), "nosniff");
		assert.match(ok.headers.get("content-security-policy")!, /sandbox/);
		assert.equal(ok.headers.get("cache-control"), "private, max-age=31536000, immutable");
		assert.equal((await api.diagram(ref, "viz-evil-1700000000000.png")).status, 404);
		assert.equal((await api.diagram(ref, "viz-gone-1.png")).status, 404);
		assert.equal((await api.diagram(ref, "../etc/passwd")).status, 404);
		assert.equal((await api.diagram(ref, "secret.png")).status, 404);
	});
});

describe("superseded note", () => {
	it("a replacing user message renders without the 'state when replaced' note (wolfd strips it from the record; the console shows the text it receives)", async () => {
		const client = new AskClient();
		const detail = await client.getThread(FIXTURE_THREAD.id);
		await render(
			<AppRouterContext.Provider value={{ push() {} } as never}>
				<SettingsDialogProvider>
					<ServerEventsProvider connect={eventsSource}>
						<MemoryEventsProvider connect={inertSource}>
							<ThreadChat wolf="1uk4" slug="home" threadId={FIXTURE_THREAD.id} title="Home" initialMessages={threadMessagesToNative(detail.messages)} initialCards={cardsOfThread(detail)} />
						</MemoryEventsProvider>
					</ServerEventsProvider>
				</SettingsDialogProvider>
			</AppRouterContext.Provider>,
		);
		assert.match(document.body.textContent!, /never mind, ship it/);
		assert.equal(document.body.textContent!.includes("state when replaced"), false);
	});
});
