import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, appendFileSync, writeFileSync, renameSync, readFileSync, mkdirSync, truncateSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { appendLedger, readLedger, readLedgerAsync, invalidateLedgerCache } from "./ledger.js";
import { ev, ledgerFile, type KbEvent, type KbRoots } from "../shared/index.js";

describe("readLedgerAsync", () => {
  let base: string;
  let roots: KbRoots;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "kb-ledger-async-"));
    roots = { kbBase: join(base, "base"), opsRoot: join(base, "ops"), denLocal: join(base, "den") };
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const batch = (from: number, n: number): KbEvent[] =>
    Array.from({ length: n }, (_, i) => ev.entryWritten(`kb-wp-E${from + i}`, `kb-wp-T${(from + i) % 50}`, "create"));

  it("reads a 20k-event ledger equal to the sync read while the event loop keeps answering", async () => {
    appendLedger(roots, batch(0, 20000));
    let probes = 0;
    let running = true;
    const probe = () => {
      if (!running) return;
      probes++;
      setImmediate(probe);
    };
    setImmediate(probe);
    const got = await readLedgerAsync(roots);
    running = false;
    expect(got).toEqual(readLedger(roots));
    expect(got).toHaveLength(20000);
    // the read yielded to the loop repeatedly instead of parsing in one block
    expect(probes).toBeGreaterThanOrEqual(3);
  });

  it("stays correct for simultaneous calls over appended data", async () => {
    appendLedger(roots, batch(0, 3));
    await readLedgerAsync(roots);
    appendLedger(roots, batch(3, 4000));
    const [a, b] = await Promise.all([readLedgerAsync(roots), readLedgerAsync(roots)]);
    const want = readLedger(roots);
    expect(a).toEqual(want);
    expect(b).toEqual(want);
    expect(await readLedgerAsync(roots)).toEqual(want);
  });

  it("returns [] for a missing ledger", async () => {
    expect(await readLedgerAsync(roots)).toEqual([]);
  });

  it("refuses caller mutation of the shared result, so it cannot leak into the next read", async () => {
    appendLedger(roots, batch(0, 3));
    const first = await readLedgerAsync(roots);
    expect(() => first.pop()).toThrow();
    expect(await readLedgerAsync(roots)).toHaveLength(3);
    const again = await readLedgerAsync(roots);
    expect(() => { (again[0] as { t: string }).t = "x"; }).toThrow();
  });

  it("parses a final line with no trailing newline when it is valid JSON, holds it while torn", async () => {
    const [e0, e1] = batch(0, 2).map((e) => JSON.stringify(e));
    mkdirSync(dirname(ledgerFile(roots)), { recursive: true });
    writeFileSync(ledgerFile(roots), e0 + "\n" + e1);
    expect(await readLedgerAsync(roots)).toEqual(readLedger(roots));
    expect(await readLedgerAsync(roots)).toHaveLength(2);
    appendFileSync(ledgerFile(roots), "\n");
    expect(await readLedgerAsync(roots)).toHaveLength(2);
    const e2 = JSON.stringify(batch(2, 1)[0]);
    appendFileSync(ledgerFile(roots), e2.slice(0, 15));
    expect(await readLedgerAsync(roots)).toHaveLength(2);
    appendFileSync(ledgerFile(roots), e2.slice(15));
    expect(await readLedgerAsync(roots)).toHaveLength(3);
  });

  it("re-reads when the file is replaced by rename (new inode)", async () => {
    appendLedger(roots, batch(0, 5));
    await readLedgerAsync(roots);
    const tmp = ledgerFile(roots) + ".new";
    writeFileSync(tmp, batch(100, 8).map((e) => JSON.stringify(e)).join("\n") + "\n");
    renameSync(tmp, ledgerFile(roots));
    const got = await readLedgerAsync(roots);
    expect(got).toEqual(readLedger(roots));
    expect(got).toHaveLength(8);
  });

  it("re-reads a same-inode rewrite that ends up longer than the cached offset", async () => {
    appendLedger(roots, batch(0, 3));
    await readLedgerAsync(roots);
    const len = readFileSync(ledgerFile(roots)).length;
    writeFileSync(ledgerFile(roots), batch(200, 10).map((e) => JSON.stringify(e)).join("\n") + "\n");
    expect(readFileSync(ledgerFile(roots)).length).toBeGreaterThan(len);
    const got = await readLedgerAsync(roots);
    expect(got).toEqual(readLedger(roots));
    expect(got).toHaveLength(10);
  });

  it("picks up appended events, holds a torn last line back until complete, and re-reads after a rewrite", async () => {
    appendLedger(roots, batch(0, 3));
    expect(await readLedgerAsync(roots)).toHaveLength(3);
    appendLedger(roots, batch(3, 2));
    expect(await readLedgerAsync(roots)).toEqual(readLedger(roots));

    const whole = JSON.stringify(batch(5, 1)[0]);
    appendFileSync(ledgerFile(roots), whole.slice(0, 20));
    expect(await readLedgerAsync(roots)).toHaveLength(5);
    appendFileSync(ledgerFile(roots), whole.slice(20) + "\n");
    expect(await readLedgerAsync(roots)).toHaveLength(6);

    // compaction: the file is rewritten smaller
    writeFileSync(ledgerFile(roots), batch(100, 2).map((e) => JSON.stringify(e)).join("\n") + "\n");
    const after = await readLedgerAsync(roots);
    expect(after).toEqual(readLedger(roots));
    expect(after).toHaveLength(2);
  });

  it("re-reads after an in-place truncate and re-append that leaves the file longer than the cached offset, once invalidated as the rollback does", async () => {
    const line = (id: string) => JSON.stringify(ev.entryWritten(id, "kb-wp-T1", "create")) + "\n";
    const sameTail = line("kb-wp-Same001");
    mkdirSync(dirname(ledgerFile(roots)), { recursive: true });
    writeFileSync(ledgerFile(roots), line("kb-wp-Old0001") + sameTail);
    expect(await readLedgerAsync(roots)).toHaveLength(2);
    // rollback cuts the same inode back; later appends differ in the first line but end with the same bytes
    truncateSync(ledgerFile(roots), 0);
    writeFileSync(ledgerFile(roots), line("kb-wp-New0001") + sameTail + line("kb-wp-More001"));
    invalidateLedgerCache(roots);
    const got = await readLedgerAsync(roots);
    expect(got).toEqual(readLedger(roots));
    expect(got).toHaveLength(3);
    expect(JSON.stringify(got[0])).toContain("kb-wp-New0001");
  });
});

