/** The Memory tab's curator line: shows pending (from the shared queue store) and filing (from events), hides at 0, re-renders when the store updates. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
let queue: { items: { wolf: string; denTopicId: string }[]; total: number } = { items: [], total: 0 };
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	IS_REACT_ACT_ENVIRONMENT: true,
	fetch: async () => ({ ok: true, json: async () => queue }),
});

const { CuratorLine } = await import("../../../components/graph/live/curator-line.tsx");
const { watchKbPending } = await import("../../../components/graph/live/kb-life-store.ts");

const filingEvent = { event: { v: 1, id: "e1", pack: "p", ts: 0, ttlMs: 1000, actor: { kind: "hub" }, verb: "curate-start", detail: { topicIds: ["t1"] } }, at: 1 } as never;

describe("curator line", () => {
	it("is empty at 0, shows pending and filing, and follows a store update without its own poll", async () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		await act(async () => root.render(<CuratorLine events={[]} />));
		assert.equal(host.textContent, "");

		queue = { items: [{ wolf: "jack", denTopicId: "a" }, { wolf: "jack", denTopicId: "b" }, { wolf: "hal", denTopicId: "c" }], total: 3 };
		let stop = () => {};
		await act(async () => {
			stop = watchKbPending(() => {});
			await new Promise((r) => setTimeout(r, 0));
		});
		assert.equal(host.textContent, "Curator · 3 pending");

		await act(async () => root.render(<CuratorLine events={[filingEvent]} />));
		assert.equal(host.textContent, "Curator · 3 pending · 1 filing");

		queue = { items: [], total: 0 };
		await act(async () => {
			stop();
			stop = watchKbPending(() => {});
			await new Promise((r) => setTimeout(r, 0));
		});
		assert.equal(host.textContent, "Curator · 1 filing");
		stop();
		await act(async () => root.unmount());
	});

	it("clears the pending count when the watcher stops, and does not read while the tab is hidden (work-wolfpack-W24l0C6)", async () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		await act(async () => root.render(<CuratorLine events={[]} />));
		queue = { items: [{ wolf: "jack", denTopicId: "a" }], total: 1 };
		let stop = () => {};
		await act(async () => {
			stop = watchKbPending(() => {});
			await new Promise((r) => setTimeout(r, 0));
		});
		assert.equal(host.textContent, "Curator · 1 pending");
		await act(async () => stop());
		assert.equal(host.textContent, "", "a stopped watcher leaves no stale count");

		let reads = 0;
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async () => (reads++, { ok: true, json: async () => queue })) as never;
		Object.defineProperty(document, "hidden", { value: true, configurable: true });
		try {
			await act(async () => {
				stop = watchKbPending(() => {});
				await new Promise((r) => setTimeout(r, 0));
			});
			assert.equal(reads, 0, "no read while hidden");
			assert.equal(host.textContent, "");
		} finally {
			stop();
			Object.defineProperty(document, "hidden", { value: false, configurable: true });
			globalThis.fetch = realFetch;
		}
		await act(async () => root.unmount());
	});
});
