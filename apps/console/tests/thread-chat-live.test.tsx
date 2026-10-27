/**
 * ThreadChat follows a turn it did not start (wolfd delivered a subagent result as a steer, a harness revision):
 * the wolf announces only a busy thread-status (needs-you-changed), the chat attaches to the stream and renders
 * text, a card, an object revision and the final message live, with no reload and no duplicates.
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

const { MockConsoleClient, FIXTURE_THREAD } = await import("@wolfpack/client");
type ThreadEvent = import("@wolfpack/client").ThreadEvent;
type ThreadDetail = import("@wolfpack/client").ThreadDetail;
type WatchOptions = import("@wolfpack/client").WatchOptions;
const { createThreadApi } = await import("../src/server/thread-api.ts");
const { cardsOfThread, threadMessagesToNative } = await import("../src/core/index.ts");
const { SettingsDialogProvider } = await import("../components/settings/settings-dialog.tsx");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
const { ThreadChat } = await import("../components/thread-chat.tsx");
const { MemoryEventsProvider } = await import("../components/memory-events.tsx");
const { ServerEventsProvider } = await import("../components/server-events.tsx");

const frames = new Map<string, (data: string) => void>();
const eventsSource = () => ({
	close() {},
	onOpen() {},
	onEvent(name: string, cb: (data: string) => void) {
		frames.set(name, cb);
	},
});
const inertSource = () => ({ close() {}, onOpen() {}, onMessage() {}, onError() {} });

const CL1 = { title: "Plan", items: [{ id: "a", label: "Write", state: "doing" }, { id: "b", label: "Test", state: "todo" }] };
const CL2 = { title: "Plan", items: [{ id: "a", label: "Write", state: "done" }, { id: "b", label: "Test", state: "doing" }] };
const CARD = { tool: "ask_user_question", fields: [{ id: "answer", kind: "free-text", label: "Which branch?" }] };

/** A client whose thread gets a turn from OUTSIDE the console: the test pushes its events and the wolf's stream serves them. */
class ServerTurnClient extends MockConsoleClient {
	private events: ThreadEvent[] = [];
	private waiters = new Set<() => void>();
	private running = false;
	watches = 0;
	private n = 0;
	constructor() {
		super({ delayMs: 0, script: [] });
	}
	push(e: Record<string, unknown>) {
		if (e.type === "turn-start") {
			this.events = [];
			this.running = true;
		}
		if (e.type === "turn-end") this.running = false;
		this.events.push({ threadId: FIXTURE_THREAD.id, at: new Date().toISOString(), turnId: "srv", id: ++this.n, ...e } as unknown as ThreadEvent);
		for (const w of [...this.waiters]) w();
	}
	override async *watch(_threadId: string, _opts: WatchOptions = {}): AsyncIterable<ThreadEvent> {
		this.watches++;
		let i = 0;
		for (;;) {
			while (i < this.events.length) {
				const ev = this.events[i++]!;
				yield ev;
				if (ev.type === "turn-end") return;
			}
			if (!this.running) return;
			await new Promise<void>((r) => {
				const w = () => (this.waiters.delete(w), r());
				this.waiters.add(w);
			});
		}
	}
	/** Like the wolf's record: a raised card pends there too. */
	override async getThread(id: string): Promise<ThreadDetail> {
		const base = await super.getThread(id);
		const card = this.events.find((e) => e.type === "card-pending") as { card: NonNullable<ThreadDetail["pendingCards"]>[number] } | undefined;
		return { ...base, busy: this.running, ...(card ? { pendingCards: [card.card] } : {}) };
	}
}

const realFetch = globalThis.fetch;
let root: Root | null = null;

function routeFetch(client: ServerTurnClient): typeof fetch {
	const api = createThreadApi(() => client);
	const ref = { wolf: "1uk4", slug: "home" };
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input), "http://t");
		const req = new Request(url, init);
		if (url.pathname.endsWith("/stream")) return api.stream(ref, req);
		if (url.pathname.endsWith("/threads/home")) return api.thread(ref);
		return new Response("{}", { status: 404 });
	}) as typeof fetch;
}

