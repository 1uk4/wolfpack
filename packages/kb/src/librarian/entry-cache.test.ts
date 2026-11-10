import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once, readEntryCached } from "./entry-cache.js";

describe("readEntryCached", () => {
  it("sees a same-size rewrite of an entry even when its mtime is put back", () => {
    const dir = mkdtempSync(join(tmpdir(), "kb-ec-"));
    try {
      const file = join(dir, "kb-wp-1.md");
      writeFileSync(file, "---\nid: kb-wp-1\nsection: sec-a-1\n---\n# T\n");
      utimesSync(file, 1700000000, 1700000000);
      expect(readEntryCached(file)?.fields.section).toBe("sec-a-1");
      writeFileSync(file, readFileSync(file, "utf-8").replace("sec-a-1", "sec-b-1"));
      utimesSync(file, 1700000000, 1700000000); // same size, same mtime: only ctime differs
      expect(readEntryCached(file)?.fields.section).toBe("sec-b-1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("once", () => {
  it("rethrows on every call while the computation keeps failing, and caches only a success", () => {
    let calls = 0;
    const f = once(() => {
      calls++;
      if (calls < 3) throw new Error("bad entry");
      return "ok";
    });
    expect(() => f()).toThrow("bad entry");
    expect(() => f()).toThrow("bad entry");
    expect(f()).toBe("ok");
    expect(f()).toBe("ok");
    expect(calls).toBe(3);
  });
});
