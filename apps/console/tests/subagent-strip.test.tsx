/** The subagent status strip, sidebar nesting and the job panel, over the injected fake client (the console's server layer). */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
const store = new Map<string, string>();
Object.assign(globalThis, {
	window: dom.window,
	self: globalThis, // next/link prefetch (requestIdleCallback)
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
	ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
	getComputedStyle: () => ({ animationName: "none" }),
	localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
});

const { MockConsoleClient, FIXTURE_THREAD } = await import("@wolfpack/client");
type ThreadSummary = import("@wolfpack/client").ThreadSummary;
const { createThreadApi } = await import("../src/server/thread-api.ts");
const { createActivityBridge } = await import("../src/server/needs-you-api.ts");
const { PanelHostProvider, RightPanelHost, PANELS } = await import("../components/panel-host.tsx");
const { SubagentStrip, SubagentStripView, useSubagentChildren } = await import("../components/subagent-strip.tsx");
const { SubagentJobs } = await import("../components/subagent-jobs.tsx");
const { SessionRow } = await import("../components/sidebar.tsx");
const { ServerEventsProvider } = await import("../components/server-events.tsx");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
const core = await import("../src/core/index.ts");

const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const PARENT = FIXTURE_THREAD.id;

const child = (n: number, over: Partial<ThreadSummary> = {}): ThreadSummary => ({
	id: `1uk4/sub-${n}`,
	wolf: "1uk4",
	kind: "subagent",
	title: `Task ${n}`,
	parentThreadId: PARENT,
	agent: "worker",
	state: "running",
	startedAt: ago(125_000),
	step: "edit",
	tokens: 12_345,
	taskId: `work-${n}`,
	...over,
});

/** A fake wolf with subagents: lists them as threads and as the parent's children; records aborts. */
class SubClient extends MockConsoleClient {
	kids: ThreadSummary[] = [];
	aborted: string[] = [];
	constructor() {
		super({ delayMs: 0 });
	}
	override async listThreads(wolf: string) {
		return [...(await super.listThreads(wolf)), ...this.kids];
	}
	async listChildren(id: string) {
		return this.kids.filter((k) => k.parentThreadId === id);
	}
	override async abort(id: string) {
		this.aborted.push(id);
	}
}

const settle = (ms = 30) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const click = (el: Element) => act(async () => void el.dispatchEvent(new dom.window.Event("click", { bubbles: true, cancelable: true })));
const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const qa = (sel: string) => [...document.querySelectorAll(sel)] as HTMLElement[];

const realFetch = globalThis.fetch;
let root: Root | null = null;
afterEach(() => {
	if (root) act(() => root!.unmount());
	root = null;
	document.body.innerHTML = "";
	globalThis.fetch = realFetch;
});

const frames = new Map<string, (data: string) => void>();
let resync: () => void = () => {};
const eventsSource = () => ({
	close() {},
	onOpen: (cb: () => void) => void (resync = cb),
	onEvent: (name: string, cb: (d: string) => void) => void frames.set(name, cb),
});
const fire = (thread: ThreadSummary) => act(async () => frames.get("thread-updated")!(JSON.stringify({ wolf: "1uk4", thread })));

function routeFetch(client: SubClient): typeof fetch {
	const api = createThreadApi(() => client);
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input), "http://t");
		const m = url.pathname.match(/\/api\/wolves\/([^/]+)\/threads\/([^/]+)\/(children|abort)$/);
		if (!m) return new Response("{}", { status: 404 });
		const ref = { wolf: decodeURIComponent(m[1]!), slug: decodeURIComponent(m[2]!) };
		return m[3] === "children" ? api.children(ref) : api.abort(ref);
	}) as typeof fetch;
}

/** No panels at all: like the shipped host while the Subagent panel is unavailable. */
const NO_PANELS: typeof PANELS = [];

function Harness() {
	const items = useSubagentChildren("1uk4", "home", PARENT);
	return (
		<>
			<SubagentStrip wolf="1uk4" slug="home" items={items} now={NOW} />
			<RightPanelHost />
		</>
	);
}

