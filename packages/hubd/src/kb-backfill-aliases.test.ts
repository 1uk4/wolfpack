import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { foldRegistry, readLedger } from "@wolfpack/kb/librarian";
import { ledgerFile } from "@wolfpack/kb/shared";
import { hubRoots } from "./layout.js";
import { formatAliasBackfillReport, kbBackfillAliases } from "./kb-backfill-aliases.js";
import { acquireKbWriterLock } from "./kb-commits.js";
import { main, parseArgs } from "./cli.js";

const tmp: string[] = [];
afterEach(() => {
  while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true });
});
const put = (f: string, s: string) => {
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, s);
};
const jl = (xs: unknown[]) => xs.map((x) => JSON.stringify(x)).join("\n") + "\n";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kb-alias-bf-"));
  tmp.push(root);
  const dataDir = join(root, "hub");
  const dewey = join(root, "dewey.jsonl");
  put(join(dataDir, "kb", "base", "domains", "wolfpack", "entries", "kb-wolfpack-AAA.md"), "---\ntitle: A\n---\nx\n");
  put(dewey, jl([
    { id: "d1", at: "2026-10-01T10:00:00.000Z", t: "entry_written", entryId: "kb-wolfpack-AAA", canonicalId: "kb-wolfpack-AAA", action: "create" },
    { id: "d2", at: "2026-10-01T10:00:00.000Z", t: "aliased", wolf: "w1", denTopicId: "t-a", canonicalId: "kb-wolfpack-AAA", hash: "sha256:h1" },
    { id: "d3", at: "2026-10-02T10:00:00.000Z", t: "aliased", wolf: "w1", denTopicId: "t-curated", canonicalId: "kb-wolfpack-OLD", hash: "sha256:h2" },
    { id: "d4", at: "2026-10-03T10:00:00.000Z", t: "aliased", wolf: "w2", denTopicId: "t-gone", canonicalId: "kb-wolfpack-GONE", hash: "sha256:h3" },
    { id: "d5", at: "2026-10-03T11:00:00.000Z", t: "aliased", wolf: "w2", denTopicId: "t-retired", canonicalId: "kb-wolfpack-RET", hash: "sha256:h4" },
    { id: "d6", at: "2026-10-04T10:00:00.000Z", t: "entry_retired", entryId: "kb-wolfpack-RET", reason: "merged into kb-wolfpack-AAA" },
    { id: "d7", at: "2026-10-04T10:00:00.000Z", t: "entry_retired", entryId: "kb-wolfpack-CUR", reason: "x" },
    { id: "d8", at: "bad", t: "aliased", wolf: "w", denTopicId: "x", canonicalId: "kb-wolfpack-AAA", hash: "h" },
  ]));
  // hub ledger already holds curator events (non-bf)
  const roots = hubRoots(dataDir);
  put(ledgerFile(roots), jl([
    { id: "cur1", at: "2026-11-05T00:00:00.000Z", t: "entry_written", entryId: "kb-wolfpack-CUR", canonicalId: "kb-wolfpack-CUR", action: "create" },
    { id: "cur2", at: "2026-11-05T00:00:01.000Z", t: "aliased", wolf: "w1", denTopicId: "t-curated", canonicalId: "kb-wolfpack-AAA", hash: "sha256:new" },
  ]));
  return { dataDir, deweyLedger: dewey, roots };
}

