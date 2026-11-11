import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createSubscriptionHandler } from "../src/server/subscription-api.ts";

const req = (method: string, body?: unknown) => new Request("http://c/api/health/subscription", { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } });

describe("/api/health/subscription", () => {
	it("needs the device gate; reports the effective mode when no file exists (host default from WOLFPACK_AUTO_UPDATE, else unknown), also for a corrupt file; PUT saves {schema,channel,mode} and rejects bad values without writing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "subscription-"));
		const file = join(dir, "subscription.json");
		let allowed = false;
		const envAuto = createSubscriptionHandler({ file, env: { WOLFPACK_AUTO_UPDATE: "1" }, gate: async () => "device abc" });
		assert.deepEqual(await (await envAuto.get(req("GET"))).json(), { exists: false, channel: "stable", mode: "auto" });
		const envOff = createSubscriptionHandler({ file, env: { WOLFPACK_AUTO_UPDATE: "0" }, gate: async () => "device abc" });
		assert.deepEqual(await (await envOff.get(req("GET"))).json(), { exists: false, channel: "stable", mode: "button" });
		const h = createSubscriptionHandler({ file, env: {}, gate: async () => (allowed ? "device abc" : Response.json({ code: "unauthorized" }, { status: 401 })) });
		try {
			assert.equal((await h.get(req("GET"))).status, 401);
			assert.equal((await h.put(req("PUT", { channel: "main", mode: "auto" }))).status, 401);
			allowed = true;
			assert.deepEqual(await (await h.get(req("GET"))).json(), { exists: false, channel: "stable", mode: "unknown" });
			const ok = await h.put(req("PUT", { channel: "main", mode: "auto" }));
			assert.equal(ok.status, 200);
			assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { schema: 1, channel: "main", mode: "auto" });
			assert.deepEqual(await (await h.get(req("GET"))).json(), { exists: true, channel: "main", mode: "auto" });
			for (const bad of [{ channel: "beta", mode: "auto" }, { channel: "main", mode: "sometimes" }, { channel: "main" }, "x"]) assert.equal((await h.put(req("PUT", bad))).status, 400);
			writeFileSync(file, "{broken");
			assert.deepEqual(await (await h.get(req("GET"))).json(), { exists: false, channel: "stable", mode: "unknown" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("on a Mac a PUT creates ~/.wolfpack and writes the file the Mac updater reads", async () => {
		const home = mkdtempSync(join(tmpdir(), "subscription-mac-"));
		try {
			const h = createSubscriptionHandler({ env: {}, platform: "darwin", home, gate: async () => "device abc" });
			const res = await h.put(req("PUT", { channel: "main", mode: "auto" }));
			assert.equal(res.status, 200);
			// The Mac updater reads this file in this shape (scripts/auto-update-mac.test.ts writes the same JSON and follows it).
			assert.deepEqual(JSON.parse(readFileSync(join(home, ".wolfpack", "release-channel.json"), "utf8")), { schema: 1, channel: "main", mode: "auto" });
			assert.deepEqual(await (await h.get(req("GET"))).json(), { exists: true, channel: "main", mode: "auto" });
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
