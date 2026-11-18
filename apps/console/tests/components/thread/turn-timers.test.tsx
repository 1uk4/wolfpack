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

const { SubagentStripView } = await import("../../../components/thread/subagent-strip.tsx");
const { TurnTimer, useTurnStart } = await import("../../../components/thread/turn-timer.tsx");
const core = await import("../../../src/core/index.ts");

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
	it("separateTurnMs ignores a run start before the start, or an invalid start", () => {
		assert.equal(core.separateTurnMs({ startedAt: ago(10_000), runStartedAt: ago(20_000) }, NOW), undefined);
		assert.equal(core.separateTurnMs({ startedAt: "nope", runStartedAt: ago(20_000) }, NOW), undefined);
		assert.equal(core.separateTurnMs({ startedAt: ago(20_000), runStartedAt: "nope" }, NOW), undefined);
		assert.equal(core.separateTurnMs({ startedAt: ago(20_000), runStartedAt: ago(5_000) }, NOW), 5_000);
	});
	it("a stopped child's turn timer ends at finishedAt", () => {
		assert.equal(core.turnElapsedMs({ runStartedAt: ago(60_000), state: "stopped", finishedAt: ago(30_000) }, NOW), 30_000);
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
	interface Props { threadId?: string; busy: boolean; server?: string; initial?: string }
	function Bar({ threadId = "t1", busy, server, initial }: Props) {
		const start = useTurnStart(threadId, busy, server, initial);
		return <TurnTimer startedAt={start} />;
	}
	const mount = async (p: Props) => {
		const el = dom.document.createElement("div");
		dom.document.body.appendChild(el);
		root = createRoot(el);
		await act(async () => root!.render(<Bar {...p} />));
		return { el, set: (n: Props) => act(async () => root!.render(<Bar {...n} />)) };
	};
	const text = (el: Element) => el.querySelector('[data-testid="turn-timer"]')?.textContent ?? null;

	it("counts from the server's turnStartedAt while busy, ticks, and disappears when idle", async () => {
		mock.timers.enable({ apis: ["setInterval", "Date"], now: NOW });
		const { el, set } = await mount({ busy: true, initial: ago(65_000) });
		assert.equal(text(el), "1m 05s");
		await act(async () => mock.timers.tick(5_000));
		assert.equal(text(el), "1m 10s");
		await set({ busy: false });
		assert.equal(text(el), null);
		await act(async () => mock.timers.tick(5_000));
		assert.equal(text(el), null);
	});
	it("a live turn counts from the turn-start event's server time, not the local clock", async () => {
		mock.timers.enable({ apis: ["setInterval", "Date"], now: NOW });
		const { el, set } = await mount({ busy: false });
		await set({ busy: true }); // busy before the event: nothing seen yet, so no timer
		assert.equal(text(el), null);
		await set({ busy: true, server: ago(20_000) });
		assert.equal(text(el), "20s");
	});
	it("after a server value was seen, a later turn falls back to the local clock until its event arrives", async () => {
		mock.timers.enable({ apis: ["setInterval", "Date"], now: NOW });
		const { el, set } = await mount({ busy: true, server: ago(10_000) });
		assert.equal(text(el), "10s");
		await set({ busy: false });
		await set({ busy: true }); // the session cleared the old value; the new event has not landed
		assert.equal(text(el), "0s");
		await act(async () => mock.timers.tick(3_000));
		assert.equal(text(el), "3s");
		await set({ busy: true, server: ago(9_000) }); // the clock is at NOW+3s, so 12s since the server start
		assert.equal(text(el), "12s");
	});
	it("the load-time initial value seeds only the turn running at load", async () => {
		mock.timers.enable({ apis: ["setInterval", "Date"], now: NOW });
		const { el, set } = await mount({ busy: true, initial: ago(30_000) });
		await set({ busy: false, initial: ago(30_000) });
		await set({ busy: true, initial: ago(30_000) });
		assert.equal(text(el), "0s"); // local fallback (a value was seen), not the stale 30s
	});
	it("an older server (never any value): busy shows no timer", async () => {
		mock.timers.enable({ apis: ["setInterval", "Date"], now: NOW });
		const { el, set } = await mount({ busy: true });
		assert.equal(text(el), null);
		await set({ busy: false });
		await set({ busy: true });
		await act(async () => mock.timers.tick(4_000));
		assert.equal(text(el), null);
	});
	it("a thread switch does not carry a start over", async () => {
		mock.timers.enable({ apis: ["setInterval", "Date"], now: NOW });
		const { el, set } = await mount({ threadId: "a", busy: true, server: ago(40_000) });
		assert.equal(text(el), "40s");
		await set({ threadId: "b", busy: true }); // b is busy but never sent a value: nothing from a
		assert.equal(text(el), null);
	});
});

describe("session wiring", () => {
	it("the adapter puts the server start on agent_start and snapshots carry it as turn_clock", () => {
		const a = new core.ThreadEventAdapter();
		const base = { id: 1, threadId: "t", at: ago(0), actor: { id: "x", kind: "wolf" } };
		const at = ago(5_000);
		assert.deepEqual(a.apply({ ...base, type: "turn-start", turnId: "turn-1", startedAt: at } as never), [{ type: "agent_start", turnStartedAt: at }]);
		assert.deepEqual(a.apply({ ...base, type: "turn-start", turnId: "turn-2" } as never), [{ type: "agent_start" }]);
		const snap = a.apply({ ...base, type: "snapshot", upToId: 1, thread: { turnStartedAt: at, messages: [] } } as never);
		assert.deepEqual(snap[0], { type: "turn_clock", turnStartedAt: at });
	});
});
