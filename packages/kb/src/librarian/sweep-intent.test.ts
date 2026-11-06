import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "@wolfpack/engine";
import { sweep } from "./sweep.js";
import { defaultSweepWriter, type SweepWriter } from "./sweep-writer.js";
import { readLedger, seenHashes } from "./ledger.js";
import { intentFile, writeIntent, replayIntent, intentDigest, intentWrittenCount } from "./intent.js";
import { appendLedger } from "./ledger.js";
import { ev, entriesDir, type KbRoots } from "../shared/index.js";

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

  it("crash after the append, before the clear: the REAL intent replays as a no-op and clears", async () => {
    const roots = setup();
    let saved = "";
    const spy: SweepWriter = { ...defaultSweepWriter, commitEntry: (r, e) => { saved = readFileSync(intentFile(r), "utf-8"); return defaultSweepWriter.commitEntry(r, e); } };
    await run(roots, false, spy);
    const before = readLedger(roots);
    expect(JSON.parse(saved).written).toBe(0); // a real value, taken from the ledger at write time
    writeFileSync(intentFile(roots), saved); // the clear never happened
    expect(await replayIntent(roots, { notify: () => {} })).toBe("discarded");
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
    const text = readFileSync(join(entriesDir(roots, "sj"), `${entryId}.md`), "utf-8");
    writeIntent(roots, { hash: "feed", entryId, domain: "sj", events: [], expect: "0".repeat(64), prev: intentDigest(text) });
    expect(await replayIntent(roots)).toBe("discarded");
    expect(seenHashes(readLedger(roots)).has("feed")).toBe(false);
  });

  it("the overflow throws BEFORE writeIntent: its section_created stays in the batch and is persisted once", async () => {
    const roots = setup();
    let produces = 0;
    const eng = {
      call: async (step: string, schema: { parse: (v: unknown) => unknown }) => {
        if (step === "classifyToSection") return schema.parse({ section: "NEW", confidence: "low" });
        if (step === "matchSubject") return schema.parse({ match: "new", reason: "different" });
        if (++produces > 1) throw new Error("model died on the overflow");
        return schema.parse(opinion("Main topic", { overflow: { title: "Second topic", summary: "Another subject.", detail: "second detail" } }));
      },
      usage: { summarize: () => ({}) },
    } as unknown as Engine;
    await sweep({ engine: eng, roots, getEmbedder: () => ({ embed: async (t: string) => (String(t).includes("Second topic") ? [0, 1, 0] : [1, 0, 0]) }), loadEntryVectors: async () => [] } as any);
    expect(entries(roots)).toHaveLength(1);
    expect(inboxMd(roots).some((f) => f.includes("~split-"))).toBe(true);
    expect(count(roots, "section_created")).toBe(2); // the main section's and the overflow's: none lost
    expect(existsSync(intentFile(roots))).toBe(false);
  });

  it("the overflow append went through and something later threw: not requeued", async () => {
    const roots = setup();
    const notify = (m: string) => { if (m.includes("→ split:")) throw new Error("notify blew up"); };
    await sweep({ engine: mkEngine(true), roots, notify, getEmbedder: () => ({ embed: async () => [1, 0, 0] }), loadEntryVectors: async () => [] } as any);
    expect(entries(roots)).toHaveLength(2);
    expect(inboxMd(roots)).toEqual([]);
    expect(count(roots, "contribution")).toBe(2);
    expect(count(roots, "entry_placed")).toBe(2);
  });

  describe("replay digests", () => {
    const seed = (roots: KbRoots, text: string | null) => {
      const dir = entriesDir(roots, "sj");
      mkdirSync(dir, { recursive: true });
      if (text !== null) writeFileSync(join(dir, "e1.md"), text);
    };
    const events = () => [ev.contribution({ from: "w1", denTopicId: "t", hash: "h1", prevHash: null, domainHint: "sj" })];
    const intent = (o: object = {}) => ({ hash: "h1", entryId: "e1", domain: "sj", events: events(), ...o });
    // The merge path (expect = renderEntry(entry)) and the patch path (expect = patchSourceProperties(...)) differ only in the text; both are old → new.
    for (const path of ["merge", "patch"]) {
      it(`${path}: live == expect appends; still == prev discards (notified); missing discards; rewritten appends (notified)`, async () => {
        const roots = setup();
        const oldT = "old text";
        const newT = `${path} new text`;
        const notes: string[] = [];
        const notify = (m: string) => void notes.push(m);
        const phase = async (file: string | null) => {
          const r = setup();
          seed(r, file);
          writeIntent(r, intent({ expect: intentDigest(newT), prev: intentDigest(oldT), written: 0 }));
          notes.length = 0;
          const out = await replayIntent(r, { notify });
          return { out, seen: count(r, "contribution"), cleared: !existsSync(intentFile(r)) };
        };
        expect(await phase(newT)).toEqual({ out: "recorded", seen: 1, cleared: true });
        expect(notes).toEqual([]);
        expect(await phase(oldT)).toEqual({ out: "discarded", seen: 0, cleared: true });
        expect(notes.join("\n")).toMatch(/discarded.*never landed/);
        expect(await phase(null)).toEqual({ out: "discarded", seen: 0, cleared: true });
        expect(notes.join("\n")).toMatch(/discarded/);
        expect(await phase("rewritten by a reorg")).toEqual({ out: "recorded", seen: 1, cleared: true });
        expect(notes.join("\n")).toMatch(/rewritten after the commit/);
      });
    }

    it("a create (no prev) whose file holds other content counts as rewritten and appends", async () => {
      const roots = setup();
      seed(roots, "something else");
      writeIntent(roots, intent({ expect: intentDigest("planned") }));
      expect(await replayIntent(roots, { notify: () => {} })).toBe("recorded");
    });

    it("written baseline above 0 (a hub merge): the commit path's growth drops the intent's own entry_written; no growth keeps it", async () => {
      const roots = setup();
      appendLedger(roots, [ev.entryWritten("e1", "e1", "create")]); // the entry's earlier life: baseline 1
      expect(intentWrittenCount(readLedger(roots), "e1")).toBe(1);
      const evs = [...events(), ev.entryWritten("e1", "e1", "merge")];
      seed(roots, "merged");
      writeIntent(roots, intent({ events: evs, expect: intentDigest("merged"), prev: intentDigest("before"), written: 1 }));
      appendLedger(roots, [ev.entryWritten("e1", "e1", "merge")]); // commitKb logged this merge
      await replayIntent(roots, { notify: () => {} });
      expect(count(roots, "entry_written")).toBe(2); // not 3
      // same intent, but the commit path logged nothing: the intent's own entry_written is kept
      const roots2 = setup();
      appendLedger(roots2, [ev.entryWritten("e1", "e1", "create")]);
      seed(roots2, "merged");
      writeIntent(roots2, intent({ events: evs, expect: intentDigest("merged"), written: 1 }));
      await replayIntent(roots2, { notify: () => {} });
      expect(count(roots2, "entry_written")).toBe(2);
    });

    it("an unchanged commit (no expect): the file only has to exist; written does not grow, all events append", async () => {
      const roots = setup();
      seed(roots, "as is");
      writeIntent(roots, intent({ events: [...events(), ev.decision({ from: "w1", denTopicId: "t", hash: "h1", outcome: "unchanged", entryId: "e1" } as any)], written: 0 }));
      expect(await replayIntent(roots, { notify: () => {} })).toBe("recorded");
      expect(count(roots, "contribution")).toBe(1);
      expect(count(roots, "decision")).toBe(1);
    });

    it("an intent with an invalid event is treated as corrupt", async () => {
      const roots = setup();
      seed(roots, "x");
      writeIntent(roots, intent({ events: [{ t: "contribution", nonsense: true }] as any }));
      const notes: string[] = [];
      expect(await replayIntent(roots, { notify: (m) => void notes.push(m) })).toBe("discarded");
      expect(notes[0]).toMatch(/corrupt/);
      expect(readdirSync(roots.opsRoot).some((f) => f.includes(".corrupt-"))).toBe(true);
    });
  });

  it("a replay append that throws at tick start keeps the intent, notifies, and blocks the tick", async () => {
    const roots = setup();
    await run(roots, false, flaky(() => true)).catch(() => undefined); // leaves a live entry + intent
    const notes: string[] = [];
    await expect(sweep({ engine: mkEngine(false), roots, notify: (m: string) => void notes.push(m), writer: flaky(() => true), getEmbedder: () => ({ embed: async () => [1, 0, 0] }), loadEntryVectors: async () => [] } as any)).rejects.toThrow(/append crashed/);
    expect(existsSync(intentFile(roots))).toBe(true);
    expect(notes.join("\n")).toMatch(/BLOCKED.*pending-commit\.json is kept/);
    expect(inboxMd(roots)).toEqual(["t.md"]); // nothing drained
    await run(roots, false); // the ledger works again: it recovers
    expect(count(roots, "contribution")).toBe(1);
    expect(entries(roots)).toHaveLength(1);
  });
});
