/** P4: the devices API (request-scoped token, markers), the Devices panel markup, and the per-connection activity bridge lifecycle. */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConsoleClient } from "@wolfpack/client";
import { DevicesView, addedDescendants, lastUsedLabel, type DeviceRow } from "../../../components/settings/devices-section.tsx";
import { createDevicesApi, pairLink } from "../../../src/server/pack/devices-api.ts";
import { createConsoleClient, makeRequestToken } from "../../../src/server/console-client.ts";
import { eventsResponse, eventsRoute } from "../../../src/server/events-stream.ts";
import { setConsoleClient } from "../../../src/server/console-client.ts";
import { wireSource, createNotifyHub, type NotifySource } from "../../../components/server-events.tsx";
import { withHubAuth } from "../../../src/core/hub-auth.ts";
import { HUB_AUTH_HEADER } from "../../../src/core/hub-auth.ts";

const NOW = Date.parse("2026-11-02T12:00:00Z");
const rows: DeviceRow[] = [
	{ id: "tok-a", label: "Phone", kind: "browser", createdAt: "2026-11-01T00:00:00Z", lastUsedAt: "2026-11-02T11:55:00Z", self: true },
	{ id: "tok-b", label: "Laptop", kind: "console", createdAt: "2026-11-01T00:00:00Z", lastUsedAt: null, self: false },
];
const noop = () => {};
const view = (over: Partial<Parameters<typeof DevicesView>[0]> = {}) =>
	renderToStaticMarkup(<DevicesView devices={rows} now={NOW} confirming={null} onAsk={noop} onRevoke={noop} onAdd={noop} onDismissCode={noop} {...over} />);

describe("Devices panel (markup)", () => {
	it("lists label, last used and marks only this device; each row has Revoke", () => {
		const html = view();
		assert.match(html, /Phone/);
		assert.match(html, /last used 5 min ago/);
		assert.match(html, /last used never/);
		assert.equal((html.match(/data-testid="device-self"/g) ?? []).length, 1);
		assert.equal((html.match(/data-testid="device-revoke"/g) ?? []).length, 2);
		assert.match(html, /data-testid="device-add"/);
		assert.doesNotMatch(html, /device-confirm/);
	});
	it("confirming shows Confirm/Cancel for that row only; self says sign out", () => {
		const html = view({ confirming: "tok-a" });
		assert.equal((html.match(/data-testid="device-confirm"/g) ?? []).length, 1);
		assert.match(html, /Sign out &amp; revoke/);
		assert.equal((html.match(/data-testid="device-revoke"/g) ?? []).length, 1);
		assert.match(view({ confirming: "tok-b" }), /Confirm revoke/);
	});
	it("shows a minted pairing code and link; phone layout classes stack rows and use 44px targets", () => {
		const html = view({ code: { code: "ABC123", expiresAt: "2026-11-02T12:10:00Z", url: "https://hub.example/pair?code=ABC123" } });
		assert.match(html, /data-testid="device-code-value"[^>]*>ABC123</);
		assert.match(html, /href="https:\/\/hub\.example\/pair\?code=ABC123"/);
		assert.match(html, /flex-col/);
		assert.match(html, /min-h-11/);
	});
	it("lastUsedLabel", () => {
		assert.equal(lastUsedLabel(null, NOW), "never");
		assert.equal(lastUsedLabel("2026-11-02T11:59:50Z", NOW), "just now");
		assert.equal(lastUsedLabel("2026-11-02T09:00:00Z", NOW), "3 h ago");
		assert.equal(lastUsedLabel("2026-10-30T12:00:00Z", NOW), "3 d ago");
	});
	it("pairLink needs the hub URL", () => {
		assert.equal(pairLink("a b", "https://h/hub/"), "https://h/hub/pair?code=a%20b");
		assert.equal(pairLink("x", ""), undefined);
	});
});

