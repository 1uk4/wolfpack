/** The pinned Needs-you section and the thread-row dot (SSR render + handlers). */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NeedsYouSection, waitingFor } from "../components/needs-you.tsx";
import { SessionRow } from "../components/sidebar.tsx";
import { itemKey, threadListItem, type NeedsYouItem } from "../src/core/index.ts";

const item = (callId: string, over: Partial<NeedsYouItem> = {}): NeedsYouItem => ({
	wolf: "1uk4",
	threadId: "1uk4/home",
	threadTitle: "Home",
	slug: "home",
	href: "/wolf/1uk4/thread/home",
	callId,
	card: { tool: "ask_user_question", fields: [{ id: "answer", kind: "free-text", label: "Which branch?" }] },
	raisedAt: "2026-10-26T10:00:00.000Z",
	...over,
});
const noop = () => {};
const render = (items: NeedsYouItem[], extra: Partial<React.ComponentProps<typeof NeedsYouSection>> = {}) =>
	renderToStaticMarkup(
		<NeedsYouSection items={items} expandedKey={null} now={new Date("2026-10-26T10:05:00.000Z")} onToggle={noop} onAnswer={noop} onOpen={noop} {...extra} />,
	);

describe("NeedsYouSection", () => {
	it("renders nothing when nothing waits", () => {
		assert.equal(render([]), "");
	});

	it("shows the count badge and one row per card: wolf, thread, headline, age", () => {
		const html = render([item("c1"), item("c2", { threadTitle: "Feature", card: { tool: "ask_user_question", title: "Release", fields: [{ id: "a", kind: "free-text", label: "x" }] } })]);
		assert.match(html, /data-testid="needs-you-count"[^>]*>2</);
		assert.equal((html.match(/data-testid="needs-you-row"/g) ?? []).length, 2);
		assert.ok(html.includes("1uk4 · Home") && html.includes("1uk4 · Feature"));
		assert.ok(html.includes("Which branch?") && html.includes("Release"));
		assert.ok(html.includes(">5m<"));
		assert.ok(!html.includes('data-testid="pending-card"'), "collapsed: no card");
	});

	it("expanding a row renders the ask card inline, plus an Open thread link", () => {
		const a = item("c1");
		const html = render([a], { expandedKey: itemKey(a) });
		assert.ok(html.includes('data-testid="pending-card"'));
		assert.ok(html.includes('data-testid="card-text"'));
		assert.ok(html.includes('data-testid="needs-you-open"'));
		assert.ok(html.includes('aria-expanded="true"'));
	});

	it("shows an answer error and the held answer's state", () => {
		const a = item("c1", { heldAnswer: { answer: { value: "draft" } } });
		const html = render([a], { expandedKey: itemKey(a), error: "Could not send the answer (409)." });
		assert.ok(html.includes("Could not send the answer (409)."));
		assert.ok(html.includes('data-testid="card-held"'));
	});

	it("offers the browser notification bell only when a toggle state is given", () => {
		assert.ok(!render([item("c1")]).includes("needs-you-notify-toggle"));
		assert.match(render([item("c1")], { notifyToggle: true }), /needs-you-notify-toggle[^>]*aria-pressed="true"/);
	});
});

describe("waitingFor", () => {
	it("is compact", () => {
		const now = new Date("2026-10-26T12:00:00.000Z");
		assert.equal(waitingFor("2026-10-26T11:59:40.000Z", now), "now");
		assert.equal(waitingFor("2026-10-26T11:15:00.000Z", now), "45m");
		assert.equal(waitingFor("2026-10-26T09:00:00.000Z", now), "3h");
		assert.equal(waitingFor("2026-10-24T12:00:00.000Z", now), "2d");
	});
});

describe("thread row", () => {
	it("a needs-you thread shows the dot and says so; an idle one has none", () => {
		const row = (status: "idle" | "needs-you" | "busy") =>
			renderToStaticMarkup(<SessionRow chat={threadListItem("1uk4", { id: "1uk4/home", title: "Home", status })} active={false} onOpen={noop} />);
		const needs = row("needs-you");
		assert.ok(needs.includes('data-testid="needs-you-dot"'));
		assert.ok(needs.includes("needs you"));
		assert.ok(!row("idle").includes("needs-you-dot"));
		assert.ok(!row("busy").includes("needs-you-dot"), "busy shows the spinner instead");
	});
});
