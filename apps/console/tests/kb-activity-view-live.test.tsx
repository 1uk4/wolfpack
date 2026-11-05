/**
 * KbActivityView in a DOM (linkedom): the refetch debounce, the sequence guard, a refetch racing Load more, the poll cleared on unmount,
 * and the since toggle resetting paging. fetch is a controllable stub; events arrive through ServerEventsProvider's injectable source.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { KbActivityResponse } from "@wolfpack/client";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	self: globalThis, // next/link's idle-prefetch helper reads `self`
});

const { KbActivityView } = await import("../components/kb-activity-view.tsx");
const { ServerEventsProvider } = await import("../components/server-events.tsx");
const { kbActivityFixture } = await import("./fixtures/kb-activity.ts");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TIMING = { debounceMs: 25, pollMs: 5_000 };
const POLLING = { debounceMs: 25, pollMs: 120 };

interface Call {
	url: URL;
	respond(data: KbActivityResponse | number, headers?: Record<string, string>): void;
}
let calls: Call[] = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
	calls = [];
	globalThis.fetch = ((input: string) =>
		new Promise<Response>((resolve) => {
			calls.push({
				url: new URL(input, "http://x"),
				respond: (d, headers) => resolve(typeof d === "number" ? Response.json({ error: "e" }, { status: d, ...(headers ? { headers } : {}) }) : Response.json(d)),
			});
		})) as typeof fetch;
});

/** A response with decisions `ids` (newest first) and an optional cursor. */
function page(ids: string[], cursor?: string): KbActivityResponse {
	const d = kbActivityFixture();
	const out: KbActivityResponse = {
		...d,
		decisions: {
			...d.decisions,
			items: ids.map((id) => ({ id, at: "2026-11-05T09:00:00Z", from: "w", denTopicId: id, hash: id, outcome: "create" as const })),
			total: ids.length,
		},
	};
	if (cursor) out.decisions.nextCursor = cursor;
	else delete out.decisions.nextCursor;
	return out;
}

type Frame = Parameters<NonNullable<ConstructorParameters<never>[0]>>;
let emit: (name: string, data: unknown) => void = () => {};
function connect() {
	const handlers = new Map<string, (d: string) => void>();
	emit = (name, data) => handlers.get(name)?.(JSON.stringify(data));
	return { close() {}, onOpen() {}, onEvent: (n: string, cb: (d: string) => void) => void handlers.set(n, cb) };
}
const hubEvent = (type: string) => act(async () => emit("hub-event", { frame: { type, id: 1, at: "2026-11-05T10:00:00Z" } }));

let root: Root | null = null;
async function mount(timing = TIMING) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => root!.render(<ServerEventsProvider connect={connect}><KbActivityView timing={timing} /></ServerEventsProvider>));
}
afterEach(async () => {
	globalThis.fetch = realFetch;
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});

const settle = (ms = 0) => act(async () => void (await sleep(ms)));
const ids = () => [...document.querySelectorAll("[data-decision]")].map((e) => e.getAttribute("data-decision"));
const click = (el: Element) => act(async () => void el.dispatchEvent(new dom.window.Event("click", { bubbles: true, cancelable: true })));
const resolve = (c: Call, d: KbActivityResponse) => act(async () => void c.respond(d));

