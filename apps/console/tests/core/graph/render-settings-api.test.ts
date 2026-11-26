/**
 * The render-settings route, hub first (work-wolfpack-H1OQNIh): hub value wins, the local file is the fallback, and the first GET
 * with an empty hub seeds it from the file. The hub is an in-memory fake at the fetch boundary; the file is an in-memory stand-in.
 */

import assert from "node:assert/strict";
import { describe, it as test } from "node:test";
import { createRenderSettingsApi } from "../../../src/server/kb/render-settings-api.ts";
import { DEFAULT_RENDER_SETTINGS, sanitizeRenderSettings, type GraphRenderSettings } from "../../../src/core/index.ts";

function setup(opts: { hub?: "up" | "down" | "none"; hubValue?: unknown; file?: GraphRenderSettings | null } = {}) {
	let hubValue: unknown = opts.hubValue ?? null;
	let file: GraphRenderSettings | null = opts.file ?? null;
	const hubCalls: string[] = [];
	const fakeFetch = (async (url: string, init: RequestInit) => {
		if (opts.hub === "down") throw new Error("ECONNREFUSED");
		hubCalls.push(`${init.method} ${url} ${(init.headers as Record<string, string>).Authorization}`);
		if (init.method === "PUT") hubValue = JSON.parse(init.body as string).value;
		return Response.json({ value: hubValue });
	}) as unknown as typeof fetch;
	const api = createRenderSettingsApi({
		readLocal: () => file,
		writeLocal: (raw) => (file = sanitizeRenderSettings(raw)),
		env: opts.hub === "none" ? {} : { WOLFPACK_HUB_URL: "http://hub" },
		fetch: fakeFetch,
	});
	const req = (method: string, body?: unknown) =>
		new Request("http://c/api/graph/render-settings", {
			method,
			headers: { authorization: "Bearer tok1", "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	return { api, req, hubCalls, file: () => file, hubValue: () => hubValue };
}

describe("render-settings route", () => {
	test("GET answers the hub's value with the caller's own bearer, ignoring the local file", async () => {
		const s = setup({ hubValue: { sizeUnits: "world", nodeSize: 4 }, file: { ...DEFAULT_RENDER_SETTINGS, nodeSize: 1 } });
		const body = (await (await s.api.get(s.req("GET"))).json()) as GraphRenderSettings;
		assert.equal(body.nodeSize, 4);
		assert.deepEqual(s.hubCalls, ["GET http://hub/v1/prefs/graph.render-settings Bearer tok1"]);
	});

	test("first GET with an empty hub seeds the hub from the local file, once, and leaves the file", async () => {
		const file = { ...DEFAULT_RENDER_SETTINGS, nodeSize: 3 };
		const s = setup({ file });
		const first = (await (await s.api.get(s.req("GET"))).json()) as GraphRenderSettings;
		assert.equal(first.nodeSize, 3);
		assert.equal((s.hubValue() as GraphRenderSettings).nodeSize, 3);
		assert.equal(s.file()?.nodeSize, 3);
		await s.api.get(s.req("GET"));
		assert.equal(s.hubCalls.filter((c) => c.startsWith("PUT")).length, 1);
	});

	test("with no hub configured or an unreachable hub, GET reads and PUT writes the local file", async () => {
		for (const hub of ["none", "down"] as const) {
			const s = setup({ hub, file: { ...DEFAULT_RENDER_SETTINGS, edgeWidth: 2 } });
			assert.equal(((await (await s.api.get(s.req("GET"))).json()) as GraphRenderSettings).edgeWidth, 2, hub);
			const put = (await (await s.api.put(s.req("PUT", { sizeUnits: "world", nodeSize: 6 }))).json()) as GraphRenderSettings;
			assert.equal(put.nodeSize, 6, hub);
			assert.equal(s.file()?.nodeSize, 6, hub);
		}
	});

	test("PUT stores the sanitized settings on the hub and leaves the file alone", async () => {
		const s = setup({ file: { ...DEFAULT_RENDER_SETTINGS, nodeSize: 1 } });
		const put = (await (await s.api.put(s.req("PUT", { sizeUnits: "world", nodeSize: 6, live: { enabled: false } }))).json()) as GraphRenderSettings;
		assert.equal(put.live.enabled, false);
		assert.equal((s.hubValue() as GraphRenderSettings).nodeSize, 6);
		assert.equal(s.file()?.nodeSize, 1);
	});
});