async function mount(client: SubClient, opts: { panels?: typeof PANELS; push?: (href: string) => void } = {}) {
	globalThis.fetch = routeFetch(client);
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(
			<AppRouterContext.Provider value={{ push: opts.push ?? (() => {}) } as never}>
				<ServerEventsProvider connect={eventsSource}>
					<PanelHostProvider wolf="1uk4" threadId={PARENT} panels={opts.panels ?? NO_PANELS}>
						<Harness />
					</PanelHostProvider>
				</ServerEventsProvider>
			</AppRouterContext.Provider>,
		);
	});
	await settle();
}

describe("the status strip", () => {
	it("draws nothing for a thread without children", async () => {
		await mount(new SubClient());
		assert.ok(q('[data-testid="subagent-strip"]') === null);
	});

	it("one row per child: agent, title, elapsed, state, step and tokens; Stop only while running", async () => {
		const c = new SubClient();
		c.kids = [child(1), child(2, { state: "queued", queuePosition: 2, startedAt: undefined, step: undefined, tokens: undefined }), child(3, { state: "waiting", step: undefined })];
		await mount(c);
		const rows = qa('[data-testid="subagent-row"]');
		assert.equal(rows.length, 3);
		const t = (row: HTMLElement, id: string) => row.querySelector(`[data-testid="${id}"]`)?.textContent;
		assert.equal(t(rows[0]!, "subagent-agent"), "worker");
		assert.equal(t(rows[0]!, "subagent-title"), "Task 1");
		assert.equal(t(rows[0]!, "subagent-elapsed"), "2m 05s");
		assert.equal(t(rows[0]!, "subagent-state"), "running");
		assert.equal(t(rows[0]!, "subagent-step"), "edit");
		assert.equal(t(rows[0]!, "subagent-tokens"), "12.3k");
		assert.equal(t(rows[1]!, "subagent-state"), "queued #2");
		assert.equal(t(rows[1]!, "subagent-elapsed"), "—");
		assert.equal(t(rows[2]!, "subagent-state"), "waiting on parent");
		assert.equal(qa('[data-testid="subagent-stop"]').length, 1);
		assert.ok(rows[0]!.querySelector('[data-testid="subagent-stop"]'));
	});

	it("thread-updated moves a row in place and adds a new child; another parent's child is ignored", async () => {
		const c = new SubClient();
		c.kids = [child(1)];
		await mount(c);
		await fire(child(1, { step: "bash", tokens: 20_000 }));
		assert.equal(qa('[data-testid="subagent-row"]').length, 1);
		assert.equal(q('[data-testid="subagent-step"]')!.textContent, "bash");
		assert.equal(q('[data-testid="subagent-tokens"]')!.textContent, "20k");
		await fire(child(2));
		assert.equal(qa('[data-testid="subagent-row"]').length, 2);
		await fire(child(9, { parentThreadId: "1uk4/other" }));
		assert.equal(qa('[data-testid="subagent-row"]').length, 2);
		await fire(child(1, { state: "stopped", finishedAt: ago(1000) }));
		assert.ok(!qa('[data-testid="subagent-row"]')[0]!.querySelector('[data-testid="subagent-stop"]'));
	});

	it("a reconnect refetches the children", async () => {
		const c = new SubClient();
		await mount(c);
		assert.equal(qa('[data-testid="subagent-row"]').length, 0);
		c.kids = [child(1)];
		await act(async () => resync());
		await settle();
		assert.equal(qa('[data-testid="subagent-row"]').length, 1);
	});

	it("Stop aborts the child's own thread", async () => {
		const c = new SubClient();
		c.kids = [child(1)];
		await mount(c);
		await click(q('[data-testid="subagent-stop"]')!);
		await settle();
		assert.deepEqual(c.aborted, ["1uk4/sub-1"]);
	});

	it("a click opens the Subagent panel with the child; without the panel it navigates to the child's thread", async () => {
		const c = new SubClient();
		c.kids = [child(1)];
		const pushed: string[] = [];
		await mount(c, { push: (h) => void pushed.push(h) });
		await click(q('[data-testid="subagent-open"]')!);
		assert.deepEqual(pushed, ["/wolf/1uk4/thread/sub-1"]); // no Subagent panel available: fall back to the child's own thread
		root!.unmount();
		document.body.innerHTML = "";
		let opened: unknown;
		const panel = { id: "subagent", label: "Subagent", icon: () => null, available: () => true, render: ({ props }: { props: unknown }) => ((opened = props), null) };
		await mount(c, { panels: [panel] as never, push: (h) => void pushed.push(h) });
		await click(q('[data-testid="subagent-open"]')!);
		assert.deepEqual(opened, { childThreadId: "1uk4/sub-1" });
		assert.equal(pushed.length, 1);
	});
});

