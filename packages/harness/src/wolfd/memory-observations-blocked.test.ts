import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMemoryObservations, resetObservationProbeCache } from "./memory-read.js";

const T0 = Date.parse("2026-10-26T10:00:00Z");
let den: string;
beforeEach(() => {
  resetObservationProbeCache();
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

  it("caches the probe for 30 s", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 404 }));
    vi.stubGlobal("fetch", f);
    const api = { endpoint: "http://x", token: "t" };
    await readMemoryObservations(den, undefined, api, 1_000_000);
    await readMemoryObservations(den, undefined, api, 1_020_000);
    expect(f).toHaveBeenCalledTimes(1);
    await readMemoryObservations(den, undefined, api, 1_031_000);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("reports pending counts, the oldest wait, and a model failure as its own cause", async () => {
    writeFileSync(join(den, ".memory", "pool", "work-state.json"), JSON.stringify({ "work-wolfpack-AAAAAAA": { firstPendingAt: T0 + 1_000, tries: 2, nextAttemptAt: 0, cause: "consolidation-failed" } }));
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));
    const r = await readMemoryObservations(den, undefined, { endpoint: "http://x", token: "t" }, T0 + 1_000 + 25 * 3_600_000);
    expect(r.observations.find((o) => o.work)?.blocked).toBe("consolidation-failed");
    expect(r.pending).toEqual({ count: 1, oldestAgeMs: 25 * 3_600_000 });
  });

  it("flags nothing for a pool with no tagged observations", async () => {
    writeFileSync(join(den, ".memory", "pool", "observations.jsonl"), JSON.stringify({ timestamp: "t", recordedAt: "r", content: "c" }) + "\n");
    expect((await readMemoryObservations(den, undefined, {})).blocked).toBeUndefined();
  });

  it("ignores an orphan entry older than the observations: nothing blocked, no pending notice", async () => {
    writeFileSync(join(den, ".memory", "pool", "work-state.json"), JSON.stringify({ "work-wolfpack-AAAAAAA": { firstPendingAt: T0 - 3_600_000, tries: 2, nextAttemptAt: 0, cause: "work-api-unavailable" } }));
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));
    const r = await readMemoryObservations(den, undefined, { endpoint: "http://x", token: "t" }, T0 + 6 * 24 * 3_600_000);
    expect(r.observations.every((o) => o.blocked === undefined)).toBe(true);
    expect(r.pending).toBeUndefined();
  });

  it("an entry under a key the observation is not grouped under does not block it", async () => {
    writeFileSync(join(den, ".memory", "pool", "work-state.json"), JSON.stringify({ "work-wolfpack-ZZZZZZZ": { firstPendingAt: T0 + 1_000, tries: 1, nextAttemptAt: 0, cause: "work-api-unavailable" } }));
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));
    const r = await readMemoryObservations(den, undefined, { endpoint: "http://x", token: "t" }, T0 + 3_600_000);
    expect(r.pending).toBeUndefined();
  });

  it("blocks observations recorded after the key first went pending, naming the feature and who it is assigned to", async () => {
    const rows = [0, 1, 2].map((i) => ({ timestamp: "t", recordedAt: new Date(T0 + i * 3_600_000).toISOString(), content: `o${i}`, work: `work-wolfpack-T${i}`, feature: "work-wolfpack-FFFFFFF" }));
    writeFileSync(join(den, ".memory", "pool", "observations.jsonl"), rows.map((r) => JSON.stringify(r) + "\n").join(""));
    writeFileSync(join(den, ".memory", "pool", "work-state.json"), JSON.stringify({ "work-wolfpack-FFFFFFF": { firstPendingAt: T0 + 1_000, tries: 3, nextAttemptAt: 0, cause: "forbidden", assignee: "hal" } }));
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));
    const r = await readMemoryObservations(den, undefined, { endpoint: "http://x", token: "t" }, T0 + 5 * 3_600_000);
    expect(r.observations.map((o) => o.blocked)).toEqual(["forbidden", "forbidden", "forbidden"]);
    expect(r.observations[0]).toMatchObject({ blockedKey: "work-wolfpack-FFFFFFF", assignee: "hal" });
    expect(r.pending?.count).toBe(3);
  });

  it("ages the warning by the blocked observations, not the oldest state entry", async () => {
    writeFileSync(join(den, ".memory", "pool", "work-state.json"), JSON.stringify({ "work-wolfpack-AAAAAAA": { firstPendingAt: T0 - 5 * 24 * 3_600_000, tries: 2, nextAttemptAt: 0, cause: "work-api-unavailable" } }));
    vi.stubGlobal("fetch", async () => { throw new Error("down"); });
    const r = await readMemoryObservations(den, undefined, { endpoint: "http://x", token: "t" }, T0 + 2 * 3_600_000);
    expect(r.pending).toEqual({ count: 1, oldestAgeMs: 2 * 3_600_000 });
  });
});
