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
// The tree answer: a live feature with an own note, a live task, an unknown-title task, a task whose stage is archived,
// a feature with only archived counts, an archived-stage feature with nothing live, a fully archived loose item, and the den.
const tree = () => ({
	features: [
		{
			id: "work-d-f", title: "Auth feature", stage: "approved", own: { pending: 1, archived: 7 },
			tasks: [
				{ id: "work-d-a", title: "Fix the login", stage: "in_build", pending: 2, archived: 1 },
				{ id: "work-d-u", title: "work-d-u", pending: 1, archived: 0 },
				{ id: "work-d-old", title: "Old shipped thing", stage: "archived", pending: 3, archived: 0 },
			],
		},
		{ id: "work-d-done", title: "Done feature", stage: "approved", own: { pending: 0, archived: 5 }, tasks: [{ id: "work-d-t", title: "Done task", pending: 0, archived: 5 }] },
		{ id: "work-d-gone", title: "Gone feature", stage: "archived", own: { pending: 4, archived: 0 }, tasks: [] },
	],
	other: [{ id: "work-d-x", pending: 0, archived: 2 }],
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
		if (u.endsWith("/memory/session-topics")) return json({ topics: [], totalBytes: 0, capBytes: 184320 });
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

const { MemoryPanel } = await import("../../../components/memory/memory-panel.tsx");
const { MemoryEventsProvider } = await import("../../../components/memory/memory-events.tsx");

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
	it("shows live observations only: Pool, then Observations with the Den first and divided, features with notes and indented tasks, no archived anything", async () => {
		await mount();
		assert.deepEqual(qa('[data-testid="memory-pool"], [data-testid="memory-feed"]').map((e) => e.getAttribute("data-testid")), ["memory-pool", "memory-feed"]);
		const list = q('[data-testid="memory-obs-groups"]')!;
		const lis = [...list.children] as HTMLElement[];
		// Den first with its divider; no separate Den section
		assert.equal(lis[0]!.getAttribute("data-testid"), "memory-den");
		assert.match(lis[0]!.className, /border-b/);
		assert.match(lis[0]!.textContent!, /Den\s*2/);
		assert.equal(qa('section[data-testid="memory-den"]').length, 0);
		// feature header: title, chip, total pending (own 1 + live tasks 2 + 1; the archived-stage task's 3 are left out)
		const header = q('[data-testid="memory-obs-feature"]')!;
		assert.equal(qa('[data-testid="memory-obs-feature"]').length, 1);
		assert.match(header.textContent!, /Auth feature/);
		assert.equal(header.querySelector('[data-work-id="work-d-f"]') !== null, true);
		assert.equal(header.getAttribute("data-count"), "4");
		// beneath it: Feature notes, then the live tasks, indented; the raw id is not repeated as a subtitle
		assert.deepEqual(lis.slice(2).map((l) => l.querySelector("button")!.getAttribute("data-testid")), ["memory-obs-group-work-d-f", "memory-obs-group-work-d-a", "memory-obs-group-work-d-u"]);
		assert.match(lis[2]!.textContent!, /Feature notes\s*1/);
		const task = q('[data-testid="memory-obs-group-work-d-a"]')!;
		assert.match(task.closest("li")!.className, /ml-4/);
		assert.match(task.textContent!, /Fix the login\s*2/);
		assert.equal(task.closest("li")!.querySelector('[data-work-id="work-d-a"]') !== null, true);
		assert.equal(task.textContent!.includes("work-d-a"), false);
		assert.equal(task.textContent!.includes("in build"), false);
		// unknown title: the chip alone
		const unknown = q('[data-testid="memory-obs-group-work-d-u"]')!;
		assert.equal(unknown.textContent!.includes("work-d-u"), false);
		assert.equal(unknown.closest("li")!.querySelector('[data-work-id="work-d-u"]') !== null, true);
		// nothing archived: no counts, no archived-stage items, no all-archived groups
		assert.equal(q('[data-testid="memory-feed"]')!.textContent!.toLowerCase().includes("archived"), false);
		for (const id of ["work-d-old", "work-d-done", "work-d-t", "work-d-gone", "work-d-x"]) assert.equal(q(`[data-testid="memory-obs-group-${id}"]`), null);
		// clicking a chip does not open the row
		await click(task.closest("li")!.querySelector('[data-work-id="work-d-a"]')!);
		assert.equal(q('[data-testid="memory-obs-items"]'), null);
	});

	it("tapping a task lists only its pending observations; back returns", async () => {
		await mount();
		await click(q('[data-testid="memory-obs-group-work-d-a"]')!);
		assert.equal(q('[data-testid="memory-obs-groups"]'), null);
		const items = qa('[data-testid="memory-obs-item"]');
		assert.equal(items.length, 2);
		assert.match(items[0]!.textContent!, /task late/);
		assert.equal(q('[data-testid="memory-feed"]')!.textContent!.includes("task done"), false);
		assert.equal(q('[data-testid="memory-obs-truncated"]'), null);
		assert.match(q('[data-testid="memory-obs-back"]')!.textContent!, /Fix the login/);
		await click(q('[data-testid="memory-obs-back"]')!);
		assert.notEqual(q('[data-testid="memory-obs-groups"]'), null);
	});

	it("keeps the blocked label on its own line inside the blocked row's button and warns about an old backlog", async () => {
		pool = [{ ...ob("2", "2026-10-26T10:00:00Z", "x", { work: "work-d-a" }), blocked: "consolidation-failed" }];
		poolPending = { count: 1, oldestAgeMs: 25 * 3_600_000 };
		await mount();
		assert.match(q('[data-testid="memory-obs-pending-warning"]')!.textContent!, /waited over 25 h/);
		const blocked = q('[data-testid="memory-obs-group-work-d-a"]')!.querySelector('[data-testid="memory-obs-blocked"]')!;
		assert.match(blocked.textContent!, /consolidation failed/);
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

