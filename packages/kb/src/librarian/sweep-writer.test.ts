import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "@wolfpack/engine";
import { sweep } from "./sweep.js";
import { defaultSweepWriter, type SweepWriter } from "./sweep-writer.js";
import { readLedger } from "./ledger.js";
import { acquireLease, freshLease, freshLeaseIn, leaseFile, LEASE_STALE_MS } from "./curator-lease.js";
import { runSweepTick } from "./tick.js";
import { countPending } from "./intake.js";
import type { KbRoots } from "../shared/index.js";

const engine = {
  call: async (step: string, schema: { parse: (v: unknown) => unknown }) => {
    if (step === "classifyToSection") return schema.parse({ section: "NEW", confidence: "low" });
    if (step === "matchSubject") return schema.parse({ match: "new", reason: "different" });
    return schema.parse({ title: "Topic", kind: { type: "fact" }, summary: "s", detail: "d", confidence: "high", facets: {}, properties: {}, proposedRelations: [] });
  },
  usage: { summarize: () => ({}) },
} as unknown as Engine;

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function setup(lane: string): KbRoots {
  const base = mkdtempSync(join(tmpdir(), "kb-writer-"));
  dirs.push(base);
  const roots = { kbBase: join(base, "base"), opsRoot: join(base, "ops"), denLocal: join(base, "den") };
  mkdirSync(join(roots.opsRoot, lane, "w1"), { recursive: true });
  mkdirSync(join(roots.opsRoot, "ledger"), { recursive: true });
  writeFileSync(join(roots.opsRoot, lane, "w1", "t.md"), `---\nfrom: w1\nden_topic_id: t\ncontent_hash: c0de\nprev_hash: null\ndomain_hint: sj\n---\n\n# A title\n\nbody\n`);
  return roots;
}
const ctx = (roots: KbRoots, extra: object = {}) => ({ engine, roots, getEmbedder: () => ({ embed: async () => [1, 0, 0] }), loadEntryVectors: async () => [], ...extra }) as any;
const tree = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).filter((f) => !f.endsWith("cache.jsonl")).sort() : []);

describe("sweep write hook", () => {
  it("the default writer and an explicit pass-through writer give the same result", async () => {
    const a = setup("inbox");
    const b = setup("inbox");
    const calls: string[] = [];
    const spy = Object.fromEntries(Object.entries(defaultSweepWriter).map(([k, fn]) => [k, (...args: unknown[]) => { calls.push(k); return (fn as (...a: unknown[]) => unknown)(...args); }])) as unknown as SweepWriter;
    const ra = await sweep(ctx(a));
    const rb = await sweep(ctx(b, { writer: spy }));
    expect(rb).toEqual(ra);
    expect(ra.created).toBe(1);
    expect(tree(b.kbBase).length).toBe(tree(a.kbBase).length);
    expect(readdirSync(join(b.opsRoot, "receipts", "w1"))).toHaveLength(1);
    expect(readLedger(b).map((e) => (e as { t: string }).t)).toEqual(readLedger(a).map((e) => (e as { t: string }).t));
    // every kind of write went through the hook
    for (const k of ["commitEntry", "appendLedger", "writeSections", "renderDomain", "renderRegistry", "writeReceipt", "markProcessed", "gitCommit"]) expect(calls).toContain(k);
  });

  it("reads another lane and leaves the item in place when a writer throws", async () => {
    const r = setup("contributions");
    const boom: SweepWriter = { ...defaultSweepWriter, commitEntry: () => { throw new Error("conflict"); } };
    const res = await sweep(ctx(r, { lane: "contributions", writer: boom }));
    expect(res.errors).toBe(1);
    expect(res.failures[0].reason).toContain("conflict");
    expect(countPending(r.opsRoot, { lane: "contributions" }).total).toBe(1);
    expect(existsSync(join(r.opsRoot, "receipts"))).toBe(false);
    const ok = await sweep(ctx(r, { lane: "contributions" }));
    expect(ok.created).toBe(1);
    expect(existsSync(join(r.opsRoot, "contributions", "w1", "_processed", "t.md"))).toBe(true);
  });
});

describe("curator lease", () => {
  it("is exclusive, re-entrant for the same owner, and stale by age or dead pid", () => {
    const d = mkdtempSync(join(tmpdir(), "kb-lease-"));
    dirs.push(d);
    const h = acquireLease([d], "hub")!;
    expect(h).toBeTruthy();
    expect(freshLease(d)?.owner).toBe("hub");
    expect(freshLeaseIn([d], "wolf")).toBeNull();
    // another process' lease is refused while fresh
    writeFileSync(leaseFile(d), JSON.stringify({ owner: "wolf", pid: process.pid + 99999, host: "elsewhere", at: "x" }));
    expect(acquireLease([d], "hub")).toBeNull();
    // stale by age
    const old = new Date(Date.now() - LEASE_STALE_MS - 1000);
    utimesSync(leaseFile(d), old, old);
    expect(freshLease(d)).toBeNull();
    const h2 = acquireLease([d], "hub")!;
    expect(h2).toBeTruthy();
    h2.release();
    expect(existsSync(leaseFile(d))).toBe(false);
    // dead pid on the same host is stale at once
    writeFileSync(leaseFile(d), JSON.stringify({ owner: "wolf", pid: 2147483000, host: require("node:os").hostname(), at: "x" }));
    expect(freshLease(d)).toBeNull();
    h.release();
  });

  it("a wolf-side tick skips while a fresh hub lease exists, and holds a wolf lease while it runs", async () => {
    const r = setup("inbox");
    const hub = acquireLease([join(r.opsRoot, "contributions")], "hub")!;
    const skipped = await runSweepTick({ roots: r, createEngine: () => engine });
    expect(skipped.outcome).toBe("idle");
    expect(countPending(r.opsRoot).total).toBe(1);
    hub.release();
    let seen: string | undefined;
    const ran = await runSweepTick({ roots: r, createEngine: () => engine, getEmbedder: () => ({ embed: async () => [1, 0, 0], shouldCompact: () => false, compact: () => 0 }) as any, notePoster: null, notify: () => { seen ??= freshLease(join(r.opsRoot, "inbox"))?.owner; } });
    expect(ran.outcome).toBe("ran");
    expect(seen).toBe("wolf");
    expect(existsSync(leaseFile(join(r.opsRoot, "inbox")))).toBe(false);
  });

  it("intake ignores the lease dotfile", () => {
    const r = setup("inbox");
    writeFileSync(join(r.opsRoot, "inbox", ".sweep-lease"), "{}");
    expect(countPending(r.opsRoot).total).toBe(1);
    expect(readFileSync(join(r.opsRoot, "inbox", ".sweep-lease"), "utf-8")).toBe("{}");
  });
});
