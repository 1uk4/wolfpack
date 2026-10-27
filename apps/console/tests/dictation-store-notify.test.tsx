/**
 * The dictation UI store notifies its useSyncExternalStore listeners from effects (hook mount/unmount/mirror, claim
 * effects). Notifying synchronously inside the commit that places/removes InlineMic fibers made React dev warn
 * "Can't perform a React state update on a component that hasn't mounted yet". Route transitions, card churn and
 * hook swaps must stay console.error-clean.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
	ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
	getComputedStyle: () => ({ animationName: "none" }),
});
Object.assign(dom.window.Element.prototype, { attachEvent() {}, detachEvent() {} });

const { SettingsDialogProvider } = await import("../components/settings/settings-dialog.tsx");
const { AskCard } = await import("../components/ask-card.tsx");
const { useDictation, InlineMic } = await import("../components/dictation.tsx");

const CARD = {
	tool: "ask_user_question",
	fields: [
		{ id: "why", kind: "free-text", label: "Why?" },
		{ id: "pick", kind: "single", label: "Which?", options: [{ label: "a", value: "a" }] },
		{ id: "many", kind: "multi", label: "Many?", options: [{ label: "x", value: "x" }], allowOther: true },
	],
} as never;

function Host({ name, children }: { name: string; children?: React.ReactNode }) {
	useDictation({ append: () => {} });
	return (
		<div data-host={name}>
			<InlineMic targetKey={`${name}-1`} onClaim={() => {}} />
			<InlineMic targetKey={`${name}-2`} onClaim={() => {}} />
			{children}
		</div>
	);
}
const card = (id: string) => <AskCard key={id} card={CARD} callId={id} pending submitting={false} onAnswer={() => {}} />;

let root: Root | null = null;
let errors: string[] = [];
const realError = console.error;
beforeEach(() => {
	errors = [];
	console.error = (...a: unknown[]) => void errors.push(a.map(String).join(" "));
});
afterEach(async () => {
	console.error = realError;
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});

const render = (node: React.ReactNode) =>
	act(async () => {
		if (!root) {
			const host = document.createElement("div");
			document.body.appendChild(host);
			root = createRoot(host);
		}
		root.render(<SettingsDialogProvider>{node}</SettingsDialogProvider>);
	});
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 10))));

describe("dictation store notifications", () => {
	it("mounts a hook host with several inline mics and cards without warnings", async () => {
		await render(<Host name="a">{card("c1")}{card("c2")}</Host>);
		await flush();
		assert.equal(document.querySelectorAll('[data-testid="inline-mic"]').length, 8);
		assert.deepEqual(errors, []);
	});

	it("swaps one hook host for another (route transition) without warnings", async () => {
		await render(<Host name="a">{card("c1")}</Host>);
		await render(<Host name="b">{card("c2")}</Host>);
		await flush();
		await render(<div />);
		await flush();
		assert.deepEqual(errors, []);
	});

	it("overlaps old and new hook hosts in one commit without warnings", async () => {
		await render(<div><Host name="a">{card("c1")}</Host></div>);
		await render(<div><Host name="b">{card("c2")}</Host></div>);
		await render(<section><Host name="c">{card("c3")}</Host><Host name="d">{card("c4")}</Host></section>);
		await flush();
		assert.deepEqual(errors, []);
	});

	it("mounts and unmounts cards while a hook stays live without warnings", async () => {
		const tree = (ids: string[]) => <Host name="a">{ids.map(card)}</Host>;
		await render(tree([]));
		await render(tree(["c1", "c2"]));
		await render(tree(["c2", "c3"]));
		await render(tree([]));
		await render(tree(["c4"]));
		await flush();
		assert.deepEqual(errors, []);
	});
});
