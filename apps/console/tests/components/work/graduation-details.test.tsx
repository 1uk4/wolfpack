/**
 * The "More details" view of a graduation (/work/<id>?view=graduation&wolf=<name>, work-wolfpack-F85qPOc): summary on top, then every
 * contribution readable; with no preview, a Prepare button. Node test runner, linkedom, fetch stubbed at the console route.
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
	CustomEvent: dom.window.CustomEvent,
	Event: dom.window.Event,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const { GraduationDetails } = await import("../../../components/work/graduation-details.tsx");
const { graduateStore } = await import("../../../components/kb/graduate-store.ts");
const { dataStore } = await import("../../../src/core/data-store.ts");

const PREVIEW = {
	itemId: "work-wolfpack-F1",
	kind: "feature",
	title: "Caching",
	domain: "wolfpack",
	summary: "Explains how lookups are cached.",
	contributions: [
		{ id: "c1", title: "How caching works", summary: "s", body: "Cached for five minutes.", initiative: false, history: [], target: "kb-wolfpack-abc1234" },
		{ id: "c2", title: "Cache keys", summary: "s2", body: "Keys are hashed.", initiative: false, history: [] },
	],
	foldedObservations: 0,
	warnings: [],
	archive: [],
	token: "tok",
	createdAt: new Date().toISOString(),
	readiness: { ready: true },
};

const realFetch = globalThis.fetch;
let root: Root | null = null;
let urls: string[] = [];
const stub = (status: unknown) => {
	globalThis.fetch = (async (url: string) => {
		urls.push(url);
		return Response.json(status);
	}) as typeof fetch;
};
beforeEach(() => {
	graduateStore.reset();
	dataStore.clear();
	urls = [];
});
afterEach(() => {
	graduateStore.reset();
	act(() => root?.unmount());
	root = null;
	document.body.innerHTML = "";
	globalThis.fetch = realFetch;
});
const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const until = async (what: string, cond: () => boolean) => {
	for (let i = 0; i < 200; i++) {
		if (cond()) return;
		await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
	}
	assert.fail(`timed out waiting for ${what}`);
};
async function mount(p: { wolf?: string; assignee?: string; ready?: boolean; reason?: string } = {}) {
	const el = document.createElement("div");
	document.body.appendChild(el);
	root = createRoot(el);
	await act(async () => root!.render(<GraduationDetails itemId="work-wolfpack-F1" wolf={p.wolf ?? "hal"} assignee={p.assignee ?? "hal"} ready={p.ready ?? true} reason={p.reason} />));
}

describe("GraduationDetails", () => {
	it("shows the summary on top, then each contribution's title, target and body", async () => {
		stub({ state: "preview_ready", preview: PREVIEW });
		await mount();
		await until("the summary", () => q("graduation-summary") !== null);
		assert.equal(urls[0], "/api/wolves/hal/work/work-wolfpack-F1/graduate/status");
		assert.equal(q("graduation-summary")!.textContent, "Explains how lookups are cached.");
		const parts = [...document.querySelectorAll('[data-testid="graduation-contribution"]')].map((e) => e.textContent ?? "");
		assert.equal(parts.length, 2);
		assert.match(parts[0]!, /How caching works/);
		assert.match(parts[0]!, /kb-wolfpack-abc1234/);
		assert.match(parts[0]!, /Cached for five minutes\./);
		assert.match(parts[1]!, /Keys are hashed\./);
	});

	it("says No graduation preview prepared and offers Prepare when the wolf holds none", async () => {
		stub({ state: "none" });
		await mount();
		await until("the empty state", () => q("graduation-none") !== null);
		assert.match(q("graduation-none")!.textContent ?? "", /No graduation preview prepared/);
		assert.equal(q("graduation-prepare")!.textContent, "Prepare");
	});

	it("notes when the preview was prepared by a wolf other than the assignee", async () => {
		stub({ state: "preview_ready", preview: PREVIEW });
		await mount({ wolf: "hal", assignee: "kit" });
		await until("the summary", () => q("graduation-summary") !== null);
		assert.equal(q("graduation-wolf-note")!.textContent, "Preview prepared by hal, not the assignee kit");
	});

	it("shows no wolf note when the preview wolf is the assignee", async () => {
		stub({ state: "preview_ready", preview: PREVIEW });
		await mount({ wolf: "hal", assignee: "hal" });
		await until("the summary", () => q("graduation-summary") !== null);
		assert.equal(q("graduation-wolf-note"), null);
	});

	it("offers no Prepare for an item that is not ready, and shows the reason instead", async () => {
		stub({ state: "none" });
		await mount({ ready: false, reason: "2 tasks not complete" });
		await until("the empty state", () => q("graduation-none") !== null);
		assert.equal(q("graduation-prepare"), null);
		assert.match(q("graduation-none")!.textContent ?? "", /Not ready to graduate: 2 tasks not complete/);
	});
});
