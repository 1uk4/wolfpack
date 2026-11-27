/**
 * The graph groups route (work-wolfpack-FnzgC6g): stored on the hub as one shared pref so every device sees the same bubbles;
 * the console file is always written too and is the fallback when no hub answers. Hub = in-memory fake at the fetch boundary;
 * file = in-memory stand-in.
 */

import assert from "node:assert/strict";
import { describe, it as test } from "node:test";
import { createGroupsApi } from "../../../src/server/kb/groups-api.ts";
import { sanitizeGroups, MAX_GROUP_DOMAINS, type GraphGroups } from "../../../src/core/graph/groups.ts";

const G = (id: string, domains: string[]) => ({ id, name: id, color: null, icon: null, domains });

function setup(opts: { hub?: "up" | "down" | "none" | "5xx"; hubValue?: unknown; file?: GraphGroups; bearer?: boolean; now?: number } = {}) {
	let hubValue: unknown = opts.hubValue ?? null;
	let file: GraphGroups = opts.file ?? { groups: [] };
	const hubCalls: string[] = [];
	const fakeFetch = (async (url: string, init: RequestInit) => {
		if (opts.hub === "down") throw new Error("ECONNREFUSED");
		hubCalls.push(`${init.method} ${url}`);
		if (opts.hub === "5xx") return new Response("boom", { status: 503 });
		if (init.method === "PUT") hubValue = JSON.parse(init.body as string).value;
		return Response.json({ value: hubValue });
	}) as unknown as typeof fetch;
	const api = createGroupsApi({
		readLocal: () => file,
		writeLocal: (raw) => (file = sanitizeGroups(raw)),
		env: opts.hub === "none" ? {} : { WOLFPACK_HUB_URL: "http://hub" },
		fetch: fakeFetch,
		now: () => opts.now ?? 1000,
	});
	const req = (method: string, body?: unknown, raw?: string) =>
		new Request("http://c/api/graph/groups", {
			method,
			headers: { ...(opts.bearer === false ? {} : { authorization: "Bearer tok1" }), "content-type": "application/json" },
			body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
		});
	return { api, req, hubCalls, file: () => file, hubValue: () => hubValue };
}

describe("graph groups route", () => {
	test("GET answers the hub's list when it is not older than the file", async () => {
		const s = setup({ hubValue: { groups: [G("a", ["x"])], updatedAt: 500 }, file: { groups: [G("b", ["y"])], updatedAt: 400 } });
		const body = (await (await s.api.get(s.req("GET"))).json()) as GraphGroups;
		assert.deepEqual(body.groups.map((g) => g.id), ["a"]);
		assert.deepEqual(s.hubCalls, ["GET http://hub/v1/prefs/graph.groups"]);
	});

	test("GET prefers a newer file and pushes it to the reachable hub", async () => {
		const s = setup({ hubValue: { groups: [G("a", ["x"])], updatedAt: 100 }, file: { groups: [G("b", ["y"])], updatedAt: 900 } });
		const body = (await (await s.api.get(s.req("GET"))).json()) as GraphGroups;
		assert.deepEqual(body.groups.map((g) => g.id), ["b"]);
		await s.api.settled();
		assert.deepEqual((s.hubValue() as GraphGroups).groups.map((g) => g.id), ["b"]);
	});

	test("PUT stores the sanitized, time-stamped list on the hub and also writes the file", async () => {
		const s = setup({ now: 1234 });
		const body = (await (await s.api.put(s.req("PUT", { groups: [G("a", ["x"]), G("b", ["x", "y"])] }))).json()) as GraphGroups;
		assert.deepEqual(body.groups.map((g) => g.domains), [["x"], ["y"]]);
		assert.deepEqual((s.hubValue() as GraphGroups).groups.map((g) => g.id), ["a", "b"]);
		assert.equal((s.hubValue() as GraphGroups).updatedAt, 1234);
		assert.deepEqual(s.file().groups.map((g) => g.id), ["a", "b"]);
		assert.equal(s.file().updatedAt, 1234);
	});

	test("without a hub, GET reads and PUT writes the console file", async () => {
		const s = setup({ hub: "none", file: { groups: [G("b", ["y"])] } });
		assert.equal(((await (await s.api.get(s.req("GET"))).json()) as GraphGroups).groups[0]?.id, "b");
		await s.api.put(s.req("PUT", { groups: [G("c", ["z"])] }));
		assert.equal(s.file().groups[0]?.id, "c");
		assert.deepEqual(s.hubCalls, []);
	});

	test("a missing bearer or a hub that is down or answers 5xx uses the file, never an error", async () => {
		for (const o of [{ hub: "down" as const }, { hub: "5xx" as const }, { bearer: false }]) {
			const s = setup({ ...o, file: { groups: [G("b", ["y"])] } });
			assert.equal(((await (await s.api.get(s.req("GET"))).json()) as GraphGroups).groups[0]?.id, "b");
			const put = await s.api.put(s.req("PUT", { groups: [G("c", ["z"])] }));
			assert.equal(put.status, 200);
			assert.equal(s.file().groups[0]?.id, "c");
		}
	});

	test("an empty hub is seeded from the file at most once per process", async () => {
		const s = setup({ file: { groups: [G("b", ["y"])] } });
		await s.api.get(s.req("GET"));
		await s.api.settled();
		assert.equal((s.hubValue() as GraphGroups).groups[0]?.id, "b");
		const puts = () => s.hubCalls.filter((c) => c.startsWith("PUT")).length;
		assert.equal(puts(), 1);
		await s.api.get(s.req("GET"));
		await s.api.settled();
		assert.equal(puts(), 1);
	});

	test("PUT with invalid JSON is 400; a body over 64 KB is 413 and stores nothing", async () => {
		const s = setup();
		assert.equal((await s.api.put(s.req("PUT", undefined, "{nope"))).status, 400);
		const big = JSON.stringify({ groups: [G("a", ["x"])], pad: "p".repeat(70 * 1024) });
		assert.equal((await s.api.put(s.req("PUT", undefined, big))).status, 413);
		assert.equal(s.hubValue(), null);
		assert.deepEqual(s.file().groups, []);
	});

	test("a group holds at most MAX_GROUP_DOMAINS domains", () => {
		const many = Array.from({ length: MAX_GROUP_DOMAINS + 20 }, (_, i) => `d${i}`);
		assert.equal(sanitizeGroups({ groups: [G("a", many)] }).groups[0]?.domains.length, MAX_GROUP_DOMAINS);
	});
});
