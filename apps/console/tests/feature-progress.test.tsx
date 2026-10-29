/**
 * The pinned feature graph: the pure model (children → show_graph nodes/edges, buildTaskGraph's status mapping, the bound
 * highlight), the panel (the folded strip and its per-thread persistence, the graph, the node click → Status panel
 * selection, the drag-to-pan view), the live refetch on events, and ThreadChat (the floating checklist stays in unbound
 * threads and gives way to the panel in bound ones).
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
const store = new Map<string, string>();
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
	localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k), clear: () => store.clear() },
});

const { buildFeatureGraph, featureStrip, GRAPH_STATUS_OF, isWorkItemId, isWorkEvent } = await import("../src/core/index.ts");
type WorkRecordResponse = import("../src/core/index.ts").WorkRecordResponse;
const { FeatureProgressPanel, useFeatureProgress } = await import("../components/feature-progress.tsx");
const { PanelHostProvider, RightPanelHost } = await import("../components/panel-host.tsx");
const { ActivityIcon } = await import("lucide-react");
const { FIXTURE_THREAD } = await import("@wolfpack/client");
const { SettingsDialogProvider } = await import("../components/settings/settings-dialog.tsx");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
const { ThreadChat } = await import("../components/thread-chat.tsx");
const { MemoryEventsProvider } = await import("../components/memory-events.tsx");
const { ServerEventsProvider } = await import("../components/server-events.tsx");

const kid = (id: string, stage: string, dependsOn: string[] = []) => ({ id, title: `Task ${id}`, kind: "task", stage, dependsOn });
/** a -> (b, c) -> d: a diamond. a shipped, b in build (the bound task), c plan, d plan (blocked). */
const feature = (stages: Record<string, string> = {}): WorkRecordResponse =>
	({
		id: "F",
		kind: "feature",
		title: "Feat",
		stage: "in_build",
		plan: "",
		record: "",
		children: [kid("a", stages.a ?? "shipped"), kid("b", stages.b ?? "in_build", ["a"]), kid("c", stages.c ?? "plan", ["a"]), kid("d", stages.d ?? "plan", ["b", "c"])],
	}) as WorkRecordResponse;
const task = (id: string): WorkRecordResponse => ({ id, kind: "task", title: `Task ${id}`, stage: "in_build", plan: "", record: "", partOf: "F" }) as WorkRecordResponse;
const modelOf = (bound: WorkRecordResponse = task("b"), f = feature()) => {
	const m = buildFeatureGraph(bound, f);
	assert.equal(m.kind, "graph");
	return m as Extract<typeof m, { kind: "graph" }>;
};

describe("buildFeatureGraph", () => {
	it("children become nodes and dependsOn links edges (dependent -> prerequisite); statuses follow buildTaskGraph; the bound task is named", () => {
		const m = modelOf();
		assert.equal(m.title, "Feat");
		assert.equal(m.label, "1/4 done");
		assert.equal(featureStrip(m), "Feat · 1/4 done");
		assert.deepEqual(m.graph.nodes.map((n) => [n.id, n.label, n.status]), [["a", "Task a", "done"], ["b", "Task b", "doing"], ["c", "Task c", "todo"], ["d", "Task d", "blocked"]]);
		assert.deepEqual(m.graph.edges.map((e) => `${e.from}>${e.to}`).sort(), ["b>a", "c>a", "d>b", "d>c"]);
		assert.equal(m.boundId, "b");
	});
	it("ready, building, shipped (live too), blocked and archived map to todo, doing, done, blocked, skipped", () => {
		assert.deepEqual(GRAPH_STATUS_OF, { shipped: "done", building: "doing", ready: "todo", blocked: "blocked", archived: "skipped" });
		const f = { ...feature({ a: "shipped", b: "live", c: "plan" }), stage: "archived" } as WorkRecordResponse;
		(f.children as unknown[]).push(kid("e", "archived"));
		const m = modelOf(task("c"), f);
		const st = Object.fromEntries(m.graph.nodes.map((n) => [n.id, n.status]));
		assert.deepEqual(st, { a: "done", b: "done", c: "todo", d: "blocked", e: "skipped" });
	});
	it("a thread bound to the feature itself highlights no node; shipping the prerequisites unblocks", () => {
		const m = modelOf(feature(), feature({ b: "shipped", c: "shipped" }));
		assert.equal(m.boundId, null);
		assert.equal(m.graph.nodes.find((n) => n.id === "d")!.status, "todo");
		assert.equal(m.label, "3/4 done");
	});
	it("nothing to show without a feature (an unparented task)", () => {
		assert.equal(buildFeatureGraph(task("b"), null).kind, "none");
	});
	it("work item ids and work memory events are recognised", () => {
		assert.equal(isWorkItemId("work-wolfpack-ASNQgEf"), true);
		assert.equal(isWorkItemId("step-1"), false);
		assert.equal(isWorkItemId("work-my-domain-ASNQgEf"), true, "a domain may contain a hyphen");
		assert.equal(isWorkItemId("work-wolfpack-short"), false);
		assert.equal(isWorkEvent({ type: "record_written", target: { kind: "work", workId: "x" } }), true);
		assert.equal(isWorkEvent({ type: "observation_captured", target: { kind: "den" } }), false);
		assert.equal(isWorkEvent({ type: "topic_archived", target: { kind: "work" } }), false);
	});
});

