/** The floating chat's sub-agent badges: one per sub-agent, name + live elapsed, a click opens that sub-agent; no table. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });

const { SubagentBadgesView } = await import("../../../components/chat-bar/subagent-badges.tsx");

const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const kid = (id: string, agent: string, over: object = {}) => ({ id: `w/${id}`, wolf: "w", kind: "subagent", title: id, parentThreadId: "w/p", agent, state: "running", startedAt: ago(195_000), ...over }) as never;

let root: Root | null = null;
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});
const props = (el: Element, name: string) => (el as any)[Object.keys(el).find((k) => k.startsWith("__reactProps$"))!][name];

describe("sub-agent badges", () => {
	it("draws one badge per sub-agent with its name and elapsed time, opens it on click, and no table", async () => {
		const opened: string[] = [];
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		await act(async () => root!.render(<SubagentBadgesView items={[kid("a", "worker"), kid("b", "reviewer", { startedAt: ago(5_000) })]} now={NOW} onOpen={(c) => void opened.push(c.id)} />));
		const badges = [...document.querySelectorAll('[data-testid="subagent-badge"]')];
		assert.equal(badges.length, 2);
		assert.match(badges[0]!.textContent ?? "", /worker/);
		assert.match(badges[0]!.textContent ?? "", /3m 15s/);
		assert.match(badges[1]!.textContent ?? "", /reviewer/);
		assert.match(badges[1]!.textContent ?? "", /5s/);
		assert.equal(document.querySelector('[data-testid="subagent-strip"]'), null);
		await act(async () => void props(badges[1]!, "onClick")({}));
		assert.deepEqual(opened, ["w/b"]);
	});
});
