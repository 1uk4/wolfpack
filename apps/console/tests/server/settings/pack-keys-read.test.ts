/**
 * The console reads the machine's Pack key file first (work-wolfpack-6EmU8pu): the Pack value beats the process env and auth.json,
 * auth.json stays the fallback, and auth.json is never written. Throwaway values and temp dirs only.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it, mock } from "node:test";

for (const v of ["ANTHROPIC_API_KEY", "DEEPGRAM_API_KEY", "TAVILY_API_KEY", "OPENROUTER_API_KEY"]) delete process.env[v];

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "wp-pack-keys-"));
const AUTH = path.join(TMP, "auth.json");
const PACK = path.join(TMP, "keys.env");
const AUTH_TEXT = JSON.stringify({ DEEPGRAM_API_KEY: "dg-from-auth", TAVILY_API_KEY: "tv-from-auth" });
fs.writeFileSync(AUTH, AUTH_TEXT);
fs.writeFileSync(PACK, "DEEPGRAM_API_KEY=dg-from-pack\nANTHROPIC_API_KEY=an-from-pack\n");
process.env.WOLFPACK_AUTH_FILE = AUTH;
process.env.WOLFPACK_KEY_FILE = PACK;
process.env.DEEPGRAM_API_KEY = "dg-from-env";

const { keyValue, initAuthEnv } = await import("../../../src/server/settings/keys.ts");

after(() => {
	delete process.env.DEEPGRAM_API_KEY;
	delete process.env.ANTHROPIC_API_KEY;
	fs.rmSync(TMP, { recursive: true, force: true });
});

describe("console reads the Pack key file first", () => {
	it("Pack beats the env and auth.json; auth.json still answers for keys the Pack lacks", () => {
		assert.equal(keyValue("DEEPGRAM_API_KEY"), "dg-from-pack");
		assert.equal(keyValue("TAVILY_API_KEY"), "tv-from-auth");
	});

	it("reads the file fresh, so a key.set shows without a restart", () => {
		fs.writeFileSync(PACK, "DEEPGRAM_API_KEY=dg-second\n");
		assert.equal(keyValue("DEEPGRAM_API_KEY"), "dg-second");
	});

	it("never copies the Pack's Anthropic key into process.env (child processes would inherit it), and never touches auth.json", () => {
		fs.writeFileSync(PACK, "ANTHROPIC_API_KEY=an-from-pack\n");
		initAuthEnv();
		assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
		assert.equal(keyValue("ANTHROPIC_API_KEY"), "an-from-pack");
		assert.equal(fs.readFileSync(AUTH, "utf8"), AUTH_TEXT);
	});

	it("a removed key is gone at once", () => {
		fs.writeFileSync(PACK, "ANTHROPIC_API_KEY=an-set\n");
		assert.equal(keyValue("ANTHROPIC_API_KEY"), "an-set");
		fs.writeFileSync(PACK, "");
		initAuthEnv();
		assert.equal(keyValue("ANTHROPIC_API_KEY"), undefined);
		assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
	});

	it("has no default key file: without WOLFPACK_KEY_FILE there is no Pack key", () => {
		fs.writeFileSync(PACK, "DEEPGRAM_API_KEY=dg-from-pack\n");
		delete process.env.WOLFPACK_KEY_FILE;
		try {
			assert.equal(keyValue("DEEPGRAM_API_KEY"), "dg-from-env");
		} finally {
			process.env.WOLFPACK_KEY_FILE = PACK;
		}
	});

	it("parses CRLF lines and returns only the known slots", () => {
		fs.writeFileSync(PACK, "DEEPGRAM_API_KEY=dg-crlf\r\nTAVILY_API_KEY=tv-pack\r\n");
		assert.equal(keyValue("DEEPGRAM_API_KEY"), "dg-crlf");
		assert.equal(keyValue("TAVILY_API_KEY"), "tv-from-auth");
	});

	it("ignores a value with characters the store would reject", () => {
		fs.writeFileSync(PACK, "DEEPGRAM_API_KEY=dg bad$value\n");
		assert.equal(keyValue("DEEPGRAM_API_KEY"), "dg-from-env");
	});

	it("refuses a world-writable key file and logs it without the value", () => {
		fs.writeFileSync(PACK, "DEEPGRAM_API_KEY=dg-open-file\n");
		fs.chmodSync(PACK, 0o666);
		const warn = mock.method(console, "warn", () => {});
		try {
			assert.equal(keyValue("DEEPGRAM_API_KEY"), "dg-from-env");
			const logged = warn.mock.calls.map((c) => c.arguments.join(" ")).join("\n");
			assert.match(logged, /world-writable/);
			assert.doesNotMatch(logged, /dg-open-file/);
		} finally {
			warn.mock.restore();
			fs.chmodSync(PACK, 0o600);
		}
	});
});
