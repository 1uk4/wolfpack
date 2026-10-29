/** The subagent status strip, sidebar nesting and the job panel, over the injected fake client (the console's server layer). */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
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
const { SubagentModalProvider } = await import("../components/subagent-modal.tsx");
const { SubagentStrip, SubagentStripView, useSubagentChildren } = await import("../components/subagent-strip.tsx");
const { ActivitySection } = await import("../components/activity-dock.tsx");
const { SessionRow, SessionsSidebar } = await import("../components/sidebar.tsx");
const { SidebarProvider } = await import("../components/sidebar.tsx");
const { ServerEventsProvider } = await import("../components/server-events.tsx");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
const core = await import("../src/core/index.ts");

const DONE = 30_000;
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
	/** listChildren answers this many ms late, with the list as it was when asked. */
	childrenDelay = 0;
	abortFails = false;
	constructor() {
		super({ delayMs: 0 });
	}
	override async listThreads(wolf: string) {
		return [...(await super.listThreads(wolf)), ...this.kids];
	}
	async listChildren(id: string) {
		const snapshot = this.kids.filter((k) => k.parentThreadId === id);
		if (this.childrenDelay) await new Promise((r) => setTimeout(r, this.childrenDelay));
		return snapshot;
	}
	override async abort(id: string) {
		if (this.abortFails) throw new Error("boom");
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

let liveClock = false;
function Harness() {
	const items = useSubagentChildren("1uk4", "home", PARENT);
	return (
		<>
			<SubagentStrip wolf="1uk4" slug="home" items={items} now={liveClock ? undefined : NOW} />
		</>
	);
}

async function mount(client: SubClient, opts: { push?: (href: string) => void } = {}) {
	globalThis.fetch = routeFetch(client);
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(
			<AppRouterContext.Provider value={{ push: opts.push ?? (() => {}) } as never}>
				<ServerEventsProvider connect={eventsSource}>
					<SubagentModalProvider>
						<Harness />
					</SubagentModalProvider>
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

	it("a click opens the subagent modal over the page, without navigating", async () => {
		const c = new SubClient();
		c.kids = [child(1)];
		const pushed: string[] = [];
		await mount(c, { push: (h) => void pushed.push(h) });
		assert.equal(q('[data-testid="subagent-modal"]'), null);
		await click(q('[data-testid="subagent-open"]')!);
		await settle();
		assert.equal(q('[data-testid="subagent-view"]')!.getAttribute("data-child"), "1uk4/sub-1");
		assert.deepEqual(pushed, []);
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

	it("a settled row lingers, then folds away with no N done row", () => {
		const folded = view(false);
		assert.equal((folded.match(/data-testid="subagent-row"/g) ?? []).length, 2); // the fresh done one and the running one
		assert.doesNotMatch(folded, /\d+ done|subagent-done-toggle/);
		assert.equal((view(true).match(/data-testid="subagent-row"/g) ?? []).length, 4);
	});

	it("the mounted strip has no done toggle", async () => {
		const c = new SubClient();
		c.kids = kids;
		await mount(c);
		assert.equal(qa('[data-testid="subagent-row"]').length, 2);
		assert.equal(q('[data-testid="subagent-done-toggle"]'), null);
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

	it("a closed (graduated) thread is marked archived", () => {
		const [closed, open] = core.foldWolfThreads(null, [{ wolf: "1uk4", threads: [wire({ ...FIXTURE_THREAD, id: "1uk4/f1", title: "Done feature", closed: true }), wire({ ...FIXTURE_THREAD, id: "1uk4/f2", title: "Live feature" })] }]) as (ReturnType<typeof core.threadListItem>)[];
		assert.equal(closed!.archived, true);
		assert.equal(open!.archived, undefined);
	});

	it("rows carry a subagent's fields", () => {
		const r = rows.find((x) => x.id === "1uk4/sub-1")!;
		assert.equal(r.parentThreadId, PARENT);
		assert.equal(r.state, "running");
		assert.equal(r.taskId, "work-1");
	});

	it("children nest under their parent; settled ones are not listed; never at the top level", () => {
		const groups = core.sidebarGroups(rows, rows, false, new Set());
		assert.deepEqual(groups.map((g) => g.top.id), [PARENT]);
		assert.deepEqual(groups[0]!.kids.map((k) => k.id), ["1uk4/sub-1"]);
		assert.equal(groups[0]!.done, 0);
		assert.ok(!groups[0]!.toggle);
		const open = core.sidebarGroups(rows, rows, false, new Set([PARENT]));
		assert.deepEqual(open[0]!.kids.map((k) => k.id), ["1uk4/sub-1"]);
	});

	it("a search finds a live child under its parent, never a settled one", () => {
		const ranked = rows.filter((r) => r.title === "Task 1" || r.title === "Task 2");
		const groups = core.sidebarGroups(rows, ranked, true, new Set());
		assert.deepEqual(groups.map((g) => [g.top.id, g.kids.map((k) => k.id)]), [[PARENT, ["1uk4/sub-1"]]]);
	});

	it("a subagent whose parent is not listed is never a top-level row", () => {
		const orphans = rows.filter((r) => r.id !== PARENT);
		assert.equal(core.sidebarGroups(orphans, orphans, false, new Set()).length, 0);
	});

	it("a subagent row shows its agent, state and step, indented", () => {
		const html = renderToStaticMarkup(<SessionRow chat={rows.find((r) => r.id === "1uk4/sub-1")!} active={false} onOpen={() => {}} nested />);
		assert.match(html, />Task 1<\/span><span> · worker</);
		assert.match(html, /data-compact="true"/);
		assert.match(html, /ml-8/);
		assert.match(html, /text-xs/);
		assert.doesNotMatch(html.replace(/title="[^"]*"/, ""), /running · edit/); // no second line (the state is only a tooltip)
		assert.match(html, /braille-spinner/);
	});

	it("a feature row sits one step under Home with a guide line; Home does not", () => {
		const feat = { ...rows.find((r) => r.id === PARENT)!, kind: "feature" };
		assert.match(renderToStaticMarkup(<SessionRow chat={feat} active={false} onOpen={() => {}} indented />), /ml-4[^"]*border-l/);
		assert.doesNotMatch(renderToStaticMarkup(<SessionRow chat={{ ...feat, kind: "home" }} active={false} onOpen={() => {}} />), /ml-4/);
	});

	it("the kind rides the list row", () => {
		const [h] = core.foldWolfThreads(null, [{ wolf: "1uk4", threads: [wire({ ...FIXTURE_THREAD, id: "1uk4/home", title: "Home", kind: "home" })] }]) as (ReturnType<typeof core.threadListItem>)[];
		assert.equal(h!.kind, "home");
		assert.equal(h!.title, "1uk4"); // labelled by the wolf, found by kind not title
		assert.equal(h!.alias, "Home");
	});

	it("the Home row shows the wolf with an orchestrator icon; search finds it by wolf name and by home", () => {
		const [h] = core.foldWolfThreads(null, [{ wolf: "1uk4", threads: [wire({ ...FIXTURE_THREAD, id: "1uk4/home", title: "Home", kind: "home" })] }]) as (ReturnType<typeof core.threadListItem>)[];
		const html = renderToStaticMarkup(<SessionRow chat={h!} active={false} onOpen={() => {}} />);
		assert.match(html, /orchestrator-icon/);
		assert.match(html, />1uk4</);
		assert.match(html, />orchestrator</);
		assert.doesNotMatch(html, />Home</);
		assert.notEqual(core.fuzzyScore("1uk", h!.title), null);
		assert.notEqual(core.fuzzyScore("home", h!.alias!), null);
		assert.equal(core.threadLabel("1uk4", { kind: "feature", title: "Home" }), "Home"); // by kind, not title
	});
});

describe("the compact subagent row", () => {
	const html = (over: Partial<ThreadSummary>) => {
		const r = core.foldWolfThreads(null, [{ wolf: "1uk4", threads: [child(1, over)] }])[0] as never;
		return renderToStaticMarkup(<AppRouterContext.Provider value={{ push() {}, prefetch() {} } as never}><SessionRow chat={r} active={false} onOpen={() => {}} nested /></AppRouterContext.Provider>);
	};

	it("the running row animates the braille glyph; waiting/queued stays still and muted", () => {
		const run = html({});
		assert.match(run, /braille-frame/);
		assert.match(run, /data-frame="9"/);
		const wait = html({ state: "queued", queuePosition: 1, startedAt: undefined });
		assert.doesNotMatch(wait, /braille-frame/);
		assert.match(wait, /braille-spinner/);
		assert.match(wait, /text-muted-foreground\/60/);
		assert.match(wait, /queued #1/); // full state in the tooltip
	});

	it("the task it serves is a link on the row, and the old Subagents panel is gone", () => {
		assert.match(html({}), /href="\/kb\/work\/work-1"/);
		assert.doesNotMatch(html({}), /subagent-jobs/);
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

describe("the fetch/event race", () => {
	it("an event during the mount fetch is laid over the fetched list: siblings and the patch both survive", async () => {
		const c = new SubClient();
		c.kids = [child(1), child(2)];
		c.childrenDelay = 80;
		const pending = mount(c);
		await new Promise((r) => setTimeout(r, 20));
		await fire(child(3)); // a new child announced while the fetch (which cannot know it) is out
		await fire(child(1, { step: "bash" }));
		await pending;
		await settle(120);
		assert.deepEqual(qa('[data-testid="subagent-row"]').map((r) => r.dataset.child), ["1uk4/sub-1", "1uk4/sub-2", "1uk4/sub-3"]);
		assert.equal(qa('[data-testid="subagent-step"]')[0]!.textContent, "bash");
	});

	it("the same after a reconnect, and on the wolf stream's needs-you baseline", async () => {
		const c = new SubClient();
		c.kids = [child(1)];
		await mount(c);
		c.kids = [child(1), child(2)];
		c.childrenDelay = 80;
		await act(async () => resync());
		await new Promise((r) => setTimeout(r, 20));
		await fire(child(3));
		await settle(150);
		assert.equal(qa('[data-testid="subagent-row"]').length, 3);
		c.childrenDelay = 0;
		c.kids = [child(1), child(2), child(3), child(4)];
		await act(async () => frames.get("needs-you-changed")!(JSON.stringify({ wolf: "1uk4" })));
		await settle();
		assert.equal(qa('[data-testid="subagent-row"]').length, 4);
		await act(async () => frames.get("needs-you-changed")!(JSON.stringify({ wolf: "1uk4", threadId: "1uk4/home", kind: "status" })));
		c.kids = [];
		await settle();
		assert.equal(qa('[data-testid="subagent-row"]').length, 4); // a named thread's change is not a baseline
	});
});

describe("the clock", () => {
	it("elapsed ticks each second, a queued row does not, and a settled row folds when its linger passes", async () => {
		mock.timers.enable({ apis: ["setInterval", "Date"], now: NOW });
		liveClock = true;
		try {
			const c = new SubClient();
			c.kids = [
				child(1, { startedAt: ago(0) }),
				child(2, { state: "queued", queuePosition: 1, startedAt: undefined }),
				child(3, { state: "done", startedAt: ago(60_000), finishedAt: ago(0) }),
			];
			await mount(c);
			const text = (n: number, id: string) => qa('[data-testid="subagent-row"]')[n]!.querySelector(`[data-testid="${id}"]`)!.textContent;
			assert.equal(text(0, "subagent-elapsed"), "0s");
			await act(async () => mock.timers.tick(5_000));
			assert.equal(text(0, "subagent-elapsed"), "5s");
			assert.equal(text(1, "subagent-elapsed"), "—");
			assert.equal(qa('[data-testid="subagent-row"]').length, 3);
			await act(async () => mock.timers.tick(DONE + 1_000));
			assert.equal(qa('[data-testid="subagent-row"]').length, 2); // the done row folded away
			assert.equal(q('[data-testid="subagent-done-toggle"]'), null);
		} finally {
			liveClock = false;
			mock.timers.reset();
		}
	});
});

describe("Stop", () => {
	it("a failed stop says so, and the message clears when the child's state changes", async () => {
		const c = new SubClient();
		c.kids = [child(1)];
		c.abortFails = true;
		await mount(c);
		await click(q('[data-testid="subagent-stop"]')!);
		await settle();
		assert.match(q('[data-testid="subagent-stop-error"]')!.textContent!, /Could not stop worker/);
		await fire(child(1, { state: "stopped", finishedAt: ago(0) }));
		assert.ok(q('[data-testid="subagent-stop-error"]') === null);
	});
});

describe("the legacy activity section", () => {
	it("hideWhenEmpty draws nothing without jobs; without the flag the header stays", () => {
		assert.equal(renderToStaticMarkup(<ActivitySection feed={{ jobs: [] }} hideWhenEmpty />), "");
		assert.match(renderToStaticMarkup(<ActivitySection feed={{ jobs: [] }} />), /Background agents/);
		const job = { id: "j", kind: "research", chatId: "c", toolCallId: "t", status: "running", activity: "x", createdAt: ago(1000), updatedAt: ago(0), title: "T", contextLimit: null };
		assert.match(renderToStaticMarkup(<ActivitySection feed={{ jobs: [job] as never }} hideWhenEmpty />), /Background agents/);
	});
});

describe("sidebarLayout: a subagent is never a top-level row", () => {
	type R = { id: string; kind?: string; parentThreadId?: string; state?: "running" | "waiting" | "queued" | "done" | "failed" | "stopped"; archived?: boolean };
	const home: R = { id: "home", kind: "home" };
	const feat: R = { id: "feat", kind: "feature", archived: true };
	const live: R = { id: "live", kind: "subagent", parentThreadId: "gone", state: "running" };
	const ids = (gs: { top: R; kids: R[] }[]) => gs.map((g) => [g.top.id, g.kids.map((k) => k.id)]);

	it("defensive: odd parents never crash or surface as rows", () => {
		const rows: R[] = [{ id: "a" }, { id: "b", parentThreadId: "a" }, { id: "c", parentThreadId: "b" }, { id: "d", parentThreadId: "gone" }];
		assert.deepEqual(core.sidebarGroups(rows, rows, false).map((g) => g.top.id), ["a"]);
		assert.doesNotThrow(() => core.sidebarGroups(rows, [{ id: "zzz", parentThreadId: "nope" }], true));
	});

	it("(a) a closed parent whose children are settled shows none of them anywhere", () => {
		const rows: R[] = [home, feat, ...["done", "failed", "stopped"].map((st, i): R => ({ id: `k${i}`, kind: "subagent", parentThreadId: "feat", state: st as R["state"] }))];
		const l = core.sidebarLayout(rows, rows, false);
		assert.deepEqual(ids(l.groups), [["home", []]]);
		assert.deepEqual(ids(l.archived), [["feat", []]]);
		const q = core.sidebarLayout(rows, rows, true);
		assert.deepEqual([...ids(q.groups), ...ids(q.archived)], [["home", []], ["feat", []]]);
	});

	it("(b) a missing parent with a settled child shows nothing", () => {
		const rows: R[] = [home, { id: "x", kind: "subagent", parentThreadId: "gone", state: "done" }];
		assert.deepEqual(ids(core.sidebarLayout(rows, rows, false).groups), [["home", []]]);
		assert.deepEqual(core.sidebarLayout([{ id: "x", kind: "subagent", parentThreadId: "gone", state: "failed" }], [{ id: "x", kind: "subagent", state: "failed" }], true), { groups: [], archived: [] });
	});

	it("(c) a live child of an archived parent nests under it, not top level; a live orphan falls under Home", () => {
		const k: R = { id: "k", kind: "subagent", parentThreadId: "feat", state: "running" };
		const rows: R[] = [home, feat, k, live];
		const l = core.sidebarLayout(rows, rows, false);
		assert.deepEqual(ids(l.archived), [["feat", ["k"]]]);
		assert.deepEqual(ids(l.groups), [["home", ["live"]]]);
		// no Home: the orphan is dropped, never promoted
		assert.deepEqual(core.sidebarLayout([live], [live], false), { groups: [], archived: [] });
		// a subagent without a parentThreadId is still never top level
		const bare: R = { id: "bare", kind: "subagent", state: "running" };
		assert.deepEqual(ids(core.sidebarLayout([home, bare], [home, bare], false).groups), [["home", ["bare"]]]);
	});
});

describe("subagent openers: the modal opens over the page, with the wolf the caller knows, no navigation", () => {
	const wire = (n: number) => ({ ...child(n), status: "busy" });
	async function mountSidebar(pushed: string[], urls: string[]) {
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const u = new URL(String(input), "http://t");
			urls.push(u.pathname);
			if (u.pathname === "/api/wolves") return Response.json({ wolves: [{ name: "1uk4" }] });
			if (u.pathname === "/api/wolves/1uk4/threads") return Response.json({ threads: [{ id: PARENT, title: "Home" }, wire(1)] });
			return new Response("{}", { status: 404 });
		}) as typeof fetch;
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		await act(async () => {
			root!.render(
				<AppRouterContext.Provider value={{ push: (h: string) => void pushed.push(h), prefetch() {} } as never}>
					<ServerEventsProvider connect={eventsSource}>
						<SubagentModalProvider>
							<SidebarProvider>
								<SessionsSidebar />
							</SidebarProvider>
						</SubagentModalProvider>
					</ServerEventsProvider>
				</AppRouterContext.Provider>,
			);
		});
		await settle(60);
	}
	(dom.window.Element.prototype as unknown as Record<string, unknown>).scrollIntoView = () => {};
	const rowButton = (title: string) => qa("button").find((b) => b.textContent?.includes(title))!;

	it("a sidebar child row click opens the modal and does not navigate", async () => {
		const pushed: string[] = [];
		const urls: string[] = [];
		await mountSidebar(pushed, urls);
		await click(rowButton("Task 1"));
		await settle();
		assert.equal(q('[data-testid="subagent-view"]')!.getAttribute("data-child"), "1uk4/sub-1");
		assert.deepEqual(pushed, []);
		assert.ok(urls.some((u) => u.startsWith("/api/wolves/1uk4/threads/sub-1")));
	});

	it("a normal sidebar row still navigates", async () => {
		const pushed: string[] = [];
		await mountSidebar(pushed, []);
		await click(rowButton("Home"));
		assert.equal(pushed.length, 1);
		assert.equal(q('[data-testid="subagent-modal"]'), null);
	});

	it("Enter on the search walk opens a subagent row in the modal and does not navigate", async () => {
		const pushed: string[] = [];
		await mountSidebar(pushed, []);
		const input = q('[data-testid="session-search"]')!;
		const key = Object.keys(input).find((k) => k.startsWith("__reactProps$"))!;
		const press = (k: string) =>
			act(async () => void (input as unknown as Record<string, { onKeyDown: (e: unknown) => void }>)[key]!.onKeyDown({ key: k, preventDefault() {}, currentTarget: { blur() {} } }));
		await press("ArrowDown"); // Home
		await press("ArrowDown"); // the subagent under it
		await press("Enter");
		await settle();
		assert.equal(q('[data-testid="subagent-view"]')!.getAttribute("data-child"), "1uk4/sub-1");
		assert.deepEqual(pushed, []);
	});
});
