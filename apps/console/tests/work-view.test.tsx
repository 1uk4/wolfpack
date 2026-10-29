/**
 * The Work view overlay (node test runner, linkedom, an injected fake client): opens from the graph header's button
 * and the sidebar's nav entry, the remembered domain, expand/collapse, the gutter lanes, header sorting,
 * the search that auto-expands, the graduated toggle, refresh on focus, and the select no-op seam.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";

const dom = parseHTML("<!doctype html><html><body></body></html>");
const store = new Map<string, string>();
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	HTMLInputElement: dom.window.HTMLInputElement,
	KeyboardEvent: dom.window.KeyboardEvent,
	Event: dom.window.Event,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
	ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
	localStorage: {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
	},
});

const { WorkViewProvider, WORK_DOMAIN_KEY } = await import("../components/work-view.tsx");
const { WorkButton, WorkNavEntry } = await import("../components/work-view-entry.tsx");
const { GraphChromeRow } = await import("../components/graph-view.tsx");
import type { WorkClient } from "../components/work-client.ts";
import type { WorkListItem } from "../src/core/kb.ts";

const item = (id: string, kind: string, over: Partial<WorkListItem> = {}): WorkListItem => ({ id, title: id.toUpperCase(), kind, stage: "plan", domain: "wolfpack", dependsOn: [], ...over });
const ITEMS: WorkListItem[] = [
	item("i1", "initiative", { title: "Phase 1" }),
	item("f1", "feature", { partOf: "i1", stage: "in_build", created: "2026-10-05", title: "Work view" }),
	item("t1", "task", { partOf: "f1", stage: "shipped", created: "2026-10-05" }),
	item("t2", "task", { partOf: "f1", stage: "in_build", dependsOn: ["t1"], created: "2026-10-06" }),
	item("t3", "task", { partOf: "f1", stage: "plan", dependsOn: ["t1", "t2"], created: "2026-10-07" }),
	item("f2", "feature", { partOf: "i1", stage: "shipped", created: "2026-10-02", title: "Graduate", dependsOn: ["f1"] }),
	item("f3", "feature", { stage: "plan", created: "2026-10-09", title: "Loose feature" }),
];
const GRADUATED: WorkListItem[] = [item("old", "feature", { stage: "archived", graduated: "2026-10-03", title: "Old one", created: "2026-09-01" })];

interface Fake extends WorkClient { calls: { domain: string; graduated: boolean }[]; items: WorkListItem[] }
const fake = (over: Partial<WorkClient> = {}): Fake => {
	const f: Fake = {
		calls: [],
		items: ITEMS,
		domains: async () => [{ name: "wolfpack", label: "Wolfpack" }, { name: "snapjack", label: "Snapjack" }],
		list: async (domain, graduated) => {
			f.calls.push({ domain, graduated });
			return { ok: true, data: { items: graduated ? [...f.items, ...GRADUATED] : f.items } };
		},
		...over,
	};
	return f;
};

let root: Root | null = null;
// The table tests read the full-screen layout (all columns); the column is the default, so start expanded.
beforeEach(() => {
	store.clear();
	store.set("wolfpack:work-view-expanded", "1");
});
afterEach(() => {
	act(() => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 10)); });
const mount = async (client: WorkClient, selected?: string[]) => {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(
			<WorkViewProvider client={client} onSelect={selected ? (id) => void selected.push(id) : undefined}>
				<WorkButton />
				<WorkNavEntry />
			</WorkViewProvider>,
		);
	});
};
const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const qa = (sel: string) => [...document.querySelectorAll(sel)] as HTMLElement[];
const click = (el: Element) => act(async () => { el.dispatchEvent(Object.assign(new dom.window.Event("click", { bubbles: true, cancelable: true }), { detail: 1 })); });
const change = (el: HTMLElement, props: object) =>
	act(async () => {
		const key = Object.keys(el).find((k) => k.startsWith("__reactProps"))!;
		(el as unknown as Record<string, { onChange(e: unknown): void }>)[key]!.onChange({ target: props });
	});
const open = async (client: WorkClient = fake()) => {
	await mount(client);
	await click(q("work-open")!);
	await settle();
};
const rows = () => qa('[data-testid^="work-row-"]').map((r) => r.getAttribute("data-testid")!.slice("work-row-".length));

describe("entry points", () => {
	it("the graph header's Work button opens the overlay; the close button closes it", async () => {
		await mount(fake());
		assert.equal(q("work-view"), null);
		await click(q("work-open")!);
		assert.ok(q("work-view"));
		assert.equal(q("work-view")!.getAttribute("role"), "dialog");
		await click(q("work-close")!);
		assert.equal(q("work-view"), null);
	});
	it("the sidebar's Work entry opens the same overlay; Esc closes it", async () => {
		await mount(fake());
		await click(q("nav-work")!);
		assert.equal(qa('[data-testid="work-view"]').length, 1);
		await act(async () => {
			const ev = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
			Object.defineProperty(ev, "key", { value: "Escape" });
			document.dispatchEvent(ev);
		});
		assert.equal(q("work-view"), null);
	});
	it("the graph chrome row and the sidebar render the entries", () => {
		const html = renderToStaticMarkup(
			<GraphChromeRow isEmpty noMatch={false} query="" onQuery={() => {}} searchInputRef={{ current: null }} settings={{} as never} changeSettings={() => {}} />,
		);
		assert.ok(html.includes('data-testid="work-open"'));
		assert.match(readFileSync(new URL("../components/sidebar.tsx", import.meta.url), "utf8"), /<WorkNavEntry \/>/);
	});
	it("the provider wraps the app shell, so the one overlay renders after the page (drag-region mask law)", () => {
		const layout = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");
		assert.match(layout, /<WorkViewProvider>\s*<AppShell>/);
	});
});

describe("domain", () => {
	it("starts on wolfpack, lists the client's domains, and fetches that domain", async () => {
		const c = fake();
		await open(c);
		const sel = q("work-domain") as HTMLSelectElement;
		assert.equal(sel.value, "wolfpack");
		assert.deepEqual(qa('[data-testid="work-domain"] option').map((o) => o.textContent), ["Wolfpack", "Snapjack"]);
		assert.deepEqual(c.calls[0], { domain: "wolfpack", graduated: false });
	});
	it("remembers the choice in localStorage and starts there next time", async () => {
		const c = fake();
		await open(c);
		await change(q("work-domain")!, { value: "snapjack" });
		await settle();
		assert.equal(store.get(WORK_DOMAIN_KEY), "snapjack");
		assert.equal(c.calls.at(-1)!.domain, "snapjack");
		await act(async () => root?.unmount());
		document.body.innerHTML = "";
		const c2 = fake();
		await open(c2);
		assert.equal((q("work-domain") as HTMLSelectElement).value, "snapjack");
		assert.equal(c2.calls[0]!.domain, "snapjack");
	});
});

describe("rows", () => {
	it("starts collapsed: only the initiative group and the Inbox", async () => {
		await open();
		assert.deepEqual(rows(), ["i1", "no-initiative"]);
	});
	it("expands and collapses groups, features and back", async () => {
		await open();
		await click(q("work-toggle-i1")!);
		assert.deepEqual(rows(), ["i1", "f1", "f2", "no-initiative"]);
		await click(q("work-toggle-f1")!);
		assert.deepEqual(rows(), ["i1", "f1", "t1", "t2", "t3", "f2", "no-initiative"]);
		assert.equal(q("work-toggle-f1")!.getAttribute("aria-expanded"), "true");
		await click(q("work-toggle-i1")!);
		assert.deepEqual(rows(), ["i1", "no-initiative"]);
		await click(q("work-toggle-i1")!);
		assert.ok(rows().includes("t3"), "a reopened group remembers its feature was open");
	});
	it("shows stage text via stageLabel, progress and created", async () => {
		await open();
		await click(q("work-toggle-i1")!);
		assert.equal(q("work-stage-f2")!.textContent, "shipped · ready to graduate");
		assert.equal(q("work-stage-f1")!.textContent, "in build");
		assert.equal(q("work-progress-f1")!.textContent, "1/3 shipped");
		assert.ok(q("work-row-f1")!.textContent!.includes("2026-10-05"));
	});
	it("draws no inline dependency line: each item appears once, as a titled chip styled by stage", async () => {
		await open();
		await click(q("work-toggle-i1")!);
		await click(q("work-toggle-f1")!);
		assert.equal(qa(".katex").length, 0);
		assert.equal(q("work-premise-t3-t1"), null);
		assert.equal(q("work-implies-t3"), null);
		assert.equal(q("work-chip-t3")!.getAttribute("data-chip-state"), "blocked");
		assert.equal(q("work-chip-f2")!.getAttribute("data-chip-state"), "ready");
		for (const id of ["f1", "t1", "t2", "t3", "f2"]) assert.equal(qa(`[data-testid="work-chip-${id}"]`).length, 1);
		assert.equal(q("work-row-t3")!.style.height, "32px");
	});
});

describe("gutter lanes", () => {
	const laneIds = () => qa('[data-testid^="work-lane-"]').filter((e) => e.tagName.toLowerCase() === "g").map((e) => e.getAttribute("data-testid")!.slice("work-lane-".length));
	it("collapsed groups draw no lanes; opening draws one per dependency, closing hides them again", async () => {
		await open();
		assert.deepEqual(laneIds(), []);
		assert.equal(q("work-lanes-i1"), null);
		await click(q("work-toggle-i1")!);
		assert.deepEqual(laneIds(), ["f1-f2"]);
		await click(q("work-toggle-f1")!);
		assert.deepEqual(laneIds().sort(), ["f1-f2", "t1-t2", "t1-t3", "t2-t3"]);
		await click(q("work-toggle-i1")!);
		assert.deepEqual(laneIds(), []);
	});
	it("a done dependent's lane is muted grey; an open one is the faint colour", async () => {
		await open();
		await click(q("work-toggle-i1")!);
		await click(q("work-toggle-f1")!);
		const lane = (id: string) => q(`work-lane-${id}`)!;
		assert.equal(lane("f1-f2").getAttribute("data-lane-state"), "done"); // f2 is shipped
		assert.equal(lane("f1-f2").getAttribute("stroke"), "#7d8493");
		assert.equal(lane("t1-t2").getAttribute("data-lane-state"), "plain");
		assert.equal(lane("t1-t2").getAttribute("stroke"), "#8a93a6");
	});
	it("shows an out-of-parent dependency as a ↖ note", async () => {
		const c = fake();
		c.items = [...ITEMS, item("f4", "feature", { dependsOn: ["f2"], title: "Later" })];
		await open(c);
		await click(q("work-toggle-no-initiative")!);
		assert.equal(q("work-note-f4-f2")!.textContent, "↖ Graduate");
		assert.deepEqual(laneIds(), []);
	});
});

describe("sorting", () => {
	it("defaults to stage order; a header click sorts by name, a second click flips it, with a chevron on the active column", async () => {
		await open();
		await click(q("work-toggle-i1")!);
		assert.deepEqual(rows(), ["i1", "f1", "f2", "no-initiative"]); // in build, then shipped
		assert.equal(q("work-sort-stage")!.getAttribute("aria-sort"), "ascending");
		await click(q("work-sort-name")!);
		assert.deepEqual(rows(), ["i1", "f1", "f2", "no-initiative"]); // Graduate, Work view
		assert.equal(q("work-sort-name")!.getAttribute("aria-sort"), "ascending");
		assert.equal(q("work-sort-stage")!.getAttribute("aria-sort"), "none");
		assert.ok(q("work-sort-name")!.querySelector("svg"));
		await click(q("work-sort-name")!);
		assert.deepEqual(rows(), ["i1", "f1", "f2", "no-initiative"]);
		assert.equal(q("work-sort-name")!.getAttribute("aria-sort"), "descending");
	});
	it("created sorts newest first on its first click", async () => {
		await open();
		await click(q("work-toggle-i1")!);
		await click(q("work-sort-created")!);
		assert.deepEqual(rows(), ["i1", "f1", "f2", "no-initiative"]);
		await click(q("work-sort-created")!);
		assert.deepEqual(rows(), ["i1", "f1", "f2", "no-initiative"]);
	});
});

describe("search", () => {
	it("a match deep in the tree expands its ancestors and hides the rest; clearing returns the collapsed view", async () => {
		await open();
		await change(q("work-search")!, { value: "t3" });
		assert.deepEqual(rows(), ["i1", "f1", "t3"]);
		await change(q("work-search")!, { value: "" });
		assert.deepEqual(rows(), ["i1", "no-initiative"]);
	});
	it("matches stage text and says so when nothing matches", async () => {
		await open();
		await change(q("work-search")!, { value: "ready to graduate" });
		assert.deepEqual(rows(), ["i1", "f2"]);
		await change(q("work-search")!, { value: "zzzz" });
		assert.ok(q("work-empty")!.textContent!.includes("No matching work"));
	});
});

describe("graduated toggle, refresh and select", () => {
	it("graduated items are hidden until the toggle refetches with them, then shown greyed", async () => {
		const c = fake();
		await open(c);
		assert.ok(!document.body.textContent!.includes("Old one"));
		await change(q("work-show-graduated")!, { checked: true });
		await settle();
		assert.equal(c.calls.at(-1)!.graduated, true);
		await click(q("work-toggle-no-initiative")!);
		assert.equal(q("work-row-old")!.getAttribute("data-graduated"), "true");
		assert.equal(q("work-row-f3")!.getAttribute("data-graduated"), null);
	});
	it("refetches when the window regains focus, keeping what is open", async () => {
		const c = fake();
		await open(c);
		await click(q("work-toggle-i1")!);
		const n = c.calls.length;
		c.items = [...ITEMS, item("f9", "feature", { partOf: "i1", stage: "in_build", title: "Fresh" })];
		await act(async () => { window.dispatchEvent(new dom.window.Event("focus")); });
		await settle();
		assert.equal(c.calls.length, n + 1);
		assert.ok(rows().includes("f9"));
		assert.ok(rows().includes("i1"));
	});
	it("shows the error when the first load fails, and keeps the list when a later refresh fails", async () => {
		let fail = true;
		const c = fake({ list: async () => (fail ? { ok: false, reason: "unavailable", message: "no Work API" } : { ok: true, data: { items: ITEMS } }) });
		await open(c);
		assert.ok(q("work-error")!.textContent!.includes("no Work API"));
		fail = false;
		await act(async () => { window.dispatchEvent(new dom.window.Event("focus")); });
		await settle();
		assert.equal(q("work-error"), null);
		fail = true;
		await act(async () => { window.dispatchEvent(new dom.window.Event("focus")); });
		await settle();
		assert.ok(rows().includes("i1"));
	});
	it("clicking a row calls onSelect(id) (a no-op seam for the split view); the expander does not", async () => {
		const picked: string[] = [];
		await mount(fake(), picked);
		await click(q("work-open")!);
		await settle();
		await click(q("work-toggle-i1")!);
		assert.deepEqual(picked, []);
		await click(q("work-row-f1")!);
		assert.deepEqual(picked, ["f1"]);
	});
});