describe("devices API", () => {
	it("forwards only the browser's token; list/revoke/mint round-trip; 401 carries the hub-auth marker", async () => {
		const seen: string[] = [];
		const hub = createServer((req, res) => {
			seen.push(`${req.method} ${req.url} ${req.headers.authorization}`);
			res.setHeader("Content-Type", "application/json");
			if (req.headers.authorization === "Bearer revoked") {
				res.statusCode = 401;
				return void res.end(JSON.stringify({ code: "unauthorized", message: "no", retryable: false }));
			}
			if (req.method === "GET") return void res.end(JSON.stringify({ devices: [{ id: "tok-a", label: "Phone", kind: "browser", createdAt: "x", lastUsedAt: null, self: true, addedBy: null, addedById: null }] }));
			if (req.method === "DELETE") return void res.end(JSON.stringify({ revoked: "tok-b", self: false }));
			res.end(JSON.stringify({ code: "CODE", expiresAt: "2026-11-02T12:10:00Z" }));
		});
		await new Promise<void>((r) => hub.listen(0, "127.0.0.1", r));
		const env = { WOLFPACK_HUB_URL: `http://127.0.0.1:${(hub.address() as AddressInfo).port}`, WOLFPACK_HUB_TOKEN: "console-own" };
		const withToken = (t: string | null) => createDevicesApi(() => createConsoleClient(env, makeRequestToken(async () => new Headers(t ? { authorization: `Bearer ${t}` } : {}))), { hubUrl: "https://hub.example" });
		try {
			const api = withToken("mine");
			assert.deepEqual(((await (await api.list()).json()) as { devices: unknown[] }).devices.length, 1);
			assert.deepEqual(await (await api.revoke("tok-b")).json(), { revoked: "tok-b", self: false, cascaded: [] });
			const mint = (await (await api.mint(" Tablet ")).json()) as { code: string; url?: string };
			assert.equal(mint.code, "CODE");
			assert.equal(mint.url, "https://hub.example/pair?code=CODE");
			const bad = await withToken("revoked").list();
			assert.equal(bad.status, 401);
			assert.equal(bad.headers.get(HUB_AUTH_HEADER), "required");
			assert.equal((await withToken(null).list()).status, 401);
			assert.ok(seen.length > 0 && seen.every((s) => s.endsWith("Bearer mine") || s.endsWith("Bearer revoked")), seen.join("\n"));
			assert.ok(seen.some((s) => s.startsWith("DELETE /v1/tokens/tok-b")));
		} finally {
			hub.closeAllConnections();
			hub.close();
		}
	});
	it("a client without a hub answers 501", async () => {
		assert.equal((await createDevicesApi(() => createConsoleClient({})).list()).status, 501);
	});
});

/** A fake device-bound client: its wolf stream emits on demand, fails like a revoked token on revoke(), and records whether it is still being followed. */
function fakeDevice(wolf: string) {
	let revoked = false;
	let wake: (() => void) | undefined;
	let pending = 0;
	const state = { open: 0, opened: 0 };
	const client = {
		listWolves: async () => {
			if (revoked) throw Object.assign(new Error("revoked"), { name: "ProtocolError", code: "unauthorized", hubAuth: true });
			return [{ name: wolf }];
		},
		async *watchActivity(_w: string, o: { signal?: AbortSignal } = {}) {
			state.open++;
			state.opened++;
			o.signal?.addEventListener("abort", () => wake?.(), { once: true });
			try {
				for (;;) {
					if (revoked) throw Object.assign(new Error("revoked"), { name: "ProtocolError", code: "unauthorized", hubAuth: true });
					if (o.signal?.aborted) return;
					if (pending > 0) {
						pending--;
						yield { type: "thread-status", threadId: "t", status: "working" };
						continue;
					}
					await new Promise<void>((r) => (wake = r));
				}
			} finally {
				state.open--;
			}
		},
	} as unknown as ConsoleClient;
	return {
		client,
		state,
		emit() {
			pending++;
			wake?.();
		},
		revoke() {
			revoked = true;
			wake?.();
		},
	};
}

/** Read an events response, recording needs-you-changed wolves and whether it ended. */
function tap(res: Response) {
	const reader = res.body!.getReader();
	const out = { wolves: [] as string[], done: false };
	void (async () => {
		const dec = new TextDecoder();
		for (;;) {
			const r = await reader.read().catch(() => ({ done: true, value: undefined }));
			if (r.done) return void (out.done = true);
			for (const m of dec.decode(r.value).matchAll(/event: needs-you-changed\ndata: (.*)\n/g)) out.wolves.push((JSON.parse(m[1]!) as { wolf: string }).wolf);
		}
	})();
	return { out, cancel: () => reader.cancel() };
}
const until = async (fn: () => boolean, ms = 3000) => {
	const end = Date.now() + ms;
	while (!fn()) {
		if (Date.now() > end) throw new Error("timed out");
		await new Promise((r) => setTimeout(r, 5));
	}
};