describe("appendLedger", () => {
  let base: string;
  let roots: KbRoots;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "kb-ledger-"));
    roots = { kbBase: join(base, "base"), opsRoot: join(base, "ops"), denLocal: join(base, "den") };
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("appends valid events", () => {
    appendLedger(roots, [ev.entryWritten("kb-wp-AbC1234", "kb-wp-AbC1234", "create")]);
    expect(readLedger(roots)).toHaveLength(1);
  });

  it("writes nothing when any event is invalid, naming the bad field", () => {
    const good = ev.entryWritten("kb-wp-AbC1234", "kb-wp-AbC1234", "create");
    const bad = { ...ev.entryWritten("kb-wp-AbC1234", "kb-wp-AbC1234", "create"), action: "explode" } as unknown as KbEvent;
    expect(() => appendLedger(roots, [good, bad])).toThrow(/Invalid entry_written ledger event — action:/);
    expect(readLedger(roots)).toHaveLength(0);
  });

  it("skips garbage and torn lines with a warning naming the line, and reads the rest", () => {
    appendLedger(roots, [ev.entryWritten("kb-wp-AbC1234", "kb-wp-AbC1234", "create")]);
    appendFileSync(ledgerFile(roots), "{not json\n{\"t\":\"entry_wri");
    appendFileSync(ledgerFile(roots), "\n");
    appendLedger(roots, [ev.entryWritten("kb-wp-Def5678", "kb-wp-Def5678", "create")]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(readLedger(roots)).toHaveLength(2);
      const msgs = warn.mock.calls.map((c) => String(c[0]));
      expect(msgs.some((m) => m.includes("line 2"))).toBe(true);
      expect(msgs.some((m) => m.includes("line 3"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
