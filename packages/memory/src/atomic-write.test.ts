import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeFileAtomic } from "./atomic-write.js";

describe("writeFileAtomic", () => {
  it("a reader polling during rewrites never sees an empty or partial file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-"));
    const file = join(dir, "observations.jsonl");
    const full = '{"content":"tagged leftover"}\n'.repeat(20000);
    writeFileSync(file, full);
    let done = false;
    const seen = new Set<number>();
    const writer = (async () => {
      for (let i = 0; i < 40; i++) {
        await writeFileAtomic(file, full);
        await new Promise((r) => setImmediate(r));
      }
      done = true;
    })();
    while (!done) {
      seen.add(readFileSync(file, "utf-8").length);
      await new Promise((r) => setImmediate(r));
    }
    await writer;
    expect([...seen]).toEqual([full.length]);
    expect(readdirSync(dir)).toEqual(["observations.jsonl"]);
  });

  it("removes its temp file when the rename fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-"));
    mkdirSync(join(dir, "target", "sub"), { recursive: true }); // rename onto a non-empty directory fails
    await expect(writeFileAtomic(join(dir, "target"), "x")).rejects.toThrow();
    expect(readdirSync(dir)).toEqual(["target"]);
  });
});
