/**
 * ThreadChat answering a wolf's card (real mount): the pending card renders inline, Submit goes through the console's
 * server layer (createThreadApi over a mock ConsoleClient), the answered card replaces the form, and the next turn's
 * text streams in. Seam 2 of the ask-card ticket.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
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

const { MockConsoleClient, FIXTURE_THREAD, NotFoundError } = await import("@wolfpack/client");
type Card = import("@wolfpack/client").Card;
type CardAnswers = import("@wolfpack/client").CardAnswers;
type ThreadDetail = import("@wolfpack/client").ThreadDetail;
const { createThreadApi } = await import("../src/server/thread-api.ts");
const { cardsOfThread, threadMessagesToNative } = await import("../src/core/index.ts");
const { SettingsDialogProvider } = await import("../components/settings/settings-dialog.tsx");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
const { ThreadChat } = await import("../components/thread-chat.tsx");
const { MemoryEventsProvider } = await import("../components/memory-events.tsx");
const { ServerEventsProvider } = await import("../components/server-events.tsx");
/** The notification channel's source: tests fire named frames through `frames`. */
const frames = new Map<string, (data: string) => void>();
const eventsSource = () => ({
	close() {},
	onOpen() {},
	onEvent(name: string, cb: (data: string) => void) {
		frames.set(name, cb);
	},
});
const inertSource = () => ({ close() {}, onOpen() {}, onMessage() {}, onError() {} });

const CALL = "call-1";
const SINGLE: Card = {
	tool: "ask_user_question",
	fields: [
		{
			id: "answer",
			kind: "single",
			label: "Which branch?",
			options: [
				{ label: "main (Recommended)", value: "main" },
				{ label: "develop", value: "develop" },
			],
		},
	],
};
const MULTI: Card = {
	tool: "ask_user_question",
	fields: [{ id: "answer", kind: "multi", label: "Which envs?", options: [{ label: "dev", value: "dev" }, { label: "staging", value: "staging" }, { label: "prod", value: "prod" }], default: ["dev"], max: 2 }],
};
const CONFIRM: Card = { tool: "ask_user_question", fields: [{ id: "answer", kind: "confirm", label: "Deploy?", confirmLabel: "Deploy", rejectLabel: "Hold off", default: true }] };
const FREE: Card = { tool: "ask_user_question", fields: [{ id: "answer", kind: "free-text", label: "Why?" }] };

/** A mock whose thread already ended a turn on a card; answering records the answer and starts the next scripted turn. */
class CardClient extends MockConsoleClient {
	answers: { callId: string; answers: CardAnswers }[] = [];
	answered?: CardAnswers;
	failNext?: string;
	/** The card was superseded server-side: history shows it dismissed, nothing pends. */
	superseded = false;
	/** The card was skipped by the operator (server-side): history shows it closed:"skipped". */
	skippedState = false;
	skips: string[] = [];
	/** The next skip is held (siblings wait). */
	holdSkipNext = false;
	heldSkip = false;
	/** An answer is held (siblings wait): the card stays pending carrying it. */
	held?: CardAnswers;
	/** The next answer is held instead of starting a turn. */
	holdNext = false;
	/** The next answer fails as an unknown card. */
	notFoundNext = false;
	constructor(private readonly card: Card) {
		super({ delayMs: 0, script: [{ kind: "text", text: "Shipping from the answer." }] });
	}
	override async getThread(id: string): Promise<ThreadDetail> {
		const base = await super.getThread(id);
		const result = this.answered ? Object.values(this.answered).map((a) => a.value).join("; ") : "The operator was asked.";
		const asked = {
			id: "entry-1",
			role: "assistant" as const,
			text: "",
			at: new Date().toISOString(),
			tools: [{ callId: CALL, name: "ask_user_question", args: { question: "q" }, result, card: this.card, ...(this.answered ? { answer: this.answered } : {}), ...(this.superseded ? { dismissed: true, closed: "superseded" as const } : {}), ...(this.skippedState ? { dismissed: true, closed: "skipped" as const, result: "(skipped by the user)" } : {}) }],
		};
		const pending = !this.answered && !this.superseded && !this.skippedState;
		const pendingCards = [{ callId: CALL, threadId: id, card: this.card, raisedAt: new Date().toISOString(), ...(this.held ? { heldAnswer: this.held } : {}), ...(this.heldSkip ? { heldSkip: true } : {}) }];
		return { ...base, messages: [asked, ...base.messages], ...(pending ? { pendingCards } : {}) };
	}
	async skipCard(threadId: string, callId: string) {
		if (this.notFoundNext) {
			this.notFoundNext = false;
			throw new NotFoundError(`card ${callId}`);
		}
		this.skips.push(callId);
		if (this.holdSkipNext) {
			this.holdSkipNext = false;
			this.heldSkip = true;
			return { messageId: `card-${callId}`, disposition: "queued" as const };
		}
		this.skippedState = true;
		return this.submit(threadId, "skipped");
	}
	async answerCard(threadId: string, callId: string, answers: CardAnswers) {
		if (this.failNext) {
			const m = this.failNext;
			this.failNext = undefined;
			throw Object.assign(new Error(m), { name: "ProtocolError", code: "invalid_request" });
		}
		if (this.notFoundNext) {
			this.notFoundNext = false;
			throw new NotFoundError(`card ${callId}`);
		}
		this.answers.push({ callId, answers });
		if (this.holdNext) {
			this.holdNext = false;
			this.held = answers;
			return { messageId: `card-${callId}`, disposition: "queued" as const };
		}
		this.answered = answers;
		return this.submit(threadId, "answer");
	}
}

