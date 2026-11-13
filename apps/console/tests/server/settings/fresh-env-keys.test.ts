/**
 * WOLFPACK_IGNORE_ENV_KEYS=1 — the fresh-user switch (owner, interlude, 2026-09-22): env keys invisible app-wide; only the Pack key
 * file counts (work-wolfpack-u6GH2kk: auth.json is gone).
 *
 * This file is deliberately its OWN PROCESS under node:test: the deletion is BOOT-TIME (importing the keys module deletes the provider key
 * env vars once), so it can only be pinned in a process that starts with the switch set.
 *
 * The engine path is the subtlety: pi-ai reads provider keys from process.env natively at every request, so the switch works by DELETING
 * the vars from the process. Assert the deletion directly, because that is what a fresh user's engines see.
 * All values are throwaway test strings, never real secrets.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

for (const v of ["OPENROUTER_API_KEY", "DEEPGRAM_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) delete process.env[v];

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "wp-fresh-env-keys-"));
const PACK = path.join(TMP, "keys.env");
fs.writeFileSync(PACK, "DEEPGRAM_API_KEY=dg-from-pack\n");
process.env.WOLFPACK_KEY_FILE = PACK;

// The env the switch must hide, set BEFORE the first import.
process.env.OPENROUTER_API_KEY = "sk-or-env-env-env";
process.env.DEEPGRAM_API_KEY = "dg-from-env";
process.env.WOLFPACK_IGNORE_ENV_KEYS = "1";

const { envKeysIgnored, initKeyEnv, keyValue } = await import("../../../src/server/settings/keys.ts");

after(() => {
	delete process.env.WOLFPACK_IGNORE_ENV_KEYS;
	fs.rmSync(TMP, { recursive: true, force: true });
});

describe("the fresh-user switch (boot under WOLFPACK_IGNORE_ENV_KEYS=1)", () => {
	it("the switch reads live", () => {
		assert.equal(envKeysIgnored(), true);
	});

	it("THE ENGINE PATH: env-only provider keys are deleted from the process at boot", () => {
		assert.equal(process.env.OPENROUTER_API_KEY, undefined);
		assert.equal(process.env.DEEPGRAM_API_KEY, undefined);
	});

	it("keyValue: the Pack file is visible, env is not, even when an env key is reintroduced after boot", () => {
		assert.equal(keyValue("DEEPGRAM_API_KEY"), "dg-from-pack");
		assert.equal(keyValue("OPENROUTER_API_KEY"), undefined);
		process.env.OPENROUTER_API_KEY = "sk-or-reintroduced-late";
		try {
			assert.equal(keyValue("OPENROUTER_API_KEY"), undefined);
		} finally {
			delete process.env.OPENROUTER_API_KEY;
		}
	});

	it("never copies the Pack's keys into process.env", () => {
		assert.equal(process.env.DEEPGRAM_API_KEY, undefined);
	});

	it("unset switch: env wins again, and the Pack file still beats it", () => {
		delete process.env.WOLFPACK_IGNORE_ENV_KEYS;
		process.env.OPENROUTER_API_KEY = "sk-or-env-wins";
		try {
			assert.equal(keyValue("OPENROUTER_API_KEY"), "sk-or-env-wins");
			assert.equal(keyValue("DEEPGRAM_API_KEY"), "dg-from-pack");
		} finally {
			delete process.env.OPENROUTER_API_KEY;
			process.env.WOLFPACK_IGNORE_ENV_KEYS = "1";
		}
	});

	it("re-running the boot deletion is idempotent, and a reintroduced env key is deleted again", () => {
		process.env.OPENROUTER_API_KEY = "sk-or-zombie";
		initKeyEnv();
		assert.equal(process.env.OPENROUTER_API_KEY, undefined);
		initKeyEnv();
		assert.equal(process.env.OPENROUTER_API_KEY, undefined);
	});

	it("without the switch the boot deletion leaves the env alone", () => {
		delete process.env.WOLFPACK_IGNORE_ENV_KEYS;
		process.env.OPENROUTER_API_KEY = "sk-or-keep";
		try {
			initKeyEnv();
			assert.equal(process.env.OPENROUTER_API_KEY, "sk-or-keep");
		} finally {
			delete process.env.OPENROUTER_API_KEY;
			process.env.WOLFPACK_IGNORE_ENV_KEYS = "1";
		}
	});
});
