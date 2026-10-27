/**
 * Structured objects (graph): the plan-graph card renders status/kind/edges, a revision replaces it in place with the
 * "updated N times" marker, and the layered layout ranks a small DAG by prerequisites.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import type { ThreadEvent } from "@wolfpack/client";

const dom = parseHTML("<html><body></body></html>");
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
});

const { SettingsDialogProvider } = await import("../components/settings/settings-dialog.tsx");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
const { ThreadChat } = await import("../components/thread-chat.tsx");
const { MemoryEventsProvider } = await import("../components/memory-events.tsx");
const { lookupCard } = await import("../components/card-registry.tsx");
const { PlanGraphCard } = await import("../components/plan-graph-card.tsx");
const { SessionModel } = await import("../components/session-core.ts");
const { threadTransport } = await import("../components/thread-transport.ts");
const { layoutGraph, graphRanks, threadMessagesToNative } = await import("../src/core/index.ts");

const inertSource = () => ({ close() {}, onOpen() {}, onMessage() {}, onError() {} });
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

const node = (id: string, status: string, kind = "step") => ({ id, label: `Label ${id}`, kind, status });
const edges = [{ from: "build", to: "design" }, { from: "test", to: "build" }, { from: "docs", to: "design" }, { from: "ship", to: "test" }, { from: "ship", to: "docs" }];
const data1 = { title: "Release", nodes: [node("design", "doing", "milestone"), node("build", "todo", "task"), node("test", "todo"), node("docs", "todo"), node("ship", "todo")], edges };
const data2 = { ...data1, nodes: [node("design", "done", "milestone"), node("build", "doing", "task"), node("test", "blocked"), node("docs", "skipped"), node("ship", "todo")] };

const base = { threadId: "t", at: "2026-01-01T00:00:00.000Z", turnId: "a" };
let n = 0;
const ev = (e: Record<string, unknown>) => ({ ...base, id: ++n, ...e }) as unknown as ThreadEvent;
const upsert = (rev: number, data: unknown) => ev({ type: "object-upsert", objectId: "plan", objectType: "graph", rev, data, textOffset: 0 });

describe("graph layout", () => {
	it("ranks by longest prerequisite chain (edges mean depends-on)", () => {
		const ranks = graphRanks(["design", "build", "test", "docs", "ship"], edges);
		assert.deepEqual([...ranks], [["design", 0], ["build", 1], ["test", 2], ["docs", 1], ["ship", 3]]);
	});

	it("places ranks as left-to-right columns, rows within a rank, edges prerequisite -> dependent", () => {
		const l = layoutGraph(data1.nodes, edges);
		const p = (id: string) => l.nodes.find((x) => x.id === id)!;
		assert.ok(p("design").x < p("build").x && p("build").x < p("test").x && p("test").x < p("ship").x);
		assert.equal(p("build").x, p("docs").x);
		assert.ok(p("build").y < p("docs").y);
		assert.equal(l.edges.length, 5);
		const e = l.edges.find((x) => x.from === "build" && x.to === "design")!;
		assert.equal(e.x1, p("design").x + l.nodeWidth);
		assert.equal(e.x2, p("build").x);
		assert.equal(l.width, 4 * l.nodeWidth + 3 * 36);
		assert.equal(l.height, 2 * l.nodeHeight + 12);
	});

	it("disconnected components, a single node, no edges, and many nodes", () => {
		const one = layoutGraph([{ id: "a" }], []);
		assert.deepEqual([one.nodes.length, one.width, one.height], [1, one.nodeWidth, one.nodeHeight]);
		const loose = layoutGraph([{ id: "a" }, { id: "b" }, { id: "c" }], []);
		assert.ok(loose.nodes.every((p) => p.rank === 0 && p.x === 0));
		assert.equal(new Set(loose.nodes.map((p) => p.y)).size, 3);
		const two = layoutGraph([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }], [{ from: "b", to: "a" }, { from: "d", to: "c" }]);
		assert.deepEqual(two.nodes.map((p) => p.rank), [0, 1, 0, 1]);
		assert.equal(layoutGraph([], []).width, 0);
		const chain = Array.from({ length: 5000 }, (_, i) => ({ id: `n${i}` }));
		const deep = layoutGraph(chain, chain.slice(1).map((c, i) => ({ from: c.id, to: `n${i}` })));
		assert.equal(Math.max(...deep.nodes.map((p) => p.rank)), 4999);
	});

	it("barycenter pass keeps dependents beside their prerequisites", () => {
		const l = layoutGraph([{ id: "a" }, { id: "b" }, { id: "x" }, { id: "y" }], [{ from: "x", to: "b" }, { from: "y", to: "a" }]);
		const y = (id: string) => l.nodes.find((p) => p.id === id)!.y;
		assert.ok(y("y") < y("x"));
	});

	it("a cyclic input does not hang (ranks stay finite)", () => {
		const r = graphRanks(["a", "b"], [{ from: "a", to: "b" }, { from: "b", to: "a" }]);
		assert.equal(r.size, 2);
	});
});

describe("plan graph card", () => {
	it("is registered under kind object", () => {
		assert.equal(lookupCard("object", "graph")?.Renderer, PlanGraphCard);
	});

	it("renders nodes with status and kind, edges, progress; no marker at rev 1", () => {
		const html = renderToStaticMarkup(<PlanGraphCard objectId="plan" type="graph" rev={1} data={data1} />);
		assert.match(html, /Release/);
		assert.equal((html.match(/data-testid="graph-node"/g) ?? []).length, 5);
		assert.equal((html.match(/data-testid="graph-edge"/g) ?? []).length, 5);
		assert.match(html, /data-status="doing"[^>]*data-kind="milestone"/);
		assert.match(html, /0\/5 done/);
		assert.doesNotMatch(html, /updated/);
	});

	it("is accessible: group label, list items, depends-on text, detail reachable without hover", () => {
		const withDetail = { ...data1, nodes: data1.nodes.map((x) => (x.id === "build" ? { ...x, detail: "compile all" } : x)) };
		const html = renderToStaticMarkup(<PlanGraphCard objectId="plan" type="graph" rev={1} data={withDetail} />);
		assert.match(html, /role="group" aria-label="Plan graph: Release, 5 nodes, 0 done"/);
		assert.equal((html.match(/<li[^>]*data-testid="graph-node"/g) ?? []).length, 5);
		assert.match(html, /depends on: Label test, Label docs/);
		assert.match(html, /title="Label build — compile all"/);
		assert.match(html, /<details[^>]*data-testid="graph-details"[\s\S]*compile all/);
		assert.doesNotMatch(html, /arrow-plan/);
	});

	it("shows the updated marker for a revision", () => {
		assert.match(renderToStaticMarkup(<PlanGraphCard objectId="plan" type="graph" rev={3} data={data2} />), /updated 2 times</);
	});

	it("renders nothing for an invalid graph (cycle, dangling edge)", () => {
		const bad = { nodes: [node("a", "todo"), node("b", "todo")] };
		assert.equal(renderToStaticMarkup(<PlanGraphCard objectId="x" type="graph" rev={1} data={{ ...bad, edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }] }} />), "");
		assert.equal(renderToStaticMarkup(<PlanGraphCard objectId="x" type="graph" rev={1} data={{ ...bad, edges: [{ from: "a", to: "zzz" }] }} />), "");
	});
});

let root: Root | null = null;
after(() => {
	globalThis.fetch = realFetch;
});
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});

const history = [
	{ id: "u", role: "user", text: "plan it", at: base.at },
	{ id: "entry-2", role: "assistant", text: "ok", at: base.at, objects: [{ objectId: "plan", type: "graph", rev: 2, data: data2, textOffset: 0 }] },
] as never;

describe("live revision in place", () => {
	it("live: two upserts fold to one part at rev 2; the reload seed draws ONE card at the latest statuses, with the marker", async () => {
		const model = new SessionModel({ chatId: "t", initialMessages: [], transport: threadTransport("w", "t") });
		const wire = threadTransport("w", "t").createWire();
		const events = [ev({ type: "turn-start" }), upsert(1, data1), upsert(2, data2), ev({ type: "text-delta", text: "ok" }), ev({ type: "turn-end", reason: "complete" })];
		for (const e of events) for (const w of wire(e as never)) model.applyWireEvent(w);
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		await act(async () => {
			root!.render(
				<AppRouterContext.Provider value={{ push() {} } as never}>
					<SettingsDialogProvider>
						<MemoryEventsProvider connect={inertSource}>
							<ThreadChat wolf="w" slug="s" threadId="t1" title="T" initialMessages={threadMessagesToNative(history) as never} />
						</MemoryEventsProvider>
					</SettingsDialogProvider>
				</AppRouterContext.Provider>,
			);
		});
		const objs = model.getState().messages.flatMap((m) => m.parts.filter((p) => p.type === "object"));
		assert.deepEqual(objs.map((p) => [p.objectId, p.rev]), [["plan", 2]]);
		const cards = document.querySelectorAll('[data-testid="plan-graph-card"]');
		assert.equal(cards.length, 1);
		assert.equal(cards[0]!.getAttribute("data-rev"), "2");
		const status = (id: string) => cards[0]!.querySelector(`[data-node-id="${id}"]`)?.getAttribute("data-status");
		assert.deepEqual(["design", "build", "test", "docs"].map(status), ["done", "doing", "blocked", "skipped"]);
		assert.match(cards[0]!.querySelector('[data-testid="object-updated"]')?.textContent ?? "", /updated 1 time/);
	});
});
