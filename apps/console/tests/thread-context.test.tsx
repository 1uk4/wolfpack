/** The thread header's context chip: label, amber past startAt, popover, Compact now (enabled mid-turn), summarising state. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	self: globalThis,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
});

const { MockConsoleClient, FIXTURE_THREAD } = await import("@wolfpack/client");
type ThreadContext = import("@wolfpack/client").ThreadContext;
const { ThreadContextChip, formatTokens, contextLabel, pastStartAt } = await import("../components/thread-context.tsx");
const { threadFetch } = await import("./helpers/thread-fetch.ts");

const BASE: ThreadContext = { tokens: 312_000, window: 1_000_000, startAt: 400_000, waitAt: 983_616, compactions: { count: 0 }, compacting: false };

class CtxClient extends MockConsoleClient {
	ctx: ThreadContext = BASE;
	compacts: Array<string | undefined> = [];
	constructor() {
		super({ delayMs: 0 });
	}
	async getThreadContext() {
		return this.ctx;
	}
	async compactThread(_id: string, instructions?: string) {
		this.compacts.push(instructions);
		this.ctx = { ...this.ctx, compacting: true };
	}
}

const settle = (ms = 1300) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const click = (el: Element) => act(async () => void el.dispatchEvent(new dom.window.Event("click", { bubbles: true, cancelable: true })));

const realFetch = globalThis.fetch;
let root: Root | null = null;
afterEach(() => {
	if (root) act(() => root!.unmount());
	root = null;
	document.body.innerHTML = "";
	globalThis.fetch = realFetch;
});

async function mount(client: CtxClient) {
	globalThis.fetch = threadFetch(client);
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	const slug = FIXTURE_THREAD.id.slice(FIXTURE_THREAD.wolf.length + 1);
	await act(async () => root!.render(<ThreadContextChip wolf={FIXTURE_THREAD.wolf} slug={slug} threadId={FIXTURE_THREAD.id} />));
	await settle();
}

describe("formatting", () => {
	it("formatTokens / contextLabel / pastStartAt", () => {
		assert.equal(formatTokens(312_000), "312k");
		assert.equal(formatTokens(1_000_000), "1M");
		assert.equal(formatTokens(1_500_000), "1.5M");
		assert.equal(formatTokens(950), "950");
		assert.equal(contextLabel(BASE), "312k / 1M");
		const at = new Date(2026, 9, 29, 14, 5).toISOString();
		assert.equal(contextLabel({ ...BASE, compactions: { count: 2, lastAt: at } }), "312k / 1M · 2× compacted 14:05");
		assert.equal(pastStartAt(BASE), false);
		assert.equal(pastStartAt({ ...BASE, tokens: 400_001 }), true);
	});
});

describe("ThreadContextChip", () => {
	it("shows the size against the window, not amber under startAt", async () => {
		await mount(new CtxClient());
		assert.equal(q('[data-testid="context-label"]')?.textContent, "312k / 1M");
		assert.equal(q('[data-testid="context-chip-button"]')?.getAttribute("data-amber"), null);
		assert.equal(q('[data-testid="context-summarising"]'), null);
	});

	it("turns amber past startAt", async () => {
		const c = new CtxClient();
		c.ctx = { ...BASE, tokens: 450_000 };
		await mount(c);
		assert.equal(q('[data-testid="context-chip-button"]')?.getAttribute("data-amber"), "true");
	});

	it("shows summarising… with the spinner while the wolf reports compacting", async () => {
		const c = new CtxClient();
		c.ctx = { ...BASE, compacting: true };
		await mount(c);
		assert.match(q('[data-testid="context-summarising"]')?.textContent ?? "", /summarising…/);
		assert.ok(q('[data-testid="context-summarising"] [data-testid="braille-spinner"]'));
	});

	it("popover: bar, counts, instructions; Compact now posts them, shows progress, and the stats refresh when done", async () => {
		const c = new CtxClient();
		c.ctx = { ...BASE, compactions: { count: 1, lastAt: new Date(2026, 9, 29, 9, 30).toISOString() } };
		await mount(c);
		assert.equal(q('[data-testid="context-popover"]'), null);
		await click(q('[data-testid="context-chip-button"]')!);
		assert.ok(q('[data-testid="context-popover"]'));
		assert.ok(q('[data-testid="context-bar"]'));
		assert.match(q('[data-testid="context-count"]')?.textContent ?? "", /Compacted 1×, last at 09:30/);
		const btn = q('[data-testid="context-compact"]') as HTMLButtonElement;
		assert.equal(btn.disabled, false);
		const ta = q('[data-testid="context-instructions"]') as HTMLTextAreaElement;
		// linkedom doesn't drive React's change plumbing: call the element's onChange prop.
		const key = Object.keys(ta).find((k) => k.startsWith("__reactProps"))!;
		await act(async () => (ta as unknown as Record<string, { onChange(e: unknown): void }>)[key]!.onChange({ target: { value: "keep the plan" } }));
		await click(btn);
		await settle(100);
		assert.deepEqual(c.compacts, ["keep the plan"]);
		assert.equal((q('[data-testid="context-compact"]') as HTMLButtonElement).disabled, true);
		assert.match(q('[data-testid="context-compact"]')?.textContent ?? "", /Summarising…/);
		// the wolf finishes: stats refresh by polling and the button comes back
		c.ctx = { ...BASE, tokens: 40_000, compactions: { count: 2, lastAt: new Date(2026, 9, 29, 14, 5).toISOString() }, compacting: false };
		await settle(3200);
		assert.equal((q('[data-testid="context-compact"]') as HTMLButtonElement).disabled, false);
		assert.equal(q('[data-testid="context-label"]')?.textContent, "40k / 1M · 2× compacted 14:05");
	});
});
