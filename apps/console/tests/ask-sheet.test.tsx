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
const { useAskSession } = await import("../components/ask-session.ts");

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
let textStatus = 200;
let hold: Promise<void> | null = null;
/** Holds submit and page-draft requests until released (a request still in flight). */
let gate: Promise<void> | null = null;
const uploads: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	if (init?.method === "POST" && String(input).endsWith("/attachments")) uploads.push(String(input));
	if (init?.method === "POST" && String(input).endsWith("/attachments")) return Response.json({ id: "up-1", name: "a.png", mimeType: "image/png", size: 3 }, { status: 201 });
	if (init?.method !== "POST" && init?.method !== "PUT") return new Response("{}", { status: 404 });
	if (String(input).endsWith("/text")) {
		posts.push({ url: String(input), body: JSON.parse(String(init.body)) });
		await hold;
		return textStatus === 200 ? Response.json({ ok: true }) : Response.json({ error: "nope" }, { status: textStatus });
	}
	posts.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
	if (gate && /\/(submit|draft)$/.test(String(input))) await gate;
	return status === 200 ? Response.json({ disposition: "started", accepted: true }) : Response.json({ error: "bad page" }, { status });
}) as typeof fetch;

const target = { wolf: "w", slug: "a" };
const q = (s: string) => document.querySelector(s) as HTMLElement | null;
const qa = (s: string) => Array.from(document.querySelectorAll(s)) as HTMLElement[];
const props = (el: Element, name: string) => (el as any)[Object.keys(el).find((k) => k.startsWith("__reactProps$"))!][name];
const click = (el: HTMLElement | null) => act(async () => void props(el!, "onClick")({ currentTarget: el, target: el, preventDefault() {}, stopPropagation() {} }));
const settle = () => act(async () => void (await new Promise((r) => setImmediate(r))));
const host = document.createElement("div");
document.body.appendChild(host);
/** Holds the open question the way the hosts (bar, thread page) do. */
function Host({ pc }: { pc: PendingCard }) {
	const [answering, setAnswering] = React.useState<{ callId: string; qid: string } | null>(null);
	const set = (a: { callId: string; qid: string } | null) => {
		if (a) aimed.push(a.qid);
		setAnswering(a);
	};
	const session = useAskSession(target, pc, { onSubmitted: () => void submitted.push(true), onRefetch: () => void refetched.push("r"), onCollapse: () => {} });
	// Stand-in for the host composer: its button (Next / Submit) and the hint under the sheet.
	return (
		<>
			<AskSheet target={target} session={session} answering={answering} setAnswering={set} dictation={undefined as never} />
			{session.action.hint ? <p data-testid="ask-missing" aria-live="polite">{session.action.hint}</p> : null}
			<button data-testid="press" disabled={session.action.disabled} onClick={() => session.press()}>{session.busy ? "Sending…" : session.action.label}</button>
		</>
	);
}
const render = (pc: PendingCard) =>
	act(async () => {
		root ??= createRoot(host);
		root.render(<Host pc={pc} />);
	});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	posts = [];
	status = 200;
	textStatus = 200;
	hold = null;
	gate = null;
	uploads.length = 0;
	refetched.length = 0;
	submitted.length = 0;
	aimed.length = 0;
});