const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const qa = (sel: string) => [...document.querySelectorAll(sel)] as HTMLElement[];
const click = (el: Element) => act(async () => void el.dispatchEvent(new dom.window.Event("click", { bubbles: true, cancelable: true })));
const settle = (ms = 40) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const realFetch = globalThis.fetch;
let root: Root | null = null;
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
	store.clear();
	globalThis.fetch = realFetch;
});
after(() => void (globalThis.fetch = realFetch));

const stubPanel = {
	id: "memory",
	label: "Status",
	icon: ActivityIcon,
	available: () => true,
	render: ({ props }: { props: Record<string, unknown> }) => <div data-testid="stub-status" data-task={String(props.taskId ?? "")} />,
};

async function mountPanel(over: Partial<React.ComponentProps<typeof FeatureProgressPanel>> = {}, threadId = "w/feature-F") {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () =>
		root!.render(
			<PanelHostProvider wolf="w" threadId={threadId} panels={[stubPanel as never]}>
				<FeatureProgressPanel threadId={threadId} model={modelOf()} busy={false} {...over} />
				<RightPanelHost />
			</PanelHostProvider>,
		),
	);
}
const ptr = (el: Element, type: string, x: number, y: number) =>
	act(async () => void el.dispatchEvent(Object.assign(new dom.window.Event(type, { bubbles: true, cancelable: true }), { clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1, pointerId: 1 })));

