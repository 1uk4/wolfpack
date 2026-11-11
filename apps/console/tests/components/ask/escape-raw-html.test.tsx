/** Card text with tag-like content (<button>, <Foo bar>) renders literally; inline code still renders as code. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	HTMLInputElement: dom.window.HTMLInputElement,
	HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
	ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
	getComputedStyle: () => ({ animationName: "none" }),
});

type Card = import("@wolfpack/client").Card;
const { AskCard } = await import("../../../components/ask/ask-card.tsx");
const { escapeRawHtml } = await import("../../../src/core/escape-html.ts");

describe("escapeRawHtml", () => {
	it("escapes tag-like text but not code, fences or autolinks", () => {
		assert.equal(escapeRawHtml("a <button> b"), "a &lt;button> b");
		assert.equal(escapeRawHtml("`<b>` and <Foo bar>"), "`<b>` and &lt;Foo bar>");
		assert.equal(escapeRawHtml("```\n<div>\n```\n<i>"), "```\n<div>\n```\n&lt;i>");
		assert.equal(escapeRawHtml("$a<b$ and <i>"), "$a<b$ and &lt;i>");
		assert.equal(escapeRawHtml("$$x<y$$"), "$$x<y$$");
		assert.equal(escapeRawHtml("\\(a<b\\) <i>"), "\\(a<b\\) &lt;i>");
		assert.equal(escapeRawHtml("[x](<a b.md>) <i>"), "[x](<a b.md>) &lt;i>");
		assert.equal(escapeRawHtml("<https://x.io> 1 < 2"), "<https://x.io> 1 < 2");
	});
});

describe("card text with tag-like content", () => {
	it("shows title-like question, details and option label literally", async () => {
		const card: Card = {
			tool: "t",
			fields: [
				{
					id: "m",
					kind: "single",
					label: "Use <button> or <Foo bar>? also `<code>`",
					description: "Details with <button> and <Foo bar>",
					options: [{ label: "Pick <button>", value: "a", description: "desc <Foo bar>" }, { label: "Plain", value: "b" }],
				},
			] as Card["fields"],
		};
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		await act(async () => {
			root.render(<AskCard callId="c1" card={card} pending submitting={false} onAnswer={() => {}} />);
		});
		const text = host.textContent ?? "";
		for (const t of ["Use <button> or <Foo bar>?", "Details with <button> and <Foo bar>", "Pick <button>", "desc <Foo bar>"]) {
			assert.ok(text.includes(t), `missing ${t} in ${text}`);
		}
		const codes = [...host.querySelectorAll("code")].map((c) => c.textContent);
		assert.ok(codes.includes("<code>"), "inline code still renders as code");
	});
});
