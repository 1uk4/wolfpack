import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMemoryObservations } from "./memory-read.js";

let den: string;
beforeEach(() => {
  den = mkdtempSync(join(tmpdir(), "obs-blocked-"));
  mkdirSync(join(den, ".memory", "pool"), { recursive: true });
  const rows = [
    { timestamp: "2026-10-26 09:00", recordedAt: "2026-10-26T09:00:00Z", content: "den one" },
    { timestamp: "2026-10-26 10:00", recordedAt: "2026-10-26T10:00:00Z", content: "tagged", work: "work-wolfpack-AAAAAAA" },
  ];
  writeFileSync(join(den, ".memory", "pool", "observations.jsonl"), rows.map((r) => JSON.stringify(r) + "\n").join(""));
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(den, { recursive: true, force: true });
});

describe("observations route: blocked on the Work API", () => {
  it("flags the pool and the tagged observations when no Work API is configured", async () => {
    const r = await readMemoryObservations(den, undefined, {});
    expect(r.blocked).toBe("work-api-unavailable");
    expect(r.observations.find((o) => o.work)?.blocked).toBe("work-api-unavailable");
    expect(r.observations.find((o) => !o.work)?.blocked).toBeUndefined();
  });

  it("flags them when the Work API is unreachable", async () => {
    vi.stubGlobal("fetch", async () => { throw new Error("ECONNREFUSED"); });
    const r = await readMemoryObservations(den, undefined, { endpoint: "http://x", token: "t" });
    expect(r.blocked).toBe("work-api-unavailable");
  });

  it("flags nothing when the Work API answers (even not found)", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));
    const r = await readMemoryObservations(den, undefined, { endpoint: "http://x", token: "t" });
    expect(r.blocked).toBeUndefined();
    expect(r.observations.every((o) => o.blocked === undefined)).toBe(true);
  });

  it("flags nothing for a pool with no tagged observations", async () => {
    writeFileSync(join(den, ".memory", "pool", "observations.jsonl"), JSON.stringify({ timestamp: "t", recordedAt: "r", content: "c" }) + "\n");
    expect((await readMemoryObservations(den, undefined, {})).blocked).toBeUndefined();
  });
});
