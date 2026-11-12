/** Seam: createMachinesApi (src/server/pack/machines-api.ts), the console's proxy for POST /api/machines/:id/commands. A fake ConsoleClient stands in for the hub. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConsoleClient } from "@wolfpack/client";
import { createMachinesApi } from "../../../src/server/pack/machines-api.ts";

const source = (machineCommand?: (h: string, c: unknown) => Promise<unknown>) => () => ({ machineCommand }) as unknown as ConsoleClient;
/** A POST as the browser sends it: the device token rides in the Authorization header (components/shell/hub-auth.tsx). */
const post = (body: unknown, headers: Record<string, string> = { Authorization: "Bearer dev-token" }) =>
	new Request("http://console.test/api/machines/sfo-01/commands", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

describe("machines API", () => {
	it("forwards a valid command to the hub client and answers its result with 200", async () => {
		const seen: unknown[] = [];
		const api = createMachinesApi(source(async (h, c) => (seen.push([h, c]), { id: "c-1", ok: true, message: "restarted, but could not confirm" })));
		const r = await api.command(post({ kind: "wolves.restart", args: {} }), "sfo-01");
		assert.equal(r.status, 200);
		assert.deepEqual(await r.json(), { id: "c-1", ok: true, message: "restarted, but could not confirm" });
		assert.deepEqual(seen, [["sfo-01", { kind: "wolves.restart", args: {} }]]);
	});

	it("defaults args to {} when the body has none", async () => {
		const seen: unknown[] = [];
		const api = createMachinesApi(source(async (_h, c) => (seen.push(c), { id: "c-1", ok: true })));
		await api.command(post({ kind: "wolves.restart" }), "sfo-01");
		assert.deepEqual(seen, [{ kind: "wolves.restart", args: {} }]);
	});

	it("keeps the hub's statuses: 409 for not_sent_*, 504 for a timeout", async () => {
		const unsupported = createMachinesApi(source(async () => ({ id: "c-2", ok: false, code: "not_sent_unsupported" })));
		assert.equal((await unsupported.command(post({ kind: "workerd.restart", args: {} }), "mac")).status, 409);
		const slow = createMachinesApi(source(async () => ({ id: "c-3", ok: false, code: "timeout" })));
		assert.equal((await slow.command(post({ kind: "logs.fetch", args: { service: "hubd", lines: 5 } }), "mac")).status, 504);
	});

	it("refuses a request with no bearer with 401 and the hub-auth marker, and never reaches the hub client", async () => {
		let called = false;
		const api = createMachinesApi(source(async () => ((called = true), {})));
		const r = await api.command(post({ kind: "wolves.restart", args: {} }, {}), "sfo-01");
		assert.equal(r.status, 401);
		assert.equal(r.headers.get("x-wolfpack-hub-auth"), "required");
		assert.equal(called, false);
	});

	it("refuses a body whose args do not match the kind with 400, without calling the hub", async () => {
		let called = false;
		const api = createMachinesApi(source(async () => ((called = true), {})));
		const r = await api.command(post({ kind: "logs.fetch", args: { lines: 5 } }), "sfo-01");
		assert.equal(r.status, 400);
		assert.equal(called, false);
	});

	it("refuses a host id over 128 characters with 400", async () => {
		let called = false;
		const api = createMachinesApi(source(async () => ((called = true), {})));
		assert.equal((await api.command(post({ kind: "wolves.restart", args: {} }), "h".repeat(129))).status, 400);
		assert.equal(called, false);
	});

	it("answers 413 for a body over 128 KB, by content-length or by what is actually read, without calling the hub", async () => {
		let called = false;
		const api = createMachinesApi(source(async () => ((called = true), {})));
		const big = JSON.stringify({ kind: "key.set", args: {}, sealed: "x".repeat(130 * 1024) });
		assert.equal((await api.command(post(big), "sfo-01")).status, 413);
		const lying = new Request("http://console.test/x", { method: "POST", headers: { Authorization: "Bearer t", "content-length": "10" }, body: big });
		assert.equal((await api.command(lying, "sfo-01")).status, 413);
		assert.equal(called, false);
	});

	it("answers 401 plus the marker when the hub rejects the token", async () => {
		const api = createMachinesApi(source(async () => Promise.reject(Object.assign(new Error("hub said no"), { code: "unauthorized" }))));
		const r = await api.command(post({ kind: "wolves.restart", args: {} }), "sfo-01");
		assert.equal(r.status, 401);
		assert.equal(r.headers.get("x-wolfpack-hub-auth"), "required");
	});

	it("answers a fixed 502 when the hub's 409/504 body is not a command result (HTML, error envelope)", async () => {
		const api = createMachinesApi(source(async () => Promise.reject(Object.assign(new Error("<html>bad gateway sealed-abc</html>"), { code: "engine_error" }))));
		const r = await api.command(post({ kind: "wolves.restart", args: {} }), "sfo-01");
		assert.equal(r.status, 502);
		assert.deepEqual(await r.json(), { error: "the hub could not complete the request", code: "engine_error" });
	});

	it("answers 400 with a fixed message on invalid_request, and never echoes a client error text that contains the sealed value", async () => {
		const api = createMachinesApi(source(async () => Promise.reject(Object.assign(new Error("bad body: SEALED-SECRET-123"), { code: "invalid_request" }))));
		const r = await api.command(post({ kind: "key.set", args: {}, sealed: "SEALED-SECRET-123" }), "sfo-01");
		assert.equal(r.status, 400);
		const text = await r.text();
		assert.equal(text.includes("SEALED-SECRET-123"), false);
		assert.deepEqual(JSON.parse(text), { error: "invalid command", code: "invalid_request" });
	});

	it("answers 501 when the client has no hub", async () => {
		const r = await createMachinesApi(source(undefined)).command(post({ kind: "workerd.restart", args: {} }), "sfo-01");
		assert.equal(r.status, 501);
	});
});
