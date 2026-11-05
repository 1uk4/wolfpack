/**
 * Legacy-name compatibility for the LH_* → WOLFPACK_* env rename and the
 * userData folder rename. Remove with the fallbacks (after 2026-12-05).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { readEnv } from "../env-compat.ts";

const require = createRequire(import.meta.url);
const { migrateLegacyUserData } = require("../../desktop/electron/userdata-migrate.cjs");
const OLD = ["Learn", "Harness"].join("");

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

describe("userData migration", () => {
	const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), "wp-ud-"));
	it("copies (not moves) the legacy folder when the new one is absent", () => {
		const root = mk();
		const old = path.join(root, OLD);
		fs.mkdirSync(path.join(old, "data"), { recursive: true });
		fs.writeFileSync(path.join(old, "console.json"), '{"consoleUrl":"x"}');
		fs.writeFileSync(path.join(old, "data", "a.txt"), "a");
		const next = path.join(root, "Wolfpack Console");
		const logs: string[] = [];
		const r = migrateLegacyUserData(next, (m: string) => logs.push(m));
		assert.equal(r.migrated, true);
		assert.equal(fs.readFileSync(path.join(next, "console.json"), "utf8"), '{"consoleUrl":"x"}');
		assert.equal(fs.readFileSync(path.join(next, "data", "a.txt"), "utf8"), "a");
		assert.ok(fs.existsSync(path.join(old, "console.json")), "old folder untouched");
		assert.equal(logs.length, 1);
	});
	it("maps the -dev folder to the -dev folder", () => {
		const root = mk();
		fs.mkdirSync(path.join(root, `${OLD}-dev`));
		fs.writeFileSync(path.join(root, `${OLD}-dev`, "console.json"), "{}");
		assert.equal(migrateLegacyUserData(path.join(root, "Wolfpack Console-dev")).migrated, true);
		assert.ok(fs.existsSync(path.join(root, "Wolfpack Console-dev", "console.json")));
	});
	it("does nothing when the new folder exists or no legacy folder", () => {
		const root = mk();
		fs.mkdirSync(path.join(root, OLD));
		fs.mkdirSync(path.join(root, "Wolfpack Console"));
		assert.equal(migrateLegacyUserData(path.join(root, "Wolfpack Console")).migrated, false);
		assert.equal(migrateLegacyUserData(path.join(mk(), "Wolfpack Console")).migrated, false);
	});
});
