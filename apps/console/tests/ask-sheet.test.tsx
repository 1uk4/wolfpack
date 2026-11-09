/** The paged `ask` questionnaire sheet (work-wolfpack-ssPFrEw): paging, the page body, in-place card-pending updates, safe context markdown, the diagram URL, 409. Real mount, stubbed fetch. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
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

type PendingCard = import("@wolfpack/client").PendingCard;
const { AskSheet } = await import("../components/ask-sheet.tsx");

const OPTS = [
	{ label: "Alpha", value: "a", tradeoff: "fast but loose" },
	{ label: "Beta", value: "b", tradeoff: "slow but sure" },
];
const card = (extra: object = {}): PendingCard["card"] =>
	({
		tool: "ask",
		paged: true,
		fields: [
			{ id: "q1", kind: "single", label: "Pick one", optional: true, options: OPTS, description: "Some **context** <script>alert(1)</script> ![x](https://evil.example/p.png)" },
			{ id: "q2", kind: "slider", label: "How much", optional: true, min: 0, max: 10, step: 1, default: 5, minLabel: "low", maxLabel: "high" },
			{ id: "q3", kind: "free-text", label: "Why", optional: true, diagram: "viz-flow-123.png" },
		],
		steps: [{ title: "First", fields: ["q1", "q2"] }, { title: "Second", fields: ["q3"] }],
		...extra,
	}) as PendingCard["card"];
const pending = (extra: Partial<PendingCard> = {}): PendingCard => ({ callId: "c1", threadId: "w/a", card: card(), raisedAt: "2026-11-09T00:00:00+00:00", ...extra });

let root: Root | null = null;
let posts: { url: string; body: any }[] = [];
let status = 200;
const refetched: string[] = [];
const aimed: string[] = [];
const submitted: boolean[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	posts.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
	return status === 200 ? Response.json({ disposition: "started" }) : Response.json({ error: "bad page" }, { status });
}) as typeof fetch;

const target = { wolf: "w", slug: "a" };
const q = (s: string) => document.querySelector(s) as HTMLElement | null;
const qa = (s: string) => Array.from(document.querySelectorAll(s)) as HTMLElement[];
const props = (el: Element, name: string) => (el as any)[Object.keys(el).find((k) => k.startsWith("__reactProps$"))!][name];
const click = (el: HTMLElement | null) => act(async () => void props(el!, "onClick")({ currentTarget: el, target: el, preventDefault() {}, stopPropagation() {} }));
const settle = () => act(async () => void (await new Promise((r) => setImmediate(r))));
const host = document.createElement("div");
document.body.appendChild(host);
const render = (pc: PendingCard) =>
	act(async () => {
		root ??= createRoot(host);
		root.render(<AskSheet target={target} pc={pc} answering={null} setAnswering={(a) => void (a && aimed.push(a.qid))} onSubmitted={(l) => void submitted.push(l)} onRefetch={() => void refetched.push("r")} />);
	});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	posts = [];
	status = 200;
	refetched.length = 0;
	submitted.length = 0;
	aimed.length = 0;
});

describe("ask sheet", () => {
	it("shows page N of M with Next, and Submit on the last page; tradeoffs show per choice", async () => {
		await render(pending());
		assert.equal(q('[data-testid="ask-page-count"]')!.textContent, "page 1 of 2");
		assert.equal(q('[data-testid="ask-page-title"]')!.textContent, "First");
		assert.equal(q('[data-testid="ask-next"]')!.textContent, "Next");
		assert.deepEqual(qa('[data-testid="ask-tradeoff"]').map((e) => e.textContent), ["fast but loose", "slow but sure"]);
		await render(pending({ pageIndex: 1 }));
		assert.equal(q('[data-testid="ask-page-count"]')!.textContent, "page 2 of 2");
		assert.equal(q('[data-testid="ask-submit"]')!.textContent, "Submit");
	});

	it("sends this page's answers only: skipped questions and an untouched slider are omitted", async () => {
		await render(pending());
		await click(qa('[data-testid="ask-option"]')[1]!);
		await click(q('[data-testid="ask-next"]'));
		await settle();
		assert.equal(posts.length, 1);
		assert.ok(posts[0]!.url.endsWith("/cards/c1/pages/0/answer"));
		assert.deepEqual(posts[0]!.body, { answers: { q1: { value: "b" } } });
		assert.deepEqual(submitted, [false]);
	});

	it("sends a moved slider but shows the default (and min/max labels) while untouched", async () => {
		await render(pending());
		assert.equal(q('[data-testid="ask-slider-value"]')!.textContent, "5");
		assert.equal(q('[data-testid="ask-slider-min"]')!.textContent, "low");
		const input = q('[data-testid="ask-slider-input"]')!;
		await act(async () => void props(input, "onChange")({ target: { value: "8" } }));
		assert.equal(q('[data-testid="ask-slider-value"]')!.textContent, "8");
		await click(q('[data-testid="ask-next"]'));
		await settle();
		assert.deepEqual(posts[0]!.body, { answers: { q2: { value: 8 } } });
	});

	it("card-pending updates in place: a higher pageIndex shows the next page, and bound text prefills the answer", async () => {
		await render(pending());
		await click(qa('[data-testid="ask-option"]')[0]!);
		await render(pending({ pageIndex: 1, draft: { q3: { value: "typed so far" } } }));
		assert.equal(q('[data-testid="ask-page-count"]')!.textContent, "page 2 of 2");
		assert.equal(qa('[data-testid="ask-question"]').length, 1);
		assert.equal((q('[data-testid="ask-free"]') as HTMLTextAreaElement).value, "typed so far");
		await click(q('[data-testid="ask-submit"]'));
		await settle();
		assert.deepEqual(posts[0]!.body, { answers: { q3: { value: "typed so far" } } });
		assert.deepEqual(submitted, [true]);
	});

	it("renders the context as markdown without raw HTML or remote images", async () => {
		await render(pending());
		await settle();
		const ctx = q('[data-testid="ask-context"]')!;
		assert.equal(ctx.querySelector("strong")?.textContent, "context");
		assert.match(ctx.textContent!, /<script>alert\(1\)<\/script>/); // shown as text, not run
		assert.equal(ctx.querySelector("script"), null);
		assert.equal(ctx.querySelector("img"), null);
	});

	it("loads a diagram only through the thread's diagram route by id", async () => {
		await render(pending({ pageIndex: 1 }));
		assert.equal(q('[data-testid="ask-diagram"]')!.getAttribute("src"), "/api/wolves/w/threads/a/diagrams/viz-flow-123.png");
		const bad = pending({ card: card({ fields: [{ id: "q3", kind: "free-text", label: "Why", optional: true, diagram: "https://evil.example/x.png" }], steps: [{ fields: ["q3"] }], paged: true }) });
		await render(bad);
		assert.equal(q('[data-testid="ask-diagram"]'), null);
		assert.equal(q('[data-testid="ask-diagram-missing"]')!.textContent, "Diagram unavailable");
	});

	it("409 refetches and says the questions changed; 400 shows the message inline", async () => {
		await render(pending());
		status = 409;
		await click(q('[data-testid="ask-next"]'));
		await settle();
		assert.deepEqual(refetched, ["r"]);
		assert.equal(q('[data-testid="ask-error"]')!.textContent, "The questions changed, check your answers.");
		status = 400;
		await click(q('[data-testid="ask-next"]'));
		await settle();
		assert.equal(q('[data-testid="ask-error"]')!.textContent, "bad page");
	});
});

const one = (fields: object[], extra: object = {}) => pending({ card: card({ fields, steps: [{ fields: (fields as { id: string }[]).map((f) => f.id) }], ...extra }) });
const change = (el: HTMLElement, v: string) => act(async () => void props(el, "onChange")({ target: { value: v } }));

describe("ask sheet answers and guards", () => {
	it("a required question blocks Next and names the question", async () => {
		await render(one([{ id: "q1", kind: "single", label: "Pick", options: OPTS }]));
		await click(q('[data-testid="ask-next"], [data-testid="ask-submit"]'));
		await settle();
		assert.equal(posts.length, 0);
		assert.equal(q('[data-testid="ask-missing"]')!.textContent, "Answer to continue: Q1");
		assert.equal(q('[data-testid="ask-missing"]')!.getAttribute("aria-live"), "polite");
	});

	it("a required slider left at its default sends the default", async () => {
		await render(one([{ id: "q1", kind: "slider", label: "How much", min: 0, max: 10, step: 1, default: 5 }]));
		assert.equal(q('[data-testid="ask-missing"]'), null);
		await click(q('[data-testid="ask-next"], [data-testid="ask-submit"]'));
		await settle();
		assert.deepEqual(posts[0]!.body, { answers: { q1: { value: 5 } } });
	});

	it("404 says the set is gone and refetches", async () => {
		await render(pending());
		status = 404;
		await click(q('[data-testid="ask-next"], [data-testid="ask-submit"]'));
		await settle();
		assert.equal(q('[data-testid="ask-error"]')!.textContent, "This question set is gone.");
		assert.deepEqual(refetched, ["r"]);
	});

	it("a double click POSTs once", async () => {
		await render(pending());
		const next = q('[data-testid="ask-next"], [data-testid="ask-submit"]')!;
		await act(async () => {
			props(next, "onClick")({});
			props(next, "onClick")({});
		});
		await settle();
		assert.equal(posts.length, 1);
		assert.equal(q('[data-testid="ask-next"], [data-testid="ask-submit"]')!.textContent, "Sending…"); // stays busy until the card moves on
	});

	it("Other text bound from the composer sends as {value, other:true} for single and {value:[..], other:[text]} for multi", async () => {
		await render({ ...one([{ id: "q1", kind: "single", label: "Pick", options: OPTS }]), draft: { q1: { value: "mine", other: true } } as never });
		await click(q('[data-testid="ask-next"], [data-testid="ask-submit"]'));
		await settle();
		assert.deepEqual(posts[0]!.body, { answers: { q1: { value: "mine", other: true } } });
		await render({ ...one([{ id: "q1", kind: "multi", label: "Pick", allowOther: true, options: OPTS }]), callId: "c2", draft: { q1: { value: ["extra"], other: ["extra"] } } as never });
		await click(qa('[data-testid="ask-option"]')[0]!);
		await click(q('[data-testid="ask-next"], [data-testid="ask-submit"]'));
		await settle();
		assert.deepEqual(posts[1]!.body, { answers: { q1: { value: ["a", "extra"], other: ["extra"] } } });
	});

	it("skip drops the question from the body", async () => {
		await render(pending());
		await click(qa('[data-testid="ask-option"]')[0]!);
		await click(q('[data-testid="ask-skip"]'));
		await click(q('[data-testid="ask-next"], [data-testid="ask-submit"]'));
		await settle();
		assert.deepEqual(posts[0]!.body, { answers: {} });
	});

	it("skip greys the question with a Skipped label; Answer un-skips it", async () => {
		await render(pending());
		const sec = () => q('[data-testid="ask-question"]')!;
		assert.equal(q('[data-testid="ask-skipped"]'), null);
		await click(qa('[data-testid="ask-option"]')[0]!);
		await click(q('[data-testid="ask-skip"]'));
		assert.equal(q('[data-testid="ask-skipped"]')!.textContent, "Skipped");
		assert.equal(sec().getAttribute("data-skipped"), "true");
		assert.equal(q('[data-testid="ask-choices"]')!.getAttribute("aria-disabled"), "true");
		assert.equal(q('[data-testid="ask-unskip"]')!.textContent, "Answer");
		assert.equal(q('[data-testid="ask-skip"]'), null);
		await click(q('[data-testid="ask-unskip"]'));
		assert.equal(q('[data-testid="ask-skipped"]'), null);
		assert.equal(q('[data-testid="ask-choices"]')!.getAttribute("aria-disabled"), null);
	});

	it("clicking the greyed question un-skips it without selecting an option; Enter does too", async () => {
		await render(pending());
		await click(qa('[data-testid="ask-option"]')[0]!);
		await click(q('[data-testid="ask-skip"]'));
		await click(qa('[data-testid="ask-option"]')[1]!); // a click on the greyed choice
		assert.equal(q('[data-testid="ask-skipped"]'), null);
		assert.deepEqual(qa('[data-testid="ask-option"]').map((o) => o.getAttribute("aria-checked")), ["false", "false"]);
		await click(q('[data-testid="ask-option"]'));
		await click(q('[data-testid="ask-skip"]'));
		await act(async () => void props(q('[data-testid="ask-question"]')!, "onKeyDown")({ key: "Enter", target: q('[data-testid="ask-question"]'), currentTarget: q('[data-testid="ask-question"]'), preventDefault() {} }));
		assert.equal(q('[data-testid="ask-skipped"]'), null);
	});

	it("a skipped question is omitted from the body and does not block Next", async () => {
		await render(pending());
		await click(qa('[data-testid="ask-option"]')[0]!);
		await click(q('[data-testid="ask-skip"]'));
		assert.equal(q('[data-testid="ask-missing"]'), null);
		await click(q('[data-testid="ask-next"], [data-testid="ask-submit"]'));
		await settle();
		assert.deepEqual(posts[0]!.body, { answers: {} });
	});

	it("after card-pending moves the page away and back, the old q1 draft is not sent", async () => {
		await render(pending());
		await click(qa('[data-testid="ask-option"]')[0]!);
		await render(pending({ pageIndex: 1 }));
		await render(pending({ pageIndex: 0 }));
		await click(q('[data-testid="ask-next"], [data-testid="ask-submit"]'));
		await settle();
		assert.deepEqual(posts[0]!.body, { answers: {} });
	});

	it("a kept draft whose option vanished in a revise is dropped", async () => {
		await render(pending());
		await click(qa('[data-testid="ask-option"]')[1]!);
		await render(pending({ card: card({ fields: [{ id: "q1", kind: "single", label: "Pick one", optional: true, options: [OPTS[0]] }, { id: "q2", kind: "slider", label: "How much", optional: true, min: 0, max: 10, step: 1 }, { id: "q3", kind: "free-text", label: "Why", optional: true }] }) }));
		await click(q('[data-testid="ask-next"], [data-testid="ask-submit"]'));
		await settle();
		assert.deepEqual(posts[0]!.body, { answers: {} });
	});

	it("clicking or pressing Enter on a free or Other field enters reply mode, focus alone does not (no keyboard trap); slider, confirm and no-Other choices never do", async () => {
		await render(one([{ id: "q1", kind: "free-text", label: "Why" }, { id: "q2", kind: "single", label: "Pick", options: OPTS }, { id: "q3", kind: "single", label: "Fixed", allowOther: false, options: OPTS }, { id: "q4", kind: "slider", label: "N", min: 0, max: 5, step: 1 }, { id: "q5", kind: "confirm", label: "Ok?" }]));
		const free = q('[data-testid="ask-free"]')!;
		assert.equal(props(free, "readOnly"), true); // a preview: typing happens in the bottom composer
		assert.equal(props(free, "onFocus"), undefined);
		assert.equal(props(q('[data-testid="ask-other"]')!, "onFocus"), undefined);
		await act(async () => void props(free, "onKeyDown")({ key: "Tab", preventDefault() {} }));
		assert.deepEqual(aimed, []);
		await act(async () => void props(free, "onKeyDown")({ key: "Enter", preventDefault() {} }));
		await click(q('[data-testid="ask-other"]'));
		assert.deepEqual(aimed, ["q1", "q2"]);
		assert.equal(qa('[data-testid="ask-question"]').map((s) => !!s.querySelector('[data-testid="ask-free"], [data-testid="ask-other"]')).join(), "true,true,false,false,false");
		assert.equal(qa('[data-testid="ask-other"]').length, 1);
	});

	it("typing is offered only where the server takes text", async () => {
		await render(one([{ id: "q1", kind: "single", label: "A", allowOther: false, options: OPTS }, { id: "q2", kind: "multi", label: "B", options: OPTS }, { id: "q3", kind: "multi", label: "C", allowOther: true, options: OPTS }, { id: "q4", kind: "free-text", label: "D" }]));
		const has = qa('[data-testid="ask-question"]').map((s) => !!s.querySelector('[data-testid="ask-free"], [data-testid="ask-other"]'));
		assert.deepEqual(has, [false, false, true, true]);
	});

	it("choices and the slider carry roles and names", async () => {
		await render(pending());
		const group = q('[data-testid="ask-question"] [role="radiogroup"]')!;
		const named = document.getElementById(group.getAttribute("aria-labelledby")!);
		assert.match(named!.textContent!, /Pick one/);
		assert.equal(qa('[data-testid="ask-option"]')[0]!.getAttribute("role"), "radio");
		assert.equal(qa('[data-testid="ask-option"]')[0]!.getAttribute("aria-checked"), "false");
		assert.equal(q('[data-testid="ask-slider-input"]')!.getAttribute("aria-valuetext"), "5 (default)");
	});

	it("multi options are checkboxes in a group named by the question", async () => {
		await render(one([{ id: "q1", kind: "multi", label: "Which ones", options: OPTS }]));
		assert.equal(qa('[data-testid="ask-option"]')[0]!.getAttribute("role"), "checkbox");
		const group = q('[role="group"]')!;
		assert.match(document.getElementById(group.getAttribute("aria-labelledby")!)!.textContent!, /Which ones/);
	});

	it("the 409 notice and a 400 message survive a refetch that hands back a fresh card object for the same page", async () => {
		await render(pending());
		status = 409;
		await click(q('[data-testid="ask-next"]'));
		await settle();
		await render(pending());
		assert.equal(q('[data-testid="ask-error"]')?.textContent, "The questions changed, check your answers.");
		status = 400;
		await click(q('[data-testid="ask-next"]'));
		await settle();
		await render(pending());
		assert.equal(q('[data-testid="ask-error"]')?.textContent, "bad page");
	});

	it("after an accepted non-final page, the same page coming back as a new card object re-enables Next", async () => {
		await render(pending());
		await click(q('[data-testid="ask-next"]'));
		await settle();
		assert.equal(q('[data-testid="ask-next"]')!.textContent, "Sending…");
		await render(pending());
		assert.equal(q('[data-testid="ask-next"]')!.textContent, "Next");
		assert.equal(props(q('[data-testid="ask-next"]')!, "disabled"), false);
	});
});

describe("ask sheet image answers", () => {
	it("an images-only draft counts as answered, shows an N images badge with thumbnails, and the page body never carries attachments", async () => {
		const req = [{ id: "q1", kind: "free-text", label: "Show me" }, { id: "q2", kind: "single", label: "Pick", optional: true, options: OPTS }];
		await render(pending({ card: card({ fields: req, steps: [{ fields: ["q1", "q2"] }] }), draft: { q1: { value: "", attachments: ["i1", "i2"] }, q2: { value: "a", attachments: ["i3"] } } as never }));
		assert.equal(q('[data-testid="ask-missing"]'), null);
		assert.deepEqual(qa('[data-testid="ask-images"]').map((e) => e.textContent), ["2 images", "1 image"]);
		assert.deepEqual(qa('[data-testid="ask-images"] img').map((i) => i.getAttribute("src")), ["/api/wolves/w/threads/a/attachments/i1", "/api/wolves/w/threads/a/attachments/i2", "/api/wolves/w/threads/a/attachments/i3"]);
		await click(q('[data-testid="ask-next"], [data-testid="ask-submit"]'));
		await settle();
		assert.deepEqual(posts[0]!.body, { answers: { q2: { value: "a" } } });
	});

	it("picking an option keeps the images bound to that question", async () => {
		const req = [{ id: "q2", kind: "single", label: "Pick", optional: true, options: OPTS }];
		await render(pending({ card: card({ fields: req, steps: [{ fields: ["q2"] }] }), draft: { q2: { value: "a", attachments: ["i3"] } } as never }));
		await click(qa('[data-testid="ask-option"]')[1]!);
		assert.deepEqual(qa('[data-testid="ask-images"]').map((e) => e.textContent), ["1 image"]);
	});

	it("a revise that keeps the question also keeps an image-only draft (free, single, multi)", async () => {
		const req = [{ id: "q1", kind: "free-text", label: "Show me" }, { id: "q2", kind: "single", label: "Pick", optional: true, options: OPTS }, { id: "q3", kind: "multi", label: "Many", optional: true, options: OPTS }];
		const c = card({ fields: req, steps: [{ fields: ["q1", "q2", "q3"] }] });
		await render(pending({ card: c, draft: { q1: { value: "", attachments: ["i1"] }, q2: { value: "", attachments: ["i2"] }, q3: { value: [], attachments: ["i3"] } } as never }));
		assert.equal(qa('[data-testid="ask-images"]').length, 3);
		await render(pending({ card: c, draft: {} as never }));
		assert.equal(qa('[data-testid="ask-images"]').length, 3);
	});
});

after_all();
function after_all() {
	process.on("exit", () => void (globalThis.fetch = realFetch));
}
