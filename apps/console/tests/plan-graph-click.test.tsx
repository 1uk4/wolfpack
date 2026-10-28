/**
 * The shared graph view's node click: the show_graph chat card opens the Status panel only for a work item id; the draggable
 * view (pinned feature graph) pans on a drag and never counts a drag as a click.
 */
import React, { act } from "react";
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
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
	ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
	getComputedStyle: () => ({ animationName: "none" }),
	localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
});

const { PlanGraphCard } = await import("../components/plan-graph-card.tsx");
const { PlanGraphView } = await import("../components/plan-graph-view.tsx");
const { PanelHostProvider, RightPanelHost } = await import("../components/panel-host.tsx");
const { ActivityIcon } = await import("lucide-react");

const WORK = "work-wolfpack-ASNQgEf";
const data = {
	title: "Plan",
	nodes: [
		{ id: WORK, label: "A work item", kind: "task", status: "doing" },
		{ id: "step-2", label: "A free-form step", kind: "step", status: "todo" },
	],
	edges: [{ from: "step-2", to: WORK }],
};
const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const click = (el: Element) => act(async () => void el.dispatchEvent(new dom.window.Event("click", { bubbles: true, cancelable: true })));
const ptr = (el: Element, type: string, x: number, y: number) =>
	act(async () => void el.dispatchEvent(Object.assign(new dom.window.Event(type, { bubbles: true, cancelable: true }), { clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1, pointerId: 1 })));
let root: Root | null = null;
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});
async function mount(node: React.ReactNode) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => root!.render(node));
}

const task = () => q('[data-testid="stub-status"]')?.getAttribute("data-task");
const stub = {
	id: "memory",
	label: "Status",
	icon: ActivityIcon,
	available: () => true,
	render: ({ props }: { props: Record<string, unknown> }) => <div data-testid="stub-status" data-task={String(props.taskId ?? "")} />,
};

const PANELS = [stub as never];

describe("show_graph chat card click", () => {
	const mountCard = () =>
		mount(
			<PanelHostProvider wolf="w" threadId="w/t" panels={PANELS}>
				<PlanGraphCard objectId="o" type="graph" rev={1} data={data} />
				<RightPanelHost />
			</PanelHostProvider>,
		);
	it("a node whose id is a work item id opens the Status panel on it", async () => {
		await mountCard();
		assert.equal(task(), "");
		await click(q(`[data-node-id="${WORK}"] [data-testid="graph-node-hit"]`)!);
		assert.equal(task(), WORK);
	});
	it("a free-form step id does nothing", async () => {
		await mountCard();
		await click(q('[data-node-id="step-2"] [data-testid="graph-node-hit"]')!);
		assert.equal(task(), "");
	});
	it("the card is not draggable", async () => {
		await mountCard();
		assert.equal(q('[data-testid="graph-scroll"]')!.getAttribute("data-draggable"), null);
	});
});

describe("draggable graph view", () => {
	const wide = {
		nodes: ["a", "b", "c", "d", "e"].map((id) => ({ id, label: id, kind: "task", status: "todo" as const })),
		edges: [["b", "a"], ["c", "b"], ["d", "c"], ["e", "d"]].map(([from, to]) => ({ from: from!, to: to! })),
	};
	it("a drag past the threshold pans and is not a click; a plain press-release still clicks", async () => {
		const clicked: string[] = [];
		await mount(<PlanGraphView draggable graph={wide} onNodeClick={(id) => clicked.push(id)} />);
		const box = q('[data-testid="graph-scroll"]')!;
		const hit = q('[data-node-id="c"] [data-testid="graph-node-hit"]')!;
		// a plain click (travel under the slop)
		await ptr(hit, "pointerdown", 50, 50);
		await ptr(hit, "pointermove", 52, 51);
		await ptr(hit, "pointerup", 52, 51);
		await click(hit);
		assert.deepEqual(clicked, ["c"]);
		assert.equal(q('[data-testid="graph-pan"]')!.getAttribute("data-pan-x"), "0");
		// a drag (the click that follows the release must not count)
		await ptr(hit, "pointerdown", 50, 50);
		await ptr(box, "pointermove", 20, 50);
		// the browser fires the click in the same task as the release
		await act(async () => {
			box.dispatchEvent(Object.assign(new dom.window.Event("pointerup", { bubbles: true, cancelable: true }), { clientX: 20, clientY: 50, button: 0, buttons: 0, pointerId: 1 }));
			hit.dispatchEvent(new dom.window.Event("click", { bubbles: true, cancelable: true }));
		});
		assert.deepEqual(clicked, ["c"], "the drag was not a click");
		assert.ok(Number(q('[data-testid="graph-pan"]')!.getAttribute("data-pan-x")) < 0, "the graph panned");
		// and clicking works again afterwards
		await ptr(hit, "pointerdown", 50, 50);
		await ptr(hit, "pointerup", 50, 50);
		await click(hit);
		assert.deepEqual(clicked, ["c", "c"]);
	});
	it("grab cursor at rest, grabbing while dragging", async () => {
		await mount(<PlanGraphView draggable graph={wide} />);
		const box = q('[data-testid="graph-scroll"]')!;
		assert.match(box.className, /cursor-grab\b/);
		await ptr(box, "pointerdown", 50, 50);
		await ptr(box, "pointermove", 30, 50);
		assert.match(q('[data-testid="graph-scroll"]')!.className, /cursor-grabbing/);
		await ptr(box, "pointerup", 30, 50);
		assert.match(q('[data-testid="graph-scroll"]')!.className, /cursor-grab\b/);
	});
});