describe("ask sheet", () => {
	it("shows page N of M with Next, and Submit on the last page; tradeoffs show per choice", async () => {
		await render(pending());
		assert.equal(q('[data-testid="ask-page-count"]')!.textContent, "page 1 of 2");
		assert.equal(q('[data-testid="ask-page-title"]')!.textContent, "First");
		assert.equal(q('[data-testid="press"]')!.textContent, "Next");
		assert.deepEqual(qa('[data-testid="ask-tradeoff"]').map((e) => e.textContent), ["fast but loose", "slow but sure"]);
		await render(pending({ pageIndex: 1 }));
		assert.equal(q('[data-testid="ask-page-count"]')!.textContent, "page 2 of 2");
		assert.equal(q('[data-testid="press"]')!.textContent, "Submit");
	});

	it("sends this page's answers only: skipped questions and an untouched slider are omitted", async () => {
		await render(pending());
		await click(qa('[data-testid="ask-option"]')[1]!);
		await click(q('[data-testid="press"]'));
		await settle();
		assert.equal(posts.length, 1);
		assert.ok(posts[0]!.url.endsWith("/cards/c1/pages/0/draft"));
		assert.equal(posts[0]!.body.goto, 1);
		assert.deepEqual(posts[0]!.body.answers, { q1: { value: "b" } });
	});

	it("sends a moved slider but shows the default (and min/max labels) while untouched", async () => {
		await render(pending());
		assert.equal(q('[data-testid="ask-slider-value"]')!.textContent, "5");
		assert.equal(q('[data-testid="ask-slider-min"]')!.textContent, "low");
		const input = q('[data-testid="ask-slider-input"]')!;
		await act(async () => void props(input, "onChange")({ target: { value: "8" } }));
		assert.equal(q('[data-testid="ask-slider-value"]')!.textContent, "8");
		await click(q('[data-testid="press"]'));
		await settle();
		assert.deepEqual(posts[0]!.body.answers, { q2: { value: 8 } });
	});

	it("card-pending updates in place: a higher pageIndex shows the next page, and bound text prefills the answer", async () => {
		await render(pending());
		await click(qa('[data-testid="ask-option"]')[0]!);
		await render(pending({ pageIndex: 1, draft: { q3: { value: "typed so far" } } }));
		assert.equal(q('[data-testid="ask-page-count"]')!.textContent, "page 2 of 2");
		assert.equal(qa('[data-testid="ask-question"]').length, 1);
		assert.equal((q('[data-testid="ask-free"]') as HTMLTextAreaElement).value, "typed so far");
		await click(q('[data-testid="press"]'));
		await settle();
		assert.deepEqual(posts[0]!.body.answers, { q3: { value: "typed so far" } });
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
		await click(q('[data-testid="press"]'));
		await settle();
		assert.deepEqual(refetched, ["r"]);
		assert.equal(q('[data-testid="ask-error"]')!.textContent, "The questions changed, check your answers.");
		status = 400;
		await click(q('[data-testid="press"]'));
		await settle();
		assert.equal(q('[data-testid="ask-error"]')!.textContent, "bad page");
	});
});

const one = (fields: object[], extra: object = {}) => pending({ card: card({ fields, steps: [{ fields: (fields as { id: string }[]).map((f) => f.id) }], ...extra }) });
const change = (el: HTMLElement, v: string) => act(async () => void props(el, "onChange")({ target: { value: v } }));

