/**
 * The Work view overlay (node test runner, linkedom, an injected fake client): is the /work page, opens items in the reader through ?item=, the remembered domain, expand/collapse, the gutter lanes, header sorting,
 * the search that auto-expands, the graduated toggle, refresh on focus.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
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
	self: globalThis, // next/link (the reader's Full page link) reads `self` when it mounts
	requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
	ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
	localStorage: {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
	},
});

const { WorkList, WORK_DOMAIN_KEY } = await import("../components/work-view.tsx");
const { WorkReaderHost } = await import("../components/work-reader.tsx");
const { FakeNav, currentUrl, historyBack, historyForward } = await import("./helpers/fake-nav.tsx");
import type { WorkClient } from "../components/work-client.ts";
import type { WorkListItem } from "../src/core/kb.ts";
import { NOTE_H, WORK_ROW_H } from "../src/core/work-connectors.ts";

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
beforeEach(() => {
	store.clear();
	// the reader's WorkItemPage fetches; nothing is online in these tests
	(globalThis as Record<string, unknown>).fetch = async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => "" });
});
afterEach(() => {
	act(() => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 10)); });
const mount = async (client: WorkClient, start = "/work") => {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(
			<FakeNav start={start}>
				<WorkList client={client} />
				<WorkReaderHost />
			</FakeNav>,
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
	await settle();
};
const rows = () => qa('[data-testid^="work-row-"]').map((r) => r.getAttribute("data-testid")!.slice("work-row-".length));

describe("the Work page", () => {
	it("renders the list on its own: no graph, no overlay shell, no layout toggle or resize handle", async () => {
		await open();
		assert.ok(q("work-view"));
		assert.equal(q("graph-placeholder"), null);
		assert.equal(q("work-layout-toggle"), null);
		assert.equal(q("work-resize"), null);
		assert.equal(q("work-close"), null);
		assert.equal(q("work-reader"), null);
	});
});

describe("opening an item", () => {
	it("a row click pushes ?item=<id> and shows the reader; the list stays mounted", async () => {
		await open();
		await click(q("work-toggle-i1")!);
		assert.equal(q("work-reader"), null);
		await click(q("work-open-f1")!);
		assert.equal(currentUrl(), "/work?item=f1");
		assert.equal(q("work-reader")!.getAttribute("data-work"), "f1");
		assert.ok(q("work-row-f1"), "the list is still there under the reader");
	});
	it("tapping a row with children toggles it (like the chevron); Open opens the reader and does not toggle", async () => {
		await open();
		const row = q("work-row-i1")!;
		assert.equal(row.getAttribute("aria-expanded"), "false");
		await click(row);
		assert.equal(row.getAttribute("aria-expanded"), "true");
		assert.ok(q("work-row-f1"));
		assert.equal(q("work-reader"), null, "a tap on a row with children does not open the reader");
		await click(row);
		assert.equal(row.getAttribute("aria-expanded"), "false");
		await click(row);
		await click(q("work-open-i1")!);
		assert.equal(q("work-reader")!.getAttribute("data-work"), "i1");
		assert.equal(q("work-row-i1")!.getAttribute("aria-expanded"), "true", "Open left the row as it was");
		assert.equal(q("work-open-i1")!.getAttribute("aria-label"), "Open Phase 1");
	});
	it("Enter and Space on a focused row toggle it", async () => {
		await open();
		const row = q("work-row-i1")!;
		const key = (k: string) => act(async () => { row.dispatchEvent(Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), { key: k })); });
		await key("Enter");
		assert.equal(row.getAttribute("aria-expanded"), "true");
		await key(" ");
		assert.equal(row.getAttribute("aria-expanded"), "false");
	});
	it("the expander does not open the reader", async () => {
		await open();
		await click(q("work-toggle-i1")!);
		assert.equal(q("work-reader"), null);
		assert.equal(currentUrl(), "/work");
	});
	it("closing (X, Esc or Back) restores the list exactly: expanded rows, search, domain, sort", async () => {
		const c = fake();
		await open(c);
		await change(q("work-domain")!, { value: "snapjack" });
		await settle();
		await click(q("work-toggle-i1")!);
		await click(q("work-toggle-f1")!);
		const before = rows();
		const esc = () => act(async () => {
			const ev = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
			Object.defineProperty(ev, "key", { value: "Escape" });
			window.dispatchEvent(ev);
		});
		for (const how of ["x", "esc", "back"] as const) {
			await click(q("work-row-t2")!);
			assert.ok(q("work-reader"), how);
			if (how === "x") await click(q("work-reader-close")!);
			else if (how === "esc") await esc();
			else await act(async () => historyBack());
			assert.equal(q("work-reader"), null, how);
			assert.equal(currentUrl(), "/work", how);
			assert.deepEqual(rows(), before, how);
			assert.equal((q("work-domain") as HTMLSelectElement).value, "snapjack", how);
		}
	});
	it("Forward re-opens the reader; /work?item=<id> opened directly shows it, and closing a deep link replaces the URL", async () => {
		await open();
		await click(q("work-toggle-i1")!);
		await click(q("work-open-f1")!);
		await act(async () => historyBack());
		assert.equal(q("work-reader"), null);
		await act(async () => historyForward());
		assert.equal(q("work-reader")!.getAttribute("data-work"), "f1");
		await act(async () => root?.unmount());
		document.body.innerHTML = "";
		await mount(fake(), "/work?item=zz");
		await settle();
		assert.equal(q("work-reader")!.getAttribute("data-work"), "zz");
		await click(q("work-reader-close")!);
		assert.equal(currentUrl(), "/work");
		assert.equal(q("work-reader"), null);
	});
	it("Esc with the reader closed does nothing to the list", async () => {
		await open();
		await click(q("work-toggle-i1")!);
		await act(async () => {
			const ev = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
			Object.defineProperty(ev, "key", { value: "Escape" });
			window.dispatchEvent(ev);
		});
		assert.ok(q("work-view"));
		assert.deepEqual(rows(), ["i1", "f1", "f2", "no-initiative"]);
	});
});

describe("domain", () => {
	it("starts on wolfpack, lists the client's domains, and fetches that domain", async () => {
		const c = fake();
		await open(c);
		const sel = q("work-domain") as HTMLSelectElement;
		assert.equal(sel.value, "wolfpack");
		assert.deepEqual(qa('[data-testid="work-domain"] option').map((o) => o.textContent), ["Wolfpack", "Snapjack"]);
		assert.deepEqual(c.calls[0], { domain: "wolfpack", graduated: true });
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
	it("has the columns Name, Status, Created and, last, Open; no Assignee, no separate Progress", async () => {
		await open();
		await click(q("work-toggle-i1")!);
		assert.deepEqual(qa('[data-testid^="work-sort-"]').map((b) => b.textContent!.trim()), ["Name", "Status", "Created"]);
		const cells = [...q("work-row-f1")!.querySelectorAll('[data-testid]')].map((e) => e.getAttribute("data-testid")!);
		assert.ok(cells.indexOf("work-stage-f1") < cells.indexOf("work-open-f1"), "Open comes after Status");
		assert.equal(q("work-open-f1")!.parentElement!.nextElementSibling, null, "Open is the rightmost cell");
		assert.ok(q("work-stage-f1")!.parentElement!.contains(q("work-progress-f1")), "progress sits in the Status cell");
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
	it("link notes sit on the row's own line, inside the row, and the row is taller by exactly that line", async () => {
		const c = fake();
		c.items = [...ITEMS, item("f4", "feature", { dependsOn: ["f2", "f1"], title: "Later" })];
		await open(c);
		await click(q("work-toggle-no-initiative")!);
		const row = q("work-row-f4")!;
		const links = q("work-links-f4")!;
		assert.ok(row.contains(links));
		assert.equal(links.querySelectorAll('[data-testid^="work-note-f4-"]').length, 2);
		assert.equal(row.style.height, `${WORK_ROW_H + NOTE_H}px`);
		assert.equal(q("work-links-f3"), null, "a row without notes has no link line");
		assert.equal(q("work-row-f3")!.style.height, `${WORK_ROW_H}px`);
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
	it("graduated items are fetched always but hidden until the toggle shows them greyed", async () => {
		const c = fake();
		await open(c);
		assert.ok(!document.body.textContent!.includes("Old one"));
		await change(q("work-show-graduated")!, { checked: true });
		await settle();
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
});

describe("the assignee dropdown", () => {
	const ok = async () => ({ ok: true as const, data: {} });
	const withOwner = (over: Partial<Fake> = {}) => fake({ assignees: async () => ({ ok: true, data: ["hal", "luka"] }), assign: ok, ...over });
	const sel = (key: string) => q(`work-assignee-${key}`) as HTMLSelectElement;
	const deferred = <T,>() => {
		let resolve!: (v: T) => void;
		const promise = new Promise<T>((r) => (resolve = r));
		return { promise, resolve };
	};
	const TREE = [
		item("f1", "feature", { assignee: "hal", title: "F1" }),
		item("t1", "task", { partOf: "f1", assignee: "hal" }),
		item("lt", "task", { assignee: "luka" }),
	];
	const openTree = async (c: Fake) => {
		await open(c);
		await click(q("work-toggle-no-initiative")!);
		await click(q("work-toggle-f1")!);
	};

	it("sits on features and loose tasks; a feature's child tasks show their assignee as text", async () => {
		await openTree(withOwner({ items: TREE }));
		assert.equal(sel("f1").value, "hal");
		assert.equal(sel("lt").value, "luka");
		assert.equal(q("work-assignee-t1"), null);
		assert.equal(q("work-assignee-text-t1")!.textContent, "hal");
	});
	it("a refused change shows the hub's message on that row and leaves the old assignee", async () => {
		await openTree(withOwner({ items: TREE, assign: async () => ({ ok: false, reason: "error", message: 'unknown assignee "zed"' }) }));
		await change(sel("f1"), { value: "luka" });
		await settle();
		assert.equal(q("work-assignee-error-f1")!.textContent, 'unknown assignee "zed"');
		assert.equal(q("work-assignee-error-lt"), null);
		assert.equal(sel("f1").value, "hal");
		assert.equal(sel("f1").disabled, false);
	});
	it("after a successful change the reloaded list shows the new assignee on the feature and on its child tasks", async () => {
		const c = withOwner({ items: TREE });
		c.assign = async (id, wolf) => {
			c.items = [item(id, "feature", { assignee: wolf, title: "F1" }), item("t1", "task", { partOf: id, assignee: wolf }), TREE[2]!];
			return { ok: true, data: {} };
		};
		await openTree(c);
		await change(sel("f1"), { value: "luka" });
		await settle();
		assert.equal(sel("f1").value, "luka");
		assert.equal(q("work-assignee-text-t1")!.textContent, "luka");
	});
	it("disables only the row being changed, and one row finishing neither re-enables the other nor clears its error", async () => {
		const a = deferred<{ ok: false; reason: "error"; message: string }>();
		const b = deferred<{ ok: true; data: object }>();
		const c = withOwner({ items: TREE, assign: (id) => (id === "f1" ? a.promise : b.promise) });
		await openTree(c);
		await change(sel("f1"), { value: "luka" });
		await change(sel("lt"), { value: "hal" });
		assert.deepEqual([sel("f1").disabled, sel("lt").disabled], [true, true]);
		await act(async () => a.resolve({ ok: false, reason: "error", message: "f1 refused" }));
		assert.deepEqual([sel("f1").disabled, sel("lt").disabled], [false, true]);
		assert.equal(q("work-assignee-error-f1")!.textContent, "f1 refused");
		await act(async () => b.resolve({ ok: true, data: {} }));
		await settle();
		assert.equal(sel("lt").disabled, false);
		assert.equal(q("work-assignee-error-f1")!.textContent, "f1 refused", "row B's success leaves row A's error");
	});
	it("a row's error clears on its next successful change", async () => {
		let fail = true;
		const c = withOwner({ items: TREE, assign: async () => (fail ? { ok: false, reason: "error", message: "nope" } : { ok: true, data: {} }) });
		await openTree(c);
		await change(sel("f1"), { value: "luka" });
		await settle();
		assert.equal(q("work-assignee-error-f1")!.textContent, "nope");
		fail = false;
		await change(sel("f1"), { value: "luka" });
		await settle();
		assert.equal(q("work-assignee-error-f1"), null);
	});
	it("a thrown assign shows an error and re-enables the select", async () => {
		await openTree(withOwner({ items: TREE, assign: async () => { throw new Error("boom"); } }));
		await change(sel("f1"), { value: "luka" });
		await settle();
		assert.equal(q("work-assignee-error-f1")!.textContent, "boom");
		assert.equal(sel("f1").disabled, false);
	});
	it("says so when the change worked but the list could not be read again", async () => {
		const c = withOwner({ items: TREE });
		c.assign = async () => {
			c.list = async () => ({ ok: false, reason: "error", message: "down" });
			return { ok: true, data: {} };
		};
		await openTree(c);
		await change(sel("f1"), { value: "luka" });
		await settle();
		assert.equal(q("work-assignee-error-f1")!.textContent, "assigned, but the list couldn't refresh");
	});
	it("shows an error in the row instead of a dropdown when the wolves cannot be loaded", async () => {
		await openTree(withOwner({ items: TREE, assignees: async () => ({ ok: false, reason: "error", message: "HTTP 502" }) }));
		assert.equal(q("work-assignee-f1"), null);
		assert.match(q("work-assignee-error-f1")!.textContent ?? "", /HTTP 502/);
	});
});
