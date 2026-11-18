/**
 * Seam: the Keys section (components/pack/pack-keys.tsx) rendered to static markup (first paint; effects don't run in SSR).
 * Covers: the grid (groups, env shadowing, missing dictation key), the no-X25519 message, and the result wording.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { KeyEditor, KeysView, outcomeText } from "../../../components/pack/pack-keys.tsx";
import type { KeyMachine } from "../../../src/core/pack/keys-model.ts";

const send = (async () => ({ id: "c", ok: true })) as never;
const machines: KeyMachine[] = [
	{ hostId: "mac", machine: "Mac", online: true, canSetKeys: true, servesConsole: true, pubkey: "PK", slots: [{ slot: "anthropic", present: true, masked: "••••4f2a", source: "pack" }] },
	{ hostId: "sfo", machine: "sfo-01", online: true, canSetKeys: true, pubkey: "PK2", keyChanged: true, fingerprint: "ff00", slots: [{ slot: "anthropic", present: true, masked: "••••9c1e", source: "pack", shadowsEnv: true }] },
];

describe("Pack > Keys", () => {
	it("a browser without X25519 gets a clear message and no key field", () => {
		const html = renderToStaticMarkup(
			<KeyEditor slot="anthropic" providerName="Anthropic" machines={machines} support={{ ok: false, message: "This browser can't seal keys (it lacks X25519 in WebCrypto)" }} send={send} onClose={() => {}} onDone={() => {}} />,
		);
		assert.match(html, /data-testid="keys-no-x25519"/);
		assert.match(html, /lacks X25519/);
		assert.ok(!html.includes("<input"));
	});

	it("the grid groups by capability, says when the environment is overridden, flags a missing dictation key and a changed machine key", () => {
		const html = renderToStaticMarkup(<KeysView machines={machines} support={{ ok: true }} send={send} reload={() => {}} />);
		assert.match(html, /data-testid="keys-group-chat"/);
		assert.match(html, /data-testid="keys-group-memory"/);
		assert.match(html, /overrides environment/);
		assert.match(html, /Needs a key/); // Mac serves a console and has no Deepgram key
		assert.match(html, /data-testid="keys-changed-sfo"/);
	});

	it("the editor lists every machine and the editor warns nothing without a mid-reply wolf", () => {
		const html = renderToStaticMarkup(<KeyEditor slot="anthropic" providerName="Anthropic" machines={machines} support={{ ok: true }} send={send} onClose={() => {}} onDone={() => {}} />);
		assert.match(html, /data-testid="keys-target-mac"/);
		assert.match(html, /data-testid="keys-target-sfo"/);
		assert.ok(!html.includes("keys-midreply"));
	});

	it("a machine whose key changed gets a disabled checkbox and is never a sealing target, until acked", () => {
		const html = renderToStaticMarkup(<KeyEditor slot="anthropic" providerName="Anthropic" machines={machines} support={{ ok: true }} send={send} onClose={() => {}} onDone={() => {}} />);
		const sfo = /data-testid="keys-target-sfo".*?<\/li>/s.exec(html)![0];
		const mac = /data-testid="keys-target-mac".*?<\/li>/s.exec(html)![0];
		assert.match(sfo, /<input type="checkbox" disabled=""/);
		assert.match(mac, /<input type="checkbox"(?! disabled)/);
		assert.match(html, /Send sealed to 1 machine\b/);
	});

	it("says that removing a key falls back to the machine's environment key", () => {
		const html = renderToStaticMarkup(<KeyEditor slot="anthropic" providerName="Anthropic" machines={machines} support={{ ok: true }} send={send} onClose={() => {}} onDone={() => {}} />);
		assert.match(html, /Remove from Mac/);
		assert.match(html, /falls back to the environment key/);
	});

	it("names mid-reply wolves before sending", () => {
		const m = machines.map((x, i) => (i === 0 ? { ...x, midReply: ["hal", "bridge"], wolves: [{ name: "hal", transport: "api" as const }, { name: "bridge", transport: "subscription" as const }] } : x));
		const html = renderToStaticMarkup(<KeyEditor slot="anthropic" providerName="Anthropic" machines={m} support={{ ok: true }} send={send} onClose={() => {}} onDone={() => {}} />);
		assert.match(html, /Mid-reply right now: hal on Mac\./);
		assert.ok(!html.includes("bridge on Mac"));
		assert.match(html, /restarts hal on Mac/);
	});

	it("a subscription-only machine is not restarted and not warned about, and its grid cell says Claude subscription", () => {
		const m: KeyMachine[] = [{ hostId: "b", machine: "Bridge", online: true, canSetKeys: true, pubkey: "PK", midReply: ["hal"], wolves: [{ name: "hal", transport: "subscription" }], slots: [] }];
		const editor = renderToStaticMarkup(<KeyEditor slot="anthropic" providerName="Anthropic" machines={m} support={{ ok: true }} send={send} onClose={() => {}} onDone={() => {}} />);
		assert.ok(!editor.includes("keys-midreply"));
		assert.match(editor, /restarts no wolves/);
		const grid = renderToStaticMarkup(<KeysView machines={m} support={{ ok: true }} send={send} reload={() => {}} />);
		const chatCell = /data-testid="keys-cell-chat-anthropic-b"[^>]*>([^<]*)</.exec(grid)![1];
		assert.equal(chatCell, "Claude subscription");
	});

	it("result wording: provider reason on rejection, restarted wolves on success, unknown outcome on timeout", () => {
		assert.match(outcomeText({ id: "c", ok: false, code: "rejected_key", message: "invalid x-api-key" }).text, /rejected this key: invalid x-api-key.*old key is kept/);
		assert.equal(outcomeText({ id: "c", ok: true, data: { restarted: [{ wolf: "hal", midReply: true }, { wolf: "dewey", midReply: false }] } }).text, "Saved. Restarted hal (was mid-reply), dewey.");
		assert.equal(outcomeText({ id: "c", ok: true, data: { restarted: [] } }, "anthropic").text, "Saved. No wolf on this machine uses it; the hub's memory picks it up after the hub restarts.");
		assert.equal(outcomeText({ id: "c", ok: true, data: { restarted: [] } }, "deepgram").text, "Saved.");
		assert.equal(outcomeText({ id: "c", ok: false, code: "timeout" }).tone, "unknown");
	});
});

describe("Pack > Keys > phone list", () => {
	const html = renderToStaticMarkup(<KeysView machines={machines} support={{ ok: true }} send={send} reload={() => {}} />);
	const stateOf = (testid: string) => new RegExp(`data-testid="${testid}"[^>]*>([^<]*)<`).exec(html)?.[1];

	it("lists a machine row under each key in every group it is in, with the same state text as the grid cell and the cell's note", () => {
		for (const g of ["chat", "memory"]) {
			assert.equal(stateOf(`keys-state-${g}-anthropic-mac`), "••••4f2a · Pack");
			assert.equal(stateOf(`keys-cell-${g}-anthropic-mac`), "••••4f2a · Pack");
			assert.equal(stateOf(`keys-state-${g}-anthropic-sfo`), "••••9c1e · Pack (overrides environment)");
			assert.equal(stateOf(`keys-cell-${g}-anthropic-sfo`), "••••9c1e · Pack (overrides environment)");
		}
		assert.match(html, /data-testid="keys-note-chat-anthropic-sfo"[^>]*>The Pack(?:'|&#x27;)s key is used; this machine(?:'|&#x27;)s environment also sets one\./);
		assert.ok(!html.includes('data-testid="keys-note-chat-anthropic-mac"')); // no note, no line
	});

	it("a machine that cannot take keys is a plain row, not a button", () => {
		// sfo's key changed, so it is never a sealing target
		assert.match(html, /<button[^>]*data-testid="keys-row-chat-anthropic-mac"/);
		assert.match(html, /<div[^>]*data-testid="keys-row-chat-anthropic-sfo"/);
	});

	it("a plain row says why it cannot be tapped, in the editor's words", () => {
		assert.match(html, /data-testid="keys-why-chat-anthropic-sfo"[^>]*>its key changed</);
		assert.ok(!html.includes('data-testid="keys-why-chat-anthropic-mac"'));
		const old: KeyMachine[] = [{ hostId: "old", machine: "old-box", online: true, canSetKeys: false, slots: [] }];
		const oldHtml = renderToStaticMarkup(<KeysView machines={old} support={{ ok: true }} send={send} reload={() => {}} />);
		assert.match(oldHtml, /data-testid="keys-why-chat-anthropic-old"[^>]*>can(?:'|&#x27;)t take keys \(update its workerd\)</);
	});

	it("tapping a machine's row opens the editor with only that machine picked", async () => {
		const { createRoot } = await import("react-dom/client");
		const { parseHTML } = await import("linkedom");
		const dom = parseHTML("<html><body></body></html>");
		Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
		const two: KeyMachine[] = [
			{ hostId: "a", machine: "Alpha", online: true, canSetKeys: true, pubkey: "PA", slots: [] },
			{ hostId: "b", machine: "Beta", online: true, canSetKeys: true, pubkey: "PB", slots: [] },
		];
		const host = dom.document.createElement("div");
		dom.document.body.appendChild(host);
		const root = createRoot(host);
		await act(async () => root.render(<KeysView machines={two} support={{ ok: true }} send={send} reload={() => {}} />));
		const tap = (id: string) => act(async () => void dom.document.querySelector(`[data-testid="${id}"]`)!.dispatchEvent(new dom.window.Event("click", { bubbles: true, cancelable: true })));
		const checked = () => ["a", "b"].map((h) => (dom.document.querySelector(`[data-testid="keys-target-${h}"] input`) as HTMLInputElement).checked);
		await tap("keys-row-chat-anthropic-b");
		assert.deepEqual(checked(), [false, true]);
		assert.match(dom.document.querySelector('[data-testid="keys-editor"]')!.textContent ?? "", /Send sealed to 1 machine\b/);
		await tap("keys-name-chat-anthropic"); // the card's name: the default selection, every machine
		assert.deepEqual(checked(), [true, true]);
		await act(async () => root.unmount());
	});
});