describe("the strip's done rows", () => {
	const kids = [
		child(1, { state: "done", finishedAt: ago(5_000) }),
		child(2, { state: "done", finishedAt: ago(10 * 60_000) }),
		child(3, { state: "failed", finishedAt: ago(20 * 60_000) }),
		child(4),
	];
	const view = (expanded: boolean) =>
		renderToStaticMarkup(<SubagentStripView items={kids} now={NOW} expanded={expanded} onToggle={() => {}} onOpen={() => {}} onStop={() => {}} />);

	it("a settled row lingers, then folds into the N done toggle; expanding shows them all", () => {
		const folded = view(false);
		assert.equal((folded.match(/data-testid="subagent-row"/g) ?? []).length, 2); // the fresh done one and the running one
		assert.match(folded, /2 done/);
		assert.equal((view(true).match(/data-testid="subagent-row"/g) ?? []).length, 4);
	});

	it("the toggle expands and collapses the strip", async () => {
		const c = new SubClient();
		c.kids = kids;
		await mount(c);
		assert.equal(qa('[data-testid="subagent-row"]').length, 2);
		await click(q('[data-testid="subagent-done-toggle"]')!);
		assert.equal(qa('[data-testid="subagent-row"]').length, 4);
		await click(q('[data-testid="subagent-done-toggle"]')!);
		assert.equal(qa('[data-testid="subagent-row"]').length, 2);
	});

	it("elapsed ticks while live and freezes at the finish time once settled", () => {
		const at = (now: number) => renderToStaticMarkup(<SubagentStripView items={[child(1), child(2, { state: "done", startedAt: ago(100_000), finishedAt: ago(40_000) })]} now={now} expanded onToggle={() => {}} onOpen={() => {}} onStop={() => {}} />);
		assert.match(at(NOW), /2m 05s/);
		assert.match(at(NOW + 10_000), /2m 15s/);
		assert.equal((at(NOW).match(/1m 00s/g) ?? []).length, 1);
		assert.equal((at(NOW + 60_000).match(/1m 00s/g) ?? []).length, 1);
	});
});

