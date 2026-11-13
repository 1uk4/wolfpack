/** Seam: sendMachineCommand (src/core/pack/machine-commands.ts), the browser client for POST /api/machines/:id/commands. fetch is the boundary. */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { COMMAND_CLIENT_TIMEOUT_MS, sendMachineCommand } from "../../../src/core/pack/machine-commands.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});
const reply = (status: number, body: unknown) => {
	const calls: { url: string; init: RequestInit }[] = [];
	globalThis.fetch = (async (url: string, init: RequestInit) => (calls.push({ url, init }), new Response(typeof body === "string" ? body : JSON.stringify(body), { status }))) as typeof fetch;
	return calls;
};

describe("sendMachineCommand", () => {
	it("POSTs kind/args to the machine's route (host id encoded) and returns the result", async () => {
		const calls = reply(200, { id: "c-1", ok: true, message: "restarted, but could not confirm" });
		const r = await sendMachineCommand("sfo 01", { kind: "wolves.restart", args: {} });
		assert.deepEqual(r, { id: "c-1", ok: true, message: "restarted, but could not confirm" });
		assert.equal(calls[0]!.url, "/api/machines/sfo%2001/commands");
		assert.equal(calls[0]!.init.method, "POST");
		assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { kind: "wolves.restart", args: {} });
	});

	it("forwards sealed in the body when given", async () => {
		const calls = reply(200, { id: "c-1", ok: true });
		await sendMachineCommand("m", { kind: "key.set", args: {}, sealed: "SEALED-X" });
		await sendMachineCommand("m", { kind: "wolves.restart" });
		assert.deepEqual(calls.map((c) => JSON.parse(String(c.init.body))), [{ kind: "key.set", args: {}, sealed: "SEALED-X" }, { kind: "wolves.restart", args: {} }]);
	});

	it("sends a client-chosen id in the body (the seal binds it) and leaves it out when absent", async () => {
		const calls = reply(200, { id: "c-mine", ok: true });
		await sendMachineCommand("m", { kind: "key.set", args: { slot: "anthropic" }, sealed: "S", id: "c-mine" });
		await sendMachineCommand("m", { kind: "wolves.restart" });
		assert.deepEqual(calls.map((c) => JSON.parse(String(c.init.body))), [{ kind: "key.set", args: { slot: "anthropic" }, sealed: "S", id: "c-mine" }, { kind: "wolves.restart", args: {} }]);
	});

	it("waits COMMAND_CLIENT_TIMEOUT_MS (30 s) and turns the client's own timeout into an ok:false 'timeout' result, without throwing", async () => {
		assert.equal(COMMAND_CLIENT_TIMEOUT_MS, 30_000);
		let seen: AbortSignal | undefined;
		globalThis.fetch = ((_u: string, init: RequestInit) => {
			seen = init.signal as AbortSignal;
			return Promise.reject(new DOMException("timed out", "TimeoutError"));
		}) as typeof fetch;
		const r = await sendMachineCommand("m", { kind: "key.set" });
		assert.equal(r.ok, false);
		assert.equal(r.code, "timeout");
		assert.ok(seen instanceof AbortSignal);
	});

	it("combines the caller's signal with the timer: aborting the caller's signal aborts the request", async () => {
		const ctl = new AbortController();
		let seen: AbortSignal | undefined;
		globalThis.fetch = ((_u: string, init: RequestInit) => {
			seen = init.signal as AbortSignal;
			return new Promise((_r, rej) => seen!.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
		}) as typeof fetch;
		const p = sendMachineCommand("m", { kind: "logs.fetch" }, { signal: ctl.signal });
		ctl.abort();
		await assert.rejects(p, { name: "AbortError" });
	});

	it("rethrows an abort instead of turning it into a result", async () => {
		globalThis.fetch = (async () => {
			throw new DOMException("aborted", "AbortError");
		}) as typeof fetch;
		await assert.rejects(sendMachineCommand("m", { kind: "logs.fetch" }, { signal: AbortSignal.abort() }), { name: "AbortError" });
	});

	it("returns a 409 and a 504 hub answer as a result", async () => {
		reply(409, { id: "c-2", ok: false, code: "not_sent_offline" });
		assert.equal((await sendMachineCommand("m", { kind: "workerd.restart" })).code, "not_sent_offline");
		reply(504, { id: "c-3", ok: false, code: "timeout" });
		assert.equal((await sendMachineCommand("m", { kind: "workerd.restart" })).code, "timeout");
	});

	it("turns a console refusal, a non-JSON answer or a network failure into an ok:false result without a hub code", async () => {
		reply(401, { error: "unauthorized", code: "unauthorized" });
		assert.deepEqual(await sendMachineCommand("m", { kind: "logs.fetch" }), { id: "", ok: false, message: "Sign in with the console once while the hub is up" });
		reply(502, "<html>");
		assert.deepEqual(await sendMachineCommand("m", { kind: "logs.fetch" }), { id: "", ok: false, message: "Command failed (HTTP 502)" });
		globalThis.fetch = (async () => {
			throw new TypeError("offline");
		}) as typeof fetch;
		assert.deepEqual(await sendMachineCommand("m", { kind: "logs.fetch" }), { id: "", ok: false, message: "Console unreachable; command not sent" });
	});
});
