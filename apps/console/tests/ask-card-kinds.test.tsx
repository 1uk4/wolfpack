/**
 * AskCard field kinds (multi / confirm) mounted directly: rendering, Other entries, min/max bounds, defaults that
 * pre-select without submitting, and the read-only answered record. Pure draft logic is covered at the bottom.
 */
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

type Card = import("@wolfpack/client").Card;
type CardAnswers = import("@wolfpack/client").CardAnswers;
const { AskCard } = await import("../components/ask-card.tsx");
const { draftAnswers, draftComplete, initialDraft } = await import("../src/core/index.ts");

const OPTS = [{ label: "Alpha", value: "a" }, { label: "Beta", value: "b" }, { label: "Gamma", value: "c" }];
const multi = (extra: object = {}): Card => ({ tool: "t", fields: [{ id: "m", kind: "multi", label: "Pick", options: OPTS, ...extra }] as Card["fields"] });
const confirm = (extra: object = {}): Card => ({ tool: "t", fields: [{ id: "c", kind: "confirm", label: "Sure?", ...extra }] as Card["fields"] });

let root: Root | null = null;
const sent: CardAnswers[] = [];
type Props = Partial<React.ComponentProps<typeof AskCard>>;
async function mount(card: Card, props: Props = {}) {
	sent.length = 0;
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(<AskCard callId="c1" card={card} pending submitting={false} onAnswer={(a) => void sent.push(a)} {...props} />);
	});
}
const click = (el: Element) =>
	act(async () => {
		el.dispatchEvent(Object.assign(new dom.window.Event("click", { bubbles: true, cancelable: true }), { detail: 1 }));
	});
// linkedom inputs don't drive React's change plumbing (no `type` on <input>), so call the element's onChange prop.
const type = (el: HTMLInputElement, value: string) =>
	act(async () => {
		const key = Object.keys(el).find((k) => k.startsWith("__reactProps"))!;
		(el as unknown as Record<string, { onChange(e: unknown): void }>)[key]!.onChange({ target: { value } });
	});
const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const qa = (sel: string) => [...document.querySelectorAll(sel)] as HTMLElement[];
const checked = () => qa('[data-testid="card-option"]').map((o) => o.getAttribute("aria-pressed"));
const submit = () => q('[data-testid="card-submit"]')!;

async function unmountRoot() {
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
}
afterEach(unmountRoot);

