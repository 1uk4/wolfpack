/**
 * The graph groups route (work-wolfpack-FnzgC6g): stored on the hub as one shared pref so every device sees the same bubbles;
 * the console file is the fallback when no hub answers. Hub = in-memory fake at the fetch boundary; file = in-memory stand-in.
 */

import assert from "node:assert/strict";
import { describe, it as test } from "node:test";
import { createGroupsApi } from "../../../src/server/kb/groups-api.ts";
import { sanitizeGroups, type GraphGroups } from "../../../src/core/graph/groups.ts";

const G = (id: string, domains: string[]) => ({ id, name: id, color: null, icon: null, domains });

function setup(opts: { hub?: "up" | "down" | "none"; hubValue?: unknown; file?: GraphGroups } = {}) {
	let hubValue: unknown = opts.hubValue ?? null;
	let file: GraphGroups = opts.file ?? { groups: [] };
	const hubCalls: string[] = [];
	const fakeFetch = (async (url: string, init: RequestInit) => {
		if (opts.hub === "down") throw new Error("ECONNREFUSED");
		hubCalls.push(`${init.method} ${url}`);
		if (init.method === "PUT") hubValue = JSON.parse(init.body as string).value;
		return Response.json({ value: hubValue });
	}) as unknown as typeof fetch;
	const api = createGroupsApi({
		readLocal: () => file,
		writeLocal: (raw) => (file = sanitizeGroups(raw)),
		env: opts.hub === "none" ? {} : { WOLFPACK_HUB_URL: "http://hub" },
		fetch: fakeFetch,
	});
	const req = (method: string, body?: unknown) =>
		new Request("http://c/api/graph/groups", {
			method,
			headers: { authorization: "Bearer tok1", "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	return { api, req, hubCalls, file: () => file, hubValue: () => hubValue };
}

describe("graph groups route", () => {
	test("GET answers the hub's list, ignoring the local file", async () => {
		const s = setup({ hubValue: { groups: [G("a", ["x"])] }, file: { groups: [G("b", ["y"])] } });
		const body = (await (await s.api.get(s.req("GET"))).json()) as GraphGroups;
		assert.deepEqual(body.groups.map((g) => g.id), ["a"]);
		assert.deepEqual(s.hubCalls, ["GET http://hub/v1/prefs/graph.groups"]);
	});

	test("PUT stores the sanitized list on the hub and leaves the file alone", async () => {
		const s = setup();
		const body = (await (await s.api.put(s.req("PUT", { groups: [G("a", ["x"]), G("b", ["x", "y"])] }))).json()) as GraphGroups;
		assert.deepEqual(body.groups.map((g) => g.domains), [["x"], ["y"]]);
		assert.deepEqual((s.hubValue() as GraphGroups).groups.map((g) => g.id), ["a", "b"]);
		assert.deepEqual(s.file().groups, []);
	});

	test("without a hub, GET reads and PUT writes the console file", async () => {
		const s = setup({ hub: "none", file: { groups: [G("b", ["y"])] } });
		assert.equal(((await (await s.api.get(s.req("GET"))).json()) as GraphGroups).groups[0]?.id, "b");
		await s.api.put(s.req("PUT", { groups: [G("c", ["z"])] }));
		assert.equal(s.file().groups[0]?.id, "c");
		assert.deepEqual(s.hubCalls, []);
	});

	test("hub down falls back to the file; empty hub is seeded from the file once", async () => {
		const down = setup({ hub: "down", file: { groups: [G("b", ["y"])] } });
		assert.equal(((await (await down.api.get(down.req("GET"))).json()) as GraphGroups).groups[0]?.id, "b");
		const empty = setup({ file: { groups: [G("b", ["y"])] } });
		await empty.api.get(empty.req("GET"));
		await new Promise((r) => setTimeout(r, 10));
		assert.equal((empty.hubValue() as GraphGroups).groups[0]?.id, "b");
	});
});