describe("FeatureProgressPanel", () => {
	it("is folded by default to the strip '<feature> · n/m done'; the loader shows only while busy", async () => {
		await mountPanel({ busy: false });
		assert.equal(q('[data-testid="feature-progress-title"]')!.textContent?.replace(/\s+/g, " "), "Feat · 1/4 done");
		assert.ok(q('[data-testid="feature-progress-panel"]') === null);
		assert.ok(q('[data-testid="feature-progress-loader"]') === null);
		await act(async () => root!.unmount());
		root = null;
		await mountPanel({ busy: true });
		assert.ok(q('[data-testid="feature-progress-loader"]'));
	});

	it("open shows the shared graph: statuses on the nodes, the bound task highlighted; no task list, strip graph or bind icon", async () => {
		await mountPanel();
		await click(q('[data-testid="feature-progress-toggle"]')!);
		assert.equal(q('[data-testid="feature-progress"]')!.getAttribute("data-expanded"), "true");
		const node = (id: string) => q(`[data-node-id="${id}"]`)!;
		assert.deepEqual(["a", "b", "c", "d"].map((id) => node(id).getAttribute("data-status")), ["done", "doing", "todo", "blocked"]);
		assert.deepEqual(["a", "b", "c", "d"].map((id) => node(id).getAttribute("data-highlight")), ["false", "true", "false", "false"]);
		assert.equal(qa('[data-testid="graph-edge"]').length, 4);
		assert.match(q('[data-testid="feature-progress-panel"]')!.className, /max-h-\[40vh\]/);
		assert.ok(q('[data-testid^="feature-progress-task-"]') === null);
		assert.ok(q('[data-testid^="feature-progress-bind-"]') === null);
		assert.ok(q('[data-testid="feature-progress-graph"]') === null);
	});

	it("a thread bound to the feature itself highlights no node and the strip says so", async () => {
		await mountPanel({ model: modelOf(feature(), feature()) }, "w/feature-F-own");
		assert.ok(q('[data-testid="feature-progress-bound-feature"]'));
		await click(q('[data-testid="feature-progress-toggle"]')!);
		assert.equal(qa('[data-highlight="true"]').length, 0);
	});

	it("a node click opens the Status panel on that task", async () => {
		await mountPanel({}, "w/feature-F-click");
		await click(q('[data-testid="feature-progress-toggle"]')!);
		await click(q('[data-node-id="c"] [data-testid="graph-node-hit"]')!);
		await act(async () => void (await new Promise((r) => setTimeout(r, 10))));
		const stub = q('[data-testid="stub-status"]')!;
		assert.ok(stub, "the Status panel opened");
		assert.equal(stub.getAttribute("data-task"), "c");
		await click(q('[data-node-id="d"] [data-testid="graph-node-hit"]')!);
		await act(async () => void (await new Promise((r) => setTimeout(r, 10))));
		assert.equal(q('[data-testid="stub-status"]')!.getAttribute("data-task"), "d");
	});

	it("the graph pans by dragging; folding and reopening resets the view", async () => {
		const wide = modelOf(task("b"), { ...feature(), children: [kid("a", "shipped"), kid("b", "plan", ["a"]), kid("c", "plan", ["b"]), kid("d", "plan", ["c"]), kid("e", "plan", ["d"])] } as WorkRecordResponse);
		await mountPanel({ model: wide }, "w/feature-F-drag");
		await click(q('[data-testid="feature-progress-toggle"]')!);
		const box = q('[data-testid="graph-scroll"]')!;
		assert.equal(box.getAttribute("data-draggable"), "true");
		const x0 = Number(q('[data-testid="graph-pan"]')!.getAttribute("data-pan-x"));
		await ptr(box, "pointerdown", 100, 100);
		await ptr(box, "pointermove", 60, 100);
		await ptr(box, "pointerup", 60, 100);
		const x = Number(q('[data-testid="graph-pan"]')!.getAttribute("data-pan-x"));
		assert.ok(x < x0, `panned left (${x} < ${x0})`);
		await click(q('[data-testid="feature-progress-toggle"]')!);
		await click(q('[data-testid="feature-progress-toggle"]')!);
		assert.equal(Number(q('[data-testid="graph-pan"]')!.getAttribute("data-pan-x")), x0);
	});

	it("full screen: the button opens the canvas in a modal, Esc closes it, a node click there opens the Status panel and closes the modal", async () => {
		await mountPanel({}, "w/feature-F-full");
		await click(q('[data-testid="feature-progress-toggle"]')!);
		assert.ok(q('[data-testid="feature-progress-modal"]') === null);
		await click(q('[data-testid="feature-progress-fullscreen"]')!);
		const modal = q('[data-testid="feature-progress-modal"]');
		assert.ok(modal, "modal open");
		assert.equal(modal!.closest('[data-testid="feature-progress"]') === null, true, "portalled out of the pointer-events-none panel");
		assert.equal(modal!.parentElement === document.body, true);
		assert.equal(modal!.querySelectorAll('[data-testid="graph-node"]').length, 4);
		assert.equal(modal!.querySelector('[data-testid="graph-scroll"]')!.getAttribute("data-draggable"), "true");
		await act(async () => void document.dispatchEvent(Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), { key: "Escape" })));
		assert.ok(q('[data-testid="feature-progress-modal"]') === null, "Esc closed it");
		await click(q('[data-testid="feature-progress-fullscreen"]')!);
		await click(q('[data-testid="feature-progress-modal"] [data-node-id="c"] [data-testid="graph-node-hit"]')!);
		await act(async () => void (await new Promise((r) => setTimeout(r, 10))));
		assert.equal(q('[data-testid="stub-status"]')!.getAttribute("data-task"), "c");
		assert.ok(q('[data-testid="feature-progress-modal"]') === null, "modal closed so the panel is visible");
	});

	it("collapse state is remembered per thread (across a remount), not shared between threads", async () => {
		await mountPanel({}, "w/feature-F-mem");
		await click(q('[data-testid="feature-progress-toggle"]')!);
		assert.ok(q('[data-testid="feature-progress-panel"]'));
		assert.equal(JSON.parse(store.get("wp.feature-progress.open.v1")!).includes("w/feature-F-mem"), true, "kept in localStorage by thread id");
		await act(async () => root!.unmount());
		root = null;
		document.body.innerHTML = "";
		await mountPanel({}, "w/feature-F-mem");
		assert.ok(q('[data-testid="feature-progress-panel"]'), "same thread: still open");
		await act(async () => root!.unmount());
		root = null;
		document.body.innerHTML = "";
		await mountPanel({}, "w/feature-F-other");
		assert.ok(q('[data-testid="feature-progress-panel"]') === null, "another thread: folded");
	});
});