describe("AskCard multi", () => {
	it("renders checkboxes; toggling picks, Submit sends the list in click order", async () => {
		await mount(multi());
		assert.equal(qa('[data-testid="card-option"]').length, 3);
		assert.equal(q('[data-testid="card-other"]'), null, "no Other without allowOther");
		await click(qa('[data-testid="card-option"]')[2]!);
		await click(qa('[data-testid="card-option"]')[0]!);
		assert.deepEqual(checked(), ["true", "false", "true"]);
		await click(submit());
		assert.deepEqual(sent, [{ m: { value: ["c", "a"] } }]);
	});

	it("defaults pre-select but never submit", async () => {
		await mount(multi({ default: ["a", "b"] }));
		assert.deepEqual(checked(), ["true", "true", "false"]);
		await new Promise((r) => setTimeout(r, 100));
		assert.deepEqual(sent, []);
		assert.equal(submit().hasAttribute("disabled"), false, "a valid default can be submitted by the operator");
		await click(qa('[data-testid="card-option"]')[1]!);
		await click(submit());
		assert.deepEqual(sent, [{ m: { value: ["a"] } }]);
	});

	it("min blocks Submit; max disables the unchecked boxes", async () => {
		await mount(multi({ min: 1, max: 2 }));
		assert.equal(submit().hasAttribute("disabled"), true, "under min");
		await click(qa('[data-testid="card-option"]')[0]!);
		assert.equal(submit().hasAttribute("disabled"), false);
		await click(qa('[data-testid="card-option"]')[1]!);
		assert.equal(qa('[data-testid="card-option"]')[2]!.hasAttribute("disabled"), true, "at max");
		await click(qa('[data-testid="card-option"]')[1]!);
		assert.equal(qa('[data-testid="card-option"]')[2]!.hasAttribute("disabled"), false);
	});

	it("allowOther: a typed entry is added as a checked custom row and sent with `other`; it can be unchecked", async () => {
		await mount(multi({ allowOther: true }));
		await click(qa('[data-testid="card-option"]')[0]!);
		await type(q('[data-testid="card-other"]') as HTMLInputElement, "  mine ");
		await click(q('[data-testid="card-other-add"]')!);
		const rows = qa('[data-testid="card-option"]');
		assert.equal(rows.length, 4);
		assert.equal(rows[3]!.getAttribute("data-custom"), "true");
		assert.equal(rows[3]!.getAttribute("aria-pressed"), "true");
		await click(submit());
		assert.deepEqual(sent, [{ m: { value: ["a", "mine"], other: ["mine"] } }]);
		await click(qa('[data-testid="card-option"]')[3]!);
		assert.equal(qa('[data-testid="card-option"]').length, 3, "unchecking a custom entry removes it");
	});

	it("text typed in Other… but not added is folded in on Submit (never lost)", async () => {
		await mount(multi({ allowOther: true, min: 2 }));
		await click(qa('[data-testid="card-option"]')[0]!);
		assert.equal(submit().hasAttribute("disabled"), true, "min 2 not met yet");
		await type(q('[data-testid="card-other"]') as HTMLInputElement, " teal ");
		assert.equal(submit().hasAttribute("disabled"), false, "the pending entry counts toward min");
		await click(submit());
		assert.deepEqual(sent, [{ m: { value: ["a", "teal"], other: ["teal"] } }]);
	});

	it("a custom entry equal to an option value is rejected (Add and Submit blocked, message shown)", async () => {
		await mount(multi({ allowOther: true }));
		await click(qa('[data-testid="card-option"]')[0]!);
		await type(q('[data-testid="card-other"]') as HTMLInputElement, "b");
		assert.match(q('[data-testid="card-other-error"]')?.textContent ?? "", /already an option/);
		assert.equal(q('[data-testid="card-other-add"]')!.hasAttribute("disabled"), true);
		assert.equal(submit().hasAttribute("disabled"), true);
		await click(q('[data-testid="card-other-add"]')!);
		assert.equal(qa('[data-testid="card-option"]').length, 3);
		await type(q('[data-testid="card-other"]') as HTMLInputElement, "");
		assert.equal(q('[data-testid="card-other-error"]'), null);
		assert.equal(submit().hasAttribute("disabled"), false);
	});

	it("pending Other text beyond max blocks Submit", async () => {
		await mount(multi({ allowOther: true, max: 1 }));
		await click(qa('[data-testid="card-option"]')[0]!);
		await type(q('[data-testid="card-other"]') as HTMLInputElement, "extra");
		assert.match(q('[data-testid="card-other-error"]')?.textContent ?? "", /At most 1/);
		assert.equal(submit().hasAttribute("disabled"), true);
	});

	it("groups are labelled by the field label and buttons use aria-pressed (no radio/checkbox roles)", async () => {
		await mount(multi());
		const group = q('[data-testid="card-multi"]')!;
		const label = document.getElementById(group.getAttribute("aria-labelledby")!);
		assert.match(label?.textContent ?? "", /Pick/);
		assert.equal(qa('[role="checkbox"], [role="radio"]').length, 0);
	});

	it("held answer pre-selects with the saved note; answered record is read-only", async () => {
		await mount(multi(), { heldAnswer: { m: { value: ["b"] } } });
		assert.ok(q('[data-testid="card-held"]'));
		assert.deepEqual(checked(), ["false", "true", "false"]);
		assert.match(submit().textContent ?? "", /Update answer/);
		await act(async () => root?.unmount());
		document.body.innerHTML = "";
		await mount(multi({ allowOther: true }), { answer: { m: { value: ["a", "mine"], other: ["mine"] } }, pending: false });
		assert.ok(q('[data-testid="answered-card"]'));
		assert.equal(q('[data-testid="card-submit"]'), null);
		const rows = qa('[data-testid="card-option"]');
		assert.deepEqual(rows.map((r) => r.getAttribute("aria-pressed")), ["true", "false", "false", "true"]);
		assert.ok(rows.every((r) => r.hasAttribute("disabled")));
	});

	it("a bare dismissed (older server) reads as Superseded with no controls", async () => {
		await mount(multi(), { dismissed: true, pending: false });
		assert.match(q('[data-testid="dismissed-card"]')?.textContent ?? "", /Superseded/);
		assert.equal(q('[data-testid="card-submit"]'), null);
		assert.ok(qa('[data-testid="card-option"]').every((r) => r.hasAttribute("disabled")));
	});
});

