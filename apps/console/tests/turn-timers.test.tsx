/** Turn timers: the subagent strip's turn/total cell, the core helpers, and the thread top bar's live turn timer. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, self: globalThis, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });

const { SubagentStripView } = await import("../components/subagent-strip.tsx");
const { TurnTimer, useTurnStart } = await import("../components/turn-timer.tsx");
const core = await import("../src/core/index.ts");

const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const kid = (over: Record<string, unknown> = {}) => ({ id: "w/s1", title: "T", parentThreadId: "w/p", agent: "worker", state: "running" as const, startedAt: ago(14 * 60_000), ...over });
const strip = (c: ReturnType<typeof kid>, now = NOW) => renderToStaticMarkup(<SubagentStripView items={[c]} now={now} onOpen={() => {}} onStop={() => {}} />);

describe("core helpers", () => {
	it("turnElapsedMs counts from runStartedAt, to finishedAt when settled", () => {
		assert.equal(core.turnElapsedMs(kid({ runStartedAt: ago(72_000) }), NOW), 72_000);
		assert.equal(core.turnElapsedMs(kid({ runStartedAt: ago(72_000), state: "done", finishedAt: ago(12_000) }), NOW), 60_000);
		assert.equal(core.turnElapsedMs(kid(), NOW), undefined);
	});
	it("separateTurnMs is undefined when absent or equal to startedAt", () => {
		const s = ago(60_000);
		assert.equal(core.separateTurnMs({ startedAt: s, runStartedAt: s }, NOW), undefined);
		assert.equal(core.separateTurnMs({ startedAt: s }, NOW), undefined);
	});
});

describe("the strip", () => {
	it("shows turn and total after a resume, counting the turn from the resume", () => {
		const html = strip(kid({ runStartedAt: ago(72_000) }));
		assert.match(html, /turn 1m 12s/);
		assert.match(html, /· 14m 00s/);
		assert.match(strip(kid({ runStartedAt: ago(72_000) }), NOW + 10_000), /turn 1m 22s/);
	});
	it("falls back to the single timer without runStartedAt or when equal to startedAt", () => {
		for (const c of [kid(), kid({ runStartedAt: ago(14 * 60_000) })]) {
			const html = strip(c);
			assert.doesNotMatch(html, /turn /);
			assert.match(html, /14m 00s/);
		}
	});
});

describe("the top bar turn timer", () => {
	let root: Root | undefined;
	afterEach(async () => {
		await act(async () => root?.unmount());
		root = undefined;
		mock.timers.reset();
	});
	function Bar({ busy, initial }: { busy: boolean; initial?: string }) {
		const start = useTurnStart(busy, initial);
		return <TurnTimer startedAt={start} />;
	}
	const mount = async (busy: boolean, initial?: string) => {
		const el = dom.document.createElement("div");
		dom.document.body.appendChild(el);
		root = createRoot(el);
		await act(async () => root!.render(<Bar busy={busy} initial={initial} />));
		return { el, rerender: (b: boolean) => act(async () => root!.render(<Bar busy={b} initial={initial} />)) };
	};
	const text = (el: Element) => el.querySelector('[data-testid="turn-timer"]')?.textContent ?? null;

	it("counts from the server's turnStartedAt while busy, ticks, and disappears when idle", async () => {
		mock.timers.enable({ apis: ["setInterval", "Date"], now: NOW });
		const { el, rerender } = await mount(true, ago(65_000));
		assert.equal(text(el), "1m 05s");
		await act(async () => mock.timers.tick(5_000));
		assert.equal(text(el), "1m 10s");
		await rerender(false);
		assert.equal(text(el), null);
		await act(async () => mock.timers.tick(5_000));
		assert.equal(text(el), null);
	});
	it("a turn that starts while open counts from then; no timer for a running turn with no turnStartedAt", async () => {
		mock.timers.enable({ apis: ["setInterval", "Date"], now: NOW });
		const idle = await mount(false);
		await idle.rerender(true);
		assert.equal(text(idle.el), "0s");
		await act(async () => mock.timers.tick(3_000));
		assert.equal(text(idle.el), "3s");
		await act(async () => root!.unmount());
		const old = await mount(true); // older server: busy at load, no field
		assert.equal(text(old.el), null);
	});
});
