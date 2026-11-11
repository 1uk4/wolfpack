/**
 * Work item chips: linkification (text + code span, not bare ids / fences), the hover card (mocked fetch, cache,
 * disabled Open thread), and no <button> nested in a <button> inside card options.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	Node: dom.window.Node,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
	ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
});

const { MessageResponse } = await import("../components/ai-elements/message.tsx");
const { WorkIdChip, WorkItemCard, lookupWorkItem, resetWorkLookupCache, criteriaExcerpt } = await import("../components/work-id-chip.tsx");
const { AskCard } = await import("../components/ask-card.tsx");
const { linkifyWorkIds, workIdFromHref } = await import("../src/core/index.ts");
const { KbMarkdown } = await import("../components/kb/kb-markdown.tsx");
type Card = import("@wolfpack/client").Card;

const ID = "work-wolfpack-cEg92qS";
const render = (md: string) => renderToStaticMarkup(<MessageResponse mode="static">{md}</MessageResponse>);

describe("work id rendering", () => {
	it("a full id in text becomes a chip showing the short id", () => {
		const html = render(`See ${ID} now`);
		assert.match(html, new RegExp(`<span[^>]*data-work-id="${ID}"[^>]*>cEg92qS</span>`));
		assert.ok(!html.includes(`>${ID}<`));
	});
	it("a full id in an inline code span becomes a chip", () => {
		const html = render(`See \`${ID}\` now`);
		assert.match(html, new RegExp(`data-work-id="${ID}"[^>]*>cEg92qS<`));
		assert.ok(!html.includes('data-streamdown="inline-code"'));
	});
	it("a bare short id stays text", () => {
		const html = render("See cEg92qS and `cEg92qS` now");
		assert.ok(!html.includes("data-work-id"));
	});
	it("fenced code is untouched", () => {
		const md = `\`\`\`\n${ID}\n\`\`\``;
		assert.equal(linkifyWorkIds(md), md);
		assert.ok(!render(md).includes("data-work-id"));
	});
	it("does not link slugs, other domains or file names", () => {
		for (const t of ["work-item-details", "work-wolfpack-section", "work-wolfpack-abc1234.md", "work-other-cEg92qS"]) {
			assert.equal(linkifyWorkIds(`see ${t} here`), `see ${t} here`, t);
		}
		assert.ok(linkifyWorkIds(`see ${ID}.`).includes("work-item.invalid"), "a sentence-ending period still links");
		assert.ok(linkifyWorkIds("work-snapjack-0p87p9Q ok").includes("work-item.invalid"));
	});
	it("a malformed escape in the href yields null instead of throwing", () => {
		assert.equal(workIdFromHref("https://work-item.invalid/%E0%A4%A"), null);
		assert.equal(workIdFromHref(`https://work-item.invalid/${ID}`), ID);
	});
	it("fences in blockquotes and list items and indented code are untouched", () => {
		for (const md of [`> \`\`\`\n> ${ID}\n> \`\`\``, `- item\n  \`\`\`\n  ${ID}\n  \`\`\``, `1. \`\`\`sh\n   ${ID}\n   \`\`\``, `para\n\n    ${ID}\n\n    ${ID}`]) {
			assert.equal(linkifyWorkIds(md), md, md);
		}
		assert.ok(linkifyWorkIds(`> \`\`\`\n> x\n> \`\`\`\n> ${ID}`).includes("work-item.invalid"), "text after a closed quoted fence links");
		assert.ok(linkifyWorkIds(`- item\n\n    ${ID} continued`).includes("work-item.invalid"), "list continuation is prose");
	});
	it("KB markdown renders an id as a chip, not a dead link", () => {
		const html = renderToStaticMarkup(<KbMarkdown>{`Depends on ${ID}`}</KbMarkdown>);
		assert.match(html, new RegExp(`data-work-id="${ID}"`));
		assert.ok(!html.includes("work-item.invalid"));
	});
	it("existing links and urls are not rewritten", () => {
		const md = `[${ID}](https://x.test/a) and https://x.test/${ID}`;
		assert.equal(linkifyWorkIds(md), md);
	});
});

describe("hover card", () => {
	const record = (over: object = {}) => ({
		id: ID, title: "Hover card", kind: "task", stage: "building", domain: "wolfpack", partOf: "work-wolfpack-07auwWg",
		successCriteria: "x".repeat(300), plan: "", record: "", ...over,
	});
	const parent = { id: "work-wolfpack-07auwWg", title: "App follow-ups", kind: "feature", stage: "building", domain: "wolfpack", plan: "", record: "" };
	let calls: string[] = [];
	let root: Root | null = null;
	const respond = (map: Record<string, unknown>) => {
		calls = [];
		(globalThis as Record<string, unknown>).fetch = async (url: string) => {
			calls.push(url);
			const path = String(url);
			if (path === "/api/wolves") return Response.json({ wolves: [{ id: "1", name: "w1", host: "h", status: "online", librarian: true }] });
			const hit = Object.entries(map).find(([k]) => path.includes(`/work/${k}/record`));
			return hit ? Response.json(hit[1]) : Response.json({ error: "nope" }, { status: 404 });
		};
	};
	beforeEach(() => resetWorkLookupCache());
	afterEach(async () => {
		await act(async () => root?.unmount());
		root = null;
		document.body.innerHTML = "";
	});
	const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
	const q = (s: string) => document.querySelector(s) as HTMLElement | null;
	async function openChip(id = ID) {
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		await act(async () => root!.render(<WorkIdChip id={id} />));
		await act(async () => q("[data-work-id]")!.dispatchEvent(new dom.window.Event("click", { bubbles: true })));
		await flush();
	}

	it("shows the item's fields from the mocked fetch", async () => {
		respond({ [ID]: record(), "work-wolfpack-07auwWg": parent });
		await openChip();
		const card = q('[data-testid="work-card"]')!;
		assert.ok(card);
		assert.equal(q('[data-testid="work-card-title"]')!.textContent, "Hover card");
		for (const t of ["task", "building", "wolfpack", "App follow-ups"]) assert.ok(card.textContent!.includes(t), t);
		assert.ok(q('[data-testid="work-card-criteria"]')!.textContent!.length <= 201);
		assert.equal(q('[data-testid="work-card-thread"]')!.hasAttribute("disabled"), false);
	});

	const ev = (el: Element, type: string) => act(async () => void el.dispatchEvent(new dom.window.Event(type, { bubbles: true, cancelable: true })));
	async function mountChip() {
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		await act(async () => root!.render(<WorkIdChip id={ID} />));
		return q("[data-work-id]")!;
	}
	it("a press focuses then clicks and the card stays open", async () => {
		respond({ [ID]: record({ partOf: null }) });
		const chip = await mountChip();
		await ev(chip, "pointerdown");
		await ev(chip, "mousedown");
		await ev(chip, "focusin");
		await ev(chip, "click");
		await flush();
		assert.ok(q('[data-testid="work-card"]'), "open after press");
		await ev(chip, "click");
		assert.ok(q('[data-testid="work-card"]'), "a second click does not close it");
		await ev(document.documentElement, "pointerdown");
		assert.equal(q('[data-testid="work-card"]'), null, "outside pointerdown closes");
	});
	it("keyboard focus opens, Escape closes, aria-haspopup is set", async () => {
		respond({ [ID]: record({ partOf: null }) });
		const chip = await mountChip();
		assert.equal(chip.getAttribute("aria-haspopup"), "dialog");
		await ev(chip, "focusin");
		await flush();
		assert.ok(q('[data-testid="work-card"]'));
		await act(async () => void document.dispatchEvent(Object.assign(new dom.window.Event("keydown", { bubbles: true }), { key: "Escape" })));
		assert.equal(q('[data-testid="work-card"]'), null);
	});
	it("Space does not activate, Enter does", async () => {
		respond({ [ID]: record({ partOf: null }) });
		const chip = await mountChip();
		const key = (k: string) => act(async () => void chip.dispatchEvent(Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), { key: k })));
		await key(" ");
		assert.equal(q('[data-testid="work-card"]'), null);
		await key("Enter");
		await flush();
		assert.ok(q('[data-testid="work-card"]'));
	});
	it("an existing feature thread is found and a missing one is labelled Start thread", async () => {
		respond({ [ID]: record(), "work-wolfpack-07auwWg": parent });
		const base = (globalThis as { fetch: (u: string) => Promise<Response> }).fetch;
		(globalThis as Record<string, unknown>).fetch = async (u: string) =>
			u === "/api/wolves/w1/threads" ? Response.json({ threads: [{ id: "t9", kind: "feature", boundWorkItem: "work-wolfpack-07auwWg" }] }) : base(u);
		const found = await lookupWorkItem(ID);
		assert.ok(found.kind === "ok" && found.thread?.id === "t9" && found.thread.wolf === "w1");
		resetWorkLookupCache();
		respond({ [ID]: record(), "work-wolfpack-07auwWg": parent });
		await openChip();
		assert.equal(q('[data-testid="work-card-thread"]')!.textContent, "Start thread");
	});
	it("a second open makes no new request (cache)", async () => {
		respond({ [ID]: record(), "work-wolfpack-07auwWg": parent });
		await lookupWorkItem(ID);
		const n = calls.length;
		await lookupWorkItem(ID);
		await Promise.all([lookupWorkItem(ID), lookupWorkItem(ID)]);
		assert.equal(calls.length, n);
	});

	it("an id that does not exist is asked once per session (the 404 is cached past the TTL), and an id not shaped like a work id is never asked", async () => {
		respond({});
		const gone = "work-wolfpack-Zzzzzzz";
		assert.equal((await lookupWorkItem(gone)).kind, "unknown");
		const n = calls.length;
		let t = Date.now();
		assert.equal((await lookupWorkItem(gone, null, () => (t += 10 * 60_000))).kind, "unknown");
		assert.equal(calls.length, n);
		assert.equal((await lookupWorkItem("work-wolfpack-preview-slot-pair")).kind, "unknown");
		assert.equal((await lookupWorkItem("origin/wolf/1uk4")).kind, "unknown");
		for (const d of ["personal", "snapjack", "wolfpack"]) assert.equal((await lookupWorkItem(`work-${d}-preview`)).kind, "unknown");
		assert.equal(calls.length, n);
	});

	it("a moments-list row with only a work id shows the item's title once the lookup resolves", async () => {
		respond({ [ID]: record({ title: "Resolved row title", partOf: null }) });
		const { MomentList } = await import("../components/branch-graph.tsx");
		const { EMPTY_OVERVIEW } = await import("../src/core/index.ts");
		const NOW = 1_800_000_000;
		const ring = { at: NOW - 600, kind: "landed" as const, lane: "main", label: "", workId: ID };
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		await act(async () => root!.render(<MomentList overview={{ ...EMPTY_OVERVIEW, main: { name: "w", kind: "wolf" } }} rings={[ring]} days={30} nowSec={NOW} />));
		await flush();
		assert.match(q('[data-testid="git-moments"] li')!.textContent!, /Resolved row title/);
	});

	it("a home lane label shows the branch name first and updates to the work item title once the lookup resolves, even after a transient failure", async () => {
		const { Swimlanes } = await import("../components/branch-graph.tsx");
		const { EMPTY_OVERVIEW } = await import("../src/core/index.ts");
		const NOW = 1_800_000_000;
		const branch = "feat/bOm8itk-browser-slot-pair";
		const record = { id: "work-wolfpack-bOm8itk", title: "Preview agent slots", kind: "feature", stage: "building", domain: "wolfpack", plan: "", record: "" };
		respond({ "work-wolfpack-bOm8itk": record });
		const ok = (globalThis as { fetch: (u: string) => Promise<Response> }).fetch;
		let wolvesCalls = 0;
		// the first wolves list request fails (a blip); the next works
		(globalThis as Record<string, unknown>).fetch = (u: string) => (u === "/api/wolves" && wolvesCalls++ === 0 ? Promise.resolve(Response.json({ error: "x" }, { status: 503 })) : ok(u));
		const overview = { ...EMPTY_OVERVIEW, main: { name: "wolf/w", kind: "wolf" as const }, home: "wolf/w", branches: [{ name: branch, shortId: "bOm8itk", landed: false, ahead: 1, behind: 0, forkAt: NOW - 3600, parent: "wolf/w" }] } as never;
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		await act(async () => root!.render(<Swimlanes overview={overview} rings={[]} days={7} nowSec={NOW} />));
		const labels = () => [...document.querySelectorAll("svg text")].map((t) => t.textContent);
		assert.ok(labels().some((t) => t!.includes("bOm8")), "branch name before the lookup");
		await act(async () => { await new Promise((r) => setTimeout(r, 2200)); });
		assert.ok(labels().some((t) => t!.includes("Preview agent slots")), `labels: ${labels().join(" | ")}`);
	});

	it("in-flight lookups are deduped", async () => {
		respond({ [ID]: record({ partOf: null }) });
		await Promise.all([lookupWorkItem(ID), lookupWorkItem(ID)]);
		assert.equal(calls.filter((c) => c.includes("/record")).length, 1);
	});

	it("Open thread is disabled when there is no thread", async () => {
		respond({ [ID]: record({ partOf: null }) });
		await openChip();
		assert.equal(q('[data-testid="work-card-thread"]')!.hasAttribute("disabled"), true);
		assert.equal(q('[data-testid="work-card-work"]')!.hasAttribute("disabled"), false);
	});

	it("the card's button reads Open and opens the reader on the current page", async () => {
		respond({ [ID]: record({ partOf: null }) });
		const assigned: string[] = [];
		const realLocation = Object.getOwnPropertyDescriptor(window, "location");
		Object.defineProperty(window, "location", { configurable: true, value: { pathname: "/wolf/hal/thread/t1", search: "?x=1", assign: (u: string) => assigned.push(u) } });
		await openChip();
		const btn = q('[data-testid="work-card-work"]')!;
		assert.equal(btn.textContent!.trim(), "Open");
		await act(async () => void btn.dispatchEvent(new dom.window.Event("click", { bubbles: true })));
		if (realLocation) Object.defineProperty(window, "location", realLocation);
		else delete (window as unknown as Record<string, unknown>).location;
		assert.deepEqual(assigned, [`/wolf/hal/thread/t1?x=1&item=${ID}`]);
	});

	it("an unknown id shows Unknown item", async () => {
		respond({});
		await openChip("work-wolfpack-zzzzzzz");
		assert.match(q('[data-testid="work-card-unknown"]')!.textContent!, /Unknown item/);
	});

	it("criteria excerpt is bounded", () => {
		assert.equal(criteriaExcerpt("a".repeat(500)).length, 201);
		assert.ok(typeof WorkItemCard === "function");
	});
});

describe("card option toggling", () => {
	it("clicking text inside an option still toggles it", async () => {
		const card = { tool: "t", fields: [{ id: "m", kind: "multi", label: "Pick", options: [{ label: "A", value: "a", description: `d ${ID}` }] }] } as unknown as Card;
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		await act(async () => root.render(<AskCard callId="c1" card={card} pending submitting={false} onAnswer={() => {}} />));
		const opt = document.querySelector('[data-testid="card-option"]')!;
		assert.equal(opt.getAttribute("aria-pressed"), "false");
		const inner = opt.querySelector("p, span:not([data-work-id])") ?? opt;
		await act(async () => void inner.dispatchEvent(new dom.window.Event("click", { bubbles: true, cancelable: true })));
		assert.equal(document.querySelector('[data-testid="card-option"]')!.getAttribute("aria-pressed"), "true");
		await act(async () => root.unmount());
		document.body.innerHTML = "";
	});
});

describe("no nested buttons in card options", () => {
	it("an option description with a link and an id renders no button inside a button", async () => {
		const card = {
			tool: "t",
			fields: [{ id: "m", kind: "multi", label: "Pick", options: [{ label: "A", value: "a", description: `see [docs](https://x.test) and ${ID}` }] }],
		} as unknown as Card;
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		await act(async () => root.render(<AskCard callId="c1" card={card} pending submitting={false} onAnswer={() => {}} />));
		const opt = document.querySelector('[data-testid="card-option"]')!;
		assert.equal(opt.querySelectorAll("button").length, 0);
		assert.ok(opt.querySelector(`[data-work-id="${ID}"]`));
		assert.ok(opt.textContent!.includes("docs"));
		await act(async () => root.unmount());
		document.body.innerHTML = "";
	});
});
