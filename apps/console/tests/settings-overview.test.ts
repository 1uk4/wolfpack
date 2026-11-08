import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createConsoleClient } from "../src/server/console-client.ts";
import { createSettingsOverviewApi } from "../src/server/settings-overview-api.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const wolf = (name: string, host: string, status = "online") => ({ id: name, name, host, status });
const prompt = (id: string) => ({ id, group: "g", label: id, editable: true, text: `text of ${id}`, source: "default", etag: "e" });
const reply = (body: unknown, status = 200) => Response.json(body, { status });

/** A hub with wolves local + hal; hal's prompts route fails. Records the Authorization header of every call. */
function stubHub(): string[] {
	const auth: string[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		auth.push(new Headers(init?.headers).get("authorization") ?? "(none)");
		if (url.pathname === "/v1/wolves") return reply({ wolves: [wolf("local", "mac"), wolf("hal", "sfo-01")] });
		if (url.pathname === "/v1/settings") return reply({ version: "0.1.0", prompts: [{ id: "sweep", group: "KB", label: "Sweep", text: "sweep text" }], config: { port: 1 } });
		if (url.pathname === "/v1/wolves/local/prompts") return reply({ prompts: [prompt("orchestrator-rules")] });
		if (url.pathname === "/v1/wolves/hal/prompts") return reply({ code: "engine_error", message: "host sfo-01 unreachable", retryable: true }, 502);
		return reply({ code: "not_found", message: "no route", retryable: false }, 404);
	}) as typeof fetch;
	return auth;
}

const hubClient = () => createConsoleClient({ WOLFPACK_HUB_URL: "http://hub.test", WOLFPACK_HUB_TOKEN: "env-hub-token" }, async () => "device-token");

describe("settings overview API", () => {
	it("returns hub settings and every wolf; a failing wolf carries its error and the rest still succeed", async () => {
		stubHub();
		const res = await createSettingsOverviewApi(hubClient).overview();
		assert.equal(res.status, 200);
		const body = await res.json();
		assert.equal(body.hub.ok, true);
		assert.equal(body.hub.settings.version, "0.1.0");
		assert.equal(body.hub.settings.prompts[0].text, "sweep text");
		const byName = Object.fromEntries(body.wolves.map((w: { name: string }) => [w.name, w]));
		assert.equal(byName.local.host, "mac");
		assert.equal(byName.local.prompts[0].text, "text of orchestrator-rules");
		assert.equal(byName.hal.host, "sfo-01");
		assert.equal(byName.hal.prompts, undefined);
		assert.match(byName.hal.error, /unreachable/);
	});

	it("calls the hub with the browser's device token and never the console's env hub token", async () => {
		const auth = stubHub();
		await createSettingsOverviewApi(hubClient).overview();
		assert.ok(auth.length >= 4);
		assert.deepEqual([...new Set(auth)], ["Bearer device-token"]);
	});

	it("reports a wolf that never answers as timed out instead of hanging", async () => {
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
			if (url.pathname === "/v1/wolves") return reply({ wolves: [wolf("hal", "sfo-01")] });
			if (url.pathname === "/v1/settings") return reply({ version: "0.1.0", prompts: [], config: {} });
			return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
		}) as typeof fetch;
		const body = await (await createSettingsOverviewApi(hubClient, { wolfTimeoutMs: 30 }).overview()).json();
		assert.match(body.wolves[0].error, /timed out/);
	});

	it("reports both compaction prompts with where they run and the real source text", async () => {
		stubHub();
		const body = await (await createSettingsOverviewApi(hubClient).overview()).json();
		const byId = Object.fromEntries(body.compaction.prompts.map((p: { id: string }) => [p.id, p]));
		const auto = byId["console-auto-summarizer"];
		assert.deepEqual(auto.triggers, ["auto"]);
		assert.equal(auto.runsIn, "console");
		assert.match(auto.text, /^You are the session-compaction summarizer for a tutoring agent\./);
		assert.match(byId["console-auto-instructions"].text, /^You are compacting the earlier part of a conversation/);
		const manual = byId["pi-durable-summarizer"];
		assert.deepEqual(manual.triggers, ["auto", "manual"]);
		assert.equal(manual.runsIn, "wolf");
		assert.equal(manual.text, null);
		assert.match(manual.source, /pi-durable\/dist\/harness\/compaction\.js/);
	});

	it("still answers 200 with wolvesError, hub and compaction when the wolf list cannot be fetched", async () => {
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
			if (url.pathname === "/v1/settings") return reply({ version: "0.1.0", prompts: [], config: {} });
			throw new TypeError("fetch failed");
		}) as typeof fetch;
		const res = await createSettingsOverviewApi(hubClient).overview();
		assert.equal(res.status, 200);
		const body = await res.json();
		assert.deepEqual(body.wolves, []);
		assert.match(body.wolvesError, /fetch failed/);
		assert.equal(body.hub.ok, true);
		assert.equal(body.compaction.prompts.length, 3);
	});

	it("keeps answering 401 with the hub-auth marker when the browser is unpaired", async () => {
		const unpaired = () => createConsoleClient({ WOLFPACK_HUB_URL: "http://hub.test" }, async () => null);
		const res = await createSettingsOverviewApi(unpaired).overview();
		assert.equal(res.status, 401);
		assert.equal(res.headers.get("x-wolfpack-hub-auth"), "required");
	});
});
