/**
 * Graduating from the app: the pure readiness / wolf-choice rules, the Graduate button in the Work list and in the graph
 * pane (shown on features, disabled with the reason until ready), and the preview modal (entries as markdown, the
 * folded count, the warnings; Confirm calls the route and refreshes; Cancel does nothing; the wolf picker when the
 * assignee is offline). Node test runner, linkedom, injected fakes: nothing here can reach a real wolf.
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
	window: Object.assign(dom.window, { innerWidth: 1600 }),
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	HTMLInputElement: dom.window.HTMLInputElement,
	KeyboardEvent: dom.window.KeyboardEvent,
	CustomEvent: dom.window.CustomEvent,
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

const { WorkViewProvider } = await import("../components/work-view.tsx");
const { WorkButton } = await import("../components/work-view-entry.tsx");
const { GraphPane, clearPaneCache } = await import("../components/graph-pane.tsx");
const { GraduateDialog } = await import("../components/graduate-dialog.tsx");
const { featureGraduateState, graduationWolf } = await import("../src/core/graduate.ts");
const { buildWorkTable } = await import("../src/core/work-table.ts");
const { describeNode } = await import("../src/core/kb-graph-model.ts");
import type { GraduateClient } from "../components/graduate-client.ts";
import type { KbResult } from "../components/kb-client.ts";
import type { WorkClient } from "../components/work-client.ts";
import type { GraduationPreview, GraduationResult, KbGraph, WorkListItem } from "../src/core/kb.ts";
import type { NodeCard } from "../src/core/kb-graph-model.ts";

// ---- pure -----------------------------------------------------------------------

describe("featureGraduateState", () => {
	const f = { kind: "feature", stage: "shipped" };
	it("is ready when it has tasks and all are complete", () => {
		assert.deepEqual(featureGraduateState(f, [{ stage: "shipped" }, { stage: "live" }]), { show: true, ready: true, reason: "" });
	});
	it("counts the open tasks as the reason", () => {
		assert.deepEqual(featureGraduateState({ kind: "feature", stage: "in_build" }, [{ stage: "shipped" }, { stage: "plan" }, { stage: "in_build" }]), { show: true, ready: false, reason: "2 tasks open" });
		assert.equal(featureGraduateState(f, [{ stage: "plan" }]).reason, "1 task open");
	});
	it("a feature without tasks is not ready", () => {
		assert.deepEqual(featureGraduateState(f, []), { show: true, ready: false, reason: "no tasks yet" });
	});
	it("without the tasks, shipped counts as ready and anything else is not shipped yet", () => {
		assert.equal(featureGraduateState(f, null).ready, true);
		assert.deepEqual(featureGraduateState({ kind: "feature", stage: "plan" }, null), { show: true, ready: false, reason: "not shipped yet" });
	});
	it("only live, non-container features carry a button", () => {
		for (const it of [{ kind: "task", stage: "shipped" }, { kind: "initiative", stage: "plan" }, { kind: "feature", stage: "archived" }, { kind: "feature", stage: "shipped", graduated: true }, { kind: "feature", stage: "shipped", container: true }]) {
			assert.equal(featureGraduateState(it, [{ stage: "shipped" }]).show, false, JSON.stringify(it));
		}
	});
});

describe("graduationWolf", () => {
	const wolves = [{ name: "hal", status: "online" }, { name: "lib", status: "online" }, { name: "forge", status: "offline" }];
	it("the assignee runs it when it is an online wolf", () => {
		assert.deepEqual(graduationWolf("hal", wolves), { kind: "assignee", wolf: "hal" });
	});
	it("an offline assignee, a person or nobody means the owner picks among the online wolves", () => {
		for (const a of ["forge", "1uk4", undefined]) assert.deepEqual(graduationWolf(a, wolves), { kind: "pick", online: ["hal", "lib"] });
		assert.deepEqual(graduationWolf("hal", []), { kind: "pick", online: [] });
	});
});

describe("work table rows", () => {
	const wi = (id: string, kind: string, over: Partial<WorkListItem> = {}): WorkListItem => ({ id, title: id, kind, stage: "plan", domain: "d", dependsOn: [], ...over });
	it("judges readiness on all the tasks, even when a search prunes some", () => {
		const items = [wi("f", "feature", { stage: "in_build" }), wi("a", "task", { partOf: "f", stage: "shipped" }), wi("b", "task", { partOf: "f", stage: "plan", title: "zebra" })];
		const t = buildWorkTable(items, { query: "a" });
		const row = t.groups[0]!.children[0]!;
		assert.deepEqual(row.graduate, { show: true, ready: false, reason: "1 task open" });
	});
});

// ---- fixtures ----------------------------------------------------------------------

const item = (id: string, kind: string, over: Partial<WorkListItem> = {}): WorkListItem => ({ id, title: id.toUpperCase(), kind, stage: "plan", domain: "wolfpack", dependsOn: [], ...over });
// Loose features (the Inbox group): READY has all tasks shipped, BUSY has 2 open, OFF is ready but assigned to an offline wolf.
const ITEMS: WorkListItem[] = [
	item("ready", "feature", { stage: "shipped", assignee: "hal", title: "Ready feature" }),
	item("r1", "task", { partOf: "ready", stage: "shipped" }),
	item("r2", "task", { partOf: "ready", stage: "shipped" }),
	item("busy", "feature", { stage: "in_build", assignee: "hal", title: "Busy feature" }),
	item("b1", "task", { partOf: "busy", stage: "shipped" }),
	item("b2", "task", { partOf: "busy", stage: "in_build" }),
	item("b3", "task", { partOf: "busy", stage: "plan" }),
	item("off", "feature", { stage: "shipped", assignee: "forge", title: "Offline owner" }),
	item("o1", "task", { partOf: "off", stage: "shipped" }),
];
const WOLVES = [{ name: "hal", status: "online" }, { name: "lib", status: "online" }, { name: "forge", status: "offline" }];

const PREVIEW: GraduationPreview = {
	itemId: "ready",
	kind: "feature",
	title: "Ready feature",
	domain: "wolfpack",
	contributions: [
		{ id: "ready", title: "How caching works", summary: "Lookups are cached.", body: "## How\n\nCached for **five minutes**.", initiative: false, history: [] },
		{ id: "ready~two", title: "Second entry", summary: "More.", body: "Another body.", initiative: false, history: [] },
	],
	foldedObservations: 3,
	warnings: ["Totals value 42 not carried over", "a secret was redacted"],
	archive: [{ id: "ready", title: "Ready feature" }, { id: "r1", title: "R1" }, { id: "r2", title: "R2" }],
	token: "abcdef012345",
	createdAt: "2026-10-28T12:00:00.000Z",
	readiness: { ready: true },
};
const RESULT: GraduationResult = { graduated: true, entries: ["ready", "ready~two"], archived: ["ready", "r1", "r2"], lateFolded: 0, unbound: 1, closedThreads: [] };

interface FakeGraduate extends GraduateClient {
	previews: { wolf: string; id: string }[];
	confirms: { wolf: string; id: string; token: string }[];
	previewResult: KbResult<GraduationPreview>;
	confirmResult: KbResult<GraduationResult>;
}
const fakeGraduate = (over: Partial<FakeGraduate> = {}): FakeGraduate => {
	const g: FakeGraduate = {
		previews: [],
		confirms: [],
		previewResult: { ok: true, data: PREVIEW },
		confirmResult: { ok: true, data: RESULT },
		wolves: async () => WOLVES,
		preview: async (wolf, id) => (g.previews.push({ wolf, id }), g.previewResult),
		confirm: async (wolf, id, token) => (g.confirms.push({ wolf, id, token }), g.confirmResult),
		...over,
	};
	return g;
};
const fakeWork = (): WorkClient & { lists: number } => {
	const w = {
		lists: 0,
		domains: async () => [{ name: "wolfpack", label: "Wolfpack" }],
		list: async () => (w.lists++, { ok: true as const, data: { items: ITEMS } }),
	};
	return w;
};

// ---- harness -------------------------------------------------------------------------

let root: Root | null = null;
beforeEach(() => {
	store.clear();
	clearPaneCache();
});
afterEach(() => {
	act(() => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 15)); });
const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const qa = (sel: string) => [...document.querySelectorAll(sel)] as HTMLElement[];
const click = (el: Element) => act(async () => { el.dispatchEvent(Object.assign(new dom.window.Event("click", { bubbles: true, cancelable: true }), { detail: 1 })); });
const change = (el: HTMLElement, props: object) =>
	act(async () => {
		const key = Object.keys(el).find((k) => k.startsWith("__reactProps"))!;
		(el as unknown as Record<string, { onChange(e: unknown): void }>)[key]!.onChange({ target: props });
	});
const mountEl = async (el: React.ReactElement) => {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => root!.render(el));
};
const openList = async (graduate: GraduateClient, work = fakeWork()) => {
	await mountEl(
		<WorkViewProvider client={work} graduate={graduate}>
			<WorkButton />
		</WorkViewProvider>,
	);
	await click(q("work-open")!);
	await settle();
	await click(q("work-toggle-no-initiative")!); // open the Inbox group
	return work;
};

// ---- Work list ------------------------------------------------------------------------

describe("Work list: the Graduate button", () => {
	it("is enabled on a ready feature and disabled, with the reason, on one with open tasks", async () => {
		await openList(fakeGraduate());
		const ready = q("work-graduate-ready") as HTMLButtonElement;
		assert.ok(ready);
		assert.equal(ready.disabled, false);
		const busy = q("work-graduate-busy") as HTMLButtonElement;
		assert.equal(busy.disabled, true);
		assert.equal(busy.getAttribute("data-reason"), "2 tasks open");
		assert.match(busy.getAttribute("title") ?? "", /2 tasks open/);
	});
	it("tasks and groups carry no button", async () => {
		await openList(fakeGraduate());
		assert.deepEqual(qa('[data-testid^="work-graduate-"]').map((b) => b.getAttribute("data-testid")).sort(), ["work-graduate-busy", "work-graduate-off", "work-graduate-ready"]);
	});
	it("clicking a disabled button opens nothing", async () => {
		const g = fakeGraduate();
		await openList(g);
		await click(q("work-graduate-busy")!);
		assert.equal(q("graduate-dialog"), null);
		assert.equal(g.previews.length, 0);
	});
	it("the click does not also select the row", async () => {
		const g = fakeGraduate();
		await openList(g);
		await click(q("work-graduate-ready")!);
		assert.ok(q("graduate-dialog"));
		assert.equal(q("work-view")!.getAttribute("data-split"), null);
	});
});

describe("graduate flow from the Work list", () => {
	it("the assignee wolf (online) previews at once; the modal shows the entries, the folded count and the warnings", async () => {
		const g = fakeGraduate();
		await openList(g);
		await click(q("work-graduate-ready")!);
		await settle();
		assert.deepEqual(g.previews, [{ wolf: "hal", id: "ready" }]);
		assert.equal(q("graduate-dialog")!.getAttribute("data-step"), "preview");
		const entries = qa('[data-testid="graduate-entry"]');
		assert.equal(entries.length, 2);
		assert.equal(entries[0]!.querySelector("[data-entry-title]")!.textContent, "How caching works");
		assert.equal(entries[0]!.querySelector("[data-entry-summary]")!.textContent, "Lookups are cached.");
		// the body is markdown: the heading and the bold text are elements, not literal markup
		const body = entries[0]!.querySelector("[data-entry-body]")!;
		assert.ok(body.textContent!.includes("Cached for five minutes"));
		assert.ok(!body.textContent!.includes("**"));
		assert.match(q("graduate-folded")!.textContent!, /3 pending observations folded/);
		assert.equal(qa("[data-warning]").length, 2);
		assert.ok(q("graduate-warnings")!.textContent!.includes("a secret was redacted"));
		assert.ok(q("graduate-archive")!.textContent!.includes("3 work items"));
		assert.equal(g.confirms.length, 0, "a preview sends nothing");
	});
	it("Confirm calls the route with the token, closes the modal and refreshes the list", async () => {
		const g = fakeGraduate();
		const work = await openList(g);
		await click(q("work-graduate-ready")!);
		await settle();
		const before = work.lists;
		await click(q("graduate-confirm")!);
		await settle();
		assert.deepEqual(g.confirms, [{ wolf: "hal", id: "ready", token: "abcdef012345" }]);
		assert.equal(q("graduate-dialog"), null);
		assert.ok(work.lists > before, "the list was fetched again");
	});
	it("Cancel closes the modal and does nothing", async () => {
		const g = fakeGraduate();
		const work = await openList(g);
		await click(q("work-graduate-ready")!);
		await settle();
		const before = work.lists;
		await click(q("graduate-cancel")!);
		assert.equal(q("graduate-dialog"), null);
		assert.equal(g.confirms.length, 0);
		assert.equal(work.lists, before);
	});
	it("an offline assignee: the modal first asks which online wolf to use", async () => {
		const g = fakeGraduate();
		await openList(g);
		await click(q("work-graduate-off")!);
		await settle();
		assert.equal(q("graduate-dialog")!.getAttribute("data-step"), "pick");
		assert.equal(g.previews.length, 0, "nothing runs before the owner picks");
		assert.deepEqual(qa('[data-testid="graduate-wolf"] option').map((o) => o.textContent), ["hal", "lib"]);
		await change(q("graduate-wolf")!, { value: "lib" });
		await click(q("graduate-pick-go")!);
		await settle();
		assert.deepEqual(g.previews, [{ wolf: "lib", id: "off" }]);
		assert.equal(q("graduate-dialog")!.getAttribute("data-step"), "preview");
		await click(q("graduate-confirm")!);
		await settle();
		assert.deepEqual(g.confirms.map((c) => c.wolf), ["lib"]);
	});
	it("no wolf online: says so and offers nothing to run", async () => {
		await openList(fakeGraduate({ wolves: async () => [{ name: "hal", status: "offline" }] }));
		await click(q("work-graduate-ready")!);
		await settle();
		assert.ok(q("graduate-no-wolf"));
		assert.equal(q("graduate-pick-go") === null, true);
	});
	it("a blocked preview cannot be confirmed", async () => {
		const g = fakeGraduate({ previewResult: { ok: true, data: { ...PREVIEW, blocked: "History line missing" } } });
		await openList(g);
		await click(q("work-graduate-ready")!);
		await settle();
		assert.match(q("graduate-blocked")!.textContent!, /History line missing/);
		assert.equal((q("graduate-confirm") as HTMLButtonElement).disabled, true);
	});
	it("a refused preview shows the reason and retries", async () => {
		const g = fakeGraduate({ previewResult: { ok: false, reason: "unavailable", message: "Ready feature is not ready to graduate: 1 task open", code: "not_ready" } });
		await openList(g);
		await click(q("work-graduate-ready")!);
		await settle();
		assert.match(q("graduate-error")!.textContent!, /1 task open/);
		g.previewResult = { ok: true, data: PREVIEW };
		await click(q("graduate-retry")!);
		await settle();
		assert.equal(g.previews.length, 2);
		assert.equal(q("graduate-dialog")!.getAttribute("data-step"), "preview");
	});
	it("a stale preview at confirm offers a fresh one, and nothing closes", async () => {
		const g = fakeGraduate({ confirmResult: { ok: false, reason: "unavailable", message: "That preview is too old.", code: "preview_stale" } });
		const work = await openList(g);
		await click(q("work-graduate-ready")!);
		await settle();
		const before = work.lists;
		await click(q("graduate-confirm")!);
		await settle();
		assert.equal(q("graduate-error")!.getAttribute("data-code"), "preview_stale");
		assert.equal(q("graduate-retry")!.textContent, "Preview again");
		assert.equal(work.lists, before, "a failed graduation refreshes nothing");
		await click(q("graduate-retry")!);
		await settle();
		assert.equal(g.previews.length, 2);
	});
});

// ---- Graph pane -------------------------------------------------------------------------

const w = (id: string, workKind: string, stage: string, label = id) => ({ id: `work:${id}`, kind: "work" as const, label, depth: 3, domain: "d", workKind, stage, assignee: "hal", updated: "2026-10-27" });
const graph: KbGraph = {
	nodes: [{ id: "dom:d", kind: "domain", label: "D", depth: 0, domain: "d" }, { id: "fac:d", kind: "factory", label: "Factory", depth: 1, domain: "d" }, w("RDY", "feature", "shipped", "Ready one"), w("OPN", "feature", "in_build", "Open one"), w("tk", "task", "shipped")],
	edges: [],
	layers: { archivedWork: false, denTopics: false },
	domain: null,
	domains: [{ name: "d", label: "D" }],
	generated: "2026-10-28T00:00:00.000Z",
};
const records: Record<string, unknown> = {
	RDY: { id: "RDY", title: "Ready one", kind: "feature", stage: "shipped", domain: "d", plan: "# R", record: "", children: [{ id: "a", title: "A", kind: "task", stage: "shipped", dependsOn: [] }, { id: "b", title: "B", kind: "task", stage: "shipped", dependsOn: [] }] },
	OPN: { id: "OPN", title: "Open one", kind: "feature", stage: "in_build", domain: "d", plan: "# O", record: "", children: [{ id: "a", title: "A", kind: "task", stage: "shipped", dependsOn: [] }, { id: "b", title: "B", kind: "task", stage: "plan", dependsOn: [] }, { id: "c", title: "C", kind: "task", stage: "plan", dependsOn: [] }] },
	tk: { id: "tk", title: "tk", kind: "task", stage: "shipped", domain: "d", plan: "# T", record: "" },
};
const json = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body });
globalThis.fetch = (async (url: string) => {
	if (url === "/api/wolves") return json(200, { wolves: [{ id: "1", name: "lib", host: "h", status: "online", librarian: true }, { id: "2", name: "hal", host: "h", status: "online" }] });
	const rec = /\/work\/([^/]+)\/record$/.exec(url);
	if (rec) return records[rec[1]!] ? json(200, records[rec[1]!]) : json(404, { error: "nope" });
	return json(404, { error: "unmocked " + url });
}) as typeof fetch;

const mountPane = async (target: string, g: GraduateClient) => {
	const card = describeNode(graph, `work:${target}`) as NodeCard;
	await mountEl(<GraphPane card={card} onClose={() => {}} onFocus={() => {}} onSelectNode={() => {}} onNavigate={() => {}} graduate={g} />);
	await settle();
};

describe("graph pane: the Graduate button", () => {
	it("a ready feature has an enabled button that opens the modal on the assignee wolf", async () => {
		const g = fakeGraduate();
		await mountPane("RDY", g);
		const btn = q("pane-graduate") as HTMLButtonElement;
		assert.equal(btn.disabled, false);
		await click(btn);
		await settle();
		assert.deepEqual(g.previews, [{ wolf: "hal", id: "RDY" }]);
		assert.equal(qa('[data-testid="graduate-entry"]').length, 2);
		await click(q("graduate-confirm")!);
		await settle();
		assert.deepEqual(g.confirms, [{ wolf: "hal", id: "RDY", token: "abcdef012345" }]);
		assert.equal(q("graduate-dialog"), null);
	});
	it("a feature with open tasks is disabled and says why", async () => {
		const g = fakeGraduate();
		await mountPane("OPN", g);
		const btn = q("pane-graduate") as HTMLButtonElement;
		assert.equal(btn.disabled, true);
		assert.equal(q("pane-graduate-reason")!.textContent, "2 tasks open");
		await click(btn);
		assert.equal(q("graduate-dialog"), null);
	});
	it("a task has no Graduate button", async () => {
		await mountPane("tk", fakeGraduate());
		assert.equal(q("pane-graduate"), null);
	});
	it("Cancel leaves the pane as it was and sends nothing", async () => {
		const g = fakeGraduate();
		await mountPane("RDY", g);
		await click(q("pane-graduate")!);
		await settle();
		await click(q("graduate-cancel")!);
		assert.equal(q("graduate-dialog"), null);
		assert.equal(g.confirms.length, 0);
		assert.ok(q("pane-graduate"));
	});
});

describe("GraduateDialog on its own", () => {
	it("the modal is a dialog and Esc closes it unless it is sending", async () => {
		const g = fakeGraduate();
		let closed = 0;
		await mountEl(<GraduateDialog target={{ id: "ready", title: "Ready feature", assignee: "hal" }} client={g} onClose={() => void closed++} />);
		await settle();
		assert.equal(q("graduate-dialog")!.getAttribute("role"), "dialog");
		await act(async () => {
			const ev = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
			Object.defineProperty(ev, "key", { value: "Escape" });
			document.dispatchEvent(ev);
		});
		assert.equal(closed, 1);
		assert.equal(g.confirms.length, 0);
	});
});
