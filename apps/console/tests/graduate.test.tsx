/**
 * Graduating from the app, as background jobs: the pure readiness / wolf-choice rules, and the flow in the Work list and in
 * the graph pane: Graduate → confirmation step (wolf, observation count) → loader while the preview job runs → Review →
 * modal (entries, folded count, warnings) → Confirm → loader while the confirm job runs → refresh and a toast. The state
 * lives in a store shared by both places and survives closing the Work view. Node test runner, linkedom, injected fakes: nothing here can reach a real wolf.
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
const { GraduateStartDialog } = await import("../components/graduate-dialog.tsx");
const { graduateStore } = await import("../components/graduate-store.ts");
const { featureGraduateState, graduationWolf } = await import("../src/core/graduate.ts");
const { buildWorkTable } = await import("../src/core/work-table.ts");
const { describeNode } = await import("../src/core/kb-graph-model.ts");
import type { GraduateClient } from "../components/graduate-client.ts";
import type { KbResult } from "../components/kb-client.ts";
import type { WorkClient } from "../components/work-client.ts";
import type { GraduationObservations, GraduationPreview, GraduationResult, GraduationStatus, KbGraph, WorkListItem } from "../src/core/kb.ts";
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

const OBS: GraduationObservations = { total: 5, byWork: [{ id: "r1", title: "R1", count: 3 }, { id: "r2", title: "R2", count: 2 }] };
const job = (kind: "preview" | "confirm") => ({ jobId: `j-${kind}`, kind, state: "running" as const, startedAt: "2026-10-28T12:00:00.000Z" });

/** A wolf that runs jobs in the background: a start answers at once, the status says running for `runningPolls` reads, then the outcome. */
interface FakeGraduate extends GraduateClient {
	starts: { kind: "preview" | "confirm"; wolf: string; id: string; token?: string }[];
	statusCalls: number;
	runningPolls: number;
	/** What the first status read says before any start (a job the wolf already holds). */
	initial: GraduationStatus;
	observationsResult: KbResult<GraduationObservations>;
	startPreviewResult: KbResult<ReturnType<typeof job>> | null;
	previewOutcome: GraduationStatus;
	confirmOutcome: GraduationStatus;
}
const fakeGraduate = (over: Partial<FakeGraduate> = {}): FakeGraduate => {
	const running = new Map<string, { kind: "preview" | "confirm"; polls: number }>();
	const g: FakeGraduate = {
		starts: [],
		statusCalls: 0,
		runningPolls: 1,
		initial: { state: "none" },
		observationsResult: { ok: true, data: OBS },
		startPreviewResult: null,
		previewOutcome: { state: "preview_ready", preview: PREVIEW },
		confirmOutcome: { state: "graduated", jobId: "j-confirm", result: RESULT },
		wolves: async () => WOLVES,
		startPreview: async (wolf, id) => {
			g.starts.push({ kind: "preview", wolf, id });
			if (g.startPreviewResult) return g.startPreviewResult;
			running.set(id, { kind: "preview", polls: 0 });
			return { ok: true, data: job("preview") };
		},
		startConfirm: async (wolf, id, token) => {
			g.starts.push({ kind: "confirm", wolf, id, token });
			running.set(id, { kind: "confirm", polls: 0 });
			return { ok: true, data: job("confirm") };
		},
		status: async (_wolf, id) => {
			g.statusCalls++;
			const j = running.get(id);
			if (!j) return { ok: true, data: g.initial };
			if (j.polls++ < g.runningPolls) return { ok: true, data: { state: "running", jobId: `j-${j.kind}`, kind: j.kind, startedAt: "2026-10-28T12:00:00.000Z" } };
			return { ok: true, data: j.kind === "preview" ? g.previewOutcome : g.confirmOutcome };
		},
		observations: async () => g.observationsResult,
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
	graduateStore.reset();
	graduateStore.pollMs = 5;
});
afterEach(() => {
	act(() => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 15)); });
/** Wait (inside act) until the DOM says so. */
const until = async (what: string, cond: () => boolean) => {
	for (let i = 0; i < 200; i++) {
		if (cond()) return;
		await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
	}
	assert.fail(`timed out waiting for ${what}`);
};
const phase = (id: string) => q(id)?.getAttribute("data-phase") ?? null;
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
		assert.equal(g.starts.length, 0);
	});
	it("the click opens the confirmation step and does not also select the row", async () => {
		await openList(fakeGraduate());
		await click(q("work-graduate-ready")!);
		assert.ok(q("graduate-dialog"));
		assert.equal(q("work-view")!.getAttribute("data-split"), null);
	});
});

