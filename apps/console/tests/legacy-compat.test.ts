/**
 * Legacy-name compatibility for the LH_* → WOLFPACK_* env rename (the userData
 * folder migration is tested in apps/desktop/electron/userdata-migrate.test.ts). Remove with the fallbacks (after 2026-12-05).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readEnv } from "../env-compat.ts";

describe("readEnv", () => {
	it("prefers the new name, falls back to the legacy one, else undefined", () => {
		delete process.env.WP_T_NEW;
		delete process.env.LH_T_OLD;
		assert.equal(readEnv("WP_T_NEW", "LH_T_OLD"), undefined);
		process.env.LH_T_OLD = "old";
		assert.equal(readEnv("WP_T_NEW", "LH_T_OLD"), "old");
		process.env.WP_T_NEW = "new";
		assert.equal(readEnv("WP_T_NEW", "LH_T_OLD"), "new");
		delete process.env.WP_T_NEW;
		delete process.env.LH_T_OLD;
	});
});
