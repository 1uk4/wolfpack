/** Composer controls: the tier dropdown + auto-ship toggle render, a change PUTs the settings, a refusal rolls back. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MockConsoleClient } from "@wolfpack/client";
import { Composer } from "../components/composer.tsx";
import { ComposerControls, TierMenuList } from "../components/composer-controls.tsx";
import { changeSettings, fetchSettings, putSettings, type ThreadSettingsState } from "../components/composer-settings.ts";
import { settingsUrl } from "../components/thread-transport.ts";
import { createThreadApi } from "../src/server/thread-api.ts";

const MODELS = { main: "claude-opus-x", smart: "claude-sonnet-x", fast: "claude-haiku-x" };
const noop = () => {};

describe("ComposerControls render", () => {
	it("shows the tier and the auto-ship switch (off by default), with the resolved model as a hint", () => {
		const html = renderToStaticMarkup(<ComposerControls settings={{ tier: "smart", autoShip: false, models: MODELS }} onChange={noop} />);
		assert.match(html, /data-testid="composer-controls"/);
		assert.match(html, /data-testid="tier-trigger"/);
		assert.match(html, />smart</);
		assert.match(html, /title="smart → claude-sonnet-x"/);
		assert.match(html, /data-testid="toggle-auto-ship"[^>]*aria-checked="false"|aria-checked="false"[^>]*data-testid="toggle-auto-ship"/);
		assert.doesNotMatch(html, /data-testid="tier-menu"/);
	});

	it("auto-ship on reads checked; an error shows", () => {
		const html = renderToStaticMarkup(<ComposerControls settings={{ tier: "main", autoShip: true }} error="wolf said no" onChange={noop} />);
		assert.match(html, /aria-checked="true"/);
		assert.match(html, /wolf said no/);
	});

	it("the open menu offers exactly main / smart / fast with each tier's model", () => {
		const html = renderToStaticMarkup(<TierMenuList settings={{ tier: "main", autoShip: false, models: MODELS }} onPick={noop} />);
		for (const t of ["main", "smart", "fast"]) assert.match(html, new RegExp(`data-testid="tier-option-${t}"`));
		assert.equal(html.match(/data-testid="tier-option-/g)?.length, 3);
		for (const m of Object.values(MODELS)) assert.match(html, new RegExp(m));
	});

	it("the Composer places the controls beside the send button", () => {
		const html = renderToStaticMarkup(<Composer busy={false} value="" onChange={noop} onSend={noop} onStop={noop} canSend={false} controls={<ComposerControls settings={{ tier: "main", autoShip: false }} onChange={noop} />} />);
		assert.ok(html.indexOf("composer-controls") > 0 && html.indexOf("composer-controls") < html.indexOf('aria-label="Send"'));
	});
});

describe("changeSettings (optimistic, rollback)", () => {
	const start: ThreadSettingsState = { tier: "main", autoShip: false };
	const harness = (put: Parameters<typeof changeSettings>[0]["put"]) => {
		let state = start;
		const seen: ThreadSettingsState[] = [];
		const set = (u: (s: ThreadSettingsState) => ThreadSettingsState) => {
			state = u(state);
			seen.push(state);
		};
		return { run: (patch: Parameters<typeof changeSettings>[0]["patch"]) => changeSettings({ current: state, patch, put, set }), get: () => state, seen };
	};

	it("shows the change at once and PUTs exactly the patch", async () => {
		const puts: unknown[] = [];
		const h = harness(async (p) => (puts.push(p), { ...start, ...p, models: MODELS }));
		const done = h.run({ tier: "fast" });
		assert.equal(h.get().tier, "fast", "optimistic before the PUT settles");
		assert.deepEqual(await done, { ok: true });
		assert.deepEqual(puts, [{ tier: "fast" }]);
		assert.deepEqual(h.get(), { tier: "fast", autoShip: false, models: MODELS });
	});

	it("rolls back only what it changed when the wolf refuses, and reports the error", async () => {
		const h = harness(async () => {
			throw new Error("engine said no");
		});
		const r = await h.run({ autoShip: true });
		assert.deepEqual(r, { ok: false, error: "engine said no" });
		assert.equal(h.get().autoShip, false);
		assert.deepEqual(h.seen.map((s) => s.autoShip), [true, false]);
	});

	it("a failed change does not undo a later change to the other field", async () => {
		const rejects: Array<(e: Error) => void> = [];
		const h = harness((p) => new Promise((resolve, reject) => (p.tier ? rejects.push(reject) : resolve({ ...start, ...p }))));
		const first = h.run({ tier: "smart" }); // pending
		assert.deepEqual(await h.run({ autoShip: true }), { ok: true });
		rejects[0]!(new Error("no")); // the tier change is refused afterwards
		assert.deepEqual(await first, { ok: false, error: "no" });
		assert.equal(h.get().tier, "main");
		assert.equal(h.get().autoShip, true);
	});
});

describe("settings over the wire", () => {
	it("putSettings sends PUT JSON to the settings url; a non-2xx carries the server's message", async () => {
		const calls: { url: string; init?: RequestInit }[] = [];
		const ok = async (url: string, init?: RequestInit) => (calls.push({ url, init }), Response.json({ tier: "fast", autoShip: false }));
		assert.deepEqual(await putSettings(settingsUrl("1uk4", "home"), { tier: "fast" }, ok), { tier: "fast", autoShip: false });
		assert.equal(calls[0]!.url, "/api/wolves/1uk4/threads/home/settings");
		assert.equal(calls[0]!.init?.method, "PUT");
		assert.equal(calls[0]!.init?.body, JSON.stringify({ tier: "fast" }));
		const bad = async () => Response.json({ error: "could not switch" }, { status: 502 });
		await assert.rejects(putSettings("/x", { tier: "fast" }, bad), /could not switch/);
		await assert.rejects(fetchSettings("/x", bad), /could not switch/);
	});

	it("the thread API relays GET / PUT to the client and validates the body", async () => {
		const client = new MockConsoleClient({ delayMs: 0 });
		const api = createThreadApi(() => client);
		const ref = { wolf: "1uk4", slug: "home" };
		const put = (body: unknown) => api.putSettings(ref, new Request("http://t", { method: "PUT", body: JSON.stringify(body) }));
		assert.deepEqual(await (await api.getSettings(ref)).json(), { tier: "main", autoShip: false });
		assert.equal((await put({ tier: "smart", autoShip: true })).status, 200);
		assert.deepEqual(await (await api.getSettings(ref)).json(), { tier: "smart", autoShip: true });
		assert.equal((await put({})).status, 400);
		assert.equal((await put({ tier: "huge" })).status, 400);
		assert.equal((await put({ autoShip: "yes" })).status, 400);
		assert.equal((await api.getSettings({ wolf: "1uk4", slug: "nope" })).status, 404);
	});
});
