/** The Memory panel's observation pool: loaded on open, grouped into the den and work items, click-through, live updates. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
const store = new Map<string, string>();
interface Obs { id: string; timestamp: string; recordedAt: string; content: string; tokenCount: number; work?: string; feature?: string; blocked?: string }
let pool: Obs[] = [];
let poolStatus = 200;
let poolPending: { count: number; oldestAgeMs?: number } | undefined;
let poolFetches = 0;
const titles: Record<string, { title: string; stage: string; kind: string }> = {
	"work-a": { title: "Fix the login", stage: "in_build", kind: "task" },
	"work-f": { title: "Auth feature", stage: "approved", kind: "feature" },
};
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
	localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
	fetch: async (url: string) => {
		const u = String(url);
		const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
		if (u.endsWith("/memory/observations")) {
			poolFetches++;
			return poolStatus === 200 ? json({ observations: [...pool].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt)), total: pool.length, ...(poolPending ? { pending: poolPending } : {}) }) : json({ error: "nope", code: "memory_unavailable" }, poolStatus);
		}
		const m = /\/work\/([^/]+)\/record$/.exec(u);
		if (m) return titles[decodeURIComponent(m[1]!)] ? json({ id: m[1], plan: "", record: "", ...titles[decodeURIComponent(m[1]!)] }) : json({ error: "gone", code: "not_found" }, 404);
		return json({ state: "live", bound: null, pool: { count: pool.length, tokens: 10, consolidateAtTokens: 100, poolTarget: 50, trigger: "hybrid" } });
	},
});

const { MemoryPanel } = await import("../components/memory-panel.tsx");
const { MemoryEventsProvider } = await import("../components/memory-events.tsx");

let emit: (frame: unknown) => void = () => {};
const source = () => ({
	close() {},
	onOpen() {},
	onMessage: (cb: (data: string) => void) => void (emit = (f) => cb(JSON.stringify(f))),
	onError() {},
});
const settle = (ms = 40) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const qa = (sel: string) => [...document.querySelectorAll(sel)] as HTMLElement[];
const click = (el: Element) => act(async () => void el.dispatchEvent(new dom.window.Event("click", { bubbles: true, cancelable: true })));
const ob = (id: string, at: string, content: string, tags: { work?: string; feature?: string } = {}): Obs => ({ id, timestamp: at.slice(0, 16).replace("T", " "), recordedAt: at, content, tokenCount: 3, ...tags });

let root: Root | null = null;
async function mount() {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => root!.render(<MemoryEventsProvider connect={source}><MemoryPanel embedded wolf="w" threadId="t1" /></MemoryEventsProvider>));
	await settle();
}
beforeEach(() => {
	store.clear();
	pool = [
		ob("1", "2026-10-26T09:00:00Z", "den one"),
		ob("2", "2026-10-26T10:00:00Z", "task early", { work: "work-a", feature: "work-f" }),
		ob("3", "2026-10-26T11:00:00Z", "task late", { work: "work-a", feature: "work-f" }),
		ob("4", "2026-10-26T12:00:00Z", "feature only", { feature: "work-f" }),
		ob("5", "2026-10-26T08:00:00Z", "den two"),
	];
	poolStatus = 200;
	poolPending = undefined;
	poolFetches = 0;
	emit = () => {};
});
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});

describe("observation pool in the Memory panel", () => {
	it("loads the persisted pool on open (no live event needed) and groups it: Den, then work items with title, stage and count", async () => {
		await mount();
		assert.equal(poolFetches >= 1, true);
		assert.equal(q('[data-testid="memory-feed"]')!.textContent!.includes("Nothing captured yet"), false);
		const rows = qa('[data-testid="memory-obs-groups"] button');
		assert.deepEqual(rows.map((r) => r.getAttribute("data-testid")), ["memory-obs-group-den", "memory-obs-group-work-f", "memory-obs-group-work-a"]);
		assert.deepEqual(rows.map((r) => r.getAttribute("data-count")), ["2", "1", "2"]);
		assert.match(rows[0]!.textContent!, /^Den/);
		assert.match(rows[1]!.textContent!, /Auth feature/);
		assert.match(rows[1]!.textContent!, /approved/);
		assert.match(rows[2]!.textContent!, /Fix the login/);
		assert.match(rows[2]!.textContent!, /in build/);
	});

	it("shows \"waiting for Work API\" on a group whose observations are blocked, and only on that group", async () => {
		pool = [
			ob("1", "2026-10-26T09:00:00Z", "den one"),
			{ ...ob("2", "2026-10-26T10:00:00Z", "task early", { work: "work-a" }), blocked: "work-api-unavailable" },
		];
		await mount();
		assert.match(q('[data-testid="memory-obs-group-work-a"]')!.textContent!, /waiting for Work API/);
		assert.equal(q('[data-testid="memory-obs-group-den"]')!.querySelector('[data-testid="memory-obs-blocked"]'), null);
	});

	it("warns when pending observations are old or many, and says why a group is blocked", async () => {
		pool = [{ ...ob("2", "2026-10-26T10:00:00Z", "x", { work: "work-a" }), blocked: "consolidation-failed" }];
		poolPending = { count: 1, oldestAgeMs: 25 * 3_600_000 };
		await mount();
		assert.match(q('[data-testid="memory-obs-pending-warning"]')!.textContent!, /waited over 25 h/);
		assert.match(q('[data-testid="memory-obs-blocked"]')!.textContent!, /consolidation failed/);
	});

	it("shows no warning for a fresh, small backlog", async () => {
		poolPending = { count: 3, oldestAgeMs: 60_000 };
		await mount();
		assert.equal(q('[data-testid="memory-obs-pending-warning"]'), null);
	});

	it("falls back to the id when the work lookup fails", async () => {
		pool = [ob("1", "2026-10-26T09:00:00Z", "x", { work: "work-gone" })];
		await mount();
		const row = q('[data-testid="memory-obs-group-work-gone"]')!;
		assert.match(row.textContent!, /work-gone/);
		assert.equal(row.querySelector('[data-testid="memory-obs-stage"]'), null);
	});

	it("an empty pool says nothing captured; a failed load says unavailable", async () => {
		pool = [];
		await mount();
		assert.match(q('[data-testid="memory-feed"]')!.textContent!, /Nothing captured yet/);
		await act(async () => root!.unmount());
		document.body.innerHTML = "";
		poolStatus = 409;
		await mount();
		assert.match(q('[data-testid="memory-obs-state"]')!.textContent!, /unavailable/);
	});

	it("clicking a row lists that item's observations newest first with timestamp and text; back returns to the list", async () => {
		await mount();
		await click(q('[data-testid="memory-obs-group-work-a"]')!);
		const items = qa('[data-testid="memory-obs-item"]');
		assert.equal(items.length, 2);
		assert.match(items[0]!.textContent!, /2026-10-26 11:00.*task late/);
		assert.match(items[1]!.textContent!, /2026-10-26 10:00.*task early/);
		assert.match(q('[data-testid="memory-obs-back"]')!.textContent!, /Fix the login/);
		await click(q('[data-testid="memory-obs-back"]')!);
		assert.equal(qa('[data-testid="memory-obs-groups"] button').length, 3);
		await click(q('[data-testid="memory-obs-group-den"]')!);
		assert.deepEqual(qa('[data-testid="memory-obs-item"]').map((i) => i.textContent!.replace(/^[\d\- :]+/, "")), ["den one", "den two"]);
	});

	it("a live observation updates the counts and the open list, with no duplicate of what was loaded", async () => {
		await mount();
		const before = poolFetches;
		await click(q('[data-testid="memory-obs-group-work-a"]')!);
		pool.push(ob("6", "2026-10-26T13:00:00Z", "task live", { work: "work-a", feature: "work-f" }));
		await act(async () => emit({ type: "observation_captured", wolf: "w", threadId: "t1", summary: "task live", count: 1, target: { kind: "work", workId: "work-a" } }));
		await settle(400);
		assert.equal(poolFetches > before, true);
		const items = qa('[data-testid="memory-obs-item"]');
		assert.equal(items.length, 3);
		assert.match(items[0]!.textContent!, /task live/);
		assert.equal(new Set(items.map((i) => i.textContent)).size, 3);
		await click(q('[data-testid="memory-obs-back"]')!);
		assert.equal(q('[data-testid="memory-obs-group-work-a"]')!.getAttribute("data-count"), "3");
		// a general one lands in the Den; the same event twice leaves one copy
		pool.push(ob("7", "2026-10-26T14:00:00Z", "den live"));
		for (let i = 0; i < 2; i++) await act(async () => emit({ type: "observation_captured", wolf: "w", summary: "den live", count: 1, target: { kind: "den" } }));
		await settle(400);
		assert.equal(q('[data-testid="memory-obs-group-den"]')!.getAttribute("data-count"), "3");
		assert.equal(q('[data-testid="memory-obs-group-work-a"]')!.getAttribute("data-count"), "3");
	});
});
