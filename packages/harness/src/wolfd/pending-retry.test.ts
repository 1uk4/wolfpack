import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPendingRetry } from "./pending-retry.js";

let den: string;
const stateFile = () => join(den, ".memory", "pool", "work-state.json");
const NOW = 10_000_000;
const entry = (o: object = {}) => ({ firstPendingAt: 1000, tries: 1, nextAttemptAt: NOW - 1, cause: "work-api-unavailable", ...o });
const write = (o: object) => writeFileSync(stateFile(), JSON.stringify(o));
beforeEach(() => {
  den = mkdtempSync(join(tmpdir(), "pending-retry-"));
  mkdirSync(join(den, ".memory", "pool"), { recursive: true });
});
afterEach(() => rmSync(den, { recursive: true, force: true }));

const make = (o: Partial<Parameters<typeof startPendingRetry>[0]> = {}) => {
  const retry = vi.fn(async () => undefined);
  const log = vi.fn();
  const r = startPendingRetry({ den, readLive: async () => new Set(["k"]), retry, log, now: () => NOW, ...o });
  return { ...r, retry, log };
};

describe("pending save retry timer", () => {
  it("runs a due retry without any consolidation trigger, and leaves a key still in backoff alone", async () => {
    write({ k: entry() });
    const due = make();
    await due.tick();
    due.stop();
    expect(due.retry).toHaveBeenCalledTimes(1);

    write({ k: entry({ nextAttemptAt: NOW + 60_000 }) });
    const waiting = make();
    await waiting.tick();
    waiting.stop();
    expect(waiting.retry).not.toHaveBeenCalled();
  });

  it("drops a key with no observations and says so, without retrying for it", async () => {
    write({ gone: entry() });
    const t = make();
    await t.tick();
    t.stop();
    expect(JSON.parse(readFileSync(stateFile(), "utf-8"))).toEqual({});
    expect(t.log).toHaveBeenCalledWith("memory: dropped pending save for gone (no observations)");
    expect(t.retry).not.toHaveBeenCalled();
  });

  it("drops an archived item's key with a note", async () => {
    write({ k: entry() });
    const t = make({ isArchived: async () => true });
    await t.tick();
    t.stop();
    expect(t.log).toHaveBeenCalledWith("memory: dropped pending save for k (item archived)");
    expect(t.retry).not.toHaveBeenCalled();
  });

  it("an unreachable hub is a quiet retry: the tick does not throw and the key stays", async () => {
    write({ k: entry() });
    const t = make({ retry: async () => { throw new Error("ECONNREFUSED"); }, isArchived: async () => { throw new Error("ECONNREFUSED"); } });
    await expect(t.tick()).resolves.toBeUndefined();
    t.stop();
    expect(Object.keys(JSON.parse(readFileSync(stateFile(), "utf-8")))).toEqual(["k"]);
  });
});
