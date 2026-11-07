import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { migrateLegacyUserData } = createRequire(import.meta.url)("./userdata-migrate.cjs");
const LEGACY = ["Learn", "Harness"].join("");

let root: string;
let oldDir: string;
let newDir: string;
const write = (p: string, body: string) => {
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, body);
};

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "ud-migrate-"));
	oldDir = path.join(root, LEGACY);
	newDir = path.join(root, "Wolfpack Console");
	write(path.join(oldDir, "console.json"), '{"consoleUrl":"https://sfo"}');
	write(path.join(oldDir, "auth.json"), '{"KEY":"old"}');
	write(path.join(oldDir, "data", "chats", "a.json"), "{}");
	write(path.join(oldDir, "SingletonLock"), "x");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("migrateLegacyUserData", () => {
	it("copies the old folder into a new folder Chromium already created empty", () => {
		write(path.join(newDir, "Cache", "x"), "cache");
		const logs: string[] = [];
		const r = migrateLegacyUserData(newDir, (m: string) => logs.push(m));
		expect(r.migrated).toBe(true);
		expect(fs.readFileSync(path.join(newDir, "console.json"), "utf8")).toBe('{"consoleUrl":"https://sfo"}');
		expect(fs.existsSync(path.join(newDir, "auth.json"))).toBe(true);
		expect(fs.existsSync(path.join(newDir, "data", "chats", "a.json"))).toBe(true);
		expect(fs.existsSync(path.join(newDir, "SingletonLock"))).toBe(false);
		expect(logs.join("\n")).toContain("copied");
	});

	it("never overwrites owner state already in the new folder", () => {
		write(path.join(newDir, "console.json"), '{"consoleUrl":"https://new"}');
		const r = migrateLegacyUserData(newDir);
		expect(r.migrated).toBe(false);
		expect(fs.readFileSync(path.join(newDir, "console.json"), "utf8")).toBe('{"consoleUrl":"https://new"}');
		expect(fs.existsSync(path.join(newDir, "auth.json"))).toBe(false);
	});

	it("replaces Chromium stores wholesale so leveldb files never mix", () => {
		const ldb = (d: string) => path.join(d, "Local Storage", "leveldb");
		write(path.join(ldb(oldDir), "CURRENT"), "old");
		write(path.join(ldb(oldDir), "MANIFEST-000005"), "old");
		write(path.join(ldb(oldDir), "000003.ldb"), "old");
		write(path.join(ldb(newDir), "CURRENT"), "new");
		write(path.join(ldb(newDir), "MANIFEST-000001"), "new");
		const r = migrateLegacyUserData(newDir);
		expect(r.migrated).toBe(true);
		expect(fs.readdirSync(ldb(newDir)).sort()).toEqual(["000003.ldb", "CURRENT", "MANIFEST-000005"]);
		expect(fs.readFileSync(path.join(ldb(newDir), "CURRENT"), "utf8")).toBe("old");
	});

	it("keeps copying when one file cannot be read, and reports it", () => {
		write(path.join(oldDir, "locked.db"), "x");
		fs.chmodSync(path.join(oldDir, "locked.db"), 0o000);
		const logs: string[] = [];
		const r = migrateLegacyUserData(newDir, (m: string) => logs.push(m));
		fs.chmodSync(path.join(oldDir, "locked.db"), 0o600);
		expect(r.migrated).toBe(true);
		expect(fs.existsSync(path.join(newDir, "console.json"))).toBe(true);
		expect(logs.join("\n")).toContain("locked.db");
	});

	it("copies rather than moves: the old folder is left untouched", () => {
		migrateLegacyUserData(newDir);
		expect(fs.readFileSync(path.join(oldDir, "console.json"), "utf8")).toBe('{"consoleUrl":"https://sfo"}');
		expect(fs.existsSync(path.join(oldDir, "data", "chats", "a.json"))).toBe(true);
	});

	it("maps the -dev folder to the -dev folder", () => {
		write(path.join(root, `${LEGACY}-dev`, "console.json"), "{}");
		const devDir = path.join(root, "Wolfpack Console-dev");
		expect(migrateLegacyUserData(devDir).migrated).toBe(true);
		expect(fs.existsSync(path.join(devDir, "console.json"))).toBe(true);
		expect(fs.existsSync(path.join(devDir, "auth.json"))).toBe(false); // prod legacy folder is not used
	});

	it("does nothing when there is no legacy folder", () => {
		const other = fs.mkdtempSync(path.join(os.tmpdir(), "ud-migrate-none-"));
		try {
			expect(migrateLegacyUserData(path.join(other, "Wolfpack Console")).migrated).toBe(false);
			expect(fs.existsSync(path.join(other, "Wolfpack Console"))).toBe(false);
		} finally {
			fs.rmSync(other, { recursive: true, force: true });
		}
	});
});