describe("KbActivityView live behaviour", () => {
	it("debounces event-driven refetches into one request", async () => {
		await mount();
		await resolve(calls[0]!, page(["a"]));
		assert.equal(calls.length, 1);
		await hubEvent("kb.changed");
		await hubEvent("sweep_finished");
		await hubEvent("resync");
		assert.equal(calls.length, 1); // still waiting out the debounce
		await settle(60);
		assert.equal(calls.length, 2);
		assert.equal(calls[1]!.url.searchParams.get("limit"), "50");
		assert.equal(calls[1]!.url.searchParams.get("before"), null);
	});

	it("only the newest refetch may land (sequence guard)", async () => {
		await mount();
		await resolve(calls[0]!, page(["a"]));
		await hubEvent("kb.changed");
		await settle(60); // refetch #1 in flight
		await hubEvent("kb.changed");
		await settle(60); // refetch #2 in flight
		assert.equal(calls.length, 3);
		await resolve(calls[2]!, page(["new"]));
		await resolve(calls[1]!, page(["stale"])); // the older answer arrives last: ignored
		assert.deepEqual(ids(), ["new"]);
	});

	it("a refetch that lands while Load more is in flight keeps the list; the page is merged", async () => {
		await mount();
		await resolve(calls[0]!, page(["a", "b"], "c1"));
		await click(document.querySelector('[data-testid="kb-load-more"]')!);
		const more = calls[1]!;
		assert.equal(more.url.searchParams.get("before"), "c1");
		await hubEvent("kb.changed");
		await settle(60);
		await resolve(calls[2]!, page(["n", "a", "b"], "c1")); // refetch lands first, same cursor
		await resolve(more, page(["c", "d"], "c2"));
		assert.deepEqual(ids(), ["n", "a", "b", "c", "d"]);
		assert.equal(document.querySelector('[data-testid="kb-load-more"]')!.textContent, "Load more");
	});

	it("when the refetch moved the cursor the stale page is dropped and Load more retries from the new cursor", async () => {
		await mount();
		await resolve(calls[0]!, page(["a", "b"], "c1"));
		await click(document.querySelector('[data-testid="kb-load-more"]')!);
		const more = calls[1]!;
		await hubEvent("kb.changed");
		await settle(60);
		await resolve(calls[2]!, page(["x", "y"], "c9")); // no overlap: paging restarts, new cursor
		await resolve(more, page(["c", "d"], "c2"));
		assert.deepEqual(ids(), ["x", "y"]); // the old page was not spliced in
		assert.equal(calls.length, 4);
		assert.equal(calls[3]!.url.searchParams.get("before"), "c9");
		await resolve(calls[3]!, page(["z"]));
		assert.deepEqual(ids(), ["x", "y", "z"]);
		assert.equal(document.querySelector('[data-testid="kb-load-more"]'), null);
	});

	it("the poll refetches only the first page and keeps loaded pages", async () => {
		await mount(POLLING);
		await resolve(calls[0]!, page(["a", "b"], "c1"));
		await click(document.querySelector('[data-testid="kb-load-more"]')!);
		await resolve(calls[1]!, page(["c", "d"], "c2"));
		assert.deepEqual(ids(), ["a", "b", "c", "d"]);
		await settle(150);
		const poll = calls[2]!;
		assert.equal(poll.url.searchParams.get("limit"), "50");
		await resolve(poll, page(["a", "b"], "c1"));
		assert.deepEqual(ids(), ["a", "b", "c", "d"]);
		await click(document.querySelector('[data-testid="kb-load-more"]')!);
		assert.equal(calls[3]!.url.searchParams.get("before"), "c2"); // the deepest cursor survived
	});

	it("the poll and a pending debounce stop on unmount", async () => {
		await mount(POLLING);
		await resolve(calls[0]!, page(["a"]));
		await hubEvent("kb.changed");
		await act(async () => root!.unmount());
		root = null;
		const n = calls.length;
		await sleep(300);
		assert.equal(calls.length, n);
	});

	it("the since toggle starts paging over and ignores the old range's in-flight Load more", async () => {
		await mount();
		await resolve(calls[0]!, page(["a", "b"], "c1"));
		await click(document.querySelector('[data-testid="kb-load-more"]')!);
		const more = calls[1]!;
		await click(document.querySelector('[data-since="7d"]')!);
		const reset = calls[2]!;
		assert.equal(reset.url.searchParams.get("since"), "7d");
		assert.equal(reset.url.searchParams.get("before"), null);
		await resolve(reset, page(["s1"], "d1"));
		await resolve(more, page(["old"], "c2")); // belongs to 30d: dropped
		assert.deepEqual(ids(), ["s1"]);
		assert.equal(document.querySelector('[data-since="7d"]')!.getAttribute("aria-pressed"), "true");
		assert.equal(document.querySelector('[data-testid="kb-load-more"]')!.textContent, "Load more");
	});

	it("a 401 with the hub-auth marker shows the unpaired message", async () => {
		await mount();
		await act(async () => calls[0]!.respond(401, { "X-Wolfpack-Hub-Auth": "required" }));
		assert.match(document.body.textContent ?? "", /not paired with the hub/);
	});

	it("any other 401 shows a generic unauthorized message", async () => {
		await mount();
		await act(async () => calls[0]!.respond(401));
		assert.match(document.body.textContent ?? "", /Unauthorized/);
		assert.doesNotMatch(document.body.textContent ?? "", /not paired/);
	});

	it("when the cursor moves twice during Load more it retries once and then stops", async () => {
		await mount();
		await resolve(calls[0]!, page(["a", "b"], "c1"));
		await click(document.querySelector('[data-testid="kb-load-more"]')!);
		const first = calls[1]!; // before=c1
		await hubEvent("kb.changed");
		await settle(60);
		await resolve(calls[2]!, page(["x", "y"], "c9")); // cursor moved once
		await resolve(first, page(["c"], "c2")); // stale: dropped, one retry from c9
		const retry = calls[3]!;
		assert.equal(retry.url.searchParams.get("before"), "c9");
		await hubEvent("kb.changed");
		await settle(60);
		await resolve(calls[4]!, page(["p", "q"], "c10")); // cursor moved a second time
		await resolve(retry, page(["r"], "c11")); // stale again: dropped, NO second retry
		await settle(30);
		assert.equal(calls.length, 5);
		assert.deepEqual(ids(), ["p", "q"]);
		assert.equal(document.querySelector('[data-testid="kb-load-more"]')!.textContent, "Load more"); // not stuck loading
	});
});
