import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendLedger, readLedger } from "./ledger.js";
import { ev, ledgerFile, type KbEvent, type KbRoots } from "../shared/index.js";

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
