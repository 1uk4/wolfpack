/**
 * Seam: key-file.cjs (readKey / writeKey / keyProblem) on real temp files. It mirrors packages/workerd/src/key-store.ts's file rules.
 * Catches: wrong format, loose mode, unsafe characters reaching the file, other lines lost on write.
 * Misses: workerd actually reading the file (covered by supervisor.test.ts).
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { readKey, writeKey, keyProblem } = createRequire(import.meta.url)("./key-file.cjs");

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "key-file-"));
  file = join(dir, "keys.env");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("key-file", () => {
  it("writes NAME=value with mode 0600 and reads it back", () => {
    writeKey(file, "ANTHROPIC_API_KEY", "sk-ant-fake-123");
    expect(readFileSync(file, "utf8")).toBe("ANTHROPIC_API_KEY=sk-ant-fake-123\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readKey(file, "ANTHROPIC_API_KEY")).toBe("sk-ant-fake-123");
    expect(readdirSync(dir)).toEqual(["keys.env"]); // no temp file left
  });

  it("replaces one key and keeps the other lines", () => {
    writeFileSync(file, "# mine\nDEEPGRAM_API_KEY=dg-1\nANTHROPIC_API_KEY=old\n", { mode: 0o600 });
    writeKey(file, "ANTHROPIC_API_KEY", "new");
    expect(readFileSync(file, "utf8")).toBe("# mine\nDEEPGRAM_API_KEY=dg-1\nANTHROPIC_API_KEY=new\n");
  });

  it("reads an absent or keyless file as empty", () => {
    expect(readKey(file, "ANTHROPIC_API_KEY")).toBe("");
    writeFileSync(file, "DEEPGRAM_API_KEY=dg\n");
    expect(readKey(file, "ANTHROPIC_API_KEY")).toBe("");
  });

  it("refuses a key with a character the env file would interpret, and writes nothing", () => {
    for (const bad of ['a"b', "a'b", "a\\b", "a$b", "a#b", "a b", "a\nb", "é"]) {
      expect(keyProblem(bad)).not.toBe("");
      expect(() => writeKey(file, "ANTHROPIC_API_KEY", bad)).toThrow(/not allowed/);
    }
    expect(existsSync(file)).toBe(false);
    expect(keyProblem("sk-ant-api03_AbC-123")).toBe("");
  });

  it("does not overwrite a keys.env it cannot read: it throws and the file keeps its bytes", () => {
    writeFileSync(file, "DEEPGRAM_API_KEY=dg-keepme\n", { mode: 0o600 });
    chmodSync(file, 0o000);
    try {
      expect(() => writeKey(file, "ANTHROPIC_API_KEY", "sk-ant-fake-123")).toThrow(/keys\.env.*(read|readable)/i);
    } finally {
      chmodSync(file, 0o600);
    }
    expect(readFileSync(file, "utf8")).toBe("DEEPGRAM_API_KEY=dg-keepme\n");
  });

  it("creates a missing parent folder at 0700", () => {
    const nested = join(dir, "fresh", "keys.env");
    writeKey(nested, "ANTHROPIC_API_KEY", "sk-ant-fake-123");
    expect(statSync(join(dir, "fresh")).mode & 0o777).toBe(0o700);
  });
});
