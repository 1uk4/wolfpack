/**
 * Route selection on the graph: payload → route adapter, the card's stepper
 * (buttons, keys, parallel dropdown), the feature task-graph overlay.
 */
import React, { act, useState } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	KeyboardEvent: dom.window.KeyboardEvent,
	Event: dom.window.Event,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
	ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
});

const { routeForNode, toRouteSelection, workNodesFromGraph, featureTaskModel } = await import("../src/core/dep-route-adapter.ts");
const { startCursor } = await import("../src/core/work-route.ts");
const { RouteNav } = await import("../components/graph-route-nav.tsx");
const { FeatureTaskOverlay, opensTaskOverlay } = await import("../components/graph-view.tsx");
import type { KbGraph } from "../src/core/kb.ts";
import type { RouteCursor } from "../src/core/work-route.ts";

const n = (id: string, workKind: string, stage: string, label = id) => ({ id: `work:${id}`, kind: "work" as const, label, depth: 3, domain: "d", workKind, stage });
// F: a(shipped) -> b, c (parallel) -> e ; e partOf F
const graph: KbGraph = {
	nodes: [
		{ id: "dom:d", kind: "domain", label: "D", depth: 0, domain: "d" },
		{ id: "fac:d", kind: "factory", label: "Factory", depth: 1, domain: "d" },
		{ id: "ent:x", kind: "entry", label: "Entry", depth: 2, domain: "d" },
		n("F", "feature", "in_build", "Feat"),
		n("a", "task", "shipped"),
		n("b", "task", "in_build"),
		n("c", "task", "plan"),
		n("e", "task", "plan"),
	],
	edges: [
		...["a", "b", "c", "e"].map((t) => ({ source: `work:${t}`, target: "work:F", kind: "partOf" as const })),
		{ source: "work:b", target: "work:a", kind: "dependsOn" as const },
		{ source: "work:c", target: "work:a", kind: "dependsOn" as const },
		{ source: "work:e", target: "work:b", kind: "dependsOn" as const },
		{ source: "work:e", target: "work:c", kind: "dependsOn" as const },
		{ source: "work:e", target: "ent:x", kind: "dependsOn" as const },
	],
	layers: { archivedWork: false, denTopics: false },
	domain: null,
	domains: [{ name: "d", label: "D" }],
	generated: "2026-10-28T00:00:00.000Z",
};

describe("route adapter", () => {
	it("builds work nodes from the payload (parent, deps among work only)", () => {
		const nodes = workNodesFromGraph(graph);
		const e = nodes.find((x) => x.id === "e")!;
		assert.equal(e.parent, "F");
		assert.deepEqual([...e.dependsOn!].sort(), ["b", "c"]);
		assert.equal(nodes.find((x) => x.id === "F")!.kind, "feature");
	});

	it("maps a route to graph ids, the Factory root and edge keys", () => {
		const route = routeForNode(graph, "work:e")!;
		const sel = toRouteSelection(route, startCursor(route), "d");
		for (const id of ["fac:d", "work:a", "work:b", "work:c", "work:e"]) assert.ok(sel.nodes.has(id), id);
		assert.ok(sel.edges.has("fac:d|work:a") && sel.edges.has("work:a|work:b") && sel.edges.has("work:c|work:e"));
		assert.deepEqual([...sel.parallel].sort(), ["work:b", "work:c"]);
		assert.deepEqual([...sel.done], ["work:a"]);
		assert.equal(sel.cursor, "work:b"); // first unfinished step, first unfinished node
	});

	it("a feature selects its tasks; the Factory, entries and nothing select no route", () => {
		assert.ok(routeForNode(graph, "work:F")!.steps.length > 0);
		assert.equal(routeForNode(graph, "fac:d"), null);
		assert.equal(routeForNode(graph, "ent:x"), null);
		assert.equal(routeForNode(graph, "work:missing"), null);
	});
});

