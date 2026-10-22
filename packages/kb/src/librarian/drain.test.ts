import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SWEEP, type Engine } from "@wolfpack/engine";
import { runSweepTick } from "./tick.js";
import { noteInfraFailure } from "./backoff.js";
import { drainFile, readDrain } from "./drain.js";
import type { KbRoots } from "../shared/index.js";

vi.mock("./reorg.js", () => ({
  reorg: vi.fn(async (opts: { domains?: string[] }) => ({
    splits: 0, merges: 0, crystallized: 0, placements: 0, labelsUpdated: 0, domains: opts.domains ?? [],
  })),
}));

const opinion = {
  title: "Same",
  kind: { type: "fact" },
  summary: "Same summary",
  detail: "Same detail",
  confidence: "high",
  facets: {},
  properties: {},
  proposedRelations: [],
};

describe("inbox drained message", () => {
  let base: string;
  let roots: KbRoots;
  const inbox = () => join(roots.opsRoot, "inbox", "w1");
  const hashOf = (name: string) => Buffer.from(name).toString("hex");
  const drop = (name: string, submitted: string) =>
    writeFileSync(
      join(inbox(), `${name}.md`),
      `---\nfrom: w1\nden_topic_id: ${name}\nchange: create\ncontent_hash: ${hashOf(name)}\nprev_hash: null\ndomain_hint: wp\nsubmitted: ${submitted}\n---\n\n# ${name}\n\n${name} body\n`
    );

  let junk: boolean;
  const engine = {
    call: vi.fn(async (step: string, schema: { parse: (v: unknown) => unknown }) => {
      if (step === "classifyToSection") return schema.parse({ section: "NEW", confidence: "low" });
      if (junk) throw new Error("model returned junk");
      return schema.parse(opinion);
    }),
    usage: { summarize: () => ({}) },
  } as unknown as Engine;
  const alerts: string[] = [];
  // Each call stands for one tick; the state file is the only thing carried over,
  // as with a fresh CLI process.
  const tick = () => runSweepTick({ roots, createEngine: () => engine, notify: () => {}, alert: (m) => void alerts.push(m), budgetMs: 1000 });
  const drained = () => alerts.filter((a) => a.includes("inbox drained"));

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "kb-drain-"));
    roots = { kbBase: join(base, "base"), opsRoot: join(base, "ops"), denLocal: join(base, "den") };
    mkdirSync(inbox(), { recursive: true });
    mkdirSync(join(roots.kbBase, "domains", "wp", "entries"), { recursive: true });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ embedding: [1, 0, 0] }))));
    junk = false;
    alerts.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(base, { recursive: true, force: true });
  });

  it("an idle tick with nothing accumulated is silent and writes nothing", async () => {
    expect((await tick()).outcome).toBe("idle");
    expect(alerts).toEqual([]);
    expect(existsSync(drainFile(roots))).toBe(false);
  });

  it("sends one message on the tick that empties the inbox, then resets", async () => {
    drop("a", "2026-10-10T01:00:00Z");
    drop("b", "2026-10-10T02:00:00Z");
    drop("c", "2026-10-10T03:00:00Z");
    await tick();
    await tick();
    expect(alerts).toEqual([]);
    const mid = readDrain(roots)!;
    expect(mid.created + mid.merged).toBe(2);
    await tick();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/^sweep: inbox drained — 3 processed \(\d merged, \d created, 0 parked, 0 failed\) since \d\d:\d\d$/);
    const m = /\((\d) merged, (\d) created/.exec(alerts[0])!;
    expect(Number(m[1]) + Number(m[2])).toBe(3);
    expect(existsSync(drainFile(roots))).toBe(false);

    // Reset: further idle ticks stay silent.
    await tick();
    await tick();
    expect(alerts).toHaveLength(1);
  });

  it("a single-item backlog still gets the message", async () => {
    drop("solo", "2026-10-10T01:00:00Z");
    await tick();
    expect(drained()).toHaveLength(1);
    expect(alerts[0]).toContain("1 processed");
  });

  it("counts a parked item, and only drains once it has left the inbox", async () => {
    junk = true;
    drop("x", "2026-10-10T01:00:00Z");
    for (let i = 0; i < SWEEP.maxAttempts; i++) await tick();
    expect(alerts.filter((a) => a.startsWith("sweep: parked"))).toHaveLength(1);
    expect(drained()).toHaveLength(1);
    expect(drained()[0]).toMatch(/1 parked/);
    // The drain message is the last one: nothing went out while the item was only failing.
    expect(alerts[alerts.length - 1]).toBe(drained()[0]);
  });

  it("a tick skipped by backoff does not drain; the message waits for recovery", async () => {
    drop("a", "2026-10-10T01:00:00Z");
    drop("b", "2026-10-10T02:00:00Z");
    await tick();
    await noteInfraFailure(roots, new Error("Overloaded"));
    alerts.length = 0;
    expect((await tick()).outcome).toBe("backoff");
    expect(alerts).toEqual([]);
    expect(readDrain(roots)).not.toBeNull();

    // Recovery: the window is over, the last item runs, the queue is empty.
    rmSync(join(roots.opsRoot, "sweep-backoff.json"));
    await tick();
    expect(drained()).toHaveLength(1);
    expect(drained()[0]).toContain("2 processed");
  });

  it("reads the tally from the state file, as a fresh process would", async () => {
    writeFileSync(
      drainFile(roots),
      JSON.stringify({ merged: 5, created: 2, parked: 0, failed: 0, unclassified: 0, rejected: 0, since: "2026-10-10T19:03:00" })
    );
    await tick();
    expect(alerts).toEqual(["sweep: inbox drained — 7 processed (5 merged, 2 created, 0 parked, 0 failed) since 19:03"]);
    expect(existsSync(drainFile(roots))).toBe(false);
  });
});
