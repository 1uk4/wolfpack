import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ingestUsage } from "./ingest.js";
import { readLedger } from "./ledger.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "engine-usage-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const line = (ts: string, output: number): string =>
  JSON.stringify({
    ts,
    wolf: "1uk4",
    source: "engine",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    billing: "api",
    input: 10,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: 0.01,
    costSource: "reported",
  });

describe("ingestUsage scoped to one den", () => {
  it("writes the den's engine records to the ledger and adds only new ones on a re-run", async () => {
    const den = path.join(tmp, "den");
    const ledgerDir = path.join(tmp, "ledger");
    fs.mkdirSync(path.join(den, "usage"), { recursive: true });
    const log = path.join(den, "usage", "2026-11.jsonl");
    fs.writeFileSync(log, line("2026-11-19T10:00:00Z", 1) + "\n" + line("2026-11-19T10:01:00Z", 2) + "\n");
    const opts = {
      ledgerDir,
      wolvesRoot: path.join(tmp, "none"),
      hosts: [],
      dens: [{ den, wolf: "1uk4", host: "local" }],
    };

    const first = await ingestUsage(opts);
    expect(first.added.engine).toBe(2);
    expect(readLedger(ledgerDir)).toHaveLength(2);

    fs.appendFileSync(log, line("2026-11-20T09:00:00Z", 3) + "\n");
    const second = await ingestUsage(opts);
    expect(second.added.engine).toBe(1);
    expect(readLedger(ledgerDir)).toHaveLength(3);
  });
});
