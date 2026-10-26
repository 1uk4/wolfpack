/** The shared sweep host keeps what createWolfHarness did inline: same manager options, same timer behaviour. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelTable } from "@wolfpack/engine";
import { getSweepManager, type SweepManager } from "./sweep-worker.js";
import { parseInterval, startLibrarianSweep, startSweepTimer } from "./sweep-host.js";

afterEach(() => vi.useRealTimers());

describe("parseInterval", () => {
  it("units, and the 4h fallback for junk", () => {
    expect(parseInterval("30s")).toBe(30_000);
    expect(parseInterval("1m")).toBe(60_000);
    expect(parseInterval("4h")).toBe(14_400_000);
    expect(parseInterval("1d")).toBe(86_400_000);
    expect(parseInterval("soon")).toBe(14_400_000);
  });
});

describe("startLibrarianSweep", () => {
  it("builds the manager from the KB roots + table + env (embed url/model, api key) and registers the singleton", () => {
    const logs: string[] = [];
    const table = { transport: "subscription" } as unknown as ModelTable;
    const m = startLibrarianSweep({
      roots: { kbBase: "/s/kb-base", opsRoot: "/s/ops", denLocal: "/s/den/kb" },
      table,
      env: { WOLFPACK_EMBED_URL: "http://127.0.0.1:11434", WOLFPACK_EMBED_MODEL: "nomic-embed-text", ANTHROPIC_API_KEY: "k" },
      log: (l) => logs.push(l),
    });
    expect(logs).toEqual(["[librarian] Sweep manager initialized"]);
    expect(getSweepManager()).toBe(m);
    expect((m as unknown as { config: Record<string, unknown> }).config).toEqual({
      kbBase: "/s/kb-base", kbOps: "/s/ops", denLocal: "/s/den/kb",
      embedUrl: "http://127.0.0.1:11434", embedModel: "nomic-embed-text", models: table, apiKey: "k",
    });
  });
});

describe("startSweepTimer", () => {
  const fake = (running: boolean, started = true) => {
    const start = vi.fn(async () => (started ? { started: true } : { started: false, reason: "paused" }));
    return { isRunning: () => running, start } as unknown as SweepManager & { start: typeof start };
  };

  it("fires every interval, logs the schedule, starts a sweep", async () => {
    vi.useFakeTimers();
    const logs: string[] = [];
    const m = fake(false);
    const t = startSweepTimer(m, "1m", (l) => logs.push(l));
    expect(logs).toEqual(["[librarian] Sweep timer: every 1m"]);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(m.start).toHaveBeenCalledTimes(2);
    clearInterval(t);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(m.start).toHaveBeenCalledTimes(2);
  });

  it("skips the tick while a sweep is running, and logs when a start is declined", async () => {
    vi.useFakeTimers();
    const logs: string[] = [];
    const busy = fake(true);
    const t1 = startSweepTimer(busy, "1m", (l) => logs.push(l));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(busy.start).not.toHaveBeenCalled();
    expect(logs).toContain("[librarian] Sweep already running, skipping timer trigger");
    clearInterval(t1);
    const declined = fake(false, false);
    const t2 = startSweepTimer(declined, "1m", (l) => logs.push(l));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(logs).toContain("[librarian] Sweep not started: paused");
    clearInterval(t2);
  });
});
