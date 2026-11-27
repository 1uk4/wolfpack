import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createSubscriptionHandler } from "../../../src/server/pack/subscription-api.ts";

const req = (method: string, body?: unknown) => new Request("http://c/api/health/subscription", { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } });

describe("/api/health/subscription", () => {
	it("needs the device gate; reports the effective mode when no file exists (host default from WOLFPACK_AUTO_UPDATE, else button), also for a corrupt file; PUT saves {schema,channel,mode} and rejects bad values without writing", async () => {
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
			assert.deepEqual(await (await h.get(req("GET"))).json(), { exists: false, channel: "stable", mode: "button" });
			const ok = await h.put(req("PUT", { channel: "main", mode: "auto" }));
			assert.equal(ok.status, 200);
			assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { schema: 1, channel: "main", mode: "auto" });
			assert.deepEqual(await (await h.get(req("GET"))).json(), { exists: true, channel: "main", mode: "auto" });
			for (const bad of [{ channel: "beta", mode: "auto" }, { channel: "main", mode: "sometimes" }, { channel: "main" }, "x"]) assert.equal((await h.put(req("PUT", bad))).status, 400);
			writeFileSync(file, "{broken");
			assert.deepEqual(await (await h.get(req("GET"))).json(), { exists: false, channel: "stable", mode: "button" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("saves the file world-readable (0644), even under a strict umask and over an old 0600 file, so workerd (another user) can read the channel", async () => {
		const dir = mkdtempSync(join(tmpdir(), "subscription-"));
		const file = join(dir, "subscription.json");
		writeFileSync(file, "{}", { mode: 0o600 });
		const old = process.umask(0o077);
		try {
			const h = createSubscriptionHandler({ file, env: {}, gate: async () => "device abc" });
			assert.equal((await h.put(req("PUT", { channel: "main", mode: "auto" }))).status, 200);
			assert.equal(statSync(file).mode & 0o777, 0o644);
		} finally {
			process.umask(old);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("in the Mac app (WOLFPACK_SINGLE_MAC=1, no paired device) GET answers without a bearer, reports the default and creates no file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "subscription-"));
		const file = join(dir, "release-channel.json");
		try {
			const h = createSubscriptionHandler({ env: { HOME: dir, WOLFPACK_SINGLE_MAC: "1", WOLFPACK_SUBSCRIPTION_FILE: file }, gate: async () => Response.json({ code: "unauthorized" }, { status: 401 }) });
			const r = await h.get(req("GET"));
			assert.equal(r.status, 200);
			assert.deepEqual(await r.json(), { exists: false, channel: "stable", mode: "button" });
			assert.equal(existsSync(file), false);
			// The app never writes this file: PUT stays gated and writes nothing.
			assert.equal((await h.put(req("PUT", { channel: "main", mode: "auto" }))).status, 401);
			assert.equal(existsSync(file), false);
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
