/**
 * The graph's docked side pane: per-kind content (facts at once, the rest
 * fetched lazily), the route stepper inside it, content following the cursor,
 * resize (clamp + persist), Esc / close, the feature task list and the
 * open-thread button.
 */
import React, { act, useState } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
const store = new Map<string, string>();
Object.assign(globalThis, {
	window: Object.assign(dom.window, { innerWidth: 1600 }),
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	KeyboardEvent: dom.window.KeyboardEvent,
	Event: dom.window.Event,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
	self: globalThis,
	IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
	ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
	localStorage: {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
	},
});

const { GraphPane, clearPaneCache } = await import("../components/graph-pane.tsx");
const { describeNode } = await import("../src/core/kb-graph-model.ts");
const { routeForNode, reconcileCursor } = await import("../src/core/dep-route-adapter.ts");
const { startCursor } = await import("../src/core/work-route.ts");
const { GRAPH_PANE_WIDTH_KEY, PANE_MAX_WIDTH, PANE_MIN_WIDTH, clampPaneWidth, parsePaneWidth, paneWork, stripComments, PaneCache } = await import("../src/core/graph-pane.ts");
import type { KbGraph } from "../src/core/kb.ts";
import type { NodeCard } from "../src/core/kb-graph-model.ts";

const w = (id: string, workKind: string, stage: string, label = id) => ({ id: `work:${id}`, kind: "work" as const, label, depth: 3, domain: "d", workKind, stage, assignee: "hal", updated: "2026-10-27" });
const graph: KbGraph = {
	nodes: [
		{ id: "dom:d", kind: "domain", label: "D", depth: 0, domain: "d" },
		{ id: "fac:d", kind: "factory", label: "Factory", depth: 1, domain: "d" },
		{ id: "ent:x", kind: "entry", label: "Entry X", depth: 2, domain: "d", maturity: "stable" },
		w("F", "feature", "in_build", "Feat"),
		w("a", "task", "shipped", "Task A"),
		w("b", "task", "in_build", "Task B"),
		w("c", "task", "plan", "Task C"),
	],
	edges: [
		...["a", "b", "c"].map((t) => ({ source: `work:${t}`, target: "work:F", kind: "partOf" as const })),
		{ source: "work:b", target: "work:a", kind: "dependsOn" as const },
		{ source: "work:c", target: "work:a", kind: "dependsOn" as const },
	],
	layers: { archivedWork: false, denTopics: false },
	domain: null,
	domains: [{ name: "d", label: "D" }],
	generated: "2026-10-28T00:00:00.000Z",
};

// ---- fetch stub --------------------------------------------------------------

const workRecords: Record<string, unknown> = {
	F: {
		id: "F", title: "Feat", kind: "feature", stage: "in_build", domain: "d",
		successCriteria: "- the pane **docks**",
		plan: "# Feat\n\n## Approach\n\nBuild the docked pane.",
		record: "### Decisions\n\n- keep it simple <!-- source: abc -->\n\n<!--\nmulti\nline\n-->\nafter",
		log: Array.from({ length: 10 }, (_, i) => `**2026-10-2${i % 10} 10:00** — entry-${i}`),
		children: [
			{ id: "a", title: "Task A", kind: "task", stage: "shipped", dependsOn: [] },
			{ id: "b", title: "Task B", kind: "task", stage: "in_build", dependsOn: ["a"] },
		],
	},
	b: { id: "b", title: "Task B", kind: "task", stage: "in_build", domain: "d", plan: "## Notes\n\nTask B notes.", record: "should not show" },
};
let calls: { url: string; method: string }[] = [];
let threadResult: { ok: boolean } = { ok: true };
const json = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body });
globalThis.fetch = (async (url: string, init?: RequestInit) => {
	const method = init?.method ?? "GET";
	calls.push({ url, method });
	if (url === "/api/wolves") return json(200, { wolves: [{ id: "1", name: "lib", host: "h", status: "online", librarian: true }, { id: "2", name: "hal", host: "h", status: "online" }] });
	const rec = /\/work\/([^/]+)\/record$/.exec(url);
	if (rec) return workRecords[rec[1]!] ? json(200, workRecords[rec[1]!]) : json(404, { error: "nope" });
	if (/\/kb\/entries\/x$/.test(url)) return json(200, { id: "x", title: "Entry X", domain: "d", body: "Entry body text **here**.", frontmatter: { maturity: "stable" }, wikilinks: [], backlinks: [] });
	if (/\/threads$/.test(url) && method === "POST") return threadResult.ok ? json(200, { id: "t1", title: "T" }) : json(500, { error: "boom" });
	return json(404, { error: "unmocked " + url });
}) as typeof fetch;

