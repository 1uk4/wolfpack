/**
 * Owner approvals (work-wolfpack-WITFT19) at the /api/work/requests seam: createApprovalsApi behind the real owner gate, hub faked at fetch.
 */
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { createHealthApi } from "../../../src/server/pack/health-api.ts";
import { createApprovalsApi } from "../../../src/server/work/approvals-api.ts";
import { createSessionWitness } from "../../../src/server/thread/session-witness.ts";

type Call = { method: string; url: string; auth: string | null };

function setup(reply: { status: number; body: unknown } = { status: 200, body: { requests: [] } }) {
	const calls: Call[] = [];
	const hubFetch = (async (url: string, init?: RequestInit) => {
		calls.push({ method: init?.method ?? "GET", url, auth: new Headers(init?.headers).get("authorization") });
		return Response.json(reply.body, { status: reply.status });
	}) as unknown as typeof fetch;
	const witness = createSessionWitness({ file: undefined });
	const gateApi = createHealthApi({ checkToken: async (t: string) => (t === "owner" ? "accepted" : "rejected"), witness } as unknown as Parameters<typeof createHealthApi>[0]);
	const api = createApprovalsApi({ gate: (req) => gateApi.gate(req, "approval"), env: { WOLFPACK_HUB_URL: "http://hub.test:3150/", WOLFPACK_HUB_TOKEN: "console-operator-token" }, fetch: hubFetch });
	return { api, calls };
}
const req = (method: string, token: string | null = "owner") => new Request("http://c/api/work/requests", { method, headers: token ? { authorization: `Bearer ${token}` } : {} });

describe("work approvals API", () => {
	it("refuses a caller without a verified device token and never calls the hub", async () => {
		const { api, calls } = setup();
		assert.equal((await api.list(req("GET", null))).status, 401);
		assert.equal((await api.approve(req("POST", "stranger"), "r1")).status, 401);
		assert.equal((await api.reject(req("POST", "stranger"), "r1")).status, 401);
		assert.equal(calls.length, 0);
	});

	it("lists, approves and rejects through the hub with the caller's own bearer", async () => {
		const { api, calls } = setup();
		await api.list(req("GET"));
		await api.approve(req("POST"), "r1");
		await api.reject(req("POST"), "r2");
		assert.deepEqual(
			calls.map((c) => [c.method, c.url, c.auth]),
			[
				["GET", "http://hub.test:3150/v1/work/requests?status=pending", "Bearer owner"],
				["POST", "http://hub.test:3150/v1/work/requests/r1/approve", "Bearer owner"],
				["POST", "http://hub.test:3150/v1/work/requests/r2/reject", "Bearer owner"],
			],
		);
	});

	it("maps a hub 403 to 403 and a hub 409 to a typed 409", async () => {
		const denied = setup({ status: 403, body: { code: "forbidden", message: "workers cannot decide", retryable: false } });
		const res = await denied.api.approve(req("POST"), "r1");
		assert.equal(res.status, 403);
		assert.equal(((await res.json()) as { code: string }).code, "forbidden");
		const done = setup({ status: 409, body: { code: "conflict", message: "already decided", retryable: false } });
		assert.equal((await done.api.approve(req("POST"), "r1")).status, 409);
	});

	it("logs one line per approve relay with the request id and status, and reads a single request", async () => {
		const log = mock.method(console, "log", () => {});
		try {
			const { api, calls } = setup({ status: 200, body: { request: { id: "r9", status: "approved" } } });
			await api.approve(req("POST"), "r9");
			await api.get(req("GET"), "r9");
			assert.equal(calls[1]?.url, "http://hub.test:3150/v1/work/requests/r9");
			assert.equal(log.mock.calls.length, 1);
			assert.match(String(log.mock.calls[0]?.arguments[0]), /^\[approvals\] approve r9: 200 in \d+ms$/);
		} finally {
			log.mock.restore();
		}
	});
});
