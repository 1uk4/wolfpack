/**
 * Graduate is blocked while the item's feature thread runs (work-wolfpack-3EYS8mM). Pure read of the wolf's thread list, plus the
 * button: disabled with the "thread still running" tooltip, enabled again when a refreshed list shows the thread idle.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
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

const { runningItemIds, threadRunningStore } = await import("../../../components/work/thread-running.ts");
const { MultiRenderer } = await import("../../../components/ask/card-fields/multi.tsx");
const { GraduateButton } = await import("../../../components/work/graduate-button.tsx");
import type { GraduateClient } from "../../../components/kb/graduate-client.ts";

describe("runningItemIds", () => {
	it("marks a feature whose thread has a turn or a live sub-agent, not idle, closed or other threads", () => {
		const rows = [
			{ id: "t1", kind: "feature", boundWorkItem: "work-w-A", status: "busy" },
			{ id: "t2", kind: "feature", boundWorkItem: "work-w-B", status: "idle" },
			{ id: "t3", kind: "feature", boundWorkItem: "work-w-C", status: "idle" },
			{ id: "s3", parentThreadId: "t3", state: "running" },
			{ id: "t4", kind: "feature", boundWorkItem: "work-w-D", status: "idle" },
			{ id: "s4", parentThreadId: "t4", state: "done" },
			{ id: "t5", kind: "feature", boundWorkItem: "work-w-E", status: "busy", closed: true },
			{ id: "home", kind: "home", status: "busy" },
		];
		assert.deepEqual([...runningItemIds(rows)].sort(), ["work-w-A", "work-w-C"]);
	});
});

describe("the thread list store", () => {
	it("shares one in-flight read per wolf, re-reads once after a refresh that arrived meanwhile, and drops an answer that a reset overtook", async () => {
		const gates: Array<(rows: unknown[]) => void> = [];
		let calls = 0;
		threadRunningStore.load = () => new Promise((resolve) => {
			calls++;
			gates.push(resolve as (rows: unknown[]) => void);
		});
		const busy = [{ id: "t1", kind: "feature", boundWorkItem: "work-w-A", status: "busy" }];
		const a = threadRunningStore.refresh("hal");
		const b = threadRunningStore.refresh("hal");
		const c = threadRunningStore.refresh("hal");
		assert.equal(calls, 1, "three callers, one read");
		gates[0]!([]);
		await new Promise((r) => setTimeout(r, 0));
		assert.equal(calls, 2, "one trailing read for the refreshes that arrived during the first");
		gates[1]!(busy);
		await Promise.all([a, b, c]);
		assert.equal(threadRunningStore.running("hal", "work-w-A"), true);
		assert.equal(calls, 2);
		const d = threadRunningStore.refresh("hal");
		threadRunningStore.reset();
		gates[2]!(busy);
		await d;
		assert.equal(threadRunningStore.running("hal", "work-w-A"), false, "the stale answer is not applied after the reset");
	});
});

let root: Root | undefined;
afterEach(() => {
	act(() => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
	threadRunningStore.reset();
});

const noClient = {} as GraduateClient;
const flush = async () => {
	await act(async () => {
		await new Promise((r) => setTimeout(r, 0));
	});
};

describe("the batch graduation card", () => {
	it("shows an item whose thread is running but does not let it be picked, and lets it be picked once idle", async () => {
		let rows: unknown[] = [{ id: "t1", kind: "feature", boundWorkItem: "work-w-A", status: "busy" }];
		threadRunningStore.load = async () => rows as never;
		const field = {
			id: "picked",
			kind: "multi",
			label: "Pick",
			options: [
				{ value: "work-w-A", label: "Feature A", href: "/work/work-w-A?view=graduation&wolf=hal" },
				{ value: "work-w-B", label: "Feature B", href: "/work/work-w-B?view=graduation&wolf=hal" },
			],
		};
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		const props = { field, value: undefined, readOnly: false, onChange: () => {}, onClear: () => {}, labelledBy: "l", typed: "", onType: () => {}, dictation: {} };
		await act(async () => {
			root!.render(React.createElement(MultiRenderer as unknown as React.ComponentType<Record<string, unknown>>, props));
		});
		await flush();
		const opt = (v: string) => host.querySelector('[data-testid="card-option"][data-value="' + v + '"]') as HTMLButtonElement;
		assert.equal(opt("work-w-A").disabled, true);
		assert.match(opt("work-w-A").getAttribute("aria-label") ?? "", /thread still running/i);
		assert.equal(opt("work-w-B").disabled, false);
		rows = [];
		await act(async () => {
			await threadRunningStore.refresh("hal");
		});
		assert.equal(opt("work-w-A").disabled, false);
	});
});

describe("GraduateButton while the feature thread runs", () => {
	it("is disabled with the still-running tooltip while busy and enabled again once the thread goes idle, with no reload", async () => {
		let rows: unknown[] = [{ id: "t1", kind: "feature", boundWorkItem: "work-w-A", status: "busy" }];
		threadRunningStore.load = async () => rows as never;
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		await act(async () => {
			root!.render(<GraduateButton itemId="work-w-A" assignee="hal" via="work" client={noClient} />);
		});
		await flush();
		const btn = () => host.querySelector('[data-testid="graduate-button"]') as HTMLButtonElement;
		assert.equal(btn().disabled, true);
		assert.equal(btn().getAttribute("data-phase"), "thread-running");
		assert.match(btn().getAttribute("aria-label") ?? "", /thread still running/i);

		rows = [{ id: "t1", kind: "feature", boundWorkItem: "work-w-A", status: "idle" }];
		await act(async () => {
			await threadRunningStore.refresh("hal");
		});
		assert.equal(btn().disabled, false);
		assert.equal(btn().getAttribute("data-phase"), "idle");
	});
});
