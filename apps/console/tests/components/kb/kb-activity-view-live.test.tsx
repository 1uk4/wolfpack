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

const { KbActivityView } = await import("../../../components/kb/kb-activity-view.tsx");
const { ServerEventsProvider } = await import("../../../components/server-events.tsx");
const { kbActivityFixture } = await import("../../fixtures/kb-activity.ts");

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

/** Newest first: a stable time per id across responses. */
const ORDER = ["n", "a", "b", "c", "d", "e"];

/** A response whose wolfpack block holds decisions `ids` (newest first); `cursor` is the domain page cursor. */
function page(ids: string[], cursor?: string): KbActivityResponse {
	const d = kbActivityFixture();
	const out: KbActivityResponse = {
		...d,
		domains: [{ domain: "wolfpack", entries: 5, waiting: 0, contributors: [{ wolf: "w", count: ids.length + 10 }] }],
		changes: { domains: [] },
		decisions: {
			...d.decisions,
			items: ids.map((id) => ({ id, at: `2026-11-05T09:${String(59 - Math.max(0, ORDER.indexOf(id))).padStart(2, "0")}:00Z`, from: "w", denTopicId: id, hash: id, outcome: "create" as const, domain: "wolfpack" })),
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

const showAll = () => document.querySelector('[data-testid="kb-show-all"]')!;

describe("KbActivityView live behaviour", () => {
	it("debounces event-driven refetches into one request", async () => {
		await mount();
		await resolve(calls[0]!, page(["a"]));
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.url.searchParams.get("limit"), "50");
		await hubEvent("kb.changed");
		await hubEvent("sweep_finished");
		await hubEvent("resync");
		assert.equal(calls.length, 1); // still waiting out the debounce
		await settle(60);
		assert.equal(calls.length, 2);
		assert.equal(calls[1]!.url.searchParams.get("domain"), null);
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

	it("show all pages one domain (50 per page) and a refetch keeps what was loaded", async () => {
		await mount();
		await resolve(calls[0]!, page(["a", "b"]));
		await click(showAll());
		const first = calls[1]!;
		assert.equal(first.url.searchParams.get("domain"), "wolfpack");
		assert.equal(first.url.searchParams.get("limit"), "50");
		assert.equal(first.url.searchParams.get("before"), null);
		assert.equal(showAll().textContent, "Loading…");
		await resolve(first, page(["a", "b", "c", "d"], "c1"));
		assert.deepEqual(ids(), ["a", "b", "c", "d"]);
		await hubEvent("kb.changed");
		await settle(60);
		await resolve(calls[2]!, page(["n", "a", "b"]));
		assert.deepEqual(ids(), ["n", "a", "b", "c", "d"]); // the loaded page survives the refetch
		await click(showAll());
		assert.equal(calls[3]!.url.searchParams.get("before"), "c1"); // continues from the domain cursor
		await resolve(calls[3]!, page(["e"]));
		assert.deepEqual(ids(), ["n", "a", "b", "c", "d", "e"]);
		assert.equal(document.querySelector('[data-testid="kb-show-all"]'), null); // last page: no cursor left
	});

	it("the poll refetches the overview and stops on unmount", async () => {
		await mount(POLLING);
		await resolve(calls[0]!, page(["a", "b"]));
		await settle(150);
		const poll = calls[1]!;
		assert.equal(poll.url.searchParams.get("limit"), "50");
		await resolve(poll, page(["a", "b", "c"]));
		assert.deepEqual(ids(), ["a", "b", "c"]);
		await hubEvent("kb.changed");
		await act(async () => root!.unmount());
		root = null;
		const n = calls.length;
		await sleep(300);
		assert.equal(calls.length, n);
	});

	it("the since toggle starts over and ignores the old range's in-flight show all", async () => {
		await mount();
		await resolve(calls[0]!, page(["a", "b"]));
		await click(showAll());
		const more = calls[1]!;
		await click(document.querySelector('[data-since="7d"]')!);
		const reset = calls[2]!;
		assert.equal(reset.url.searchParams.get("since"), "7d");
		assert.equal(reset.url.searchParams.get("domain"), null);
		await resolve(reset, page(["s1"]));
		await resolve(more, page(["old1", "old2"], "c2")); // belongs to 30d: dropped
		assert.deepEqual(ids(), ["s1"]);
		assert.equal(document.querySelector('[data-since="7d"]')!.getAttribute("aria-pressed"), "true");
		assert.equal(showAll().textContent, "show all 11 →");
		// the range applies to a domain page too
		await click(showAll());
		assert.equal(calls[3]!.url.searchParams.get("since"), "7d");
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
});