describe("ask sheet answers and guards", () => {
	it("a required question blocks Next and names the question", async () => {
		await render(one([{ id: "q1", kind: "single", label: "Pick", options: OPTS }]));
		await click(q('[data-testid="press"]'));
		await settle();
		assert.equal(posts.length, 0);
		assert.equal(q('[data-testid="ask-missing"]')!.textContent, "Answer to continue: Q1");
		assert.equal(q('[data-testid="ask-missing"]')!.getAttribute("aria-live"), "polite");
	});

	it("a required slider left at its default sends the default", async () => {
		await render(one([{ id: "q1", kind: "slider", label: "How much", min: 0, max: 10, step: 1, default: 5 }]));
		assert.equal(q('[data-testid="ask-missing"]'), null);
		await click(q('[data-testid="press"]'));
		await settle();
		assert.deepEqual(posts[0]!.body.answers, { q1: { value: 5 } });
	});

	it("404 says the set is gone and refetches", async () => {
		await render(pending());
		status = 404;
		await click(q('[data-testid="press"]'));
		await settle();
		assert.equal(q('[data-testid="ask-error"]')!.textContent, "This question set is gone.");
		assert.deepEqual(refetched, ["r"]);
	});

	it("a double click POSTs once", async () => {
		await render(pending());
		const next = q('[data-testid="press"]')!;
		await act(async () => {
			props(next, "onClick")({});
			props(next, "onClick")({});
		});
		await settle();
		assert.equal(posts.length, 1);
		assert.equal(q('[data-testid="ask-page-count"]')!.textContent, "page 2 of 2");
	});

	it("Other text bound from the composer sends as {value, other:true} for single and {value:[..], other:[text]} for multi", async () => {
		await render({ ...one([{ id: "q1", kind: "single", label: "Pick", options: OPTS }]), draft: { q1: { value: "mine", other: true } } as never });
		await click(q('[data-testid="press"]'));
		await settle();
		assert.deepEqual(posts[0]!.body.answers, { q1: { value: "mine", other: true } });
		await render({ ...one([{ id: "q1", kind: "multi", label: "Pick", allowOther: true, options: OPTS }]), callId: "c2", draft: { q1: { value: ["extra"], other: ["extra"] } } as never });
		await click(qa('[data-testid="ask-option"]')[0]!);
		await click(q('[data-testid="press"]'));
		await settle();
		assert.deepEqual(posts[1]!.body.answers, { q1: { value: ["a", "extra"], other: ["extra"] } });
	});

	it("Skip question shows on every optional question from the start, not once it has an answer", async () => {
		await render(pending());
		assert.equal(qa('[data-testid="ask-skip"]').length, 2); // q1 and q2 are optional, nothing answered yet
		await render(one([{ id: "q3", kind: "free-text", label: "Req" }]));
		assert.equal(qa('[data-testid="ask-skip"]').length, 0); // a required question has none
	});

	it("skip drops the question from the body", async () => {
		await render(pending());
		await click(qa('[data-testid="ask-option"]')[0]!);
		await click(q('[data-testid="ask-skip"]'));
		await click(q('[data-testid="press"]'));
		await settle();
		assert.deepEqual(posts[0]!.body.answers, {});
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
		// (compare booleans: a failed assert.equal on a DOM node makes node diff the whole linkedom tree and the run hangs)
		assert.equal(sec().querySelector('[data-testid="ask-skip"]') === null, true);
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
		await click(q('[data-testid="press"]'));
		await settle();
		assert.deepEqual(posts[0]!.body.answers, {});
	});

	it("after card-pending moves the page away and back, the q1 answer is kept and sent with the page", async () => {
		await render(pending());
		await click(qa('[data-testid="ask-option"]')[0]!);
		await render(pending({ pageIndex: 1 }));
		await render(pending({ pageIndex: 0 }));
		await click(q('[data-testid="press"]'));
		await settle();
		assert.deepEqual(posts[0]!.body.answers, { q1: { value: "a" } }); // answers now live with the set, not the page: Back must show them
	});

	it("a kept draft whose option vanished in a revise is dropped", async () => {
		await render(pending());
		await click(qa('[data-testid="ask-option"]')[1]!);
		await render(pending({ card: card({ fields: [{ id: "q1", kind: "single", label: "Pick one", optional: true, options: [OPTS[0]] }, { id: "q2", kind: "slider", label: "How much", optional: true, min: 0, max: 10, step: 1 }, { id: "q3", kind: "free-text", label: "Why", optional: true }] }) }));
		await click(q('[data-testid="press"]'));
		await settle();
		assert.deepEqual(posts[0]!.body.answers, {});
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
		assert.equal(qa('[data-testid="ask-question"]').map((s) => !!s.querySelector('[data-testid="ask-free"], [data-testid="ask-other"]')).join(), "true,false,false,false,false"); // the second tap moved the one open composer from q1 to q2
		assert.equal(qa('[data-testid="ask-other"]').length, 0);
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
		await click(q('[data-testid="press"]'));
		await settle();
		await render(pending());
		assert.equal(q('[data-testid="ask-error"]')?.textContent, "The questions changed, check your answers.");
		status = 400;
		await click(q('[data-testid="press"]'));
		await settle();
		await render(pending());
		assert.equal(q('[data-testid="ask-error"]')?.textContent, "bad page");
	});

	it("Next moves to page 2 at once (Back appears, Submit replaces Next); Back sends goto 0 and returns, keeping the answers", async () => {
		await render(pending());
		assert.equal(q('[data-testid="ask-back"]') === null, true); // no Back on page 1
		await click(qa('[data-testid="ask-option"]')[1]!);
		await click(q('[data-testid="press"]'));
		assert.equal(q('[data-testid="ask-page-count"]')!.textContent, "page 2 of 2");
		assert.equal(q('[data-testid="press"]')!.textContent, "Submit");
		await settle();
		await click(q('[data-testid="ask-back"]'));
		await settle();
		assert.equal(posts[1]!.body.goto, 0);
		assert.equal(q('[data-testid="ask-page-count"]')!.textContent, "page 1 of 2");
		assert.equal(q('[data-testid="press"]')!.textContent, "Next");
		assert.equal(posts.length, 2);
	});
});

