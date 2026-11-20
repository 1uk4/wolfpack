/** wolfd feeds the usage ledger itself: a finished turn triggers an ingest of this wolf's den (the break behind work-wolfpack-2lGbN3k). */
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { createUsageIngester } from "./usage-ingest.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage } from "./scripted-model.js";
import { startTestWolf, type TestWolf } from "./test-wolf.js";

let tw: TestWolf | undefined;
afterEach(async () => {
  await tw?.stop();
  tw = undefined;
});

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("wolfd usage ingest", () => {
  it("ingests this wolf's den once after finished turns, debounced", async () => {
    const calls: Array<{ den: string; wolf: string; ledgerDir: string }> = [];
    tw = await startTestWolf({
      script: [fauxAssistantMessage("one"), fauxAssistantMessage("two")],
      usageIngest: async (o) => void calls.push(o),
      usageIngestDebounceMs: 60,
      usageLedgerDir: "/tmp/ledger-for-test",
    });
    await tw.submit("a");
    await tw.submit("b");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await settle(200);
    expect(calls).toEqual([{ den: join(tw.wolf.config.den), wolf: "testwolf", ledgerDir: "/tmp/ledger-for-test" }]);
  });

  it("logs an ingest failure once and still completes the turn", async () => {
    const lines: string[] = [];
    tw = await startTestWolf({
      script: [fauxAssistantMessage("one")],
      usageIngest: async () => {
        throw new Error("ledger disk full");
      },
      usageIngestDebounceMs: 20,
      log: (l) => lines.push(l),
    });
    const events = await tw.submit("a");
    expect(events.at(-1)).toMatchObject({ type: "turn-end", reason: "complete" });
    await vi.waitFor(() => expect(lines.filter((l) => l.includes("ledger disk full"))).toHaveLength(1));
  });

  it("appends ingest errors and the locked outcome to usage-ingest.log", async () => {
    const logDir = fs.mkdtempSync(join(os.tmpdir(), "usage-log-"));
    try {
      let n = 0;
      const ing = createUsageIngester({
        den: "/d",
        wolf: "w",
        debounceMs: 5,
        logDir,
        log: () => {},
        ingest: async () => {
          if (n++ === 0) throw new Error("ledger disk full");
          return { locked: true };
        },
      });
      const file = join(logDir, "usage-ingest.log");
      ing.trigger();
      await vi.waitFor(() => expect(fs.readFileSync(file, "utf8")).toContain("ledger disk full"));
      ing.trigger();
      await vi.waitFor(() => expect(fs.readFileSync(file, "utf8")).toContain("locked"));
      ing.stop();
    } finally {
      fs.rmSync(logDir, { recursive: true, force: true });
    }
  });
});
