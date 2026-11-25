/**
 * The console's graduation client (work-wolfpack-F85qPOc): graduateDirect maps the route's answers, getPendingPreview reads the wolf's status.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

const { graduateDirect, getPendingPreview } = await import("../../../components/work/graduate-direct-client.ts");

const realFetch = globalThis.fetch;
let sent: { url: string; body?: string }[] = [];
const reply = (status: number, body: unknown) => {
	sent = [];
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		sent.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
		return Response.json(body, { status });
	}) as typeof fetch;
};
afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("graduateDirect", () => {
	it("posts to the item's graduate-direct route and returns the result", async () => {
		reply(200, { itemId: "i1", domain: "wolfpack", sent: 2, archived: 3, via: "work", approvedBy: { actor: "owner", device: "d", at: "t" } });
		const r = await graduateDirect("i1", { contributions: [], via: "work" });
		assert.equal(sent[0]?.url, "/api/work/i1/graduate-direct");
		assert.deepEqual(r, { ok: true, itemId: "i1", domain: "wolfpack", sent: 2, archived: 3, via: "work", approvedBy: { actor: "owner", device: "d", at: "t" } });
	});

	it("flags a hub 400 'already graduated' and keeps a 403 as an error", async () => {
		reply(400, { error: "item i1 is already graduated", code: "invalid_request" });
		assert.deepEqual(await graduateDirect("i1", { contributions: [], via: "card" }), { ok: false, status: 400, code: "invalid_request", message: "item i1 is already graduated", alreadyGraduated: true });
		reply(403, { error: "owner only", code: "forbidden" });
		const denied = await graduateDirect("i1", { contributions: [], via: "card" });
		assert.equal(denied.ok === false && denied.alreadyGraduated, false);
		assert.equal(denied.ok === false && denied.status, 403);
	});
});

describe("getPendingPreview", () => {
	const preview = (createdAt: string) => ({ itemId: "i1", kind: "feature", title: "T", domain: "d", contributions: [], foldedObservations: 0, warnings: [], archive: [], token: "tok", createdAt, readiness: { ready: true } });

	it("answers none when the wolf holds no preview", async () => {
		reply(200, { state: "none" });
		assert.deepEqual(await getPendingPreview("hal", "i1"), { ok: true, none: true });
	});

	it("returns a fresh preview and treats an expired one as none", async () => {
		reply(200, { state: "preview_ready", preview: preview(new Date().toISOString()) });
		const fresh = await getPendingPreview("hal", "i1");
		assert.equal(fresh.ok && "preview" in fresh && fresh.preview.token, "tok");
		reply(200, { state: "preview_ready", preview: preview(new Date(Date.now() - 7 * 3600_000).toISOString()) });
		assert.deepEqual(await getPendingPreview("hal", "i1"), { ok: true, none: true });
	});
});
