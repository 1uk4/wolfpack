/**
 * The feature progress panel: the pure model (diamond layering, blocked, bound), the panel (title/count/loader, greyed
 * shipped, highlighted bound, blocked marker, graph columns, bind + confirm, collapse persistence) and ThreadChat
 * (the floating checklist stays in unbound threads and gives way to the panel in bound ones).
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

const { buildFeatureProgress, layoutStrip } = await import("../src/core/index.ts");
type WorkRecordResponse = import("../src/core/index.ts").WorkRecordResponse;
const { FeatureProgressPanel } = await import("../components/feature-progress.tsx");
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
const progressOf = (bound: WorkRecordResponse = task("b"), f = feature()) => {
	const p = buildFeatureProgress(bound, f);
	assert.equal(p.kind, "progress");
	return p as Extract<typeof p, { kind: "progress" }>;
};

describe("buildFeatureProgress", () => {
	it("a diamond layers into three columns; blocked, bound, counts and order follow", () => {
		const p = progressOf();
		assert.equal(p.title, "Feat");
		assert.equal(p.label, "1/4 shipped");
		assert.equal(p.layers, 3);
		assert.equal(p.rows, 2);
		assert.deepEqual(p.tasks.map((t) => [t.id, t.layer, t.index]), [["a", 0, 1], ["b", 1, 2], ["c", 1, 3], ["d", 2, 4]]);
		assert.deepEqual(p.tasks.filter((t) => t.blocked).map((t) => t.id), ["d"]);
		assert.deepEqual(p.tasks.filter((t) => t.bound).map((t) => t.id), ["b"]);
		assert.deepEqual(p.tasks.filter((t) => t.shipped).map((t) => t.id), ["a"]);
		assert.deepEqual(p.edges.map((e) => `${e.from}>${e.to}`).sort(), ["a>b", "a>c", "b>d", "c>d"]);
		const s = layoutStrip(p);
		const x = (id: string) => s.nodes.find((n) => n.id === id)!.x;
		assert.ok(x("a") < x("b") && x("b") === x("c") && x("c") < x("d"), "left to right by step");
		assert.equal(s.edges.length, 4);
	});
	it("a thread bound to the feature itself has no bound task; shipping the prerequisite unblocks", () => {
		const p = progressOf(feature(), feature({ b: "shipped", c: "shipped" }));
		assert.equal(p.boundIsFeature, true);
		assert.equal(p.tasks.some((t) => t.bound), false);
		assert.equal(p.tasks.find((t) => t.id === "d")!.blocked, false);
		assert.equal(p.label, "3/4 shipped");
	});
	it("nothing to show without a feature (an unparented task)", () => {
		assert.equal(buildFeatureProgress(task("b"), null).kind, "none");
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

async function mountPanel(over: Partial<React.ComponentProps<typeof FeatureProgressPanel>> = {}, threadId = "w/feature-F") {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => root!.render(<FeatureProgressPanel wolf="w" slug="feature-F" threadId={threadId} progress={progressOf()} busy={false} {...over} />));
}

describe("FeatureProgressPanel", () => {
	it("shows '<feature> · n/m shipped' and the small loader only while busy", async () => {
		await mountPanel({ busy: false });
		assert.equal(q('[data-testid="feature-progress-title"]')!.textContent?.replace(/\s+/g, " "), "Feat · 1/4 shipped");
		assert.equal(q('[data-testid="feature-progress-loader"]'), null);
		await act(async () => root!.unmount());
		root = null;
		await mountPanel({ busy: true });
		assert.ok(q('[data-testid="feature-progress-loader"]'));
	});

	it("is collapsed by default; open shows the graph (columns per step) and the task list: shipped greyed, bound highlighted, blocked marked", async () => {
		await mountPanel();
		assert.equal(q('[data-testid="feature-progress-panel"]'), null);
		await click(q('[data-testid="feature-progress-toggle"]')!);
		assert.ok(q('[data-testid="feature-progress-graph"]'));
		assert.deepEqual(
			["a", "b", "c", "d"].map((id) => q(`[data-testid="feature-progress-node-${id}"]`)!.getAttribute("data-layer")),
			["0", "1", "1", "2"],
		);
		const a = q('[data-testid="feature-progress-task-a"]')!;
		assert.equal(a.getAttribute("data-shipped"), "true");
		assert.match(a.innerHTML, /opacity-60/, "shipped is greyed");
		const b = q('[data-testid="feature-progress-task-b"]')!;
		assert.equal(b.getAttribute("data-bound"), "true");
		assert.match(b.className, /ring-yellow-400/, "bound is highlighted");
		assert.ok(q('[data-testid="feature-progress-glow"]'), "bound node glows in the graph");
		assert.equal(q('[data-testid="feature-progress-node-b"]')!.getAttribute("data-bound"), "true");
		assert.ok(q('[data-testid="feature-progress-blocked-d"]'), "d waits on b and c");
		assert.equal(q('[data-testid="feature-progress-blocked-c"]'), null);
		assert.equal(q('[data-testid="feature-progress-blocked-a"]'), null);
	});

	it("clicking a task focuses it in the graph and offers 'open'; clicking a graph node focuses its row", async () => {
		await mountPanel({}, "w/feature-F-click");
		await click(q('[data-testid="feature-progress-toggle"]')!);
		await click(q('[data-testid="feature-progress-task-c"] button')!);
		assert.equal(q('[data-testid="feature-progress-node-c"]')!.getAttribute("data-focused"), "true");
		assert.equal(q('[data-testid="feature-progress-open"]')!.getAttribute("href"), "/kb/work/c");
		await click(q('[data-testid="feature-progress-node-d"]')!);
		assert.equal(q('[data-testid="feature-progress-task-d"]')!.getAttribute("data-focused"), "true");
		assert.equal(q('[data-testid="feature-progress-task-c"]')!.getAttribute("data-focused"), "false");
	});

	it("the bind icon confirms, then POSTs {workItemId} to the thread's bind route and refreshes; the bound and shipped rows cannot bind", async () => {
		const calls: { url: string; body: unknown }[] = [];
		globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
			calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
			return Response.json({ threadId: "w/feature-F", workItemId: "c" });
		}) as typeof fetch;
		let bound = 0;
		await mountPanel({ onBound: () => bound++ }, "w/feature-F-bind");
		await click(q('[data-testid="feature-progress-toggle"]')!);
		assert.equal(q('[data-testid="feature-progress-bind-b"]')!.hasAttribute("disabled"), true);
		assert.equal(q('[data-testid="feature-progress-bind-a"]')!.hasAttribute("disabled"), true);
		await click(q('[data-testid="feature-progress-bind-c"]')!);
		assert.equal(calls.length, 0, "confirm first");
		assert.match(q('[data-testid="feature-progress-confirm"]')!.textContent ?? "", /Rebind this thread from "Task b" to "Task c"\?/);
		await click(q('[data-testid="feature-progress-confirm-no"]')!);
		assert.equal(q('[data-testid="feature-progress-confirm"]'), null);
		assert.equal(calls.length, 0);
		await click(q('[data-testid="feature-progress-bind-c"]')!);
		await click(q('[data-testid="feature-progress-confirm-yes"]')!);
		await settle();
		assert.deepEqual(calls, [{ url: "/api/wolves/w/threads/feature-F/bind", body: { workItemId: "c" } }]);
		assert.equal(bound, 1);
		assert.equal(q('[data-testid="feature-progress-confirm"]'), null);
	});

	it("a refused bind shows the server's message and keeps the confirm", async () => {
		globalThis.fetch = (async () => Response.json({ error: "work-x is already bound in conversation 7; release it there first" }, { status: 400 })) as typeof fetch;
		await mountPanel({}, "w/feature-F-refuse");
		await click(q('[data-testid="feature-progress-toggle"]')!);
		await click(q('[data-testid="feature-progress-bind-c"]')!);
		await click(q('[data-testid="feature-progress-confirm-yes"]')!);
		await settle();
		assert.match(q('[data-testid="feature-progress-error"]')!.textContent ?? "", /already bound in conversation 7/);
	});

	it("collapse state is remembered per thread (across a remount), not shared between threads", async () => {
		await mountPanel({}, "w/feature-F-mem");
		await click(q('[data-testid="feature-progress-toggle"]')!);
		assert.ok(q('[data-testid="feature-progress-panel"]'));
		await act(async () => root!.unmount());
		root = null;
		document.body.innerHTML = "";
		await mountPanel({}, "w/feature-F-mem");
		assert.ok(q('[data-testid="feature-progress-panel"]'), "same thread: still open");
		await act(async () => root!.unmount());
		root = null;
		document.body.innerHTML = "";
		await mountPanel({}, "w/feature-F-other");
		assert.equal(q('[data-testid="feature-progress-panel"]'), null, "another thread: collapsed");
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
		assert.equal(q('[data-testid="feature-progress"]'), null);
	});

	it("a thread bound to a feature pins its progress panel instead of the checklist (also for a bound task of it)", async () => {
		globalThis.fetch = serverFetch("F");
		await mountChat({ initialBound: "F" });
		assert.ok(q('[data-testid="feature-progress"]'));
		assert.equal(q('[data-testid="pinned-checklist"]'), null);
		assert.equal(q('[data-testid="feature-progress-title"]')!.textContent?.replace(/\s+/g, " "), "Feat · 1/4 shipped");
		await act(async () => root!.unmount());
		root = null;
		document.body.innerHTML = "";
		globalThis.fetch = serverFetch("F", "b");
		await mountChat({ initialBound: "b" });
		assert.ok(q('[data-testid="feature-progress"]'));
		assert.equal(q('[data-testid="pinned-checklist"]'), null);
		await click(q('[data-testid="feature-progress-toggle"]')!);
		assert.equal(q('[data-testid="feature-progress-task-b"]')!.getAttribute("data-bound"), "true");
	});
});
