/** /pair without a #token: a single "Pairing token or link" input; submitting (Enter) stores the token like the link flow and goes home. */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as ReactDOMClient from "react-dom/client";
import { flushSync } from "react-dom";
import { act } from "react";
import { parseHTML } from "linkedom";
import { HUB_TOKEN_KEY } from "../../../src/core/ui/hub-auth.ts";

const dom = parseHTML("<html><body></body></html>");
const store = new Map<string, string>();
const replaced: string[] = [];
Object.assign(globalThis, {
	window: Object.assign(dom.window, {
		localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
		location: { hash: "", pathname: "/pair", protocol: "http:", replace: (u: string) => void replaced.push(u) },
	}),
	document: dom.document,
	history: { replaceState: () => {} },
	fetch: async () => ({ json: async () => ({ url: null }) }),
	IS_REACT_ACT_ENVIRONMENT: true,
});

const { default: PairPage } = await import("../../../app/pair/page.tsx");

const mount = async () => {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = ReactDOMClient.createRoot(host);
	await act(async () => {
		root.render(<PairPage />);
	});
	return { host, root };
};
const submit = (host: HTMLElement, value: string) => {
	const input = host.querySelector("input")!;
	input.value = value;
	flushSync(() => host.querySelector("form")!.dispatchEvent(new (window as never as { Event: typeof Event }).Event("submit", { bubbles: true, cancelable: true })));
};

describe("pair page sign-in box", () => {
	it("labels one input, stores a pasted pairing link's token and opens the console home", async () => {
		const { host, root } = await mount();
		assert.match(host.innerHTML, /Pairing token or link/);
		assert.equal(host.querySelectorAll("input").length, 1);
		submit(host, "http://127.0.0.1:3231/pair#token=tok123");
		assert.equal(store.get(HUB_TOKEN_KEY), "tok123");
		assert.deepEqual(replaced, ["/"]);
		root.unmount();
	});
	it("shows an inline error for garbage and stores nothing", async () => {
		store.clear();
		replaced.length = 0;
		const { host, root } = await mount();
		submit(host, "not a token!");
		assert.equal(store.size, 0);
		assert.deepEqual(replaced, []);
		assert.match(host.innerHTML, /role="alert"/);
		assert.doesNotMatch(host.querySelector("[role='alert']")!.textContent ?? "", /not a token/, "the error never echoes the input");
		root.unmount();
	});
});
