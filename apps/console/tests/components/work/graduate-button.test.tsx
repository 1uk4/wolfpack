/**
 * GraduateButton (work-wolfpack-F85qPOc): click → busy while the preview is prepared → popover with the summary, a More details link,
 * Confirm / Cancel → graduateDirect → the item shows graduated. Node test runner, linkedom, injected fake wolf and a stubbed route.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
	window: Object.assign(dom.window, { innerWidth: 1600 }),
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	KeyboardEvent: dom.window.KeyboardEvent,
	CustomEvent: dom.window.CustomEvent,
	Event: dom.window.Event,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
});

const { GraduateButton } = await import("../../../components/work/graduate-button.tsx");
const { graduateStore } = await import("../../../components/kb/graduate-store.ts");
const { onGraduated } = await import("../../../components/kb/graduation-signal.ts");
import type { GraduateClient } from "../../../components/kb/graduate-client.ts";

const PREVIEW = {
	itemId: "work-wolfpack-F1",
	kind: "feature",
	title: "Caching",
	domain: "wolfpack",
	summary: "Explains how lookups are cached.",
	contributions: [{ id: "c1", title: "How caching works", summary: "s", body: "b", initiative: false, history: [] }],
	foldedObservations: 0,
	warnings: [],
	archive: [{ id: "work-wolfpack-F1", title: "Caching" }],
	token: "tok",
	createdAt: new Date().toISOString(),
	readiness: { ready: true },
};

const fakeClient = (): GraduateClient & { previews: number } => {
	const c = {
		previews: 0,
		wolves: async () => [{ name: "hal", status: "online" }],
		startPreview: async () => (c.previews++, { ok: true as const, data: { jobId: "j", kind: "preview" as const, state: "running" as const, startedAt: "t" } }),
		startConfirm: async () => ({ ok: false as const, reason: "error" as const, message: "unused" }),
		approve: async () => ({ ok: true as const, data: {} }),
		request: async () => ({ ok: false as const, reason: "error" as const, message: "unused" }),
		status: async () => ({ ok: true as const, data: c.previews ? { state: "preview_ready" as const, preview: (held ?? PREVIEW) as typeof PREVIEW } : { state: "none" as const } }),
		observations: async () => ({ ok: true as const, data: { total: 0, byWork: [] } }),
	};
	return c;
};

const realFetch = globalThis.fetch;
let posts: { url: string; body: Record<string, unknown> }[] = [];
// What the wolf's status route answers on the pre-send re-read: the same preview by default.
let held: unknown = null;
const route = (status: number, body: unknown) => {
	held = PREVIEW;
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		if (url.endsWith("/graduate/status")) return Response.json(held ? { state: "preview_ready", preview: held } : { state: "none" });
		posts.push({ url, body: JSON.parse(String(init?.body)) });
		return Response.json(body, { status });
	}) as typeof fetch;
};

let root: Root | null = null;
beforeEach(() => {
	graduateStore.reset();
	graduateStore.pollMs = 5;
	posts = [];
});
afterEach(() => {
	act(() => root?.unmount());
	root = null;
	document.body.innerHTML = "";
	globalThis.fetch = realFetch;
});
const until = async (what: string, cond: () => boolean) => {
	for (let i = 0; i < 200; i++) {
		if (cond()) return;
		await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
	}
	assert.fail(`timed out waiting for ${what}`);
};
const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
async function mount(via: "work" | "graph" = "work") {
	const c = fakeClient();
	const el = document.createElement("div");
	document.body.appendChild(el);
	root = createRoot(el);
	await act(async () => root!.render(<GraduateButton itemId="work-wolfpack-F1" assignee="hal" via={via} title="Caching" client={c} />));
	return c;
}
const click = (id: string) => act(async () => void q(id)!.dispatchEvent(new dom.window.Event("click", { bubbles: true })));

describe("GraduateButton", () => {
	it("prepares the preview, shows summary and a More details link, and Confirm graduates directly", async () => {
		route(200, { itemId: "work-wolfpack-F1", domain: "wolfpack", sent: 1, archived: 1, via: "graph", approvedBy: { actor: "owner", device: "d", at: "t" } });
		const signalled: string[] = [];
		const off = onGraduated((id) => signalled.push(id));
		await mount("graph");
		await click("graduate-button");
		await until("popover", () => q("graduate-popover") !== null);
		assert.match(q("graduate-popover")!.textContent ?? "", /Explains how lookups are cached\./);
		assert.equal(q("graduate-more")!.getAttribute("href"), "/work/work-wolfpack-F1?view=graduation&wolf=hal");
		await click("graduate-confirm");
		await until("graduated", () => q("graduate-button")?.getAttribute("data-phase") === "graduated");
		assert.equal(posts[0]?.url, "/api/work/work-wolfpack-F1/graduate-direct");
		assert.deepEqual(posts[0]?.body, { contributions: PREVIEW.contributions, summary: PREVIEW.summary, via: "graph", wolf: "hal" });
		assert.deepEqual(signalled, ["work-wolfpack-F1"]);
		assert.equal(graduateStore.get("work-wolfpack-F1"), undefined);
		off();
	});

	it("shows a failed confirm inline and treats 'already graduated' as done", async () => {
		route(403, { error: "owner only", code: "forbidden" });
		await mount();
		await click("graduate-button");
		await until("popover", () => q("graduate-popover") !== null);
		await click("graduate-confirm");
		await until("error", () => /owner only/.test(q("graduate-error")?.textContent ?? ""));
		assert.notEqual(q("graduate-popover"), null);
		route(400, { error: "item is already graduated", code: "invalid_request" });
		await click("graduate-confirm");
		await until("graduated", () => q("graduate-button")?.getAttribute("data-phase") === "graduated");
	});

	it("does not send a preview that changed after the popover showed it, and shows the fresh one", async () => {
		route(200, { itemId: "work-wolfpack-F1", domain: "wolfpack", sent: 1, archived: 1, via: "work", approvedBy: { actor: "owner", device: "d", at: "t" } });
		await mount();
		await click("graduate-button");
		await until("popover", () => q("graduate-popover") !== null);
		held = { ...PREVIEW, token: "tok2", summary: "A rewritten summary." };
				await click("graduate-confirm");
		await until("changed notice", () => /The preview changed, review it again/.test(document.body.textContent ?? ""));
		assert.equal(posts.length, 0);
		await until("fresh summary", () => /A rewritten summary\./.test(q("graduate-popover")?.textContent ?? ""));
		assert.equal(graduateStore.get("work-wolfpack-F1")?.phase, "ready");
	});

	it("does not send when the wolf's preview has expired", async () => {
		route(200, {});
		await mount();
		await click("graduate-button");
		await until("popover", () => q("graduate-popover") !== null);
		held = { ...PREVIEW, createdAt: "not a date" };
		await click("graduate-confirm");
		await until("notice", () => /The preview changed, review it again/.test(document.body.textContent ?? ""));
		assert.equal(posts.length, 0);
	});

	it("sends one request when Confirm is clicked twice in the same tick", async () => {
		route(200, { itemId: "work-wolfpack-F1", domain: "wolfpack", sent: 1, archived: 1, via: "work", approvedBy: { actor: "owner", device: "d", at: "t" } });
		await mount();
		await click("graduate-button");
		await until("popover", () => q("graduate-popover") !== null);
		const confirm = q("graduate-confirm")!;
		await act(async () => {
			confirm.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
			confirm.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
		});
		await until("graduated", () => q("graduate-button")?.getAttribute("data-phase") === "graduated");
		assert.equal(posts.length, 1);
	});

	it("is disabled up front, with the reason as its title, when the item has no assignee", async () => {
		const el = document.createElement("div");
		document.body.appendChild(el);
		root = createRoot(el);
		await act(async () => root!.render(<GraduateButton itemId="work-wolfpack-F1" via="work" title="Caching" client={fakeClient()} />));
		const b = q("graduate-button") as HTMLButtonElement;
		assert.equal(b.disabled, true);
		assert.match(b.getAttribute("title") ?? "", /no assignee/i);
	});
});
