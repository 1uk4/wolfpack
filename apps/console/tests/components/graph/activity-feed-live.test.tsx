/**
 * The activity feed in a DOM, fed by the real live client (fake presence + SSE stream): a thread becoming active must show its feed line,
 * not throw (it crashed the whole graph page into its error screen).
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
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
	self: globalThis,
});

const { ActivityFeed } = await import("../../../components/graph/live/activity-feed.tsx");
const { FakeNav } = await import("../../helpers/fake-nav.tsx");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const T = "1uk4/feature-work-wolfpack-ELzLSkV";
const enc = new TextEncoder();
const frame = (event: unknown) => enc.encode(`data: ${JSON.stringify({ type: "pack.activity", at: new Date().toISOString(), event })}\n\n`);

let push: (b: Uint8Array) => void = () => {};
const realFetch = globalThis.fetch;
beforeEach(() => {
	globalThis.fetch = ((input: string) => {
		if (String(input).includes("presence")) return Promise.resolve(Response.json({ v: 1, pack: "default", at: Date.now(), wolves: [], threads: [], subagents: [], owner: [] }));
		const body = new ReadableStream<Uint8Array>({ start: (c) => void (push = (b) => c.enqueue(b)) });
		return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));
	}) as typeof fetch;
});
afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("ActivityFeed with live frames", () => {
	let root: Root;
	let host: HTMLElement;
	afterEach(() => act(() => root.unmount()));

	it("shows a thread's started-working line instead of throwing", async () => {
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		const errors: unknown[] = [];
		const orig = console.error;
		console.error = () => {};
		try {
			await act(async () => {
				root.render(
					<FakeNav start="/graph">
						<ActivityFeed renderer={null} settings={{ live: { enabled: true } }} />
					</FakeNav>,
				);
				await sleep(50);
			});
			try {
				await act(async () => {
				push(frame({ v: 1, id: "a1", pack: "default", ts: Date.now(), ttlMs: 120000, actor: { kind: "thread", wolf: "1uk4", threadId: T, title: "Live map" }, verb: "thread-active" }));
				await sleep(250); // the store tells React at most every 150 ms
				});
			} catch (e) {
				errors.push(e);
			}
		} finally {
			console.error = orig;
		}
		assert.deepEqual(errors, []);
		assert.match(host.textContent ?? "", /1uk4 · started working Live map/);
	});
});
