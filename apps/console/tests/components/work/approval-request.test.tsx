/** Owner-approval UI against a fixture hub (work-wolfpack-WITFT19): the Work page block, the thread card, the needs-you badge and the Work list's hidden direct controls. Real mounts, stubbed fetch, no network. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<!doctype html><html><body></body></html>");
const mem = new Map<string, string>();
Object.assign(globalThis, {
	window: Object.assign(dom.window, { localStorage: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) } }),
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	HTMLInputElement: dom.window.HTMLInputElement,
	HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
	KeyboardEvent: dom.window.KeyboardEvent,
	Event: dom.window.Event,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	self: globalThis,
	requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
	ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
	getComputedStyle: () => ({ animationName: "none" }),
});
Object.assign(dom.window.Element.prototype, { attachEvent() {}, detachEvent() {} });

const { ServerEventsProvider } = await import("../../../components/shell/server-events.tsx");
const { FakeNav, currentUrl } = await import("../../helpers/fake-nav.tsx");
const { PendingApprovalBlock, ApprovalThreadCard } = await import("../../../components/work/approval-request.tsx");
const { AttachedThreadProvider } = await import("../../../components/chat-bar/attached-thread.tsx");
const { NeedsYouBadge } = await import("../../../components/chat-bar/chat-bar.tsx");
const { WorkList } = await import("../../../components/work/work-view.tsx");
import type { WorkClient } from "../../../components/work/work-client.ts";
import type { WorkListItem } from "../../../src/core/kb/kb.ts";

const contrib = (id: string, title: string, summary: string, body = "") => ({ id, title, summary, body, initiative: false, history: [] });
const graduate = {
	id: "rq1",
	workId: "f1",
	kind: "graduate",
	requestedBy: { wolf: "hal", thread: "hal/t1" },
	requestedAt: "2026-11-20T10:00:00.000Z",
	preview: { contributions: [contrib("c1", "Alpha entry", "First alpha line\nsecond line"), contrib("c2", "Beta entry", "Beta summary"), contrib("c3", "Gamma entry", "", "\nGamma body line\nmore")] },
	target: null,
	status: "pending",
};
const reassign = { id: "rq2", workId: "f1", kind: "reassign", requestedBy: { wolf: "hal" }, requestedAt: "2026-11-20T11:00:00.000Z", preview: null, target: "luka", status: "pending" };

let pending: object[] = [];
let posts: string[] = [];
const handlers = new Map<string, (d: string) => void>();
const fakeSource = () => ({ close() {}, onOpen() {}, onEvent: (n: string, cb: (d: string) => void) => void handlers.set(n, cb) });
const emit = (n: string, d: object) => act(async () => void handlers.get(n)?.(JSON.stringify(d)));
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = String(input);
	if (init?.method === "POST") {
		posts.push(url);
		return Response.json({}, { status: 200 });
	}
	if (url === "/api/work/requests") return Response.json({ requests: pending });
	return new Response("{}", { status: 404 });
}) as typeof fetch;

let root: Root | null = null;
const flush = () => act(async () => void (await Promise.all([1, 2, 3, 4, 5].map(() => new Promise((r) => setImmediate(r))))));
const mount = async (ui: React.ReactNode) => {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => root!.render(<FakeNav start="/work"><ServerEventsProvider connect={fakeSource}><AttachedThreadProvider>{ui}</AttachedThreadProvider></ServerEventsProvider></FakeNav>));
	await flush();
};
const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const qa = (sel: string) => [...document.querySelectorAll(sel)] as HTMLElement[];
const button = (text: string) => qa("button").find((b) => b.textContent?.trim() === text)!;
const props = (el: HTMLElement, name: string) => (el as any)[Object.keys(el).find((k) => k.startsWith("__reactProps$"))!][name];
const click = (el: HTMLElement) => act(async () => void props(el, "onClick")({ currentTarget: el, target: el, preventDefault() {}, stopPropagation() {} }));

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
	pending = [];
	posts = [];
	handlers.clear();
});
after(() => void (globalThis.fetch = realFetch));

describe("PendingApprovalBlock", () => {
	it("shows a graduate request with every contribution and posts approve and reject for its id", async () => {
		pending = [graduate];
		await mount(<PendingApprovalBlock workId="f1" />);
		const text = q("approval-summary")!.textContent!;
		assert.equal(q("approval-summary")!.getAttribute("data-kind"), "graduate");
		assert.match(text, /requested by hal/);
		for (const t of ["Alpha entry", "Beta entry", "Gamma entry"]) assert.match(text, new RegExp(t));
		assert.match(text, /First alpha line/);
		assert.doesNotMatch(text, /second line/);
		assert.match(text, /Gamma body line/, "an empty summary falls back to the body's first line");
		assert.match(text, /3 contributions/);
		await click(button("Approve"));
		await click(button("Reject"));
		assert.deepEqual(posts, ["/api/work/requests/rq1/approve", "/api/work/requests/rq1/reject"]);
	});

	it("shows a reassign request's target and no contributions", async () => {
		pending = [reassign];
		await mount(<PendingApprovalBlock workId="f1" />);
		assert.match(q("approval-summary")!.textContent!, /Assign to luka/);
		assert.doesNotMatch(q("approval-summary")!.textContent!, /contribution/);
	});
});

describe("ApprovalThreadCard", () => {
	it("renders only this thread's and wolf's request, then leaves the decision mark after approve", async () => {
		pending = [graduate, { ...reassign, requestedBy: { wolf: "hal", thread: "hal/other" } }, { ...reassign, id: "rq3", requestedBy: { wolf: "someone", thread: "hal/t1" } }];
		await mount(<ApprovalThreadCard wolf="hal" threadId="hal/t1" />);
		assert.deepEqual(qa('[data-testid="approval-card"]').map((c) => c.getAttribute("data-request")), ["rq1"]);
		await click(button("Approve"));
		pending = [];
		await emit("work-request-changed", { requestId: "rq1", itemId: "f1", kind: "graduate", status: "approved" });
		await flush();
		assert.equal(q("approval-card"), null);
		assert.match(q("approval-card-decided")!.textContent!, /^Approved by you at /);
	});

	it("marks a request rejected on another surface as Rejected", async () => {
		pending = [graduate];
		await mount(<ApprovalThreadCard wolf="hal" threadId="hal/t1" />);
		pending = [];
		await emit("work-request-changed", { requestId: "rq1", itemId: "f1", kind: "graduate", status: "rejected" });
		await flush();
		assert.match(q("approval-card-decided")!.textContent!, /^Rejected at /);
	});
});

describe("NeedsYouBadge", () => {
	const thread = { id: "hal/a", title: "A thread", status: "needs-you", wolf: "hal" } as any;
	const approvals = [
		{ requestId: "rq1", workId: "f1", label: "graduate approval: Feature one", href: "/kb/work/f1" },
		{ requestId: "rq2", workId: "f2", label: "reassign approval: Feature two", href: "/kb/work/f2" },
	];
	it("counts waiting threads plus approvals and chips each approval to its work page", async () => {
		await mount(<NeedsYouBadge waiting={[thread]} all={[thread]} approvals={approvals} />);
		assert.equal(q("chat-bar-needs-you")!.textContent, "3");
		const chips = qa('[data-testid="chat-bar-approval"]');
		assert.deepEqual(chips.map((c) => c.textContent), ["graduate approval: Feature one", "reassign approval: Feature two"]);
		await click(chips[1]!);
		assert.equal(currentUrl(), "/kb/work/f2");
	});
	it("with no waiting thread the badge opens the first approval", async () => {
		await mount(<NeedsYouBadge waiting={[]} all={[]} approvals={[approvals[0]!]} />);
		assert.equal(q("chat-bar-needs-you")!.textContent, "1");
		await click(q("chat-bar-needs-you")!);
		assert.equal(currentUrl(), "/kb/work/f1");
	});
});

describe("the Work list with a pending request", () => {
	const items = [
		{ id: "f1", title: "F1", kind: "feature", stage: "shipped", domain: "wolfpack", dependsOn: [], assignee: "hal", created: "2026-10-05" },
		{ id: "f9", title: "F9", kind: "feature", stage: "shipped", domain: "wolfpack", dependsOn: [], assignee: "hal", created: "2026-10-06" },
		// a feature is ready to graduate only when it has tasks and all are done
		{ id: "t1", title: "T1", kind: "task", stage: "shipped", domain: "wolfpack", dependsOn: [], partOf: "f1", created: "2026-10-05" },
		{ id: "t9", title: "T9", kind: "task", stage: "shipped", domain: "wolfpack", dependsOn: [], partOf: "f9", created: "2026-10-06" },
	] as WorkListItem[];
	const client = {
		domains: async () => [{ name: "wolfpack", label: "Wolfpack" }],
		list: async () => ({ ok: true, data: { items } }),
		assignees: async () => ({ ok: true, data: ["hal", "luka"] }),
		assign: async () => ({ ok: true as const, data: {} }),
	} as unknown as WorkClient;
	it("hides the direct Graduate button and assignee menu only on the item with a pending request", async () => {
		pending = [graduate];
		await mount(<WorkList client={client} />);
		await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
		await flush();
		await click(q("work-toggle-no-initiative")!); // open the Inbox group the loose features sit in
		assert.equal(q("work-graduate-f1"), null);
		assert.ok(q("work-graduate-f9"), "the other item keeps its control");
		const chips = document.querySelectorAll('[data-testid="work-awaiting-approval"]');
		assert.equal(chips.length, 1, "only the pending item shows the chip");
		assert.equal(chips[0]!.textContent, "awaiting approval");
		// Narrow widths: the text is hidden below md and a text-free clock glyph stands in, so the chip cannot crowd out the title.
		assert.equal(chips[0]!.querySelector("span")!.className, "hidden md:inline");
		assert.ok(chips[0]!.querySelector("svg.md\\:hidden"), "compact glyph shows only below md");
		assert.equal(q("work-graduate-f9")!.closest('[data-testid="work-awaiting-approval"]'), null);
		assert.equal(q("work-assignee-f1")!.tagName, "SPAN", "static text, not a menu button");
		assert.equal(q("work-assignee-f9")!.tagName, "BUTTON");
	});
});