describe("per-connection activity bridge", () => {
	it("two devices: revoking one ends only its bridge; closing a tab stops its bridge", async () => {
		const a = fakeDevice("wa");
		const b = fakeDevice("wb");
		const opts = { bridge: { backoffMs: [5], wolvesTtlMs: 0 } };
		const ta = tap(eventsResponse({ ...opts, clientFor: async () => a.client }));
		const tb = tap(eventsResponse({ ...opts, clientFor: async () => b.client }));
		await until(() => a.state.open === 1 && b.state.open === 1);
		a.emit();
		b.emit();
		await until(() => ta.out.wolves.includes("wa") && tb.out.wolves.includes("wb"));

		a.revoke(); // device A revoked at the hub
		await until(() => ta.out.done && a.state.open === 0); // terminal: connection closed, loop gone
		const opened = a.state.opened;
		await new Promise((r) => setTimeout(r, 60));
		assert.equal(a.state.opened, opened, "a 401 is not retried");

		const before = tb.out.wolves.length;
		b.emit(); // the other device is unaffected
		await until(() => tb.out.wolves.length > before);
		assert.equal(tb.out.done, false);

		await tb.cancel(); // tab B closed
		await until(() => b.state.open === 0);
		const bOpened = b.state.opened;
		await new Promise((r) => setTimeout(r, 60));
		assert.equal(b.state.opened, bOpened, "no follow loop outlives its connection");
	});
});

describe("provenance and cascade (panel)", () => {
	const tree: DeviceRow[] = [
		{ id: "tok-a", label: "Phone", kind: "browser", createdAt: "x", lastUsedAt: null, self: true, addedBy: null, addedById: null },
		{ id: "tok-b", label: "Tablet", kind: "browser", createdAt: "x", lastUsedAt: null, self: false, addedBy: "Phone", addedById: "tok-a" },
		{ id: "tok-c", label: "Watch", kind: "browser", createdAt: "x", lastUsedAt: null, self: false, addedBy: "Tablet", addedById: "tok-b" },
		{ id: "tok-old", label: "Old", kind: "browser", createdAt: "x", lastUsedAt: null, self: false }, // predates provenance
	];
	it("addedDescendants is transitive and ignores tokens without provenance", () => {
		assert.deepEqual(addedDescendants(tree, "tok-a").sort(), ["tok-b", "tok-c"]);
		assert.deepEqual(addedDescendants(tree, "tok-b"), ["tok-c"]);
		assert.deepEqual(addedDescendants(tree, "tok-old"), []);
	});
	it("shows 'added by X' only where known; the confirm offers the cascade box with the count", () => {
		const html = view({ devices: tree });
		assert.equal((html.match(/data-testid="device-added-by"/g) ?? []).length, 2);
		assert.match(html, /added by Phone/);
		const ask = view({ devices: tree, confirming: "tok-a" });
		assert.match(ask, /data-testid="device-cascade"/);
		assert.match(ask, /also revoke devices it added \((<!-- -->)?2(<!-- -->)?\)/);
		assert.doesNotMatch(view({ devices: tree, confirming: "tok-c" }), /device-cascade/);
	});
	it("the API forwards ?cascade=1 and answers a hub conflict as 409 with its message; other failures are a generic 502", async () => {
		const urls: string[] = [];
		const hub = createServer((req, res) => {
			urls.push(`${req.method} ${req.url}`);
			res.setHeader("Content-Type", "application/json");
			if (req.url?.includes("tok-last")) { res.statusCode = 409; return void res.end(JSON.stringify({ code: "conflict", message: "refusing to revoke the last console token", retryable: false })); }
			if (req.url?.includes("tok-boom")) { res.statusCode = 502; return void res.end(JSON.stringify({ code: "engine_error", message: "secret internal detail /var/x", retryable: true })); }
			res.end(JSON.stringify({ revoked: "tok-a", self: false, cascaded: ["tok-b"] }));
		});
		await new Promise<void>((r) => hub.listen(0, "127.0.0.1", r));
		const env = { WOLFPACK_HUB_URL: `http://127.0.0.1:${(hub.address() as AddressInfo).port}` };
		const api = createDevicesApi(() => createConsoleClient(env, makeRequestToken(async () => new Headers({ authorization: "Bearer t" }))));
		try {
			assert.deepEqual(await (await api.revoke("tok-a", { cascade: true })).json(), { revoked: "tok-a", self: false, cascaded: ["tok-b"] });
			assert.ok(urls.includes("DELETE /v1/tokens/tok-a?cascade=1"), urls.join());
			const last = await api.revoke("tok-last");
			assert.equal(last.status, 409);
			assert.match(((await last.json()) as { error: string }).error, /last console token/);
			const boom = await api.revoke("tok-boom");
			assert.equal(boom.status, 502);
			assert.doesNotMatch(JSON.stringify(await boom.json()), /secret|\/var/);
		} finally { hub.closeAllConnections(); hub.close(); }
	});
	it("after a self-revoke the panel's next call is a hub 401 and the global fetch wrapper signs out", async () => {
		const store = new Map<string, string>([["wolfpack.hub.token", "mine"]]);
		const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
		const api = createDevicesApi(() => createConsoleClient({ WOLFPACK_HUB_URL: "http://127.0.0.1:1" }, async () => null)); // no usable token = what a revoked one looks like at the console
		let out = 0;
		const f = withHubAuth(async () => api.list(), { storage, origin: "http://c", onUnauthorized: () => void out++ });
		const res = await f("/api/devices");
		assert.equal(res.status, 401);
		assert.equal(out, 1);
		assert.equal(store.has("wolfpack.hub.token"), false);
	});
});