// ---------------------------------------------------------------- live data

describe("useFeatureProgress: events refetch", () => {
	/** A fake events channel: `fire(name, payload)` reaches the hub like an SSE frame. */
	function channel() {
		const on = new Map<string, (d: string) => void>();
		let open: () => void = () => {};
		return {
			connect: () => ({ close() {}, onOpen: (cb: () => void) => void (open = cb), onEvent: (n: string, cb: (d: string) => void) => void on.set(n, cb) }),
			fire: (name: string, payload: unknown) => on.get(name)?.(JSON.stringify(payload)),
			reopen: () => open(),
		};
	}
	function Probe({ threadId }: { threadId: string }) {
		const { state } = useFeatureProgress("w", threadId, 0);
		return state.phase === "ready" ? <FeatureProgressPanel threadId={threadId} model={state.model} busy={false} /> : <i data-testid="no-graph" />;
	}
	let stages: Record<string, string> = {};
	let recordFetches = 0;
	const fetchFor = (): typeof fetch =>
		(async (input: RequestInfo | URL) => {
			const url = new URL(String(input), "http://t");
			if (url.pathname === "/api/wolves/w/threads") return Response.json({ threads: [{ id: "w/t", boundWorkItem: "b" }] });
			const rec = url.pathname.match(/\/work\/([^/]+)\/record$/);
			if (rec) {
				recordFetches++;
				return Response.json(rec[1] === "F" ? feature(stages) : task(rec[1]!));
			}
			return new Response("{}", { status: 404 });
		}) as typeof fetch;
	async function mountProbe(ch: ReturnType<typeof channel>) {
		stages = {};
		recordFetches = 0;
		globalThis.fetch = fetchFor();
		store.set("wp.feature-progress.open.v1", JSON.stringify(["w/t"]));
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		await act(async () =>
			root!.render(
				<ServerEventsProvider connect={ch.connect}>
					<MemoryEventsProvider connect={() => memSource}>
						<Probe threadId="w/t" />
					</MemoryEventsProvider>
				</ServerEventsProvider>,
			),
		);
		await settle(60);
	}
	let emitMem: (f: unknown) => void = () => {};
	const memSource = { close() {}, onOpen() {}, onMessage: (cb: (d: string) => void) => void (emitMem = (f) => cb(JSON.stringify(f))), onError() {} };
	const status = (id: string) => q(`[data-node-id="${id}"]`)!.getAttribute("data-status");

	it("a stage change event refetches (debounced, once for a burst) and the node's status updates", async () => {
		const ch = channel();
		await mountProbe(ch);
		assert.equal(status("c"), "todo");
		assert.equal(status("d"), "blocked");
		assert.equal(q('[data-testid="feature-progress-title"]')!.textContent, "Feat · 1/4 done");
		const before = recordFetches;
		stages = { b: "shipped", c: "shipped", d: "in_build" };
		await act(async () => {
			ch.fire("thread-updated", { wolf: "w", thread: { id: "w/other", boundWorkItem: "x" } });
			ch.fire("thread-updated", { wolf: "w", thread: { id: "w/t" } });
			ch.fire("needs-you-changed", { wolf: "w" });
		});
		assert.equal(recordFetches, before, "debounced: nothing yet");
		await settle(450);
		assert.equal(recordFetches - before, 2, "one refetch for the burst (bound record + feature)");
		assert.equal(status("b"), "done");
		assert.equal(status("c"), "done");
		assert.equal(status("d"), "doing");
		assert.equal(q('[data-testid="feature-progress-title"]')!.textContent, "Feat · 3/4 done");
	});

	it("a memory event about a work item, a reconnect and window focus each refetch; a den event and another wolf's thread do not", async () => {
		const ch = channel();
		await mountProbe(ch);
		const count = async (fn: () => Promise<void> | void) => {
			const n = recordFetches;
			await act(async () => void (await fn()));
			await settle(450);
			return recordFetches - n;
		};
		assert.equal(await count(() => emitMem({ type: "record_written", wolf: "w", target: { kind: "work", workId: "zzz" }, observationCount: 1 })), 2);
		assert.equal(await count(() => ch.reopen()), 2);
		assert.equal(await count(() => void window.dispatchEvent(new dom.window.Event("focus"))), 2);
		assert.equal(await count(() => emitMem({ type: "observation_captured", wolf: "w", target: { kind: "den", topicId: "t" } })), 0);
		assert.equal(await count(() => ch.fire("thread-updated", { wolf: "other", thread: { id: "w/t" } })), 0);
	});
});

