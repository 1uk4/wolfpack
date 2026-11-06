import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "@wolfpack/engine";
import { sweep } from "./sweep.js";
import { defaultSweepWriter, type SweepWriter } from "./sweep-writer.js";
import { readLedger, seenHashes } from "./ledger.js";
import { intentFile, writeIntent, replayIntent } from "./intent.js";
import type { KbRoots } from "../shared/index.js";

const opinion = (title: string, extra: object = {}) => ({ title, kind: { type: "fact" }, summary: `${title} summary`, detail: `${title} detail`, confidence: "high", facets: {}, properties: {}, proposedRelations: [], ...extra });
/** Fake engine: with `split` the first subject carries a second one as overflow. */
const mkEngine = (split: boolean) =>
  ({
    call: async (step: string, schema: { parse: (v: unknown) => unknown }, o?: { prompt?: string }) => {
      if (step === "classifyToSection") return schema.parse({ section: "NEW", confidence: "low" });
      if (step === "matchSubject") return schema.parse({ match: "new", reason: "different" });
      if (split && (o?.prompt ?? "").includes("OVERFLOW: allowed")) return schema.parse(opinion("Main topic", { overflow: { title: "Second topic", summary: "Another subject.", detail: "second detail" } }));
      return schema.parse(opinion("Main topic"));
    },
    usage: { summarize: () => ({}) },
  }) as unknown as Engine;

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function setup(): KbRoots {
  const base = mkdtempSync(join(tmpdir(), "kb-intent-"));
  dirs.push(base);
  const roots = { kbBase: join(base, "base"), opsRoot: join(base, "ops"), denLocal: join(base, "den") };
  mkdirSync(join(roots.opsRoot, "inbox", "w1"), { recursive: true });
  mkdirSync(join(roots.opsRoot, "ledger"), { recursive: true });
  writeFileSync(join(roots.opsRoot, "inbox", "w1", "t.md"), `---\nfrom: w1\nden_topic_id: t\ncontent_hash: c0de\nprev_hash: null\ndomain_hint: sj\n---\n\n# A title\n\nbody\n`);
  return roots;
}
const run = (roots: KbRoots, split: boolean, writer?: SweepWriter) =>
  sweep({ engine: mkEngine(split), roots, writer, getEmbedder: () => ({ embed: async () => [1, 0, 0] }), loadEntryVectors: async () => [] } as any);
/** A writer whose appendLedger throws on the calls `failOn` accepts (1-based). */
const flaky = (failOn: (n: number) => boolean): SweepWriter => {
  let n = 0;
  return { ...defaultSweepWriter, appendLedger: (r, e) => { if (failOn(++n)) throw new Error("append crashed"); return defaultSweepWriter.appendLedger(r, e); } };
};
const entries = (r: KbRoots) => (existsSync(join(r.kbBase, "domains", "sj", "entries")) ? readdirSync(join(r.kbBase, "domains", "sj", "entries")).filter((f) => f.endsWith(".md")) : []);
const inboxMd = (r: KbRoots) => readdirSync(join(r.opsRoot, "inbox", "w1")).filter((f) => f.endsWith(".md"));
const processed = (r: KbRoots) => (existsSync(join(r.opsRoot, "inbox", "w1", "_processed")) ? readdirSync(join(r.opsRoot, "inbox", "w1", "_processed")) : []);
const count = (r: KbRoots, t: string) => readLedger(r).filter((e) => (e as { t: string }).t === t).length;

describe("sweep commit intent", () => {
  it("crash after the commit, before the append: the next tick records it, no second entry", async () => {
    const roots = setup();
    await run(roots, false, flaky(() => true)).catch(() => undefined);
    expect(entries(roots)).toHaveLength(1);
    expect(seenHashes(readLedger(roots)).has("c0de")).toBe(false);
    expect(existsSync(intentFile(roots))).toBe(true);
    await run(roots, false);
    expect(entries(roots)).toHaveLength(1);
    expect(seenHashes(readLedger(roots)).has("c0de")).toBe(true);
    expect(count(roots, "contribution")).toBe(1);
    expect(inboxMd(roots)).toEqual([]);
    expect(processed(roots)).toHaveLength(1);
    expect(existsSync(intentFile(roots))).toBe(false);
  });

  it("crash after the append, before the clear: replay appends nothing and clears", async () => {
    const roots = setup();
    await run(roots, false);
    const before = readLedger(roots);
    const entryId = entries(roots)[0].replace(/\.md$/, "");
    writeIntent(roots, { hash: "c0de", entryId, domain: "sj", events: before });
    expect(await replayIntent(roots)).toBe("discarded");
    expect(readLedger(roots)).toHaveLength(before.length);
    expect(existsSync(intentFile(roots))).toBe(false);
  });

  it("overflow append fails once: not requeued, no leaked batch, one set of overflow events", async () => {
    const roots = setup();
    const r = await run(roots, true, flaky((n) => n === 2));
    expect(r.created).toBeGreaterThanOrEqual(1);
    expect(entries(roots)).toHaveLength(2);
    expect(inboxMd(roots)).toEqual([]); // no ~split requeue
    expect(count(roots, "contribution")).toBe(2);
    expect(count(roots, "entry_placed")).toBe(2);
    expect(count(roots, "aliased")).toBe(2);
    expect(existsSync(intentFile(roots))).toBe(false);
  });

  it("overflow append fails persistently: requeued, PERSIST does not throw, no duplicate afterwards", async () => {
    const roots = setup();
    await run(roots, true, flaky((n) => n >= 2));
    expect(entries(roots)).toHaveLength(2);
    expect(inboxMd(roots).some((f) => f.includes("~split-"))).toBe(true);
    expect(count(roots, "contribution")).toBe(1);
    await run(roots, true);
    expect(entries(roots)).toHaveLength(2);
    expect(count(roots, "contribution")).toBe(2);
    expect(count(roots, "entry_placed")).toBe(2);
    expect(inboxMd(roots)).toEqual([]);
    expect(existsSync(intentFile(roots))).toBe(false);
  });

  it("a corrupt intent is renamed aside and the sweep proceeds", async () => {
    const roots = setup();
    writeFileSync(intentFile(roots), "{not json");
    const msgs: string[] = [];
    const r = await sweep({ engine: mkEngine(false), roots, notify: (m: string) => msgs.push(m), getEmbedder: () => ({ embed: async () => [1, 0, 0] }), loadEntryVectors: async () => [] } as any);
    expect(r.created).toBe(1);
    expect(readdirSync(roots.opsRoot).some((f) => f.startsWith("pending-commit.json.corrupt-"))).toBe(true);
    expect(msgs.join("\n")).toMatch(/corrupt commit intent/);
    expect(existsSync(intentFile(roots))).toBe(false);
  });

  it("an intent whose entry file is missing is discarded and the item routes normally", async () => {
    const roots = setup();
    writeIntent(roots, { hash: "c0de", entryId: "ghost", domain: "sj", events: [] });
    const r = await run(roots, false);
    expect(r.created).toBe(1);
    expect(entries(roots)).toHaveLength(1);
    expect(count(roots, "contribution")).toBe(1);
  });

  it("an intent for a merge whose write never landed (old file still there) is discarded", async () => {
    const roots = setup();
    await run(roots, false);
    const entryId = entries(roots)[0].replace(/\.md$/, "");
    writeIntent(roots, { hash: "feed", entryId, domain: "sj", events: [], expect: "0".repeat(64) });
    expect(await replayIntent(roots)).toBe("discarded");
    expect(seenHashes(readLedger(roots)).has("feed")).toBe(false);
  });
});
