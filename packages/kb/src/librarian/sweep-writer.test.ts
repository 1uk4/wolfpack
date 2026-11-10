import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "@wolfpack/engine";
import { sweep } from "./sweep.js";
import { defaultSweepWriter, type SweepWriter } from "./sweep-writer.js";
import { readLedger } from "./ledger.js";
import { acquireLease, assertNoLiveHub, freshLease, freshLeaseIn, leaseFile, LEASE_STALE_MS, MUTEX_STALE_MS } from "./curator-lease.js";
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

  it("does not append its mid-sweep events to the ledger array the caller handed in", async () => {
    const r = setup("inbox");
    const shared = readLedger(r);
    const res = await sweep(ctx(r, { readLog: () => shared }));
    expect(res.created).toBe(1);
    expect(shared).toEqual([]);
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

  it("a standalone KB write command refuses while a fresh hub lease exists on the roots, and says to use hubd rebuild", () => {
    const r = setup("inbox");
    expect(() => assertNoLiveHub(r)).not.toThrow();
    const hub = acquireLease([join(r.opsRoot, "contributions")], "hub")!;
    expect(() => assertNoLiveHub(r)).toThrow(/use `hubd rebuild`/);
    hub.release();
    expect(() => assertNoLiveHub(r)).not.toThrow();
  });

  it("a standalone KB write command also refuses while the hub's kb-writer lock is held by a live process (curator enabled or not), not by a dead one", () => {
    const r = setup("inbox");
    mkdirSync(join(r.denLocal, "run"), { recursive: true });
    const lock = join(r.denLocal, "run", "kb-writer.lock");
    writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: "x" }));
    expect(() => assertNoLiveHub(r)).toThrow(/use `hubd rebuild`/);
    writeFileSync(lock, JSON.stringify({ pid: 2147483000, startedAt: "x" }));
    expect(() => assertNoLiveHub(r)).not.toThrow();
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

describe("curator lease races", () => {
  const lease = (d: string, o: object = {}) => writeFileSync(leaseFile(d), JSON.stringify({ owner: "wolf", pid: process.pid + 99999, host: "elsewhere", at: "x", ...o }));
  const old = (d: string, ms = LEASE_STALE_MS + 1000) => { const t = new Date(Date.now() - ms); utimesSync(leaseFile(d), t, t); };
  const mk = () => { const d = mkdtempSync(join(tmpdir(), "kb-lease-")); dirs.push(d); return d; };

  it("an empty / unreadable lease is HELD inside the grace period, stale after it (no takeover of a half-written file)", () => {
    const d = mk();
    writeFileSync(leaseFile(d), "");
    expect(acquireLease([d], "hub")).toBeNull();
    expect(readFileSync(leaseFile(d), "utf-8")).toBe("");
    old(d, 60_000);
    const h = acquireLease([d], "hub")!;
    expect(h).toBeTruthy();
    expect(freshLease(d)?.owner).toBe("hub");
    h.release();
  });

  it("the lease is published whole: no empty file is ever visible, and no temp files are left", () => {
    const d = mk();
    const h = acquireLease([d], "hub")!;
    expect(JSON.parse(readFileSync(leaseFile(d), "utf-8")).owner).toBe("hub");
    expect(readdirSync(d).filter((f) => f.includes(".sweep-lease."))).toEqual([]);
    h.release();
  });

  it("two takers interleaved over a stale lease: exactly one wins", () => {
    const d = mk();
    lease(d);
    old(d);
    let inner: ReturnType<typeof acquireLease> | undefined;
    let fired = false;
    // The first taker has judged the lease stale; before it takes over, a second taker runs the whole takeover.
    const first = acquireLease([d], "hub", {
      afterJudgedStale: () => {
        if (fired) return;
        fired = true;
        inner = acquireLease([d], "wolf", { afterJudgedStale: () => undefined });
      },
    });
    expect(inner).toBeTruthy(); // the interleaved taker took the stale lease
    expect(first).toBeNull(); // the first one finds a fresh lease now and does not remove it
    expect(JSON.parse(readFileSync(leaseFile(d), "utf-8"))).toMatchObject({ owner: "wolf", pid: process.pid });
    inner!.release();
    expect(existsSync(leaseFile(d))).toBe(false);
    expect(existsSync(`${leaseFile(d)}.takeover`)).toBe(false);
  });

  it("a held takeover mutex makes the other taker back off, a dead holder's mutex is cleared", () => {
    const d = mk();
    lease(d);
    old(d);
    writeFileSync(`${leaseFile(d)}.takeover`, JSON.stringify({ pid: process.pid, nonce: "n" })); // a live taker is mid-takeover
    expect(acquireLease([d], "hub")).toBeNull();
    expect(JSON.parse(readFileSync(leaseFile(d), "utf-8")).pid).toBe(process.pid + 99999); // untouched
    writeFileSync(`${leaseFile(d)}.takeover`, JSON.stringify({ pid: 2147483000, nonce: "n" })); // a dead one
    expect(acquireLease([d], "hub", { pidAlive: (p) => p !== 2147483000 })).toBeNull(); // this call clears it
    const h = acquireLease([d], "hub")!;
    expect(h).toBeTruthy();
    h.release();
  });

  it("a live-pid mutex older than the stale age is cleared (a crashed taker whose pid was reused)", () => {
    const d = mk();
    lease(d);
    old(d);
    const mf = `${leaseFile(d)}.takeover`;
    writeFileSync(mf, JSON.stringify({ pid: process.pid, nonce: "n" })); // holder pid is alive
    expect(acquireLease([d], "hub")).toBeNull(); // young mutex: back off
    expect(existsSync(mf)).toBe(true);
    const t = new Date(Date.now() - 2 * MUTEX_STALE_MS);
    utimesSync(mf, t, t);
    expect(acquireLease([d], "hub")).toBeNull(); // this call clears it
    expect(existsSync(mf)).toBe(false);
    const h = acquireLease([d], "hub")!;
    expect(h).toBeTruthy();
    h.release();
  });

  it("a heartbeat that lands between the stale judgment and the mutex is not stolen", () => {
    const d = mk();
    lease(d);
    old(d);
    const got = acquireLease([d], "hub", { afterJudgedStale: () => { const t = new Date(); utimesSync(leaseFile(d), t, t); } }); // the holder beats
    expect(got).toBeNull();
    expect(JSON.parse(readFileSync(leaseFile(d), "utf-8")).pid).toBe(process.pid + 99999); // untouched
    expect(existsSync(`${leaseFile(d)}.takeover`)).toBe(false);
  });

  it("re-entry by the same owner takes every dir and the first release keeps the lease", () => {
    const a = mk();
    const b = mk();
    const h1 = acquireLease([a], "wolf")!;
    const h2 = acquireLease([a, b], "wolf")!;
    expect(h2).toBeTruthy();
    expect(existsSync(leaseFile(b))).toBe(true); // the second dir was not skipped
    h1.release();
    expect(existsSync(leaseFile(a))).toBe(true); // still used by h2
    h2.release();
    expect(existsSync(leaseFile(a))).toBe(false);
    expect(existsSync(leaseFile(b))).toBe(false);
    // a different owner in the same process is refused, and nothing is left behind
    const w = acquireLease([a], "wolf")!;
    expect(acquireLease([b, a], "hub")).toBeNull();
    expect(existsSync(leaseFile(b))).toBe(false);
    w.release();
  });

  it("the wolf-side skip is announced once per state change, not every tick", async () => {
    const r = setup("inbox");
    const hub = acquireLease([join(r.opsRoot, "contributions")], "hub")!;
    const notes: string[] = [];
    for (let i = 0; i < 3; i++) await runSweepTick({ roots: r, createEngine: () => engine, notify: (m) => notes.push(m) });
    expect(notes.filter((m) => m.includes("skipped"))).toHaveLength(1);
    hub.release();
    await runSweepTick({ roots: r, createEngine: () => engine, getEmbedder: () => ({ embed: async () => [1, 0, 0], shouldCompact: () => false, compact: () => 0 }) as any, notePoster: null });
    const hub2 = acquireLease([join(r.opsRoot, "contributions")], "hub")!;
    await runSweepTick({ roots: r, createEngine: () => engine, notify: (m) => notes.push(m) });
    expect(notes.filter((m) => m.includes("skipped"))).toHaveLength(2); // announced again after the state changed
    hub2.release();
  });

  it("leaseOwner none: no wolf lease is taken (the caller owns the lease)", async () => {
    const r = setup("inbox");
    const hub = acquireLease([join(r.opsRoot, "contributions")], "hub")!;
    let owner: string | undefined;
    await runSweepTick({ roots: r, createEngine: () => engine, leaseOwner: "none", getEmbedder: () => ({ embed: async () => [1, 0, 0], shouldCompact: () => false, compact: () => 0 }) as any, notePoster: null, notify: () => { owner ??= freshLease(join(r.opsRoot, "inbox"))?.owner; } });
    expect(owner).toBeUndefined();
    hub.release();
  });
});
