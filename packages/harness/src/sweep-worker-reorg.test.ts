import { describe, it, expect, afterEach, vi } from "vitest";
import type { ModelTable } from "@wolfpack/engine";

// The tick is held mid-reorg so the manager's status can be inspected there.
const gate = vi.hoisted(() => ({ release: () => {}, reached: () => {} }));
vi.mock("@wolfpack/kb/librarian", async (orig) => {
  const m = await orig<typeof import("@wolfpack/kb/librarian")>();
  return {
    ...m,
    runSweepTick: vi.fn(async (opts: { notify?: (msg: string) => void }) => {
      opts.notify?.("Running post-sweep reorg check...");
      gate.reached();
      await new Promise<void>((r) => (gate.release = r));
      return {
        outcome: "ran",
        sweep: { processed: 1, created: 1, merged: 0, rejected: 0, parked: [], remaining: 0, failures: [], errors: 0, unclassified: 0, touchedDomains: ["wp"] },
      };
    }),
  };
});

import { SweepManager } from "./sweep-worker.js";

describe("SweepManager during the post-sweep reorg", () => {
  afterEach(() => vi.restoreAllMocks());

  it("stays running, with progress visible, until the whole tick (reorg included) finishes", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const mgr = new SweepManager({
      kbBase: "/nope/kb",
      kbOps: "/nope/ops",
      denLocal: "/nope/den",
      models: { tiers: { smart: { provider: "anthropic", model: "x" } } } as unknown as ModelTable,
    });
    const atReorg = new Promise<void>((r) => (gate.reached = r));
    await mgr.start();
    await atReorg;

    expect(mgr.isRunning()).toBe(true);
    expect(mgr.getStatus()).toMatchObject({ state: "running", progress: "Running post-sweep reorg check..." });
    expect((await mgr.start()).started).toBe(false);

    gate.release();
    while (mgr.isRunning()) await new Promise((r) => setTimeout(r, 5));
    expect(mgr.getStatus()).toMatchObject({ state: "completed", result: { processed: 1, created: 1 } });
  });
});