describe("draggable graph view: robustness", () => {
	const chain = {
		nodes: ["a", "b", "c", "d", "e"].map((id) => ({ id, label: id, kind: "task", status: "todo" as const })),
		edges: [["b", "a"], ["c", "b"], ["d", "c"], ["e", "d"]].map(([from, to]) => ({ from: from!, to: to! })),
	};
	const panX = () => q('[data-testid="graph-pan"]')!.getAttribute("data-pan-x");
	const ptrB = (el: Element, type: string, x: number, buttons: number, pointerId = 1) =>
		act(async () => void el.dispatchEvent(Object.assign(new dom.window.Event(type, { bubbles: true, cancelable: true }), { clientX: x, clientY: 50, button: 0, buttons, pointerId })));
	it("a move with no button held after the press does not pan (a release outside the box left no stuck press)", async () => {
		await mount(<PlanGraphView draggable graph={chain} onNodeClick={() => {}} />);
		const box = q('[data-testid="graph-scroll"]')!;
		await ptrB(box, "pointerdown", 50, 1);
		await ptrB(box, "pointermove", 0, 0);
		assert.equal(panX(), "0");
		await ptrB(box, "pointermove", -40, 0);
		assert.equal(panX(), "0", "the press was dropped");
	});
	it("a second pointer does not hijack the pan", async () => {
		await mount(<PlanGraphView draggable graph={chain} />);
		const box = q('[data-testid="graph-scroll"]')!;
		await ptrB(box, "pointerdown", 50, 1, 1);
		await ptrB(box, "pointermove", 0, 1, 2);
		assert.equal(panX(), "0");
		await ptrB(box, "pointermove", 0, 1, 1);
		assert.ok(Number(panX()) < 0);
	});
	it("after a drag released with no click, the next click is not swallowed", async () => {
		const clicked: string[] = [];
		await mount(<PlanGraphView draggable graph={chain} onNodeClick={(id) => clicked.push(id)} />);
		const box = q('[data-testid="graph-scroll"]')!;
		await ptrB(box, "pointerdown", 50, 1);
		await ptrB(box, "pointermove", 0, 1);
		await ptrB(box, "pointerup", 0, 0);
		await act(async () => void (await new Promise((r) => setTimeout(r, 10))));
		await click(q('[data-node-id="c"] [data-testid="graph-node-hit"]')!);
		assert.deepEqual(clicked, ["c"]);
	});
	it("a cyclic dependsOn and an edge to a missing node still render", async () => {
		const g = { nodes: chain.nodes.slice(0, 3), edges: [{ from: "b", to: "a" }, { from: "a", to: "b" }, { from: "c", to: "zzz" }, { from: "zzz", to: "a" }] };
		await mount(<PlanGraphView draggable graph={g} />);
		assert.equal(document.querySelectorAll('[data-testid="graph-node"]').length, 3);
	});
});

describe("canvas mode: slivers, free pan, re-center", () => {
	const g = {
		nodes: [
			{ id: "a", label: "Alpha done", kind: "task", status: "done" as const },
			{ id: "b", label: "Beta skipped", kind: "task", status: "skipped" as const },
			{ id: "c", label: "Gamma todo", kind: "task", status: "todo" as const },
		],
		edges: [{ from: "c", to: "a" }, { from: "c", to: "b" }],
	};
	const panX = () => Number(q('[data-testid="graph-pan"]')!.getAttribute("data-pan-x"));
	it("done and archived nodes are label-less slivers with a title and aria-label; a click still reaches onNodeClick; edges still draw", async () => {
		const clicked: string[] = [];
		await mount(<PlanGraphView draggable collapseDone graph={g} onNodeClick={(id) => clicked.push(id)} />);
		for (const id of ["a", "b"]) {
			const li = q(`[data-node-id="${id}"]`)!;
			assert.equal(li.getAttribute("data-sliver"), "true");
			assert.equal((li.textContent ?? "").trim(), "", "no visible text");
			assert.ok((li.getAttribute("title") ?? "").length > 0);
			assert.ok((li.getAttribute("aria-label") ?? "").includes(id === "a" ? "Alpha done" : "Beta skipped"));
		}
		assert.ok(q('[data-node-id="c"]')!.getAttribute("data-sliver") === null);
		assert.ok((q('[data-node-id="c"]')!.textContent ?? "").includes("Gamma todo"));
		assert.equal(document.querySelectorAll('[data-testid="graph-edge"]').length, 2);
		await click(q('[data-node-id="a"] [data-testid="graph-node-hit"]')!);
		assert.deepEqual(clicked, ["a"]);
	});
	it("the chat card (no collapseDone) still renders done nodes with their labels", async () => {
		await mount(<PlanGraphView graph={g} />);
		assert.ok(q('[data-node-id="a"]')!.getAttribute("data-sliver") === null);
		assert.ok((q('[data-node-id="a"]')!.textContent ?? "").includes("Alpha done"));
	});
	it("a pan far past the edges is not clamped; re-center resets the offset", async () => {
		await mount(<PlanGraphView draggable graph={g} />);
		const box = q('[data-testid="graph-scroll"]')!;
		const x0 = panX();
		await ptr(box, "pointerdown", 5000, 50);
		await ptr(box, "pointermove", -5000, 50);
		await ptr(box, "pointerup", -5000, 50);
		assert.equal(panX(), x0 - 10000);
		await click(q('[data-testid="graph-recenter"]')!);
		assert.equal(panX(), x0);
	});
});
