import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendLedger, readLedger } from "./ledger.js";
import { ev, type KbEvent, type KbRoots } from "../shared/index.js";

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
});
