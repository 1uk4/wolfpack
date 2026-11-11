/**
 * Pack panel domains (work-wolfpack-I2AysMu) at the /api/pack/domains seam: createDomainsApi behind the real owner gate
 * (createHealthApi().gate), with the hub faked at the network boundary (fetch). Hub error bodies are hubd's ErrorEnvelope.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHealthApi } from "../../../src/server/pack/health-api.ts";
import { createDomainsApi } from "../../../src/server/pack/domains-api.ts";
import { createSessionWitness } from "../../../src/server/thread/session-witness.ts";

type Call = { method: string; url: string; auth: string | null; body: unknown };
type Reply = { status: number; body: unknown } | "down";

function setup(reply: Reply = { status: 200, body: { domains: [] } }) {
	const calls: Call[] = [];
	const hubFetch = (async (url: string, init?: RequestInit) => {
		calls.push({ method: init?.method ?? "GET", url, auth: new Headers(init?.headers).get("authorization"), body: init?.body ? JSON.parse(String(init.body)) : undefined });
		if (reply === "down") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
		return Response.json(reply.body, { status: reply.status });
	}) as unknown as typeof fetch;
	// The owner gate is the real one; only its "ask the hub if this device token is good" call is faked: "owner" is accepted.
	const witness = createSessionWitness({ file: undefined });
	const gateApi = createHealthApi({ checkToken: async (t: string) => (t === "owner" ? "accepted" : "rejected"), witness } as unknown as Parameters<typeof createHealthApi>[0]);
	const api = createDomainsApi({ gate: (req) => gateApi.gate(req, "domain change"), env: { WOLFPACK_HUB_URL: "http://hub.test:3150/", WOLFPACK_HUB_TOKEN: "console-operator-token" }, fetch: hubFetch });
	return { api, calls };
}
const req = (method: string, body?: unknown, token: string | null = "owner") =>
	new Request("http://c/api/pack/domains", { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const json = async (r: Response) => (await r.json()) as Record<string, unknown>;

describe("pack domains API", () => {
	it("refuses a caller without a verified device token and never calls the hub", async () => {
		const { api, calls } = setup();
		assert.equal((await api.list(req("GET", undefined, null))).status, 401);
		assert.equal((await api.create(req("POST", { name: "docs" }, "stranger"))).status, 401);
		assert.equal((await api.remove(req("DELETE", undefined, "stranger"), "docs")).status, 401);
		assert.equal(calls.length, 0);
	});

	it("lists, adds, edits and deletes through the hub with the console's operator token, not the caller's", async () => {
		const { api, calls } = setup({ status: 201, body: { domain: { name: "docs", label: "Docs", created: "2026-11-09" } } });
		const made = await api.create(req("POST", { name: "docs", label: "Docs", description: "All docs", color: "#aabbcc" }));
		assert.equal(made.status, 201);
		assert.deepEqual((await json(made)).domain, { name: "docs", label: "Docs", created: "2026-11-09" });
		await api.update(req("PATCH", { label: "Documents", color: "#112233" }), "docs");
		await api.remove(req("DELETE"), "docs");
		await api.list(req("GET"));
		assert.deepEqual(
			calls.map((c) => [c.method, c.url, c.auth, c.body]),
			[
				["POST", "http://hub.test:3150/v1/registry/domains", "Bearer console-operator-token", { name: "docs", label: "Docs", description: "All docs", color: "#aabbcc" }],
				["PATCH", "http://hub.test:3150/v1/registry/domains/docs", "Bearer console-operator-token", { label: "Documents", color: "#112233" }],
				["DELETE", "http://hub.test:3150/v1/registry/domains/docs", "Bearer console-operator-token", undefined],
				["GET", "http://hub.test:3150/v1/registry/domains", "Bearer console-operator-token", undefined],
			],
		);
	});

	it("rejects bad input before calling the hub", async () => {
		const { api, calls } = setup();
		for (const body of [{ name: "my-docs" }, { name: "docs", color: "red" }, { name: "docs", label: 5 }]) {
			const r = await api.create(req("POST", body));
			assert.equal(r.status, 400, JSON.stringify(body));
		}
		assert.equal((await json(await api.create(req("POST", { name: "my-docs" })))).error, "Domain names are lower-case letters and digits only, up to 32 (no hyphens).");
		assert.equal((await api.update(req("PATCH", { name: "other" }), "docs")).status, 400); // no rename
		assert.equal((await api.remove(req("DELETE"), "Bad-Name")).status, 400);
		for (const name of ["a/../b", "x%2f.."]) {
			assert.equal((await api.update(req("PATCH", { label: "x" }), name)).status, 400, name);
			assert.equal((await api.remove(req("DELETE"), name)).status, 400, name);
		}
		assert.equal(calls.length, 0);
	});

	it("says hub refusals in plain words, naming the subscribed wolves", async () => {
		const dup = await setup({ status: 409, body: { code: "conflict", message: "domain docs exists", retryable: false } }).api.create(req("POST", { name: "docs" }));
		assert.equal(dup.status, 409);
		assert.equal((await json(dup)).error, "A domain named docs already exists.");

		const subscribed = await setup({ status: 409, body: { code: "conflict", message: "domain docs still has subscribers: alpha, beta", retryable: false, details: { wolves: "alpha, beta" } } }).api.remove(req("DELETE"), "docs");
		assert.equal(subscribed.status, 409);
		const subBody = await json(subscribed);
		assert.equal(subBody.error, "Can't delete docs: these wolves are still subscribed to it: alpha, beta. Unsubscribe them in each wolf's settings first.");
		assert.deepEqual(subBody.wolves, ["alpha", "beta"]);

		const asArray = await setup({ status: 409, body: { code: "conflict", message: "x", details: { wolves: ["alpha", "beta"] } } }).api.remove(req("DELETE"), "docs");
		assert.deepEqual((await json(asArray)).wolves, ["alpha", "beta"]);

		const forbidden = await setup({ status: 403, body: { code: "forbidden", message: "registry writes need an operator actor", retryable: false } }).api.create(req("POST", { name: "docs" }));
		assert.equal(forbidden.status, 502);
		assert.equal((await json(forbidden)).error, "The hub does not allow this console to change domains (its token is not an operator token).");

		const gone = await setup({ status: 404, body: { code: "not_found", message: "domain x not found", retryable: false } }).api.remove(req("DELETE"), "x");
		assert.equal(gone.status, 404);
		assert.equal((await json(gone)).error, "There is no domain named x.");

		const down = await setup("down").api.list(req("GET"));
		assert.equal(down.status, 503);
		assert.equal((await json(down)).error, "The hub is not answering, so domains cannot be read or changed right now.");
	});

	it("says so when the console has no hub configured", async () => {
		const gateApi = createHealthApi({ checkToken: async () => "accepted", witness: createSessionWitness({ file: undefined }) } as unknown as Parameters<typeof createHealthApi>[0]);
		const api = createDomainsApi({ gate: (r) => gateApi.gate(r, "domain change"), env: {}, fetch: (async () => { throw new Error("must not be called"); }) as unknown as typeof fetch });
		const r = await api.list(req("GET"));
		assert.equal(r.status, 501);
		assert.equal((await json(r)).error, "This console has no hub to manage domains on (WOLFPACK_HUB_URL and WOLFPACK_HUB_TOKEN are not set).");
	});
});