// ---- harness ------------------------------------------------------------------

let root: Root | null = null;
beforeEach(() => {
	clearPaneCache();
	store.clear();
	calls = [];
	threadResult = { ok: true };
});
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
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement;
const text = () => document.body.textContent ?? "";

interface Spies { closed: number; selected: string[]; navigated: string[]; focused: string[][]; layouts: number }
function Harness({ target, spies, routed = false }: { target: string; spies: Spies; routed?: boolean }) {
	const route = routed ? routeForNode(graph, target) : null;
	const [cursorState, setCursor] = useState<ReturnType<typeof startCursor> | null>(null);
	const cursor = route ? reconcileCursor(route, cursorState) : null;
	const byRaw = new Map(graph.nodes.map((n) => [n.id.replace(/^work:/, ""), n] as const));
	const nodeId = cursor?.node ? `work:${cursor.node}` : target;
	const card = describeNode(graph, nodeId) as NodeCard;
	const routeNav = route && cursor ? { route, cursor, label: (id: string) => byRaw.get(id)?.label ?? id, stage: (id: string) => byRaw.get(id)?.stage ?? "", onCursor: setCursor } : null;
	return (
		<GraphPane
			card={card}
			routeNav={routeNav}
			onClose={() => void spies.closed++}
			onFocus={(ids) => void spies.focused.push(ids)}
			onSelectNode={(id) => void spies.selected.push(id)}
			onNavigate={(h) => void spies.navigated.push(h)}
			onLayout={() => void spies.layouts++}
		/>
	);
}
const spies = (): Spies => ({ closed: 0, selected: [], navigated: [], focused: [], layouts: 0 });
const key = (k: string, target: Element = document.body) => act(() => {
	const ev = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
	Object.defineProperty(ev, "key", { value: k });
	target.dispatchEvent(ev);
});
const pointer = (type: string, clientX: number, target: EventTarget = window) => act(() => {
	const ev = new dom.window.Event(type, { bubbles: true, cancelable: true });
	Object.assign(ev, { clientX });
	target.dispatchEvent(ev);
});

// ---- pure ---------------------------------------------------------------------

describe("pane helpers", () => {
	it("clamps the width to [min, max] (and the viewport share) and parses storage", () => {
		assert.equal(clampPaneWidth(10), PANE_MIN_WIDTH);
		assert.equal(clampPaneWidth(5000), PANE_MAX_WIDTH);
		assert.equal(clampPaneWidth(500), 500);
		assert.equal(clampPaneWidth(700, 800), 560);
		assert.equal(parsePaneWidth("junk"), parsePaneWidth(null));
		assert.equal(parsePaneWidth("99999"), PANE_MAX_WIDTH);
	});
	it("strips source comments (single- and multi-line) from the Record", () => {
		assert.equal(stripComments("a <!-- s -->\n\n\n<!--\nx\n-->\nb"), "a \n\nb");
	});
	it("shows the last 10 log entries newest first; only features carry Record and tasks", () => {
		const base = { id: "i", title: "t", stage: "plan", plan: "# T\n\n## H\n\nbody", record: "rec", log: Array.from({ length: 15 }, (_, i) => String(i)) };
		const task = paneWork({ ...base, kind: "task" });
		assert.equal(task.record, "");
		assert.deepEqual(task.log, ["14", "13", "12", "11", "10", "9", "8", "7", "6", "5"]);
		assert.equal(paneWork({ ...base, kind: "feature", children: [{ id: "c", title: "C", kind: "task", stage: "plan", dependsOn: [] }] }).tasks.length, 1);
	});
	it("the cache expires and evicts", () => {
		let t = 0;
		const c = new PaneCache<number>(2, 100, () => t);
		c.set("a", 1); c.set("b", 2); c.set("c", 3);
		assert.equal(c.get("a"), undefined);
		assert.equal(c.get("c"), 3);
		t = 101;
		assert.equal(c.get("c"), undefined);
	});
});