describe("kb-backfill --aliases", () => {
  it("dry run reports and writes nothing", async () => {
    const f = fixture();
    const before = readLedger(f.roots).length;
    const r = await kbBackfillAliases({ ...f, dryRun: true });
    expect(readLedger(f.roots).length).toBe(before);
    expect(r.perType).toEqual({ aliased: 3, entry_retired: 1 });
    expect(r.skippedKeys).toEqual(["w1:t-curated"]);
    expect(r.skippedRetired).toEqual(["kb-wolfpack-CUR"]);
    expect(r.unresolvedTargets).toEqual(["kb-wolfpack-GONE"]); // RET resolves via its survivor
    expect(r.invalid).toBe(1);
    expect(r.appended).toBe(0);
    expect(formatAliasBackfillReport(r).join("\n")).toContain("kb-wolfpack-GONE");
  });

  it("applies without --force on a ledger with curator events, is idempotent, and the curator alias stays the latest", async () => {
    const f = fixture();
    const r1 = await kbBackfillAliases(f);
    expect(r1.appended).toBe(4);
    const r2 = await kbBackfillAliases(f);
    expect(r2.appended).toBe(0);
    expect(r2.alreadyPresent).toBe(4);
    const log = readLedger(f.roots);
    expect(log.filter((e) => e.id.startsWith("bf-")).length).toBe(4);
    const reg = foldRegistry(log);
    const owner = [...reg.values()].find((t) => t.aliases.some((a) => a.wolf === "w1" && a.denTopicId === "t-curated"));
    expect(owner?.canonicalId).toBe("kb-wolfpack-AAA"); // curator's, not Dewey's kb-wolfpack-OLD
    expect(owner?.aliases.find((a) => a.denTopicId === "t-curated")?.lastHash).toBe("sha256:new");
    expect([...reg.values()].some((t) => t.aliases.some((a) => a.denTopicId === "t-a"))).toBe(true);
  });

  it("is wired in the CLI and needs --dewey-ledger", async () => {
    expect(() => parseArgs(["kb-backfill", "--aliases", "--data-dir", "/x"])).toThrow(/dewey-ledger/);
    const f = fixture();
    const out: string[] = [];
    await main(["kb-backfill", "--aliases", "--dewey-ledger", f.deweyLedger, "--data-dir", f.dataDir, "--dry-run"], {}, (m) => out.push(m));
    expect(out.join("\n")).toContain("dry run");
  });

  it("skips a Dewey entry_retired when the hub ledger already has a curator retire for that entry", async () => {
    const f = fixture();
    appendFileSync(ledgerFile(f.roots), jl([{ id: "cur3", at: "2026-11-06T00:00:00.000Z", t: "entry_retired", entryId: "kb-wolfpack-RET", reason: "merged into kb-wolfpack-CUR" }]));
    const r = await kbBackfillAliases(f);
    expect(r.skippedRetired).toContain("kb-wolfpack-RET");
    expect(readLedger(f.roots).filter((e) => e.t === "entry_retired" && e.entryId === "kb-wolfpack-RET").map((e) => e.id)).toEqual(["cur3"]);
  });

  it("collapses duplicate source events by their derived id", async () => {
    const f = fixture();
    const dup = { id: "dupe", at: "2026-10-05T10:00:00.000Z", t: "aliased", wolf: "w9", denTopicId: "t-dup", canonicalId: "kb-wolfpack-AAA", hash: "sha256:hd" };
    appendFileSync(f.deweyLedger, jl([dup, dup]));
    const r = await kbBackfillAliases(f);
    expect(r.appended).toBe(5);
    expect(readLedger(f.roots).filter((e) => e.t === "aliased" && e.denTopicId === "t-dup").length).toBe(1);
  });

  it("fails cleanly while a live hubd holds the KB writer lock (real run), and says hubd must be stopped", async () => {
    const f = fixture();
    const lock = acquireKbWriterLock(f.dataDir);
    try {
      await expect(kbBackfillAliases(f)).rejects.toThrow(/lock|writer/i);
      expect(readLedger(f.roots).filter((e) => e.id.startsWith("bf-")).length).toBe(0);
    } finally {
      lock.release();
    }
    const r = await kbBackfillAliases(f);
    expect(formatAliasBackfillReport(r)[0]).toContain("hubd must be stopped");
  });

  it("first run copies, the curator re-aliases the same key, a second run skips it and the curator alias stays latest", async () => {
    const f = fixture();
    await kbBackfillAliases(f);
    appendFileSync(ledgerFile(f.roots), jl([{ id: "cur9", at: "2026-11-07T00:00:00.000Z", t: "aliased", wolf: "w2", denTopicId: "t-gone", canonicalId: "kb-wolfpack-AAA", hash: "sha256:cur" }]));
    const r2 = await kbBackfillAliases(f);
    expect(r2.skippedKeys).toContain("w2:t-gone");
    expect(r2.appended).toBe(0);
    const reg = foldRegistry(readLedger(f.roots));
    const owner = [...reg.values()].find((t) => t.aliases.some((a) => a.wolf === "w2" && a.denTopicId === "t-gone"));
    expect(owner?.canonicalId).toBe("kb-wolfpack-AAA");
    expect(owner?.aliases.find((a) => a.denTopicId === "t-gone")?.lastHash).toBe("sha256:cur");
  });
});
