/**
 * The whole live path against a REAL wolfd: startTestWolf -> HttpConsoleClient -> the console's real activity bridge and
 * /api/events seam -> the real thread API (record + stream routes) -> ThreadChat. A sub-agent's result starts a parent
 * turn nobody submitted; the open thread must show it and the parent's reply live (no reload), and nothing calls
 * /api/needs-you (the bridge has to start from the events channel alone).
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

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const { fauxAssistantMessage, fauxToolCall } = await import("../../../packages/harness/dist/wolfd/scripted-model.js");
const { startTestWolf } = await import("../../../packages/harness/dist/wolfd/test-wolf.js");
type TestWolf = import("../../../packages/harness/dist/wolfd/test-wolf.js").TestWolf;
const { createThreadApi } = await import("../src/server/thread-api.ts");
const { activityBridge } = await import("../src/server/needs-you-api.ts");
const { setConsoleClient } = await import("../src/server/console-client.ts");
const { eventsResponse } = await import("../src/server/events-stream.ts");
const { cardsOfThread, threadMessagesToNative } = await import("../src/core/index.ts");
const { SettingsDialogProvider } = await import("../components/settings/settings-dialog.tsx");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
const { ThreadChat } = await import("../components/thread-chat.tsx");
const { MemoryEventsProvider } = await import("../components/memory-events.tsx");
const { ServerEventsProvider } = await import("../components/server-events.tsx");

const inertSource = () => ({ close() {}, onOpen() {}, onMessage() {}, onError() {} });
const PROFILE = "---\nname: tester\ndescription: A scripted test agent\nmodel: fast\ntools: read, grep\n---\n\nYou are a test agent.\n";

/** The console's real /api/events response as the browser's NotifySource. */
function realEventsSource() {
	const handlers = new Map<string, (data: string) => void>();
	let onOpen = () => {};
	const res = eventsResponse();
	const reader = res.body!.getReader();
	void (async () => {
		const dec = new TextDecoder();
		let buf = "";
		for (;;) {
			const { value, done } = await reader.read();
			if (done) return;
			buf += dec.decode(value);
			for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
				const frame = buf.slice(0, i);
				buf = buf.slice(i + 2);
				if (frame.startsWith(": connected")) onOpen();
				const m = /^event: (\S+)\ndata: (.*)$/s.exec(frame);
				if (m) handlers.get(m[1]!)?.(m[2]!);
			}
		}
	})().catch(() => {});
	return {
		close: () => void reader.cancel().catch(() => {}),
		onOpen: (cb: () => void) => void (onOpen = cb),
		onEvent: (name: string, cb: (data: string) => void) => void handlers.set(name, cb),
	};
}

const realFetch = globalThis.fetch;
let root: Root | null = null;
let tw: TestWolf | undefined;

after(() => {
	globalThis.fetch = realFetch;
});
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
	activityBridge().stop();
	(globalThis as Record<symbol, unknown>)[Symbol.for("wolfpack.console.activityBridge")] = undefined;
	setConsoleClient(undefined);
	await tw?.stop();
	tw = undefined;
});

const text = () => document.body.textContent ?? "";
const until = async (fn: () => boolean, ms = 10000) => {
	const end = Date.now() + ms;
	while (!fn()) {
		if (Date.now() > end) assert.fail(`timed out; page text: ${text().slice(0, 400)}`);
		await act(async () => void (await new Promise((r) => setTimeout(r, 30))));
	}
};

describe("ThreadChat on a real wolf", () => {
	it("shows a steer-started parent turn (a sub-agent's result and the parent's reply) without a reload", async () => {
		let open!: () => void;
		const gate = new Promise<void>((r) => (open = r));
		const step: import("../../../packages/harness/dist/wolfd/scripted-model.js").FauxResponseStep = async (ctx, options) => {
			const child = JSON.stringify(ctx.messages.filter((m) => m.role === "system")).includes("You are the sub-agent");
			const last = ctx.messages[ctx.messages.length - 1];
			const t = typeof last.content === "string" ? last.content : (last.content as Array<{ type: string; text?: string }>).map((b) => b.text ?? "").join("");
			if (!child) {
				if (last.role === "toolResult") return fauxAssistantMessage("spawned");
				if (t.startsWith("spawn:")) return fauxAssistantMessage(fauxToolCall("subagent", { agent: "tester", task: "SLOW work", name: "tester" }), { stopReason: "toolUse" });
				return fauxAssistantMessage("PARENT_REPLY_TO_RESULT");
			}
			await Promise.race([gate, new Promise<void>((r) => options?.signal?.addEventListener("abort", () => r()))]);
			return fauxAssistantMessage("CHILD_RESULT_TEXT");
		};
		tw = await startTestWolf({ script: Array.from({ length: 40 }, () => step) });
		const dir = join(tw.root, "agent", "agents");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "tester.md"), PROFILE);
		setConsoleClient(tw.client);

		const api = createThreadApi(() => tw!.client);
		const ref = { wolf: "testwolf", slug: "home" };
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input), "http://t");
			if (url.origin !== "http://t") return realFetch(input, init); // the wolf itself
			const req = new Request(url, init);
			if (url.pathname.endsWith("/stream")) return api.stream(ref, req);
			if (url.pathname.endsWith("/threads/home")) return api.thread(ref);
			return new Response("{}", { status: 404 });
		}) as typeof fetch;

		await tw.client.submit(tw.home, "spawn: x", { whenBusy: "reject" });
		for await (const _ of tw.client.watch(tw.home));
		const detail = await tw.client.getThread(tw.home);
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		await act(async () => {
			root!.render(
				<AppRouterContext.Provider value={{ push() {} } as never}>
					<SettingsDialogProvider>
						<ServerEventsProvider connect={realEventsSource}>
							<MemoryEventsProvider connect={inertSource}>
								<ThreadChat wolf="testwolf" slug="home" threadId={tw.home} title="Home" initialMessages={threadMessagesToNative(detail.messages)} initialCards={cardsOfThread(detail)} />
							</MemoryEventsProvider>
						</ServerEventsProvider>
					</SettingsDialogProvider>
				</AppRouterContext.Provider>,
			);
		});
		await act(async () => void (await new Promise((r) => setTimeout(r, 300))));
		assert.ok(!text().includes("PARENT_REPLY_TO_RESULT"));

		open(); // the child finishes: its result starts a parent turn
		await until(() => text().includes("PARENT_REPLY_TO_RESULT"));
		assert.equal(text().split("PARENT_REPLY_TO_RESULT").length - 1, 1, "shown once");
	});
});