// ---- component ------------------------------------------------------------------

describe("GraphPane content", () => {
	it("work feature: facts at once, then success criteria, document, Record (comments stripped), log, tasks, buttons", async () => {
		mount(<Harness target="work:F" spies={spies()} />);
		// facts + loading before the fetch lands
		assert.ok(q("graph-pane") && q("graph-pane").getAttribute("data-kind") === "work");
		for (const t of ["Feat", "in build", "feature", "hal", "2026-10-27"]) assert.ok(text().includes(t), t);
		assert.ok(q("pane-loading"));
		await settle();
		assert.ok(!q("pane-loading"));
		const sec = (n: string) => document.querySelector(`[data-section="${n}"]`)?.textContent ?? "";
		assert.ok(sec("success-criteria").includes("docks"));
		assert.ok(sec("document").includes("Build the docked pane."));
		assert.ok(sec("record").includes("keep it simple") && !sec("record").includes("source: abc") && !sec("record").includes("multi"));
		const log = [...document.querySelectorAll("[data-log-entry]")].map((e) => e.textContent ?? "");
		assert.equal(log.length, 10);
		assert.ok(log[0]!.includes("entry-9"), "newest first");
		assert.equal(document.querySelectorAll("[data-task]").length, 2);
		assert.ok(q("pane-open").getAttribute("href") === "/kb/work/F" && q("pane-open").textContent === "Open page");
		assert.ok(q("pane-open-thread"));
	});

	it("a task shows no Record and no thread button; a repeat selection is served from the cache", async () => {
		mount(<Harness target="work:b" spies={spies()} />);
		await settle();
		assert.ok(!document.querySelector('[data-section="record"]'));
		assert.ok(!q("pane-open-thread"));
		assert.ok(text().includes("Task B notes."));
		const n = calls.filter((c) => c.url.endsWith("/work/b/record")).length;
		assert.equal(n, 1);
	});

	it("entry: facts from the payload, the entry text rendered from the librarian", async () => {
		mount(<Harness target="ent:x" spies={spies()} />);
		assert.ok(text().includes("stable") && text().includes("Entry X"));
		await settle();
		assert.ok(text().includes("Entry body text"));
		assert.ok(calls.some((c) => c.url === "/api/wolves/lib/kb/entries/x"));
		assert.ok(q("pane-open").getAttribute("href") === "/kb/entry/x");
	});

	it("factory: a summary from the payload, nothing fetched", async () => {
		mount(<Harness target="fac:d" spies={spies()} />);
		await settle();
		assert.equal(q("graph-pane").getAttribute("data-kind"), "factory");
		assert.ok(text().includes("in build") && text().includes("shipped"), "work by stage");
		assert.equal(calls.length, 0);
	});

	it("a failed lookup says so but keeps the facts", async () => {
		const g = { ...graph, nodes: [...graph.nodes, w("zz", "task", "plan", "Ghost")] };
		const card = describeNode(g, "work:zz")!;
		mount(<GraphPane card={card} onClose={() => {}} onFocus={() => {}} onSelectNode={() => {}} onNavigate={() => {}} />);
		await settle();
		assert.ok(q("pane-error").textContent!.includes("No such work item"));
		assert.ok(text().includes("Ghost"));
	});
});

describe("route stepper in the pane", () => {
	it("steps with the buttons and keys, the dropdown works, and the content follows the cursor", async () => {
		mount(<Harness target="work:F" spies={spies()} routed />);
		await settle();
		const step = () => q("route-step").textContent!;
		const title = () => q("pane-title").textContent;
		assert.ok(step().startsWith("Step 2 of 3"));
		assert.equal(title(), "Task B");
		await settle();
		assert.ok(text().includes("Task B notes."), "the document follows the cursor");
		act(() => q("route-prev").click());
		assert.ok(step().startsWith("Step 1 of 3") && title() === "Task A");
		key("ArrowRight");
		assert.ok(step().startsWith("Step 2 of 3"));
		// parallel step: b / c
		const sel = q("route-parallel") as unknown as HTMLSelectElement;
		act(() => {
			Object.defineProperty(sel, "value", { value: "c", configurable: true });
			sel.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
		});
		assert.equal(title(), "Task C");
		assert.ok(step().includes("plan"));
	});
});