/** The console's server layer over the mock client, standing in for the Next routes. */
function routeFetch(client: CardClient): typeof fetch {
	const api = createThreadApi(() => client);
	const ref = { wolf: "1uk4", slug: "home" };
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input), "http://t");
		const req = new Request(url, init);
		const answer = url.pathname.match(/\/cards\/([^/]+)\/answer$/);
		if (answer && req.method === "POST") return api.answerCard(ref, decodeURIComponent(answer[1]!), req);
		const skip = url.pathname.match(/\/cards\/([^/]+)\/skip$/);
		if (skip && req.method === "POST") return api.skipCard(ref, decodeURIComponent(skip[1]!));
		if (url.pathname.endsWith("/stream")) return api.stream(ref, req);
		if (url.pathname.endsWith("/threads/home")) return api.thread(ref);
		return new Response("{}", { status: 404 });
	}) as typeof fetch;
}

const realFetch = globalThis.fetch;
let root: Root | null = null;

async function mount(client: CardClient) {
	globalThis.fetch = routeFetch(client);
	const detail = await client.getThread(FIXTURE_THREAD.id);
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(
			<AppRouterContext.Provider value={{ push() {} } as never}>
				<SettingsDialogProvider>
					<ServerEventsProvider connect={eventsSource}>
					<MemoryEventsProvider connect={inertSource}>
						<ThreadChat
							wolf="1uk4"
							slug="home"
							threadId={FIXTURE_THREAD.id}
							title="Home"
							initialMessages={threadMessagesToNative(detail.messages)}
							initialCards={cardsOfThread(detail)}
						/>
					</MemoryEventsProvider>
					</ServerEventsProvider>
				</SettingsDialogProvider>
			</AppRouterContext.Provider>,
		);
	});
}

const settle = (ms = 60) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const click = (el: Element) =>
	act(async () => {
		el.dispatchEvent(Object.assign(new dom.window.Event("click", { bubbles: true, cancelable: true }), { detail: 1 }));
	});
const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;

after(() => {
	globalThis.fetch = realFetch;
});
async function unmount() {
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
}

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});

