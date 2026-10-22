import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseFrontmatter } from "@wolfpack/engine";
import { createEmbedder, currentEntryHashes, embedInput } from "./embed.js";
import { contentHash, vectorsDir, type KbRoots } from "../shared/index.js";

describe("vector cache", () => {
  let base: string;
  let roots: KbRoots;
  let fetchMock: ReturnType<typeof vi.fn>;
  const cacheFile = () => join(vectorsDir(roots), "cache.jsonl");
  const lines = () => readFileSync(cacheFile(), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { hash: string });

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "kb-embed-"));
    roots = { kbBase: join(base, "base"), opsRoot: join(base, "ops"), denLocal: join(base, "den") };
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ embedding: [1, 0, 0] })));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(base, { recursive: true, force: true });
  });

  it("compact keeps only the listed hashes, rewrites the file atomically, and prunes memory", async () => {
    const e = createEmbedder(roots);
    for (const h of ["a", "b", "c"]) await e.embed(h, h);
    expect(lines().map((l) => l.hash)).toEqual(["a", "b", "c"]);

    expect(e.compact(new Set(["b"]))).toBe(2);
    expect(lines().map((l) => l.hash)).toEqual(["b"]);
    expect(readdirSync(vectorsDir(roots)).filter((f) => f.includes(".tmp"))).toEqual([]);

    // b is still cached; a was dropped and is embedded again.
    fetchMock.mockClear();
    await e.embed("b", "b");
    expect(fetchMock).not.toHaveBeenCalled();
    await e.embed("a", "a");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shouldCompact fires once the file holds over twice the live entries plus slack", async () => {
    const e = createEmbedder(roots);
    for (let i = 0; i < 60; i++) await e.embed(`t${i}`, `h${i}`);
    expect(e.shouldCompact(40)).toBe(false); // 60 <= 2*40 + 50
    expect(e.shouldCompact(4)).toBe(true); // 60 > 2*4 + 50
  });

  it("appends after a compaction keep the file consistent", async () => {
    const e = createEmbedder(roots);
    await e.embed("a", "a");
    await e.embed("b", "b");
    e.compact(new Set(["a"]));
    await e.embed("c", "c");
    expect(lines().map((l) => l.hash)).toEqual(["a", "c"]);
    expect(createEmbedder(roots).compact(new Set(["a", "c"]))).toBe(0);
  });

  it("a cache another writer changed is re-read, not served from memory", async () => {
    const e1 = createEmbedder(roots);
    await e1.embed("a", "a");
    createEmbedder(roots); // memoised load
    writeFileSync(cacheFile(), JSON.stringify({ hash: "z", vec: [0, 0, 1] }) + "\n" + JSON.stringify({ hash: "y", vec: [0, 1, 0] }) + "\n");
    fetchMock.mockClear();
    const e3 = createEmbedder(roots);
    expect(await e3.embed("zz", "z")).toEqual([0, 0, 1]);
    expect(fetchMock).not.toHaveBeenCalled();
    await e3.embed("a", "a"); // no longer cached
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("currentEntryHashes hashes the text an entry's vector is cached under", () => {
    const dir = join(roots.kbBase, "domains", "wp", "entries");
    mkdirSync(dir, { recursive: true });
    const raw = "---\nid: kb-wp-AAAAAAA\ntitle: T\ndomain: wp\n---\n\nbody text\n";
    writeFileSync(join(dir, "kb-wp-AAAAAAA.md"), raw);
    const expected = contentHash(embedInput({ title: "T", detail: parseFrontmatter(raw).body }));
    expect([...currentEntryHashes(roots)]).toEqual([expected]);
  });
});