describe("resize, Esc, close", () => {
	it("dragging the left edge resizes within the bounds and remembers the width", () => {
		mount(<Harness target="fac:d" spies={spies()} />);
		const width = () => (q("graph-pane").style as unknown as { width: string }).width;
		assert.equal(width(), "380px");
		pointer("pointerdown", 1000, q("pane-resize"));
		pointer("pointermove", 900); // 100 px to the left → wider
		assert.equal(width(), "480px");
		pointer("pointermove", -4000);
		assert.equal(width(), `${PANE_MAX_WIDTH}px`);
		pointer("pointermove", 4000);
		assert.equal(width(), `${PANE_MIN_WIDTH}px`);
		pointer("pointermove", 850);
		pointer("pointerup", 850);
		assert.equal(width(), "530px");
		assert.equal(store.get(GRAPH_PANE_WIDTH_KEY), "530");
		pointer("pointermove", 100); // after release: ignored
		assert.equal(width(), "530px");
	});

	it("reopens at the remembered width; a corrupt value falls back to the default", () => {
		store.set(GRAPH_PANE_WIDTH_KEY, "600");
		mount(<Harness target="fac:d" spies={spies()} />);
		assert.equal((q("graph-pane").style as unknown as { width: string }).width, "600px");
		act(() => root!.unmount());
		store.set(GRAPH_PANE_WIDTH_KEY, "abc");
		mount(<Harness target="fac:d" spies={spies()} />);
		assert.equal((q("graph-pane").style as unknown as { width: string }).width, "380px");
	});

	it("announces its layout (the view nudges the camera) on open and on resize", () => {
		const s = spies();
		mount(<Harness target="fac:d" spies={s} />);
		assert.equal(s.layouts, 1);
		pointer("pointerdown", 1000, q("pane-resize"));
		pointer("pointermove", 950);
		pointer("pointerup", 950);
		assert.ok(s.layouts >= 2);
	});

	it("Esc and the close button close; Esc is left alone while typing", () => {
		const s = spies();
		mount(
			<div>
				<input data-testid="box" />
				<Harness target="fac:d" spies={s} />
			</div>,
		);
		key("Escape", q("box"));
		assert.equal(s.closed, 0);
		key("Escape");
		assert.equal(s.closed, 1);
		act(() => q("pane-close").click());
		assert.equal(s.closed, 2);
	});
});

describe("feature actions", () => {
	it("clicking a task in the feature's list selects it", async () => {
		const s = spies();
		mount(<Harness target="work:F" spies={s} />);
		await settle();
		act(() => (document.querySelector('[data-task="a"]') as HTMLElement).click());
		assert.deepEqual(s.selected, ["work:a"]);
	});

	it("Open thread opens the feature's thread and navigates to it; a failure is shown", async () => {
		const s = spies();
		mount(<Harness target="work:F" spies={s} />);
		await settle();
		const btns = [...document.querySelectorAll('[data-testid="pane-open-thread"]')] as HTMLElement[];
		assert.deepEqual(btns.map((b) => b.getAttribute("data-wolf")), ["hal", "lib"], "worker wolves first, then the librarian");
		assert.equal(btns[0]!.textContent, "Open thread on hal");
		threadResult = { ok: false };
		await act(async () => { btns[0]!.click(); await new Promise((r) => setTimeout(r, 10)); });
		assert.ok(q("graph-pane").textContent!.includes("boom"));
		assert.deepEqual(s.navigated, []);
		threadResult = { ok: true };
		await act(async () => { btns[0]!.click(); await new Promise((r) => setTimeout(r, 10)); });
		const post = calls.find((c) => c.method === "POST");
		assert.equal(post!.url, "/api/wolves/hal/threads");
		assert.equal(s.navigated.length, 1);
		assert.ok(String(s.navigated[0]).startsWith("/wolf/hal/thread/"));
	});
});
