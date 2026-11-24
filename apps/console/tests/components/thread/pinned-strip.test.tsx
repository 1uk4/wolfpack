/** The pinned strip: every pin of the unified store renders as a chip; objects expand inline (a sheet on phones), work/kb open the viewer. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<!doctype html><html><body></body></html>");
(globalThis as Record<string, unknown>).self ??= globalThis;
const store = new Map<string, string>();
let wide = true;
Object.assign(globalThis, {
	window: Object.assign(dom.window, { matchMedia: () => ({ matches: wide, addEventListener() {}, removeEventListener() {} }) }),
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	Event: dom.window.Event,
	IS_REACT_ACT_ENVIRONMENT: true,
	localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
});

const { PinnedStrip, useSyncObjectPins } = await import("../../../components/thread/pinned-strip.tsx");
const ps = await import("../../../components/thread/pin-store.ts");
const vs = await import("../../../components/viewer/viewer-store.ts");
const tp = await import("../../../components/thread/task-pin.tsx");

let root: Root | null = null;
beforeEach(() => {
	store.clear();
	wide = true;
	ps.resetPinnedViewsCache();
	vs.resetViewerCache();
});
afterEach(() => {
	act(() => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});

async function mount(el: React.ReactElement) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => root!.render(el));
}
const q = (s: string) => document.querySelector(s) as HTMLElement | null;
const qa = (s: string) => [...document.querySelectorAll(s)] as HTMLElement[];
const click = (el: HTMLElement | null) => act(async () => void el!.dispatchEvent(new dom.window.Event("click", { bubbles: true })));
const chip = (key: string) => `[data-pin-key="${key}"]`;

const decision = { type: "decision", id: "db", rev: 1, data: { title: "Datastore", options: [{ id: "pg", label: "Postgres" }, { id: "sq", label: "SQLite" }], chosen: "pg", rationale: "Concurrent writers." } } as const;
const checklist = { type: "checklist", id: "cl", rev: 1, data: { title: "Plan", items: [{ id: "i0", label: "Step zero", state: "done" }, { id: "i1", label: "Step one", state: "todo" }] } } as const;
const objects = [checklist, decision];
const strip = () => <PinnedStrip wolf="hal" threadId="t1" objects={objects} />;

describe("pinned strip", () => {
	it("renders one chip per pin in store order, with the kind icon and title (id as fallback)", async () => {
		ps.pin("t1", { kind: "checklist", id: "cl", title: "Plan", pinnedBy: "agent", rev: 1 });
		ps.pin("t1", { kind: "work", id: "w1", title: "Fix the thing", pinnedBy: "owner" });
		ps.pin("t1", { kind: "kb", id: "k1", pinnedBy: "owner" });
		ps.pin("t2", { kind: "kb", id: "other", pinnedBy: "owner" });
		await mount(strip());
		assert.deepEqual(qa('[data-testid="pinned-chip"]').map((c) => c.getAttribute("data-pin-key")), ["checklist:cl", "work:w1", "kb:k1"]);
		assert.match(q(chip("work:w1"))!.textContent ?? "", /Fix the thing/);
		assert.match(q(chip("kb:k1"))!.textContent ?? "", /k1/);
		assert.ok(q(`${chip("work:w1")} svg`), "kind icon");
	});

	it("the x unpins (dismisses) the chip", async () => {
		ps.pin("t1", { kind: "work", id: "w1", title: "A", pinnedBy: "owner" });
		await mount(strip());
		await click(q(`${chip("work:w1")} [data-testid="pinned-chip-dismiss"]`));
		assert.deepEqual(ps.listPins("t1"), []);
		assert.equal(q('[data-testid="pinned-chip"]'), null);
	});

	it("an object chip expands its card inline; expanding another collapses the first; clicking again collapses", async () => {
		ps.pin("t1", { kind: "checklist", id: "cl", title: "Plan", pinnedBy: "agent", rev: 1 });
		ps.pin("t1", { kind: "decision", id: "db", title: "Datastore", pinnedBy: "agent", rev: 1 });
		await mount(strip());
		assert.equal(q('[data-testid="pinned-expanded"]'), null);
		await click(q(`${chip("checklist:cl")} [data-testid="pinned-chip-open"]`));
		assert.match(q('[data-testid="pinned-expanded"]')!.textContent ?? "", /Step one/);
		await click(q(`${chip("decision:db")} [data-testid="pinned-chip-open"]`));
		assert.equal(qa('[data-testid="pinned-expanded"]').length, 1);
		assert.match(q('[data-testid="pinned-expanded"]')!.textContent ?? "", /SQLite/);
		assert.equal(q(chip("checklist:cl"))!.getAttribute("data-expanded"), "false");
		await click(q(`${chip("decision:db")} [data-testid="pinned-chip-open"]`));
		assert.equal(q('[data-testid="pinned-expanded"]'), null);
	});

	it("a work or kb chip opens the viewer on it and never expands inline", async () => {
		ps.pin("t1", { kind: "kb", id: "k1", title: "Entry", pinnedBy: "owner" });
		await mount(strip());
		await click(q(`${chip("kb:k1")} [data-testid="pinned-chip-open"]`));
		const s = vs.getViewerState("hal", "t1");
		assert.equal(s.open, true);
		assert.deepEqual(s.stack.at(-1), { kind: "kb", id: "k1", title: "Entry" });
		assert.equal(q('[data-testid="pinned-expanded"]'), null);
	});

	it("on a phone the chips are one scrolling row and the expanded object is a sheet with a close button", async () => {
		wide = false;
		ps.pin("t1", { kind: "checklist", id: "cl", title: "Plan", pinnedBy: "agent", rev: 1 });
		await mount(strip());
		const row = q('[data-testid="pinned-chips"]')!;
		assert.match(row.className, /flex-nowrap/);
		assert.match(row.className, /overflow-x-auto/);
		await click(q(`${chip("checklist:cl")} [data-testid="pinned-chip-open"]`));
		assert.match(q('[data-testid="pinned-sheet"]')!.textContent ?? "", /Step one/);
		assert.equal(q('[data-testid="pinned-expanded"]'), null);
		await click(q('[data-testid="pinned-sheet-close"]'));
		assert.equal(q('[data-testid="pinned-sheet"]'), null);
	});

	it("on a wide screen the chips wrap", async () => {
		ps.pin("t1", { kind: "kb", id: "k1", pinnedBy: "owner" });
		await mount(strip());
		assert.match(q('[data-testid="pinned-chips"]')!.className, /flex-wrap/);
	});
});

describe("useSyncObjectPins", () => {
	function Harness({ objs }: { objs: Parameters<typeof useSyncObjectPins>[1] }) {
		useSyncObjectPins("t1", objs);
		return null;
	}
	it("pins the newest object of each type, oldest-first by recency, with its data title", async () => {
		await mount(
			<Harness
				objs={[
					{ ...decision, recency: 3 },
					{ ...checklist, id: "old", recency: 1 },
					{ ...checklist, recency: 2, pinRev: 1 },
				]}
			/>,
		);
		assert.deepEqual(ps.listPins("t1").map((p) => `${p.kind}:${p.id}:${p.title}`), ["checklist:cl:Plan", "decision:db:Datastore"]);
	});
});

describe("bound task chip", () => {
	const model = { kind: "graph", featureId: "F", title: "Feat", shipped: 1, total: 4, label: "1/4 done", graph: { title: "Feat", nodes: [], edges: [] }, boundId: null } as never;
	const withTask = (extra: React.ReactNode = null) => (
		<>
			<PinnedStrip wolf="hal" threadId="t1" objects={objects} task={{ model, busy: false }} />
			{extra}
		</>
	);
	const keys = () => qa('[data-testid="pinned-chip"]').map((c) => c.getAttribute("data-pin-key"));
	beforeEach(() => tp.resetHiddenTasks());

	it("binding adds the task chip with title and progress; unbinding removes it", async () => {
		tp.syncTaskPin("t1", "work-w-F");
		await mount(withTask());
		assert.deepEqual(keys(), ["task:task"]);
		assert.match(q(chip("task:task"))!.textContent ?? "", /Feat.*1\/4 done/);
		await act(async () => tp.syncTaskPin("t1", undefined));
		assert.deepEqual(keys(), []);
	});

	it("x hides the chip without touching the binding, a re-sync keeps it hidden, and the header toggle shows it again", async () => {
		tp.syncTaskPin("t1", "work-w-F");
		await mount(withTask(<tp.TaskPinToggle threadId="t1" bound="work-w-F" />));
		assert.equal(q('[data-testid="task-pin-show"]'), null, "no control while the chip shows");
		await click(q(`${chip("task:task")} [data-testid="pinned-chip-dismiss"]`));
		assert.deepEqual(keys(), []);
		await act(async () => tp.syncTaskPin("t1", "work-w-F"));
		assert.deepEqual(keys(), [], "still bound, still hidden");
		await click(q('[data-testid="task-pin-show"]'));
		assert.deepEqual(keys(), ["task:task"]);
	});

	const taskCall = (callId: string, pinned: boolean, state = "output-available") => ({ type: "tool-pin", toolCallId: callId, state, input: { objectId: "task", pinned } });
	const transcript = (...parts: Record<string, unknown>[]) => [{ role: "assistant", parts }];
	const apply = (...parts: Record<string, unknown>[]) => act(async () => tp.applyAgentTaskPin("t1", "work-w-F", tp.lastAgentTaskPin(transcript(...parts))));

	it("an agent task pin:false hides the chip and shows the header control without unbinding; pin:true brings it back", async () => {
		tp.syncTaskPin("t1", "work-w-F");
		await mount(withTask(<tp.TaskPinToggle threadId="t1" bound="work-w-F" />));
		await apply(taskCall("c1", false));
		assert.deepEqual(keys(), []);
		assert.ok(q('[data-testid="task-pin-show"]'), "header control appears");
		await apply(taskCall("c1", false), taskCall("c2", true));
		assert.deepEqual(keys(), ["task:task"]);
		assert.equal(q('[data-testid="task-pin-show"]'), null);
	});

	it("agent pin:true clears the owner's hide, and an owner x after an agent event wins until the next agent event", async () => {
		tp.syncTaskPin("t1", "work-w-F");
		await mount(withTask());
		await click(q(`${chip("task:task")} [data-testid="pinned-chip-dismiss"]`));
		assert.deepEqual(keys(), []);
		await apply(taskCall("c1", true));
		assert.deepEqual(keys(), ["task:task"], "agent show clears the owner's hide");
		await click(q(`${chip("task:task")} [data-testid="pinned-chip-dismiss"]`));
		await apply(taskCall("c1", true));
		assert.deepEqual(keys(), [], "replaying the earlier agent call does not undo the later owner x");
		await apply(taskCall("c1", true), taskCall("c2", false));
		await apply(taskCall("c1", true), taskCall("c2", false), taskCall("c3", true));
		assert.deepEqual(keys(), ["task:task"], "a newer agent call wins over the earlier owner x");
	});

	it("replaying the same transcript is idempotent and ignores failed or pending calls", async () => {
		tp.syncTaskPin("t1", "work-w-F");
		await mount(withTask());
		await apply(taskCall("c1", false));
		await apply(taskCall("c1", false));
		await act(async () => tp.syncTaskPin("t1", "work-w-F"));
		assert.deepEqual(keys(), []);
		await apply(taskCall("c1", false), taskCall("c2", true, "output-error"), taskCall("c3", true, "input-available"));
		assert.deepEqual(keys(), [], "errored and in-flight calls change nothing");
	});

	it("binding a different item shows the chip again after a dismissal", async () => {
		tp.syncTaskPin("t1", "work-w-F");
		await mount(withTask());
		await click(q(`${chip("task:task")} [data-testid="pinned-chip-dismiss"]`));
		await act(async () => tp.syncTaskPin("t1", "work-w-G"));
		assert.deepEqual(keys(), ["task:task"]);
	});

	it("shows next to a checklist chip; the title opens the bound item in the viewer, the chip body expands the progress graph", async () => {
		ps.pin("t1", { kind: "checklist", id: "cl", title: "Plan", pinnedBy: "agent", rev: 1 });
		tp.syncTaskPin("t1", "work-w-F");
		await mount(withTask());
		assert.deepEqual(keys(), ["checklist:cl", "task:task"]);
		await click(q(`${chip("task:task")} [data-testid="pinned-task-title"]`));
		assert.deepEqual(vs.getViewerState("hal", "t1").stack.at(-1), { kind: "work", id: "work-w-F" });
		assert.equal(q('[data-testid="pinned-expanded"]'), null);
		await click(q(`${chip("task:task")} [data-testid="pinned-chip-open"]`));
		assert.ok(q('[data-testid="pinned-expanded"] [data-testid="feature-progress"]'));
	});
});
