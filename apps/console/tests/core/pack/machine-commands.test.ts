/** Seam: sendMachineCommand (src/core/pack/machine-commands.ts), the browser client for POST /api/machines/:id/commands. fetch is the boundary. */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { sendMachineCommand } from "../../../src/core/pack/machine-commands.ts";

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
