/**
 * Seam: the Keys section (components/pack/pack-keys.tsx) rendered to static markup (first paint; effects don't run in SSR).
 * Covers: the grid (groups, env shadowing, missing dictation key), the no-X25519 message, and the result wording.
 */
import React from "react";
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