describe("ThreadChat answers a card (real mount, server layer over a mock client)", () => {
	it("renders the pending card inline instead of a tool row; Submit stays disabled until a pick", async () => {
		const client = new CardClient(SINGLE);
		await mount(client);
		assert.ok(q('[data-testid="pending-card"]'), "pending card present");
		assert.equal(q('[data-testid="answered-card"]'), null);
		assert.equal(document.querySelectorAll('[data-testid="card-option"]').length, 2);
		assert.match(document.body.textContent ?? "", /Which branch\?/);
		assert.equal(q('[data-testid="card-submit"]')!.hasAttribute("disabled"), true);
	});

	it("single: pick an option, Submit -> POSTed through the server layer, answered card shows, next turn streams in", async () => {
		const client = new CardClient(SINGLE);
		await mount(client);
		await click(document.querySelectorAll('[data-testid="card-option"]')[1]!);
		assert.equal(q('[data-testid="card-submit"]')!.hasAttribute("disabled"), false);
		await click(q('[data-testid="card-submit"]')!);
		await settle();
		assert.deepEqual(client.answers, [{ callId: CALL, answers: { answer: { value: "develop" } } }]);
		assert.ok(q('[data-testid="answered-card"]'), "answered record replaces the form");
		assert.equal(q('[data-testid="pending-card"]'), null);
		assert.equal(q('[data-testid="card-submit"]'), null);
		assert.match(document.body.textContent ?? "", /Shipping from the answer\./);
		// The record refetched at settle keeps the answered card (card + answer ride the history).
		await settle();
		assert.ok(q('[data-testid="answered-card"]'));
	});

	it("an idle open thread follows the wolf's activity: a held answer given elsewhere appears", async () => {
		const client = new CardClient(FREE);
		await mount(client);
		assert.equal(q('[data-testid="card-held"]'), null);
		client.held = { answer: { value: "from the sidebar" } };
		await act(async () => frames.get("needs-you-changed")!(JSON.stringify({ wolf: "1uk4" })));
		await settle();
		assert.ok(q('[data-testid="card-held"]'), "the held answer shows without a settle");
	});

	it("shows the server's rejection and keeps the card pending", async () => {
		const client = new CardClient(SINGLE);
		client.failNext = "not an option";
		await mount(client);
		await click(document.querySelectorAll('[data-testid="card-option"]')[0]!);
		await click(q('[data-testid="card-submit"]')!);
		await settle();
		assert.match(q('[data-testid="card-error"]')?.textContent ?? "", /not an option/);
		assert.ok(q('[data-testid="pending-card"]'));
		assert.deepEqual(client.answers, []);
	});

	it("an answered card in history renders as a record with no controls", async () => {
		const client = new CardClient(FREE);
		client.answered = { answer: { value: "because" } };
		await mount(client);
		assert.ok(q('[data-testid="answered-card"]'));
		assert.equal(q('[data-testid="card-submit"]'), null);
		assert.match(q('[data-testid="card-answer-text"]')?.textContent ?? "", /because/);
	});

	it("a held answer (siblings wait) is shown after a reload and can be changed", async () => {
		const client = new CardClient(SINGLE);
		client.held = { answer: { value: "develop" } };
		await mount(client);
		assert.ok(q('[data-testid="pending-card"]'));
		assert.ok(q('[data-testid="card-held"]'), "held note");
		const picked = [...document.querySelectorAll('[data-testid="card-option"]')].map((o) => o.getAttribute("aria-pressed"));
		assert.deepEqual(picked, ["false", "true"]);
		assert.match(q('[data-testid="card-submit"]')!.textContent ?? "", /Update answer/);
		await click(document.querySelectorAll('[data-testid="card-option"]')[0]!);
		await click(q('[data-testid="card-submit"]')!);
		await settle();
		assert.deepEqual(client.answers, [{ callId: CALL, answers: { answer: { value: "main" } } }]);
	});

	it("a queued answer stays pending and shows as held", async () => {
		const client = new CardClient(SINGLE);
		client.holdNext = true;
		await mount(client);
		await click(document.querySelectorAll('[data-testid="card-option"]')[1]!);
		await click(q('[data-testid="card-submit"]')!);
		await settle();
		assert.ok(q('[data-testid="pending-card"]'));
		assert.ok(q('[data-testid="card-held"]'));
		assert.equal(q('[data-testid="answered-card"]'), null);
	});

	it("a superseded card renders as Superseded with no controls", async () => {
		const client = new CardClient(SINGLE);
		client.superseded = true;
		await mount(client);
		assert.match(q('[data-testid="dismissed-card"]')?.textContent ?? "", /Superseded/);
		assert.equal(q('[data-testid="card-submit"]'), null);
		assert.equal(q('[data-testid="pending-card"]'), null);
	});

	it("Skip posts a skip (no answer), the card shows Skipped read-only and the next turn streams in", async () => {
		const client = new CardClient(SINGLE);
		await mount(client);
		await click(q('[data-testid="card-skip"]')!);
		await settle();
		assert.deepEqual(client.skips, [CALL]);
		assert.deepEqual(client.answers, []);
		const card = q('[data-testid="dismissed-card"]');
		assert.ok(card, "the card closed");
		assert.equal(q('[data-testid="card-closed-badge"]')?.textContent, "Skipped");
		assert.equal(q('[data-testid="card-skip"]'), null);
		assert.equal(q('[data-testid="card-submit"]'), null);
		assert.ok(document.querySelectorAll('[data-testid="card-option"]').length > 0, "fields stay visible, read-only");
		assert.ok([...document.querySelectorAll('[data-testid="card-option"]')].every((o) => o.hasAttribute("disabled")));
		assert.match(document.body.textContent ?? "", /Shipping from the answer\./);
	});

	it("Skip works from any step of a stepped card", async () => {
		const STEPPED: Card = {
			tool: "ask_user_question",
			fields: [
				{ id: "one", kind: "free-text", label: "First?" },
				{ id: "two", kind: "free-text", label: "Second?" },
			],
			steps: [{ title: "A", fields: ["one"] }, { title: "B", fields: ["two"] }],
		};
		const client = new CardClient(STEPPED);
		await mount(client);
		assert.ok(q('[data-testid="card-skip"]'), "skip on step 1");
		await click(q('[data-testid="card-skip"]')!);
		await settle();
		assert.deepEqual(client.skips, [CALL]);
		assert.equal(q('[data-testid="card-closed-badge"]')?.textContent, "Skipped");
	});

	it("a queued skip stays pending and shows as held", async () => {
		const client = new CardClient(SINGLE);
		client.holdSkipNext = true;
		await mount(client);
		await click(q('[data-testid="card-skip"]')!);
		await settle();
		assert.ok(q('[data-testid="pending-card"]'));
		assert.ok(q('[data-testid="card-held-skip"]'));
		assert.equal(q('[data-testid="card-closed-badge"]'), null);
	});

	it("reload: skipped and superseded history show distinct badges", async () => {
		const skipped = new CardClient(SINGLE);
		skipped.skippedState = true;
		await mount(skipped);
		const a = q('[data-testid="card-closed-badge"]')!;
		assert.equal(a.textContent, "Skipped");
		assert.equal(q('[data-testid="dismissed-card"]')?.getAttribute("data-closed"), "skipped");
		const skippedClass = a.getAttribute("class");
		await unmount();
		const superseded = new CardClient(SINGLE);
		superseded.superseded = true;
		await mount(superseded);
		const b = q('[data-testid="card-closed-badge"]')!;
		assert.equal(b.textContent, "Superseded");
		assert.equal(q('[data-testid="dismissed-card"]')?.getAttribute("data-closed"), "superseded");
		assert.notEqual(b.getAttribute("class"), skippedClass, "distinct styling, not just text");
	});

	it("an answered card carries the Answered badge", async () => {
		const client = new CardClient(SINGLE);
		await mount(client);
		await click(document.querySelectorAll('[data-testid="card-option"]')[0]!);
		await click(q('[data-testid="card-submit"]')!);
		await settle();
		assert.equal(q('[data-testid="card-closed-badge"]')?.textContent, "Answered");
	});

	it("a 404 on answer (superseded meanwhile) refreshes the thread: the card turns skipped", async () => {
		const client = new CardClient(SINGLE);
		await mount(client);
		await click(document.querySelectorAll('[data-testid="card-option"]')[0]!);
		client.notFoundNext = true;
		client.superseded = true;
		await click(q('[data-testid="card-submit"]')!);
		await settle();
		assert.ok(q('[data-testid="dismissed-card"]'), "refetched record shows the card skipped");
		assert.match(q('[data-testid="card-error"]')?.textContent ?? "", /card/i);
	});

	it("multi: the default is pre-checked but nothing is sent until Submit; toggled picks POST as a list", async () => {
		const client = new CardClient(MULTI);
		await mount(client);
		const boxes = () => [...document.querySelectorAll('[data-testid="card-option"]')];
		assert.deepEqual(boxes().map((o) => o.getAttribute("aria-pressed")), ["true", "false", "false"]);
		await settle(120);
		assert.deepEqual(client.answers, [], "default never auto-submits");
		assert.ok(q('[data-testid="pending-card"]'));
		await click(boxes()[2]!);
		await click(q('[data-testid="card-submit"]')!);
		await settle();
		assert.deepEqual(client.answers, [{ callId: CALL, answers: { answer: { value: ["dev", "prod"] } } }]);
		assert.ok(q('[data-testid="answered-card"]'));
	});

	it("confirm: default pre-selects the confirm button without submitting; reject posts false", async () => {
		const client = new CardClient(CONFIRM);
		await mount(client);
		assert.equal(q('[data-testid="card-confirm"]')!.textContent, "Deploy");
		assert.equal(q('[data-testid="card-reject"]')!.textContent, "Hold off");
		assert.equal(q('[data-testid="card-confirm"]')!.getAttribute("aria-pressed"), "true");
		await settle(120);
		assert.deepEqual(client.answers, []);
		await click(q('[data-testid="card-reject"]')!);
		await click(q('[data-testid="card-submit"]')!);
		await settle();
		assert.deepEqual(client.answers, [{ callId: CALL, answers: { answer: { value: false } } }]);
		const rec = q('[data-testid="answered-card"]');
		assert.ok(rec);
		assert.equal(rec!.querySelector('[data-testid="card-reject"]')!.getAttribute("aria-pressed"), "true");
		assert.equal(rec!.querySelector('[data-testid="card-reject"]')!.hasAttribute("disabled"), true);
	});

	it("held multi / confirm answers show after a reload; a skipped confirm has no controls to answer with", async () => {
		const held = new CardClient(MULTI);
		held.held = { answer: { value: ["staging"] } };
		await mount(held);
		assert.ok(q('[data-testid="card-held"]'));
		assert.deepEqual([...document.querySelectorAll('[data-testid="card-option"]')].map((o) => o.getAttribute("aria-pressed")), ["false", "true", "false"]);
		await act(async () => root?.unmount());
		document.body.innerHTML = "";
		const skipped = new CardClient(CONFIRM);
		skipped.superseded = true;
		await mount(skipped);
		assert.match(q('[data-testid="dismissed-card"]')?.textContent ?? "", /Superseded/);
		assert.equal(q('[data-testid="card-submit"]'), null);
		assert.equal(q('[data-testid="card-confirm"]')!.hasAttribute("disabled"), true);
	});
});