describe("AskCard skip and closed badges", () => {
	it("Skip sits next to Submit, calls onSkip without answering, and is disabled when not pending", async () => {
		let skips = 0;
		await mount(multi(), { onSkip: () => void skips++ });
		await click(q('[data-testid="card-skip"]')!);
		assert.equal(skips, 1);
		assert.deepEqual(sent, []);
		assert.ok(q('[data-testid="card-submit"]'));
		await unmountRoot();
		await mount(multi(), { onSkip: () => void skips++, pending: false });
		assert.ok(q('[data-testid="card-skip"]')!.hasAttribute("disabled"));
	});

	it("each closed state has its own badge, styling and test hook", async () => {
		const seen: Record<string, string | null> = {};
		const cases: [string, CardAnswers | undefined][] = [["answered", { m: { value: ["a"] } }], ["skipped", undefined], ["superseded", undefined]];
		for (const [closed, answer] of cases) {
			await mount(multi(), { closed: closed as "answered", dismissed: closed !== "answered", answer, pending: false });
			const badge = q('[data-testid="card-closed-badge"]')!;
			assert.equal(badge.getAttribute("data-closed"), closed);
			assert.equal(badge.textContent, ({ answered: "Answered", skipped: "Skipped", superseded: "Superseded" } as Record<string, string>)[closed]);
			assert.equal(q('[data-testid="card-skip"]'), null);
			seen[closed] = badge.getAttribute("class");
			await unmountRoot();
		}
		assert.equal(new Set(Object.values(seen)).size, 3, "three distinct badge styles");
	});
});

describe("AskCard confirm", () => {
	it("renders Yes/No by default and custom labels; nothing selected without a default; Submit needs a choice", async () => {
		await mount(confirm());
		assert.equal(q('[data-testid="card-confirm"]')!.textContent, "Yes");
		assert.equal(q('[data-testid="card-reject"]')!.textContent, "No");
		assert.equal(submit().hasAttribute("disabled"), true);
		await click(q('[data-testid="card-confirm"]')!);
		await click(submit());
		assert.deepEqual(sent, [{ c: { value: true } }]);
	});

	it("reject sends false; custom labels render", async () => {
		await mount(confirm({ confirmLabel: "Ship", rejectLabel: "Hold" }));
		assert.equal(q('[data-testid="card-reject"]')!.textContent, "Hold");
		await click(q('[data-testid="card-reject"]')!);
		await click(submit());
		assert.deepEqual(sent, [{ c: { value: false } }]);
	});

	it("default false pre-selects reject and does not auto-submit", async () => {
		await mount(confirm({ default: false }));
		assert.equal(q('[data-testid="card-reject"]')!.getAttribute("aria-pressed"), "true");
		assert.equal(q('[data-testid="card-confirm"]')!.getAttribute("aria-pressed"), "false");
		await new Promise((r) => setTimeout(r, 100));
		assert.deepEqual(sent, []);
	});

	it("answered record marks the choice and disables both buttons; held shows its note", async () => {
		await mount(confirm(), { answer: { c: { value: true } }, pending: false });
		assert.ok(q('[data-testid="answered-card"]'));
		assert.equal(q('[data-testid="card-confirm"]')!.getAttribute("aria-pressed"), "true");
		assert.ok(q('[data-testid="card-confirm"]')!.hasAttribute("disabled") && q('[data-testid="card-reject"]')!.hasAttribute("disabled"));
		await act(async () => root?.unmount());
		document.body.innerHTML = "";
		await mount(confirm(), { heldAnswer: { c: { value: false } } });
		assert.ok(q('[data-testid="card-held"]'));
		assert.equal(q('[data-testid="card-reject"]')!.getAttribute("aria-pressed"), "true");
	});
});

describe("draft logic", () => {
	it("initialDraft pre-selects defaults per kind; draftComplete/draftAnswers follow the kind", () => {
		const card: Card = {
			tool: "t",
			fields: [
				{ id: "m", kind: "multi", label: "m", options: OPTS, default: ["a"], min: 1 },
				{ id: "c", kind: "confirm", label: "c", default: false },
				{ id: "s", kind: "single", label: "s", options: OPTS },
			],
		};
		const d = initialDraft(card);
		assert.deepEqual(d, { m: { value: ["a"] }, c: { value: false } });
		assert.equal(draftComplete(card, d), false, "single unanswered");
		const full = { ...d, s: { value: " b " } };
		assert.equal(draftComplete(card, full), true);
		assert.deepEqual(draftAnswers(card, full), { m: { value: ["a"] }, c: { value: false }, s: { value: "b" } });
		assert.equal(draftComplete(card, { ...full, m: { value: [] } }), false, "under min");
	});
});