describe("events channel: auth loss is terminal", () => {
	/** An EventSource stand-in: reconnects after every server close until the client calls close(). */
	function autoReconnecting(open: () => Response) {
		let closed = false, connects = 0;
		const handlers = new Map<string, (data: string) => void>();
		const run = async () => {
			while (!closed) {
				connects++;
				const reader = open().body!.getReader();
				const dec = new TextDecoder();
				for (;;) {
					const r = await reader.read();
					if (r.done) break;
					for (const m of dec.decode(r.value).matchAll(/^event: (\S+)$/gm)) handlers.get(m[1]!)?.("{}");
					if (closed) return;
				}
				await new Promise((r) => setTimeout(r, 5)); // EventSource's own retry delay
			}
		};
		const source: NotifySource = { close: () => void (closed = true), onOpen() {}, onEvent: (n, cb) => void handlers.set(n, cb) };
		return { source, connects: () => connects, start: () => void run() };
	}
	it("a revoked device's tab stops reconnecting: the auth-lost frame closes its EventSource and signs out once", async () => {
		const a = fakeDevice("wa");
		a.revoke();
		const es = autoReconnecting(() => eventsResponse({ bridge: { backoffMs: [5], wolvesTtlMs: 0 }, clientFor: async () => a.client }));
		let signedOut = 0;
		wireSource(es.source, createNotifyHub(), () => void signedOut++);
		es.start();
		await until(() => signedOut === 1);
		await new Promise((r) => setTimeout(r, 80));
		assert.equal(es.connects(), 1, "no reconnect after auth-lost");
		assert.equal(signedOut, 1);
	});
	it("the frame precedes the close", async () => {
		const a = fakeDevice("wa");
		a.revoke();
		const res = eventsResponse({ bridge: { wolvesTtlMs: 0 }, clientFor: async () => a.client });
		const reader = res.body!.getReader();
		let text = "";
		for (;;) { const r = await reader.read(); if (r.done) break; text += new TextDecoder().decode(r.value); }
		assert.match(text, /event: auth-lost\ndata: \{\}\n\n$/);
	});
	it("the connect request itself is 401 + marker when a hub is configured and there is no token; without a hub it is the plain channel", async () => {
		const res = await eventsRoute({ WOLFPACK_HUB_URL: "http://127.0.0.1:1" });
		assert.equal(res.status, 401);
		assert.equal(res.headers.get(HUB_AUTH_HEADER), "required");
		const plain = await eventsRoute({});
		assert.equal(plain.status, 200);
		await plain.body!.cancel();
	});
	it("the no-token fallback (process client, no request scope) ends at once with auth-lost, no loop left", async () => {
		const noToken = createConsoleClient({ WOLFPACK_HUB_URL: "http://127.0.0.1:1", WOLFPACK_HUB_TOKEN: "console-own" }, async () => null);
		let listed = 0;
		const spy = new Proxy(noToken, { get: (t, p) => (p === "watchActivity" ? (...a: unknown[]) => (listed++, (t as never as Record<string, (...x: unknown[]) => unknown>)[p]!(...a)) : Reflect.get(t, p, t)) });
		setConsoleClient(spy);
		try {
			const res = eventsResponse({ bridge: { backoffMs: [5], wolvesTtlMs: 0 } });
			const tp = tap(res);
			await until(() => tp.out.done);
			await new Promise((r) => setTimeout(r, 60));
			assert.equal(listed, 0, "no wolf stream was ever opened");
		} finally { setConsoleClient(undefined); }
	});
	it("a bridge refused with busy (the stream cap) retries with backoff and does not spin; the connection stays open", async () => {
		let attempts = 0;
		const busy = { listWolves: async () => [{ name: "w" }], async *watchActivity() { attempts++; throw Object.assign(new Error("too many open event streams (limit 128); retry later"), { name: "ProtocolError", code: "busy", retryable: true }); } } as unknown as ConsoleClient;
		const t = tap(eventsResponse({ bridge: { backoffMs: [20, 40, 80], wolvesTtlMs: 60_000 }, clientFor: async () => busy }));
		await new Promise((r) => setTimeout(r, 250));
		// 0, +20, +40, +80, +80 ...: about 5 attempts in 250ms; a spinning loop would be in the hundreds
		assert.ok(attempts >= 3 && attempts <= 7, `attempts=${attempts}`);
		assert.equal(t.out.done, false);
		await t.cancel();
		const final = attempts;
		await new Promise((r) => setTimeout(r, 120));
		assert.equal(attempts, final, "stops with the tab");
	});
});
