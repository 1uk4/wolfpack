/**
 * Golden test: the default sweep (no writer, no lane) leaves exactly the tree and ledger the sweep produced BEFORE the write hook
 * existed (captured from 341aa774^, volatile ids and timestamps normalised). Regenerate only for an intended output change:
 *   GOLDEN_OUT=packages/kb/src/librarian/sweep-golden.json npx vitest run packages/kb/src/librarian/sweep-golden.test.ts
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { Engine } from "@wolfpack/engine";
import { sweep } from "./sweep.js";
import { contentHash, type KbRoots } from "../shared/index.js";

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), "sweep-golden.json");
const engine = {
  call: async (step: string, schema: { parse: (v: unknown) => unknown }) => {
    if (step === "classifyToSection") return schema.parse({ section: "NEW", confidence: "low" });
    if (step === "matchSubject") return schema.parse({ match: "new", reason: "different" });
    return schema.parse({ title: "Topic", kind: { type: "fact" }, summary: "s", detail: "d", confidence: "high", facets: { subsystem: "core", surface: "api", layer: "service", lifecycle: "stable" }, properties: {}, proposedRelations: [] });
  },
  usage: { summarize: () => ({}) },
} as unknown as Engine;

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const files = (dir: string, rel = ""): string[] =>
  readdirSync(join(dir, rel)).flatMap((n) => {
    const r = rel ? `${rel}/${n}` : n;
    return statSync(join(dir, r)).isDirectory() ? files(dir, r) : [r];
  });

function norm(text: string): string {
  return text
    .replace(/kb-[a-z]+-[0-9A-Za-z]{7}/g, "ID")
    .replace(/sec-[a-z]+-[0-9A-Za-z]{6}/g, "SEC")
    .replace(/ev-[0-9A-Za-z]{10}/g, "EV")
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z?/g, "TS")
    .replace(/\d{4}-\d{2}-\d{2}/g, "DATE")
    .replace(/-[0-9a-f]{10}\.md/g, "-HASH.md")
    .replace(/[0-9a-f]{12,}/g, "HEX");
}

/** [label/path, content] pairs, normalised, sorted AFTER normalisation (ids are random). */
function snapshot(roots: KbRoots): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [label, dir] of [["base", roots.kbBase], ["ops", roots.opsRoot], ["den", roots.denLocal]] as const) {
    let list: string[] = [];
    try { list = files(dir); } catch { /* none */ }
    for (const f of list) {
      if (f.endsWith("cache.jsonl") || f.includes(".lock")) continue;
      let text = norm(readFileSync(join(dir, f), "utf-8"));
      if (f.endsWith("_registry.md")) text = text.split("\n").sort().join("\n"); // topic order follows the random ids
      out.push([`${label}/${norm(f)}`, text]);
    }
  }
  return out.sort((x, y) => (x[0] + x[1]).localeCompare(y[0] + y[1]));
}

describe("sweep golden (pre-write-hook output)", () => {
  it("the default sweep reproduces the pre-change tree and ledger", async () => {
    const base = mkdtempSync(join(tmpdir(), "kb-golden-"));
    dirs.push(base);
    const roots: KbRoots = { kbBase: join(base, "base"), opsRoot: join(base, "ops"), denLocal: join(base, "den") };
    mkdirSync(join(roots.opsRoot, "ledger"), { recursive: true });
    const put = (wolf: string, topic: string, body: string, hash = contentHash(body)) => {
      mkdirSync(join(roots.opsRoot, "inbox", wolf), { recursive: true });
      writeFileSync(join(roots.opsRoot, "inbox", wolf, `${topic}-${hash.slice(0, 10)}.md`), `---\nfrom: ${wolf}\nden_topic_id: ${topic}\ncontent_hash: ${hash}\nprev_hash: null\ndomain_hint: sj\nsummary: "About ${topic}"\nsubmitted: 2026-10-01 12:00\n---\n\n${body}\n`);
    };
    put("w1", "alpha", "# Alpha\n\nfirst body");
    put("w1", "beta", "# Beta\n\nsecond body");
    put("w2", "gamma", "# Gamma\n\nthird body");
    const results = [];
    for (let i = 0; i < 4; i++) {
      const r = await sweep({ engine, roots, getEmbedder: () => ({ embed: async () => [1, 0, 0] }), loadEntryVectors: async () => [] } as any);
      results.push({ processed: r.processed, created: r.created, merged: r.merged, rejected: r.rejected, errors: r.errors, remaining: r.remaining });
    }
    const got = { results, tree: snapshot(roots) };
    if (process.env.GOLDEN_OUT) {
      writeFileSync(process.env.GOLDEN_OUT, JSON.stringify(got, null, 1));
      return;
    }
    expect(got).toEqual(JSON.parse(readFileSync(GOLDEN, "utf-8")));
  });
});
