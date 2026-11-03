/**
 * Regression for work-wolfpack-kuSV9Sm: the root .gitignore `keys/` pattern
 * swallowed app/api/keys/, so builds from git shipped without /api/keys and
 * saving a key 404'd. Every key-related route the UI fetches must be a
 * TRACKED, non-ignored file. Also pins AUTH_FILE resolution and a masked
 * PUT/GET round-trip under LH_DATA_DIR. Dummy values only.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

const CONSOLE = path.resolve(import.meta.dirname, "..");

const ROUTES = [
	"app/api/keys/route.ts",
	"app/api/keys/[id]/route.ts",
	"app/api/stt/token/route.ts",
];

describe("key routes are tracked in git", () => {
	for (const rel of ROUTES) {
		it(rel, () => {
			assert.ok(fs.existsSync(path.join(CONSOLE, rel)), `${rel} missing`);
			const tracked = execFileSync("git", ["ls-files", "--", rel], { cwd: CONSOLE, encoding: "utf8" }).trim();
			if (tracked) return;
			// Not yet committed (pre-commit run): must at least not be ignored.
			let ignored = true;
			try {
				execFileSync("git", ["check-ignore", "-q", "--", rel], { cwd: CONSOLE });
			} catch {
				ignored = false;
			}
			assert.equal(ignored, false, `${rel} is gitignored — it would never ship`);
		});
	}
});

async function loadAuthFile(env: Record<string, string | undefined>): Promise<string> {
	const saved = { a: process.env.LH_AUTH_FILE, d: process.env.LH_DATA_DIR };
	for (const [k, v] of Object.entries({ LH_AUTH_FILE: env.LH_AUTH_FILE, LH_DATA_DIR: env.LH_DATA_DIR })) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	try {
		const mod = (await import(`../config.ts?case=${Math.random()}`)) as { AUTH_FILE: string };
		return mod.AUTH_FILE;
	} finally {
		for (const [k, v] of [["LH_AUTH_FILE", saved.a], ["LH_DATA_DIR", saved.d]] as const) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

describe("AUTH_FILE resolution", () => {
	it("LH_AUTH_FILE wins", async () => {
		assert.equal(await loadAuthFile({ LH_AUTH_FILE: "/x/a.json", LH_DATA_DIR: "/y/data" }), "/x/a.json");
	});
	it("LH_DATA_DIR alone puts auth.json in the data dir", async () => {
		assert.equal(await loadAuthFile({ LH_DATA_DIR: "/var/lib/console/data" }), "/var/lib/console/data/auth.json");
	});
	it("neither: app-root auth.json (unchanged)", async () => {
		assert.equal(await loadAuthFile({}), path.join(CONSOLE, "auth.json"));
	});
});

describe("PUT then GET round-trip under LH_DATA_DIR", () => {
	it("stores server-side, masked in status, mode 0600", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-kusv-"));
		const dataDir = path.join(dir, "data");
		fs.mkdirSync(dataDir);
		delete process.env.LH_AUTH_FILE;
		delete process.env.DEEPGRAM_API_KEY;
		process.env.LH_DATA_DIR = dataDir;
		const { saveKey, keyStatuses, keyValue } = (await import("../src/server/keys.ts")) as typeof import("../src/server/keys.ts");
		const dummy = "dg_dummy_0123456789abcdef0123456789abcdef";
		const r = saveKey("DEEPGRAM_API_KEY", dummy);
		assert.equal(r.ok, true);
		const file = path.join(dataDir, "auth.json");
		assert.ok(fs.existsSync(file), "auth.json should live under LH_DATA_DIR");
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);
		assert.equal(keyValue("DEEPGRAM_API_KEY"), dummy);
		const status = keyStatuses().find((s: { id: string }) => s.id === "DEEPGRAM_API_KEY");
		assert.ok(status);
		const json = JSON.stringify(keyStatuses());
		assert.ok(!json.includes(dummy), "plaintext leaked in status");
		assert.ok(json.includes("cdef"), "last 4 expected in mask");
	});
});