let root: Root | null = null;
afterEach(() => {
	act(() => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});
const mount = (el: React.ReactElement) => {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	act(() => root!.render(el));
	return host;
};

function Harness({ target = "work:e", log }: { target?: string; log?: (c: RouteCursor) => void }) {
	const route = routeForNode(graph, target)!;
	const [cursor, setCursor] = useState(() => startCursor(route));
	const byRaw = new Map(graph.nodes.map((x) => [x.id.replace(/^work:/, ""), x] as const));
	return (
		<div>
			<input data-testid="box" />
			<RouteNav nav={{ route, cursor, label: (id) => byRaw.get(id)?.label ?? id, stage: (id) => byRaw.get(id)?.stage ?? "", onCursor: (c) => { log?.(c); setCursor(c); } }} />
		</div>
	);
}
const q = (host: Element, id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement;
const key = (k: string, target: Element = document.body) => act(() => {
	const ev = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
	Object.defineProperty(ev, "key", { value: k });
	target.dispatchEvent(ev);
});

describe("RouteNav", () => {
	it("starts at the first unfinished step and steps with the buttons", () => {
		const host = mount(<Harness />);
		assert.equal(q(host, "route-step").textContent, "Step 2 of 3 · in build");
		act(() => q(host, "route-next").click());
		assert.equal(q(host, "route-step").textContent, "Step 3 of 3 · plan");
		act(() => q(host, "route-prev").click());
		act(() => q(host, "route-prev").click());
		assert.equal(q(host, "route-step").textContent, "Step 1 of 3 · shipped");
		assert.ok(q(host, "route-prev").hasAttribute("disabled"));
	});

	it("steps with ← and → keys", () => {
		const host = mount(<Harness />);
		key("ArrowRight");
		assert.ok(q(host, "route-step").textContent!.startsWith("Step 3 of 3"));
		key("ArrowLeft");
		key("ArrowLeft");
		assert.ok(q(host, "route-step").textContent!.startsWith("Step 1 of 3"));
	});

	it("ignores the keys in inputs", () => {
		const host = mount(<Harness />);
		key("ArrowRight", q(host, "box"));
		assert.ok(q(host, "route-step").textContent!.startsWith("Step 2 of 3"));
	});

	it("lists the step's nodes at a parallel step; choosing one moves the cursor", () => {
		const seen: RouteCursor[] = [];
		const host = mount(<Harness log={(c) => seen.push(c)} />);
		const sel = q(host, "route-parallel") as unknown as HTMLSelectElement;
		assert.deepEqual([...sel.querySelectorAll("option")].map((o) => o.textContent), ["b", "c"]);
		act(() => {
			Object.defineProperty(sel, "value", { value: "c", configurable: true });
			sel.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
		});
		assert.equal(seen.at(-1)!.node, "c");
		assert.ok(q(host, "route-step").textContent!.includes("plan"));
		act(() => q(host, "route-next").click());
		assert.equal(q(host, "route-parallel"), null, "no dropdown at a single-node step");
	});
});

describe("feature task-graph overlay", () => {
	it("double-click opens for features only", () => {
		assert.ok(opensTaskOverlay(graph, "work:F"));
		assert.ok(!opensTaskOverlay(graph, "work:b"));
		assert.ok(!opensTaskOverlay(graph, "fac:d"));
	});

	it("builds the feature's exact task graph from the payload", () => {
		const m = featureTaskModel(graph, "work:F")!;
		assert.deepEqual(m.nodes.map((x) => x.id).sort(), ["a", "b", "c", "e"]);
		assert.equal(m.edges.length, 4);
		assert.equal(m.featureTitle, "Feat");
	});

	it("renders the overlay shell", () => {
		const host = mount(<FeatureTaskOverlay graph={graph} featureId="work:F" onClose={() => {}} onSelectNode={() => {}} />);
		assert.ok(document.querySelector('[data-testid="task-graph-overlay"]') || host.querySelector('[data-testid="task-graph-overlay"]'));
	});
});
