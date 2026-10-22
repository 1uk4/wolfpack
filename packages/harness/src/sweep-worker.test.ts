import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ModelTable } from "@wolfpack/engine";

let failWith: Error;
vi.mock("@wolfpack/engine", async (orig) => {
  const m = await orig<typeof import("@wolfpack/engine")>();
  return {
    ...m,
    engineSteps: () => ({ produce: {} }),
    createEngine: () => ({
      call: async (step: string, schema: { parse: (v: unknown) => unknown }) => {
        if (step === "classifyToSection") return schema.parse({ section: "NEW", confidence: "low" });
        throw failWith;
      },
      usage: { summarize: () => ({}) },
    }),
  };
});

import { SweepManager } from "./sweep-worker.js";

describe("SweepManager alerts", () => {
  let base: string;
  let mgr: SweepManager;
  const msgs: string[] = [];
  const inbox = () => join(base, "ops", "inbox", "w1");

  const tick = async () => {
    await mgr.start();
    while (mgr.isRunning()) await new Promise((r) => setTimeout(r, 5));
  };

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "kb-harness-"));
    mkdirSync(inbox(), { recursive: true });
    mkdirSync(join(base, "kb", "domains", "wp", "entries"), { recursive: true });
    writeFileSync(
      join(inbox(), "bad.md"),
      "---\nfrom: w1\nden_topic_id: bad\nchange: create\ncontent_hash: h-bad\nprev_hash: null\ndomain_hint: wp\nsubmitted: 2026-10-10T01:00:00Z\n---\n\n# bad\n\nbody\n"
    );
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ embedding: [1, 0, 0] }))));
    vi.spyOn(console, "log").mockImplementation(() => {});
    msgs.length = 0;
    mgr = new SweepManager(
      {
        kbBase: join(base, "kb"),
        kbOps: join(base, "ops"),
        denLocal: join(base, "den"),
        models: { tiers: { smart: { provider: "anthropic", model: "x" } } } as unknown as ModelTable,
        apiKey: "k",
      },
      (m) => msgs.push(m)
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    rmSync(base, { recursive: true, force: true });
  });

  it("alerts when an item is parked, and sends no per-item or complete chatter", async () => {
    failWith = new Error("model returned junk");
    for (let i = 0; i < 3; i++) await tick();
    expect(readdirSync(inbox()).filter((f) => f.endsWith(".md"))).toEqual([]);
    expect(msgs).toEqual(["sweep: parked w1/bad — failed 3 times: model returned junk"]);
  });

  it("an outage sends one down alert, skips ticks in backoff, and parks nothing", async () => {
    failWith = Object.assign(new Error("Overloaded"), { status: 529 });
    for (let i = 0; i < 4; i++) await tick();
    expect(msgs).toEqual(["sweep paused: Overloaded, retrying with backoff"]);
    expect(readdirSync(inbox()).filter((f) => f.endsWith(".md"))).toEqual(["bad.md"]);
  });
});