describe("graduate flow from the Work list", () => {
	it("the confirmation step names the wolf and how many observations from how many tasks will be folded, and starts nothing yet", async () => {
		const g = fakeGraduate();
		await openList(g);
		await click(q("work-graduate-ready")!);
		await settle();
		const dlg = q("graduate-dialog")!;
		assert.equal(dlg.getAttribute("data-step"), "confirm");
		assert.match(q("graduate-summary")!.textContent!, /Graduate “Ready feature” on hal/);
		assert.match(q("graduate-count")!.textContent!, /5 observations from 2 tasks will be folded into the contributions sent to the librarian’s inbox/);
		assert.deepEqual(qa("[data-work]").map((li) => li.textContent), ["R1: 3 observations", "R2: 2 observations"]);
		assert.doesNotMatch(dlg.textContent!, /written to the (KB|knowledge base)/i);
		assert.equal(g.starts.length, 0, "nothing runs before Graduate is clicked");
		await click(q("graduate-cancel")!);
		assert.equal(q("graduate-dialog"), null);
		assert.equal(g.starts.length, 0);
	});
	it("no pending observations: says so", async () => {
		await openList(fakeGraduate({ observationsResult: { ok: true, data: { total: 0, byWork: [] } } }));
		await click(q("work-graduate-ready")!);
		await settle();
		assert.match(q("graduate-count")!.textContent!, /no pending observations to fold/);
	});
	it("a count that cannot be read does not stop the graduation", async () => {
		const g = fakeGraduate({ observationsResult: { ok: false, reason: "error", message: "boom" } });
		await openList(g);
		await click(q("work-graduate-ready")!);
		await settle();
		assert.match(q("graduate-summary")!.textContent!, /could not be counted/);
		await click(q("graduate-go")!);
		await settle();
		assert.deepEqual(g.starts, [{ kind: "preview", wolf: "hal", id: "ready" }]);
	});
	it("Graduate closes the step and puts a loader over the button while the preview job runs; the rest of the list stays usable", async () => {
		const g = fakeGraduate({ runningPolls: 1000 });
		await openList(g);
		await click(q("work-graduate-ready")!);
		await settle();
		await click(q("graduate-go")!);
		await settle();
		assert.equal(q("graduate-dialog"), null, "the step is closed: the job does not block the UI");
		assert.deepEqual(g.starts, [{ kind: "preview", wolf: "hal", id: "ready" }]);
		assert.equal(phase("work-graduate-ready"), "previewing");
		assert.ok(q("work-graduate-ready-loader"));
		assert.equal((q("work-graduate-ready") as HTMLButtonElement).disabled, true);
		// another row still works while it runs
		await click(q("work-graduate-off")!);
		await settle();
		assert.ok(q("graduate-dialog"), "a second feature opens its own step");
		assert.ok(g.statusCalls > 1, "the status is polled");
	});
	it("the button becomes Review; the modal shows the entries, the folded count and the warnings; nothing is sent until Confirm", async () => {
		const g = fakeGraduate();
		await openList(g);
		await click(q("work-graduate-ready")!);
		await settle();
		await click(q("graduate-go")!);
		await until("Review", () => phase("work-graduate-ready") === "ready");
		assert.equal(q("work-graduate-ready")!.textContent, "Review");
		assert.equal(g.starts.filter((s) => s.kind === "confirm").length, 0);
		await click(q("work-graduate-ready")!);
		assert.equal(q("graduate-dialog")!.getAttribute("data-step"), "review");
		const entries = qa('[data-testid="graduate-entry"]');
		assert.equal(entries.length, 2);
		assert.equal(entries[0]!.querySelector("[data-entry-title]")!.textContent, "How caching works");
		assert.equal(entries[0]!.querySelector("[data-entry-summary]")!.textContent, "Lookups are cached.");
		// the body is markdown: the bold text is an element, not literal markup
		const body = entries[0]!.querySelector("[data-entry-body]")!;
		assert.ok(body.textContent!.includes("Cached for five minutes"));
		assert.ok(!body.textContent!.includes("**"));
		assert.match(q("graduate-folded")!.textContent!, /3 pending observations folded/);
		assert.equal(qa("[data-warning]").length, 2);
		assert.ok(q("graduate-warnings")!.textContent!.includes("a secret was redacted"));
		assert.ok(q("graduate-archive")!.textContent!.includes("3 work items"));
		// the copy says what Confirm does: a contribution to the librarian's inbox, not a write to the KB
		assert.match(q("graduate-body")!.textContent!, /2 proposed entries to the librarian’s inbox/);
		assert.match(q("graduate-confirm")!.textContent!, /librarian/);
		assert.doesNotMatch(q("graduate-dialog")!.textContent!, /written to the (KB|knowledge base)|will write/i);
	});
	it("Cancel on the Review modal keeps Review on the button and sends nothing", async () => {
		const g = fakeGraduate();
		await openList(g);
		await click(q("work-graduate-ready")!);
		await settle();
		await click(q("graduate-go")!);
		await until("Review", () => phase("work-graduate-ready") === "ready");
		await click(q("work-graduate-ready")!);
		await click(q("graduate-cancel")!);
		assert.equal(q("graduate-dialog"), null);
		assert.equal(phase("work-graduate-ready"), "ready");
		assert.equal(g.starts.filter((s) => s.kind === "confirm").length, 0);
	});
	it("Confirm starts the confirm job with the token, shows the loader again, then refreshes the list and says what was sent", async () => {
		const g = fakeGraduate({ runningPolls: 3 });
		const work = await openList(g);
		await click(q("work-graduate-ready")!);
		await settle();
		await click(q("graduate-go")!);
		await until("Review", () => phase("work-graduate-ready") === "ready");
		await click(q("work-graduate-ready")!);
		const before = work.lists;
		await click(q("graduate-confirm")!);
		assert.equal(q("graduate-dialog"), null, "the modal closes at once");
		assert.deepEqual(g.starts.at(-1), { kind: "confirm", wolf: "hal", id: "ready", token: "abcdef012345" });
		assert.equal(phase("work-graduate-ready"), "graduating");
		assert.ok(q("work-graduate-ready-loader"));
		await until("the toast", () => q("graduate-done") !== null);
		assert.ok(work.lists > before, "the list was fetched again");
		assert.match(q("graduate-done")!.textContent!, /2 contributions sent to the librarian/);
		assert.match(q("graduate-done")!.textContent!, /after the librarian’s next sweep/);
		assert.equal(graduateStore.get("ready"), undefined);
		await click(q("graduate-done-dismiss")!);
		assert.equal(q("graduate-done"), null);
	});
	it("the state survives closing and reopening the Work view", async () => {
		const g = fakeGraduate({ runningPolls: 1000 });
		const work = fakeWork();
		await openList(g, work);
		await click(q("work-graduate-ready")!);
		await settle();
		await click(q("graduate-go")!);
		await settle();
		await click(q("work-close")!);
		assert.equal(q("work-view"), null);
		g.runningPolls = 0; // the wolf finishes while the view is closed
		await until("the job to finish", () => graduateStore.get("ready")?.phase === "ready");
		await click(q("work-open")!);
		await settle();
		await click(q("work-toggle-no-initiative")!);
		assert.equal(phase("work-graduate-ready"), "ready", "reopened: Review, no new preview");
		assert.equal(g.starts.filter((s) => s.kind === "preview").length, 1);
	});
	it("a preview the wolf already holds shows as Review without a click, and a running one as the loader", async () => {
		const g = fakeGraduate({ initial: { state: "preview_ready", preview: PREVIEW } });
		await openList(g);
		await until("Review", () => phase("work-graduate-ready") === "ready");
		assert.equal(g.starts.length, 0);
		graduateStore.reset();
		const g2 = fakeGraduate({ initial: { state: "running", jobId: "j", kind: "confirm", startedAt: "2026-10-28T12:00:00.000Z" } });
		await act(async () => root!.unmount());
		root = null;
		document.body.innerHTML = "";
		await openList(g2);
		await until("the loader", () => phase("work-graduate-ready") === "graduating");
	});
	it("an offline assignee: the step asks which online wolf, and counts that wolf's pool", async () => {
		const asked: string[] = [];
		const g = fakeGraduate({ observations: async (wolf) => (asked.push(wolf), { ok: true, data: wolf === "lib" ? { total: 1, byWork: [{ id: "o1", title: "O1", count: 1 }] } : OBS }) });
		await openList(g);
		await click(q("work-graduate-off")!);
		await settle();
		assert.equal(q("graduate-dialog")!.getAttribute("data-step"), "pick");
		assert.equal(g.starts.length, 0, "nothing runs before the owner picks");
		assert.deepEqual(qa('[data-testid="graduate-wolf"] option').map((o) => o.textContent), ["hal", "lib"]);
		await change(q("graduate-wolf")!, { value: "lib" });
		await settle();
		assert.deepEqual(asked, ["hal", "lib"]);
		assert.match(q("graduate-count")!.textContent!, /1 observation from 1 task will be folded/);
		await click(q("graduate-go")!);
		await settle();
		assert.deepEqual(g.starts, [{ kind: "preview", wolf: "lib", id: "off" }]);
	});
	it("no wolf online: says so and offers nothing to run", async () => {
		await openList(fakeGraduate({ wolves: async () => [{ name: "hal", status: "offline" }] }));
		await click(q("work-graduate-ready")!);
		await settle();
		assert.ok(q("graduate-no-wolf"));
		assert.equal((q("graduate-go") as HTMLButtonElement).disabled, true);
	});
	it("a blocked preview cannot be confirmed", async () => {
		const g = fakeGraduate({ previewOutcome: { state: "preview_ready", preview: { ...PREVIEW, blocked: "History line missing" } } });
		await openList(g);
		await click(q("work-graduate-ready")!);
		await settle();
		await click(q("graduate-go")!);
		await until("Review", () => phase("work-graduate-ready") === "ready");
		await click(q("work-graduate-ready")!);
		assert.match(q("graduate-blocked")!.textContent!, /History line missing/);
		assert.equal((q("graduate-confirm") as HTMLButtonElement).disabled, true);
	});
	it("a failed preview shows the reason on the button, and Retry goes back to the confirmation step", async () => {
		const g = fakeGraduate({ previewOutcome: { state: "error", jobId: "j", kind: "preview", code: "not_ready", message: "Ready feature is not ready to graduate: 1 task open" } });
		await openList(g);
		await click(q("work-graduate-ready")!);
		await settle();
		await click(q("graduate-go")!);
		await until("the error", () => phase("work-graduate-ready") === "error");
		assert.match(q("work-graduate-ready")!.getAttribute("title")!, /1 task open/);
		assert.equal(q("work-graduate-ready")!.textContent, "Retry");
		g.previewOutcome = { state: "preview_ready", preview: PREVIEW };
		await click(q("work-graduate-ready")!);
		await settle();
		assert.equal(q("graduate-dialog")!.getAttribute("data-step"), "confirm");
		await click(q("graduate-go")!);
		await until("Review", () => phase("work-graduate-ready") === "ready");
		assert.equal(g.starts.filter((s) => s.kind === "preview").length, 2);
	});
	it("a start that is refused shows on the button too", async () => {
		const g = fakeGraduate({ startPreviewResult: { ok: false, reason: "unavailable", message: "no Work API configured", code: "memory_unavailable" } });
		await openList(g);
		await click(q("work-graduate-ready")!);
		await settle();
		await click(q("graduate-go")!);
		await settle();
		assert.equal(phase("work-graduate-ready"), "error");
		assert.equal(q("work-graduate-ready")!.getAttribute("data-code"), "memory_unavailable");
	});
	it("a stale preview at confirm goes back to the Graduate step, and nothing refreshes", async () => {
		const g = fakeGraduate({ confirmOutcome: { state: "error", jobId: "j", kind: "confirm", code: "preview_stale", message: "That preview is too old." } });
		const work = await openList(g);
		await click(q("work-graduate-ready")!);
		await settle();
		await click(q("graduate-go")!);
		await until("Review", () => phase("work-graduate-ready") === "ready");
		await click(q("work-graduate-ready")!);
		const before = work.lists;
		await click(q("graduate-confirm")!);
		await until("the error", () => phase("work-graduate-ready") === "error");
		assert.equal(q("work-graduate-ready")!.getAttribute("data-code"), "preview_stale");
		assert.equal(work.lists, before, "a failed graduation refreshes nothing");
		await click(q("work-graduate-ready")!);
		await settle();
		assert.equal(q("graduate-dialog")!.getAttribute("data-step"), "confirm");
	});
	it("another failure at confirm goes back to Review: the preview is still good", async () => {
		const g = fakeGraduate({ confirmOutcome: { state: "error", jobId: "j", kind: "confirm", code: "engine_error", message: "graduation stopped, nothing archived" } });
		await openList(g);
		await click(q("work-graduate-ready")!);
		await settle();
		await click(q("graduate-go")!);
		await until("Review", () => phase("work-graduate-ready") === "ready");
		await click(q("work-graduate-ready")!);
		await click(q("graduate-confirm")!);
		await until("the error", () => phase("work-graduate-ready") === "error");
		await click(q("work-graduate-ready")!);
		assert.equal(q("graduate-dialog")!.getAttribute("data-step"), "review");
		assert.equal(g.starts.filter((s) => s.kind === "preview").length, 1);
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
let recordReads = 0;
const json = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body });
globalThis.fetch = (async (url: string) => {
	if (url === "/api/wolves") return json(200, { wolves: [{ id: "1", name: "lib", host: "h", status: "online", librarian: true }, { id: "2", name: "hal", host: "h", status: "online" }] });
	const rec = /\/work\/([^/]+)\/record$/.exec(url);
	if (rec) recordReads++;
	if (rec) return records[rec[1]!] ? json(200, records[rec[1]!]) : json(404, { error: "nope" });
	return json(404, { error: "unmocked " + url });
}) as typeof fetch;

const mountPane = async (target: string, g: GraduateClient) => {
	const card = describeNode(graph, `work:${target}`) as NodeCard;
	await mountEl(<GraphPane card={card} onClose={() => {}} onFocus={() => {}} onSelectNode={() => {}} onNavigate={() => {}} graduate={g} />);
	await settle();
};

describe("graph pane: the Graduate button", () => {
	it("a ready feature runs the same flow: step → loader → Review → modal → Confirm → loader → refresh", async () => {
		const g = fakeGraduate({ runningPolls: 1000 });
		await mountPane("RDY", g);
		const btn = q("pane-graduate") as HTMLButtonElement;
		assert.equal(btn.disabled, false);
		await click(btn);
		await settle();
		assert.match(q("graduate-count")!.textContent!, /5 observations from 2 tasks will be folded/);
		await click(q("graduate-go")!);
		await settle();
		assert.equal(q("graduate-dialog"), null);
		assert.deepEqual(g.starts, [{ kind: "preview", wolf: "hal", id: "RDY" }]);
		assert.equal(phase("pane-graduate"), "previewing");
		assert.ok(q("pane-graduate-loader"));
		g.runningPolls = 0;
		await until("Review", () => phase("pane-graduate") === "ready");
		await click(q("pane-graduate")!);
		assert.equal(qa('[data-testid="graduate-entry"]').length, 2);
		const reads = recordReads;
		g.runningPolls = 1000;
		await click(q("graduate-confirm")!);
		assert.equal(q("graduate-dialog"), null);
		assert.deepEqual(g.starts.at(-1), { kind: "confirm", wolf: "hal", id: "RDY", token: "abcdef012345" });
		assert.equal(phase("pane-graduate"), "graduating");
		g.runningPolls = 0;
		await until("the graduation", () => graduateStore.getDone().length === 1);
		assert.equal(graduateStore.getDone()[0]!.id, "RDY");
		await settle();
		assert.ok(recordReads > reads, "the pane read the feature again");
	});
	it("shares the job state with the Work list: a feature previewed elsewhere shows Review here", async () => {
		const g = fakeGraduate();
		await graduateStore.startPreview(g, { id: "RDY", title: "Ready one", assignee: "hal" }, "hal");
		await until("the preview", () => graduateStore.get("RDY")?.phase === "ready");
		await mountPane("RDY", g);
		assert.equal(phase("pane-graduate"), "ready");
		assert.equal(g.starts.length, 1, "the pane started nothing");
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
	it("Cancel leaves the pane as it was and starts nothing", async () => {
		const g = fakeGraduate();
		await mountPane("RDY", g);
		await click(q("pane-graduate")!);
		await settle();
		await click(q("graduate-cancel")!);
		assert.equal(q("graduate-dialog"), null);
		assert.equal(g.starts.length, 0);
		assert.equal(phase("pane-graduate"), null);
		assert.ok(q("pane-graduate"));
	});
	it("a failed job shows its message beside the button", async () => {
		const g = fakeGraduate({ previewOutcome: { state: "error", jobId: "j", kind: "preview", code: "engine_error", message: "model exploded, nothing archived" } });
		await mountPane("RDY", g);
		await click(q("pane-graduate")!);
		await settle();
		await click(q("graduate-go")!);
		await until("the error", () => phase("pane-graduate") === "error");
		assert.match(q("pane-graduate-error")!.textContent!, /model exploded/);
	});
});

describe("GraduateStartDialog on its own", () => {
	it("the step is a dialog and Esc closes it", async () => {
		const g = fakeGraduate();
		let closed = 0;
		await mountEl(<GraduateStartDialog target={{ id: "ready", title: "Ready feature", assignee: "hal" }} client={g} onClose={() => void closed++} />);
		await settle();
		assert.equal(q("graduate-dialog")!.getAttribute("role"), "dialog");
		await act(async () => {
			const ev = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
			Object.defineProperty(ev, "key", { value: "Escape" });
			document.dispatchEvent(ev);
		});
		assert.equal(closed, 1);
		assert.equal(g.starts.length, 0);
	});
});