describe("the sidebar", () => {
	const wire = (c: ThreadSummary) => c;
	const rows = core.foldWolfThreads(null, [{ wolf: "1uk4", threads: [wire({ ...FIXTURE_THREAD, id: PARENT, title: "Home" }), child(1), child(2, { state: "done", finishedAt: ago(1000) }), child(3, { state: "failed", finishedAt: ago(1000) })] }]) as (ReturnType<typeof core.threadListItem>)[];

	it("rows carry a subagent's fields", () => {
		const r = rows.find((x) => x.id === "1uk4/sub-1")!;
		assert.equal(r.parentThreadId, PARENT);
		assert.equal(r.state, "running");
		assert.equal(r.taskId, "work-1");
	});

	it("children nest under their parent, collapsed once done; never at the top level", () => {
		const groups = core.sidebarGroups(rows, rows, false, new Set());
		assert.deepEqual(groups.map((g) => g.top.id), [PARENT]);
		assert.deepEqual(groups[0]!.kids.map((k) => k.id), ["1uk4/sub-1"]);
		assert.equal(groups[0]!.done, 2);
		assert.ok(groups[0]!.toggle);
		const open = core.sidebarGroups(rows, rows, false, new Set([PARENT]));
		assert.deepEqual(open[0]!.kids.map((k) => k.id), ["1uk4/sub-1", "1uk4/sub-2", "1uk4/sub-3"]);
		assert.equal(open[0]!.done, 0);
		assert.ok(open[0]!.toggle);
	});

	it("a search finds a child under its parent without collapsing", () => {
		const ranked = rows.filter((r) => r.title === "Task 2");
		const groups = core.sidebarGroups(rows, ranked, true, new Set());
		assert.deepEqual(groups.map((g) => [g.top.id, g.kids.map((k) => k.id)]), [[PARENT, ["1uk4/sub-2"]]]);
	});

	it("an orphan (its parent not listed) stays reachable at the top level", () => {
		const orphans = rows.filter((r) => r.id !== PARENT);
		assert.equal(core.sidebarGroups(orphans, orphans, false, new Set()).length, 3);
	});

	it("a subagent row shows its agent, state and step, indented", () => {
		const html = renderToStaticMarkup(<SessionRow chat={rows.find((r) => r.id === "1uk4/sub-1")!} active={false} onOpen={() => {}} nested />);
		assert.match(html, /worker · running · edit/);
		assert.match(html, /ml-4/);
	});
});

describe("the job panel", () => {
	const jobRows = [
		{ id: "1uk4/home", title: "Home" },
		child(1),
		child(2, { state: "queued", queuePosition: 1, startedAt: undefined }),
		child(3, { state: "done", finishedAt: ago(1000) }),
	] as never[];

	it("draws nothing without subagents", () => {
		assert.equal(renderToStaticMarkup(<SubagentJobs rows={[{ id: "1uk4/home", title: "Home" }] as never[]} onOpen={() => {}} now={NOW} />), "");
	});

	it("lists running and queued with the task link; done ones sit behind a toggle", async () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		const opened: string[] = [];
		await act(async () => root!.render(<AppRouterContext.Provider value={{ push() {}, prefetch() {} } as never}><SubagentJobs rows={jobRows} onOpen={(j) => void opened.push((j as { id: string }).id)} now={NOW} /></AppRouterContext.Provider>)); 
		assert.equal(qa('[data-testid="subagent-job"]').length, 2);
		assert.match(q('[data-testid="subagent-jobs"]')!.textContent!, /queued #1/);
		assert.equal(q('[data-testid="subagent-job-task"]')!.getAttribute("href"), "/kb/work/work-1");
		await click(q('[data-testid="subagent-jobs-done-toggle"]')!);
		assert.equal(qa('[data-testid="subagent-job"]').length, 3);
		await click(qa('[data-testid="subagent-job"] button')[0]!);
		assert.deepEqual(opened, ["1uk4/sub-1"]);
	});
});

describe("the activity bridge", () => {
	it("a wolf's thread-updated goes to the bus as thread-updated, not as a needs-you poke", async () => {
		class WatchClient extends MockConsoleClient {
			async *watchActivity() {
				yield { type: "thread-updated", id: 1, wolf: "1uk4", at: ago(0), thread: child(1) } as never;
				await new Promise(() => {});
			}
		}
		const pokes: string[] = [];
		const threads: unknown[] = [];
		const bridge = createActivityBridge((w) => void pokes.push(w), { emitThread: (w, t) => void threads.push([w, t.id]) });
		bridge.ensure(new WatchClient({ delayMs: 0 }));
		await new Promise((r) => setTimeout(r, 50));
		await new Promise((r) => setTimeout(r, 50));
		bridge.stop();
		assert.deepEqual(threads, [["1uk4", "1uk4/sub-1"]]);
		assert.deepEqual(pokes, []);
	});
});