async function mount(client: ServerTurnClient) {
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
							<ThreadChat wolf="1uk4" slug="home" threadId={FIXTURE_THREAD.id} title="Home" initialMessages={threadMessagesToNative(detail.messages)} initialCards={cardsOfThread(detail)} />
						</MemoryEventsProvider>
					</ServerEventsProvider>
				</SettingsDialogProvider>
			</AppRouterContext.Provider>,
		);
	});
}

const settle = (ms = 40) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const busy = (threadId = FIXTURE_THREAD.id) => act(async () => frames.get("needs-you-changed")!(JSON.stringify({ wolf: "1uk4", threadId, kind: "status", status: "busy" })));
const text = () => document.body.textContent ?? "";
const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;

after(() => {
	globalThis.fetch = realFetch;
});
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});

describe("ThreadChat follows a server-started turn", () => {
	it("busy event -> attaches; text, a card, an object revision and the final message render live", async () => {
		const client = new ServerTurnClient();
		await mount(client);
		await settle();
		assert.equal(client.watches, 0, "idle thread: nothing attached");

		client.push({ type: "turn-start" });
		await busy();
		await settle();
		assert.equal(client.watches, 1, "attached to the server-started turn");

		await act(async () => {
			client.push({ type: "text-delta", text: "Subagent one finished." });
		});
		await settle();
		assert.match(text(), /Subagent one finished\./);

		await act(async () => {
			client.push({ type: "tool-start", callId: "k1", name: "show_checklist", args: { objectId: "cl", ...CL1 } });
			client.push({ type: "object-upsert", objectId: "cl", objectType: "checklist", rev: 1, data: CL1, textOffset: 22 });
			client.push({ type: "tool-end", callId: "k1", result: "ok", isError: false });
		});
		await settle();
		const states = () => [...document.querySelectorAll('[data-testid="checklist-item"]')].map((i) => i.getAttribute("data-state"));
		assert.deepEqual(states().slice(0, 2), ["doing", "todo"]);

		await act(async () => {
			client.push({ type: "tool-start", callId: "k2", name: "show_checklist", args: { objectId: "cl", ...CL2 } });
			client.push({ type: "object-upsert", objectId: "cl", objectType: "checklist", rev: 2, data: CL2, textOffset: 22 });
			client.push({ type: "tool-end", callId: "k2", result: "ok", isError: false });
			client.push({ type: "tool-start", callId: "q1", name: "ask_user_question", args: { question: "q" } });
			client.push({ type: "card-pending", card: { callId: "q1", threadId: FIXTURE_THREAD.id, card: CARD, raisedAt: new Date().toISOString() } });
		});
		await settle();
		assert.deepEqual(states().slice(0, 2), ["done", "doing"], "checklist ticked live");
		assert.ok(q('[data-testid="pending-card"]'), "question card shows live");
		assert.match(text(), /Which branch\?/);

		await act(async () => {
			client.push({ type: "text-delta", text: "Waiting on you." });
			client.push({ type: "turn-end", reason: "complete" });
		});
		await settle();
		assert.equal(text().split("Subagent one finished.").length - 1, 1, "no duplicate message");
		assert.match(text(), /Waiting on you\./);
		assert.ok(q('[data-testid="pending-card"]'), "card still pending after the turn settles");
	});

	it("a turn that finished before the late busy arrived is in the refetched record: no replay, no duplicate", async () => {
		const client = new ServerTurnClient();
		await mount(client);
		client.push({ type: "turn-start" });
		client.push({ type: "text-delta", text: "Already recorded." });
		client.push({ type: "turn-end", reason: "complete" });
		// the record (refetched on attach) already carries the finished turn
		const detail = await client.getThread(FIXTURE_THREAD.id);
		client.getThread = async () => ({ ...detail, busy: false, messages: [...detail.messages, { id: "srv-1", role: "assistant", text: "Already recorded.", at: new Date().toISOString() }] });
		await busy();
		await settle();
		assert.equal(text().split("Already recorded.").length - 1, 1, "shown once");
	});

	it("a busy event for another thread does not attach", async () => {
		const client = new ServerTurnClient();
		await mount(client);
		client.push({ type: "turn-start" });
		await busy("1uk4/other");
		await settle();
		assert.equal(client.watches, 0);
	});
});