describe("ask sheet image answers", () => {
	it("an images-only draft counts as answered, shows an N images badge with thumbnails, and the page body never carries attachments", async () => {
		const req = [{ id: "q1", kind: "free-text", label: "Show me" }, { id: "q2", kind: "single", label: "Pick", optional: true, options: OPTS }];
		await render(pending({ card: card({ fields: req, steps: [{ fields: ["q1", "q2"] }] }), draft: { q1: { value: "", attachments: ["i1", "i2"] }, q2: { value: "a", attachments: ["i3"] } } as never }));
		assert.equal(q('[data-testid="ask-missing"]'), null);
		assert.deepEqual(qa('[data-testid="ask-images"]').map((e) => e.textContent), ["2 images", "1 image"]);
		assert.deepEqual(qa('[data-testid="ask-images"] img').map((i) => i.getAttribute("src")), ["/api/wolves/w/threads/a/attachments/i1", "/api/wolves/w/threads/a/attachments/i2", "/api/wolves/w/threads/a/attachments/i3"]);
		await click(q('[data-testid="press"]'));
		await settle();
		assert.deepEqual(posts[0]!.body.answers, { q2: { value: "a" } });
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

describe("ask sheet inline composer", () => {
	const FREE = () => one([{ id: "q1", kind: "free-text", label: "Why", optional: true }]);
	const composer = () => q('[data-testid="ask-inline-composer"]');
	const area = () => q('[data-testid="ask-inline-composer"] textarea') as HTMLTextAreaElement;
	const open = () => click(q('[data-testid="ask-free"]'));
	const type = (v: string) => act(async () => void props(area(), "onChange")({ target: Object.assign(area(), { value: v }) }));
	const sendNow = () => act(async () => void props(q('[data-testid="ask-inline-composer"] form')!, "onSubmit")({ preventDefault() {} }));
	const texts = () => posts.filter((p) => p.url.endsWith("/questions/q1/text"));
	const attach = async () => {
		const input = q('[data-testid="ask-inline-composer"] [data-testid="attachment-picker"]') as HTMLInputElement;
		await act(async () => void props(input, "onChange")({ target: Object.assign(input, { files: [new File(["abc"], "a.png", { type: "image/png" })], value: "" }) }));
		for (let i = 0; i < 20 && !q('[data-testid="attachment-chip"][data-status="ready"]'); i++) await settle();
	};

	it("tapping a free field turns it into a composer in place, with attach, send and the dictate row but no model or Auto-ship controls", async () => {
		await render(FREE());
		assert.equal(composer() === null, true);
		await open();
		assert.equal(composer() !== null, true);
		assert.equal(q('[data-testid="ask-free"]') === null, true); // the field became the composer
		assert.match(q('[data-testid="answering-chip"]')!.textContent!, /Replying to: Why/);
		assert.equal(q('[data-testid="ask-inline-composer"] button[aria-label="Attach images"]') !== null, true);
		assert.equal(q('[data-testid="ask-inline-composer"] button[type="submit"]') !== null, true);
		assert.equal(q('[data-testid="composer-controls"]') === null, true);
		assert.equal(q('[data-testid="tier-trigger"]') === null, true);
	});

	it("opening the composer on an answered field shows the existing answer, so new words append to it and Send replaces the answer with the combined text", async () => {
		await render({ ...FREE(), draft: { q1: { value: "first part" } } });
		await open();
		assert.equal(props(area(), "value"), "first part", "the composer holds the field's text");
		await type("first part and more");
		await sendNow();
		await settle();
		assert.equal(texts()[0]!.body.text, "first part and more");
	});

	it("closing the composer without editing the answer leaves no 'Unsent' note", async () => {
		await render({ ...FREE(), draft: { q1: { value: "first part" } } });
		await open();
		await click(q('[data-testid="answering-chip-clear"]'));
		assert.equal(q('[data-testid="ask-unsent"]'), null);
	});

	it("Other on a single question opens the same composer under the options", async () => {
		await render(one([{ id: "q1", kind: "single", label: "Pick", options: OPTS }]));
		await click(q('[data-testid="ask-other"]'));
		assert.equal(qa('[data-testid="ask-option"]').length, 2);
		assert.equal(composer() !== null, true);
		assert.equal(q('[data-testid="ask-other"]') === null, true);
	});

	it("in a multi question Send adds a checked custom row, clears the composer and keeps it open; several customs go in the body and unchecking drops one", async () => {
		await render(one([{ id: "q1", kind: "multi", label: "Tags", allowOther: true, options: OPTS }]));
		await click(q('[data-testid="ask-other"]'));
		await type("red");
		await sendNow();
		await settle();
		assert.deepEqual(texts()[0]!.body, { picked: [], others: ["red"] });
		assert.equal(composer() !== null, true);
		assert.equal(props(area(), "value"), "");
		await type("blue");
		await sendNow();
		await settle();
		assert.deepEqual(texts()[1]!.body, { picked: [], others: ["red", "blue"] });
		const rows = () => qa('[data-testid="ask-option"][data-custom="true"]');
		assert.deepEqual(rows().map((r) => r.getAttribute("aria-checked") + ":" + r.textContent), ["true:red", "true:blue"]);
		await click(rows()[0]!); // uncheck red
		await settle();
		assert.deepEqual(rows().map((r) => r.textContent), ["blue"]);
		assert.deepEqual(texts()[2]!.body, { picked: [], others: ["blue"] });
		await click(q('[data-testid="press"]'));
		await settle();
		assert.deepEqual(posts.at(-1)!.body.answers, { q1: { value: ["blue"], other: ["blue"] } });
	});

	it("Skip question sits in the question's header row for every kind, free text included", async () => {
		await render(one([{ id: "q1", kind: "free-text", label: "Anything else?", optional: true }]));
		assert.equal(q('[data-testid="ask-question-header"] [data-testid="ask-skip"]') !== null, true);
		await click(q('[data-testid="ask-skip"]'));
		assert.equal(q('[data-testid="ask-question-header"] [data-testid="ask-unskip"]') !== null, true);
	});

	it("Send binds the text and closes the composer; a double Send posts once", async () => {
		await render(FREE());
		await open();
		await type("because");
		let release!: () => void;
		hold = new Promise<void>((r) => (release = r));
		await sendNow();
		await sendNow(); // the round trip is still open
		release();
		await settle();
		assert.deepEqual(texts().map((p) => p.body), [{ text: "because" }]);
		assert.equal(composer() === null, true);
		assert.equal(refetched.length, 1); // the server's draft is read back for the preview
		assert.equal(q('[data-testid="ask-free"]') !== null, true);
		assert.equal(props(q('[data-testid="ask-free"]')!, "value"), "because"); // the field now holds the sent text
	});

	it("× closes it and keeps the draft: the field says Unsent and reopening restores the text", async () => {
		await render(FREE());
		await open();
		await type("half a thought");
		await click(q('[data-testid="answering-chip-clear"]'));
		assert.equal(composer() === null, true);
		assert.equal(texts().length, 0);
		assert.match(q('[data-testid="ask-unsent"]')!.textContent!, /Unsent: half a thought/);
		await open();
		assert.equal(props(area(), "value"), "half a thought");
	});

	it("a click outside closes it and keeps the draft; a click inside does not", async () => {
		await render(FREE());
		await open();
		await type("keep");
		await act(async () => void area().dispatchEvent(new dom.window.Event("click", { bubbles: true })));
		assert.equal(composer() !== null, true);
		await act(async () => void document.body.dispatchEvent(new dom.window.Event("click", { bubbles: true })));
		assert.equal(composer() === null, true);
		assert.match(q('[data-testid="ask-unsent"]')!.textContent!, /keep/);
	});

	it("a failed send puts the text and the image back and says why", async () => {
		textStatus = 400;
		await render(FREE());
		await open();
		await attach();
		await type("look");
		await sendNow();
		await settle();
		assert.deepEqual(texts()[0]!.body, { text: "look", attachments: ["up-1"] });
		assert.equal(composer() !== null, true);
		assert.equal(props(area(), "value"), "look");
		assert.equal(qa('[data-testid="attachment-chip"]').length, 1);
		assert.equal(q('[data-testid="ask-inline-composer"] [role="alert"]')!.textContent, "nope");
	});

	it("attaching inside the composer uploads the image and Send binds it with the text; unsent images show on the field after ×", async () => {
		await render(FREE());
		await open();
		await attach();
		await click(q('[data-testid="answering-chip-clear"]'));
		assert.match(q('[data-testid="ask-unsent"]')!.textContent!, /\(1 image\)/);
		await open();
		assert.equal(qa('[data-testid="attachment-chip"]').length, 1);
		await sendNow(); // an image alone is an answer
		await settle();
		assert.deepEqual(texts().map((p) => p.body), [{ text: "", attachments: ["up-1"] }]);
	});
});

const { askQueue, useAskQueue } = await import("../components/ask-session.ts");
const oneStep = (label: string, extra: object = {}) => ({ ...card(), fields: [{ id: "q1", kind: "free-text", label }], steps: [{ fields: ["q1"] }], ...extra }) as PendingCard["card"];
/** The thread's host: the queue of its waiting questionnaires, the current one in the sheet, a stand-in note box. */
function QueueHost({ cards }: { cards: PendingCard[] }) {
	const [done, setDone] = React.useState<string[]>([]);
	const queue = useAskQueue(askQueue(cards.filter((p) => !done.includes(p.callId))));
	const session = useAskSession(target, queue.current, { onSubmitted: (id) => setDone((d) => [...d, id]), queued: queue.ids, onRefetch: () => {} });
	return queue.current ? (
		<>
			<AskSheet target={target} session={session} queue={queue} answering={null} setAnswering={() => {}} dictation={undefined as never} />
			<textarea data-testid="note" value={session.note.text} onChange={(e) => session.setNoteText(e.target.value)} />
			<button data-testid="attach-note" onClick={() => session.addNoteFiles([new File(["abc"], "a.png", { type: "image/png" })])} />
			<button data-testid="press" disabled={session.action.disabled} onClick={() => session.press()}>{session.busy ? "Sending…" : session.action.label}</button>
			{session.error ? <p data-testid="host-error">{session.error}</p> : null}
		</>
	) : null;
}
describe("queued questionnaires", () => {
	const mine = pending({ callId: "c1", threadId: "w/a", source: { kind: "self", label: "you" }, card: oneStep("Mine") });
	const kid = pending({ callId: "c2", threadId: "w/kid", source: { kind: "subagent", label: "worker: ask-sheet" }, card: { ...oneStep("Theirs"), fields: [{ id: "q1", kind: "free-text", label: "Theirs", optional: true }] } });
	const show = (cards: PendingCard[]) => act(async () => { root ??= createRoot(host); root.render(<QueueHost cards={cards} />); });

	it("counts the cards with their source, switches without submitting, keeps each note, and submits to the asker's own thread", async () => {
		await show([kid, mine]);
		assert.equal(q('[data-testid="ask-queue-label"]')!.textContent, "1 of 2 \u00b7 worker: ask-sheet");
		await change(q('[data-testid="note"]')!, "for the child");
		await click(q('[data-testid="ask-queue-next"]'));
		assert.equal(q('[data-testid="ask-queue-label"]')!.textContent, "2 of 2 \u00b7 you");
		assert.equal((q('[data-testid="note"]') as HTMLTextAreaElement).value, "");
		await click(q('[data-testid="ask-queue-prev"]'));
		assert.equal((q('[data-testid="note"]') as HTMLTextAreaElement).value, "for the child");
		assert.equal(posts.filter((p) => p.url.endsWith("/submit")).length, 0);
		await click(q('[data-testid="press"]'));
		await settle();
		const sub = posts.find((p) => p.url.endsWith("/submit"))!;
		assert.equal(sub.url, "/api/wolves/w/threads/kid/cards/c2/submit");
		assert.equal(sub.body.note.text, "for the child");
		assert.equal(q('[data-testid="ask-queue"]') === null, true); // one left: no counter
		assert.equal(q('[data-testid="ask-sheet"]')!.getAttribute("data-call-id"), "c1");
	});

	const PUTS = () => posts.filter((p) => p.url.includes("/note") || p.url.endsWith("/draft"));
	const wait = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
	const typeNote = (v: string) => change(q('[data-testid="note"]')!, v);
	const kidTwoPage = pending({ callId: "c2", threadId: "w/kid", source: { kind: "subagent", label: "worker: ask-sheet" } });
	let release: () => void = () => {};
	const hold2 = () => (gate = new Promise<void>((r) => (release = r)));

	it("a submit still in flight when the owner switches settles its own card and leaves the one on screen alone", async () => {
		hold2();
		await show([kid, mine]);
		await typeNote("for the child");
		await click(q('[data-testid="press"]'));
		await click(q('[data-testid="ask-queue-next"]'));
		await typeNote("mine only");
		status = 200;
		release();
		await settle();
		await wait(480);
		assert.equal(q('[data-testid="ask-sheet"]')!.getAttribute("data-call-id"), "c1"); // c2 settled, c1 is what is left
		assert.equal((q('[data-testid="note"]') as HTMLTextAreaElement).value, "mine only");
		assert.equal(posts.some((p) => p.url.includes("/threads/kid/") && p.url.endsWith("/note")), false);
		assert.deepEqual(posts.filter((p) => p.url.endsWith("/cards/c1/note")).map((p) => p.body), [{ text: "mine only" }]);
		assert.notEqual(q('[data-testid="press"]')!.textContent, "Sending\u2026"); // not stuck busy
	});

	it("a refused submit for a card the owner left shows no error on the card on screen", async () => {
		hold2();
		await show([kid, mine]);
		await click(q('[data-testid="press"]'));
		await click(q('[data-testid="ask-queue-next"]'));
		status = 400;
		release();
		await settle();
		assert.equal(q('[data-testid="host-error"]') === null, true);
		assert.equal(q('[data-testid="ask-error"]') === null, true);
		assert.notEqual(q('[data-testid="press"]')!.textContent, "Sending\u2026");
	});

	it("a page change still in flight when the owner switches does not move or blame the card on screen", async () => {
		hold2();
		await show([kidTwoPage, mine]);
		await click(q('[data-testid="press"]')); // Next
		await click(q('[data-testid="ask-queue-next"]'));
		status = 400;
		release();
		await settle();
		const d = posts.find((p) => p.url.endsWith("/draft"))!;
		assert.equal(d.url, "/api/wolves/w/threads/kid/cards/c2/pages/0/draft");
		assert.equal(q('[data-testid="host-error"]') === null, true);
		assert.equal(q('[data-testid="ask-sheet"]')!.getAttribute("data-call-id"), "c1");
		assert.notEqual(q('[data-testid="press"]')!.textContent, "Sending\u2026");
	});

	it("a card's answers survive a switch, but a field the server changed meanwhile shows the server's value", async () => {
		const a = pending({ callId: "c2", threadId: "w/kid", source: { kind: "subagent", label: "worker: ask-sheet" } });
		const picked = () => qa('[data-testid="ask-option"]').map((o) => o.getAttribute("aria-checked"));
		await show([a, mine]);
		await click(qa('[data-testid="ask-option"]')[0]!);
		assert.deepEqual(picked(), ["true", "false"]);
		await click(q('[data-testid="ask-queue-next"]'));
		await click(q('[data-testid="ask-queue-prev"]'));
		assert.deepEqual(picked(), ["true", "false"]); // kept across the switch
		await click(q('[data-testid="ask-queue-next"]'));
		await show([{ ...a, pageAnswers: { q1: { value: "b" } } } as PendingCard, mine]);
		await click(q('[data-testid="ask-queue-prev"]'));
		assert.deepEqual(picked(), ["false", "true"]);
	});

	it("a note left unsaved because its page change was in flight is saved after switching back", async () => {
		hold2();
		await show([kidTwoPage, mine]);
		await click(q('[data-testid="press"]')); // Next, held in flight
		await typeNote("late thought");
		await click(q('[data-testid="ask-queue-next"]'));
		release();
		await settle();
		await click(q('[data-testid="ask-queue-prev"]'));
		await wait(480);
		const saved = posts.filter((p) => p.url === "/api/wolves/w/threads/kid/cards/c2/note");
		assert.deepEqual(saved.map((p) => p.body), [{ text: "late thought" }]);
		assert.equal(PUTS().length > 0, true);
	});

	it("a child card's note upload goes to the child's thread", async () => {
		await show([kid, mine]);
		await click(q('[data-testid="attach-note"]'));
		await settle();
		assert.deepEqual(uploads, ["/api/wolves/w/threads/kid/attachments"]);
	});

	it("a late older card does not take the sheet from the one the owner is on", async () => {
		await show([mine]);
		await show([kid, mine]);
		assert.equal(q('[data-testid="ask-sheet"]')!.getAttribute("data-call-id"), "c1");
		assert.equal(q('[data-testid="ask-queue-label"]')!.textContent, "2 of 2 \u00b7 you");
	});
});

after_all();
function after_all() {
	process.on("exit", () => void (globalThis.fetch = realFetch));
}