describe("console bind API", () => {
	it("POST bind resolves the slug, forwards {workItemId} to the client, and refuses a bad body", async () => {
		const { MockConsoleClient } = await import("@wolfpack/client");
		const { createThreadApi } = await import("../src/server/thread-api.ts");
		const client = new MockConsoleClient({ delayMs: 0, script: [] });
		const api = createThreadApi(() => client);
		const ref = { wolf: "1uk4", slug: "home" };
		const ok = await api.bind(ref, new Request("http://t/x", { method: "POST", body: JSON.stringify({ workItemId: "work-x-1" }) }));
		assert.equal(ok.status, 200);
		assert.deepEqual(client.binds, [{ threadId: FIXTURE_THREAD.id, workItemId: "work-x-1" }]);
		assert.equal((await api.bind(ref, new Request("http://t/x", { method: "POST", body: "{}" }))).status, 400);
	});
});

// ---------------------------------------------------------------- ThreadChat

const CHECKLIST = {
	id: "a",
	role: "assistant" as const,
	text: "",
	at: "2026-01-01T00:00:00.000Z",
	objects: [{ objectId: "cl", type: "checklist", rev: 1, data: { title: "Plan", items: [{ id: "i0", label: "Step", state: "todo" }] }, textOffset: 0, seq: 1 }],
};

function serverFetch(boundWorkItem: string | undefined, boundItem?: string): typeof fetch {
	return (async (input: RequestInfo | URL) => {
		const url = new URL(String(input), "http://t");
		if (url.pathname === "/api/wolves/1uk4/threads") return Response.json({ threads: [{ id: FIXTURE_THREAD.id, wolf: "1uk4", kind: "feature", title: "T", ...(boundWorkItem ? { boundWorkItem } : {}), ...(boundItem ? { boundItem } : {}) }] });
		const rec = url.pathname.match(/\/work\/([^/]+)\/record$/);
		if (rec) return Response.json(rec[1] === "F" ? feature() : task(rec[1]!));
		return new Response("{}", { status: 404 });
	}) as typeof fetch;
}

async function mountChat(over: { initialBound?: string } = {}) {
	const { threadMessagesToNative } = await import("../src/core/index.ts");
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	const frames = () => ({ close() {}, onOpen() {}, onEvent() {} });
	await act(async () => {
		root!.render(
			<AppRouterContext.Provider value={{ push() {} } as never}>
				<SettingsDialogProvider>
					<ServerEventsProvider connect={frames}>
						<MemoryEventsProvider connect={() => ({ close() {}, onOpen() {}, onMessage() {}, onError() {} })}>
							<ThreadChat wolf="1uk4" slug="home" threadId={FIXTURE_THREAD.id} title="T" initialMessages={threadMessagesToNative([CHECKLIST])} {...over} />
						</MemoryEventsProvider>
					</ServerEventsProvider>
				</SettingsDialogProvider>
			</AppRouterContext.Provider>,
		);
	});
	await settle(80);
}

describe("ThreadChat pinned area", () => {
	it("an unbound thread keeps the floating checklist and shows no progress panel", async () => {
		globalThis.fetch = serverFetch(undefined);
		await mountChat();
		assert.ok(q('[data-testid="pinned-checklist"]'));
		assert.ok(q('[data-testid="feature-progress"]') === null);
	});

	it("a thread bound to a feature pins its progress panel instead of the checklist (also for a bound task of it)", async () => {
		globalThis.fetch = serverFetch("F");
		await mountChat({ initialBound: "F" });
		assert.ok(q('[data-testid="feature-progress"]'));
		assert.ok(q('[data-testid="pinned-checklist"]') === null);
		assert.equal(q('[data-testid="feature-progress-title"]')!.textContent?.replace(/\s+/g, " "), "Feat · 1/4 done");
		await act(async () => root!.unmount());
		root = null;
		document.body.innerHTML = "";
		globalThis.fetch = serverFetch("F", "b");
		await mountChat({ initialBound: "b" });
		assert.ok(q('[data-testid="feature-progress"]'));
		assert.ok(q('[data-testid="pinned-checklist"]') === null);
		await click(q('[data-testid="feature-progress-toggle"]')!);
		assert.equal(q('[data-node-id="b"]')!.getAttribute("data-highlight"), "true");
	});
});
