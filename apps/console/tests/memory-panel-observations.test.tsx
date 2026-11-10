/** The Memory panel's observation tree: feature → tasks with counts, tap-through to a node's pending and archived observations, blocked/backoff notes, live refetch. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
const store = new Map<string, string>();
interface Obs { id: string; timestamp: string; recordedAt: string; content: string; tokenCount: number; work?: string; feature?: string; blocked?: string; blockedMessage?: string }
let pool: Obs[] = [];
let poolStatus = 200;
let poolPending: { count: number; oldestAgeMs?: number } | undefined;
let treeFetches = 0;
const tree = () => ({
	features: [{ id: "work-d-f", title: "Auth feature", stage: "approved", own: { pending: 1, archived: 0 }, tasks: [{ id: "work-d-a", title: "Fix the login", pending: 2, archived: 1 }] }],
	other: [],
	den: { pending: 2 },
});
const nodes: Record<string, unknown> = {
	"work-d-a": {
		id: "work-d-a",
		pending: [{ id: "p1", content: "task late", recordedAt: "2026-10-26T11:00:00Z" }, { id: "p2", content: "task early", recordedAt: "2026-10-26T10:00:00Z" }],
		archived: [{ id: "a1", content: "task done", at: "2026-10-25T09:00:00Z", outcome: "written", target: "Record of work-d-a" }],
		truncated: true,
	},
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
			return poolStatus === 200 ? json({ observations: pool, total: pool.length, ...(poolPending ? { pending: poolPending } : {}) }) : json({ error: "nope", code: "memory_unavailable" }, poolStatus);
		}
		if (u.endsWith("/memory/tree")) {
			treeFetches++;
			return poolStatus === 200 ? json(tree()) : json({ error: "nope", code: "memory_unavailable" }, poolStatus);
		}
		const n = /\/memory\/tree\/([^/]+)$/.exec(u);
		if (n) return nodes[decodeURIComponent(n[1]!)] ? json(nodes[decodeURIComponent(n[1]!)]) : json({ id: n[1], pending: [], archived: [], truncated: false });
		if (/\/work\/[^/]+\/record$/.test(u)) return json({ error: "gone", code: "not_found" }, 404);
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
	pool = [ob("1", "2026-10-26T09:00:00Z", "den one")];
	poolStatus = 200;
	poolPending = undefined;
	treeFetches = 0;
	emit = () => {};
});
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});

describe("observation tree in the Memory panel", () => {
	it("shows features with counts, tasks only after expanding, then the Den", async () => {
		await mount();
		const feature = q('[data-testid="memory-obs-group-work-d-f"]')!;
		assert.match(feature.textContent!, /Auth feature/);
		assert.match(feature.textContent!, /3 pending · 1 archived/);
		assert.equal(q('[data-testid="memory-obs-group-work-d-a"]'), null);
		await click(q('[data-testid="memory-obs-toggle-work-d-f"]')!);
		assert.match(q('[data-testid="memory-obs-group-work-d-a"]')!.textContent!, /Fix the login.*2 pending · 1 archived/);
		await click(q('[data-testid="memory-obs-toggle-work-d-f"]')!);
		assert.equal(q('[data-testid="memory-obs-group-work-d-a"]'), null);
		assert.match(q('[data-testid="memory-obs-group-den"]')!.textContent!, /Den.*2 pending/);
	});

	it("tapping a task replaces the list with its pending then archived observations; back returns", async () => {
		await mount();
		await click(q('[data-testid="memory-obs-toggle-work-d-f"]')!);
		await click(q('[data-testid="memory-obs-group-work-d-a"]')!);
		assert.equal(q('[data-testid="memory-obs-groups"]'), null);
		const items = qa('[data-testid="memory-obs-item"]');
		assert.deepEqual(items.map((i) => i.getAttribute("data-state")), ["pending", "pending", "archived"]);
		assert.match(items[0]!.textContent!, /task late/);
		assert.match(items[2]!.textContent!, /task done/);
		assert.match(items[2]!.textContent!, /written → Record of work-d-a/);
		assert.match(q('[data-testid="memory-obs-truncated"]')!.textContent!, /not shown/);
		assert.match(q('[data-testid="memory-obs-back"]')!.textContent!, /Fix the login/);
		await click(q('[data-testid="memory-obs-back"]')!);
		assert.notEqual(q('[data-testid="memory-obs-groups"]'), null);
	});

	it("keeps the blocked reason on the blocked work item's row and warns about an old backlog", async () => {
		pool = [{ ...ob("2", "2026-10-26T10:00:00Z", "x", { work: "work-d-f" }), blocked: "consolidation-failed" }];
		poolPending = { count: 1, oldestAgeMs: 25 * 3_600_000 };
		await mount();
		assert.match(q('[data-testid="memory-obs-pending-warning"]')!.textContent!, /waited over 25 h/);
		assert.match(q('[data-testid="memory-obs-group-work-d-f"]')!.textContent!, /consolidation failed/);
		assert.equal(q('[data-testid="memory-obs-group-den"]')!.querySelector('[data-testid="memory-obs-blocked"]'), null);
	});

	it("says unavailable when the tree cannot be loaded", async () => {
		poolStatus = 409;
		await mount();
		assert.match(q('[data-testid="memory-obs-state"]')!.textContent!, /unavailable/);
	});

	it("refetches the tree on a live observation", async () => {
		await mount();
		const before = treeFetches;
		await act(async () => emit({ type: "observation_captured", wolf: "w", threadId: "t1", summary: "x", count: 1, target: { kind: "den" } }));
		await settle(400);
		assert.equal(treeFetches > before, true);
	});
});
