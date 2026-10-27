/**
 * Dewey's sweep events and the pipeline route through a real librarian wolfd: a sandbox with a KB copy, a contribution in
 * its inbox, the real sweep tick with a stubbed LLM engine and embedder (the `sweepTick` seam), observed on the wolf's
 * event stream and `GET /v1/wolves/:name/kb/pipeline`. The "live" KB is hashed before and after.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Engine } from "@wolfpack/engine";
import { takeSnapshot } from "@wolfpack/engine";
import { startLocalWorkServer } from "@wolfpack/agent";
import { runSweepTick, type CachedEmbedder } from "@wolfpack/kb/librarian";
import { KbPipelineResponseSchema, MemoryEventSchema, type MemoryEvent } from "@wolfpack/protocol";
import { ProtocolError } from "@wolfpack/client";
import { fauxAssistantMessage } from "../../packages/harness/src/wolfd/scripted-model.js";
import { startTestWolf, type TestWolf } from "../../packages/harness/src/wolfd/test-wolf.js";
import { getSweepManager } from "../../packages/harness/src/sweep-worker.js";

const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), `kbev-${p}-`));
  dirs.push(d);
  return d;
};
let tw: TestWolf | undefined;
const aborts: AbortController[] = [];
afterEach(async () => {
  for (const a of aborts.splice(0)) a.abort();
  await tw?.stop();
  tw = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const opinion = (title: string) => ({ title, kind: { type: "fact" }, summary: `${title} summary`, detail: `${title} detail`, confidence: "high", facets: {}, properties: {}, proposedRelations: [] });
const engine = {
  call: async (step: string, schema: { parse: (v: unknown) => unknown }) => {
    if (step === "classifyToSection") return schema.parse({ section: "NEW", confidence: "low" });
    return schema.parse(opinion("Caching"));
  },
  usage: { summarize: () => ({}) },
} as unknown as Engine;
const embedder = { embed: async () => [1, 0, 0], compact: () => 0, shouldCompact: () => false } as unknown as CachedEmbedder;

function hashTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out[p] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

async function liveAndDev(): Promise<{ live: string; dev: string }> {
  const live = tmp("live");
  const work = join(live, "work");
  const srv = await startLocalWorkServer({ ledgerDir: work, token: "live-fixture" });
  await srv.close();
  mkdirSync(join(live, "ops"), { recursive: true });
  mkdirSync(join(live, "den"), { recursive: true });
  const kbBaseDir = join(live, "kbbase");
  mkdirSync(join(kbBaseDir, "domains/wolfpack/entries"), { recursive: true });
  writeFileSync(join(kbBaseDir, "domains.yaml"), "domains:\n  wolfpack: {}\n");
  const dev = join(tmp("dev"), "snap");
  takeSnapshot({ source: { workDir: work, workBaseDir: join(work, "base"), opsDir: join(live, "ops"), denDir: join(live, "den"), kbBaseDir }, devRoot: dev });
  return { live, dev };
}

async function startWolf(dev: string, librarian: boolean): Promise<TestWolf> {
  tw = await startTestWolf({
    script: [fauxAssistantMessage("ok")],
    yaml: `sandbox:\n  root: ${dev}\nmemory:\n  librarian: ${librarian}\n  sweepInterval: 1d\n`,
    sweepTick: (o) => runSweepTick({ ...o, createEngine: () => engine, getEmbedder: () => embedder, notePoster: null }),
  });
  return tw;
}

function collect(t: TestWolf): MemoryEvent[] {
  const events: MemoryEvent[] = [];
  const ctl = new AbortController();
  aborts.push(ctl);
  (async () => {
    for await (const e of t.client.watchMemory!("testwolf", { signal: ctl.signal })) events.push(e);
  })().catch(() => {});
  return events;
}
async function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}
const sweepOnce = async () => {
  const mgr = getSweepManager()!;
  await mgr.start();
  while (mgr.isRunning()) await new Promise((r) => setTimeout(r, 10));
};
const types = (evs: MemoryEvent[]) => evs.map((e) => e.type);

const contribution = (topic: string, domain = "wolfpack") =>
  `---\nfrom: w1\nden_topic_id: ${topic}\nchange: create\ncontent_hash: ${Buffer.from(topic).toString("hex")}\nprev_hash: null\ndomain_hint: ${domain}\nsubmitted: 2026-10-26T01:00:00Z\n---\n\n# ${topic}\n\nSessions are cached for five minutes.\n`;

describe("Dewey events + pipeline on a librarian wolfd", { timeout: 30_000 }, () => {
  it("a sweep emits started / item / finished, persists the last run across an idle tick, and the pipeline route reflects it", async () => {
    const { live, dev } = await liveAndDev();
    const liveBefore = hashTree(live);
    const t = await startWolf(dev, true);
    const ops = join(dev, "ops");
    mkdirSync(join(ops, "inbox", "w1"), { recursive: true });
    writeFileSync(join(ops, "inbox", "w1", "caching.md"), contribution("caching"));
    writeFileSync(join(ops, "inbox", "w1", "stuck.md"), contribution("stuck", ""));
    const events = collect(t);
    await new Promise((r) => setTimeout(r, 100));

    // Before any sweep: the lane shows both waiting, no last run.
    const before = await t.client.getKbPipeline!("testwolf");
    expect(before.lanes).toEqual([{ wolf: "w1", pending: 2, oldestAgeMs: expect.any(Number) }]);
    expect(before.sweep.last).toBeUndefined();

    await sweepOnce();
    await waitFor(() => types(events).includes("sweep_finished"));
    expect(types(events)).toEqual(["sweep_started", "sweep_item", "sweep_finished"]);
    expect(events[0]).toMatchObject({ type: "sweep_started", wolf: "testwolf", pending: 2 });
    expect(events[1]).toMatchObject({ type: "sweep_item", from: "w1", outcome: "create", entryId: expect.stringMatching(/^kb-wolfpack-/) });
    expect(events[2]).toMatchObject({ type: "sweep_finished", processed: 1, created: 1, merged: 0, rejected: 0, parked: 0, remaining: 1 });
    for (const e of events) expect(MemoryEventSchema.safeParse(e).success).toBe(true);
    const entryId = (events[1] as { entryId: string }).entryId;

    // The second item has no domain: it parks at once (one item per tick).
    await sweepOnce();
    await waitFor(() => types(events).filter((x) => x === "sweep_finished").length === 2);
    expect(events.slice(3).map((e) => e.type)).toEqual(["sweep_started", "sweep_item", "sweep_finished"]);
    expect(events[4]).toMatchObject({ denTopicId: "stuck", outcome: "parked" });
    expect(events[5]).toMatchObject({ parked: 1, remaining: 0 });

    // The last sweep is on disk, and an idle tick (nothing in the inbox) leaves it, emits nothing, and keeps the status.
    const lastFile = join(t.wolf.config.den, "kb", "sweep-last.json");
    expect(existsSync(lastFile)).toBe(true);
    const saved = readFileSync(lastFile, "utf8");
    expect(JSON.parse(saved)).toMatchObject({ parked: 1, remaining: 0 });
    const count = events.length;
    await sweepOnce();
    await new Promise((r) => setTimeout(r, 150));
    expect(events.length).toBe(count);
    expect(readFileSync(lastFile, "utf8")).toBe(saved);
    const status = getSweepManager()!.getStatus();
    expect(status.state).toBe("idle");
    expect(status.completedAt).toBe(JSON.parse(saved).finishedAt);
    expect(status.result).toMatchObject({ parked: 1 });

    // The pipeline route.
    const p = await t.client.getKbPipeline!("testwolf");
    expect(KbPipelineResponseSchema.safeParse(p).success).toBe(true);
    expect(p.lanes).toEqual([{ wolf: "w1", pending: 0 }]);
    expect(p.receipts.map((r) => [r.denTopicId, r.outcome]).sort()).toEqual([["caching", "create"], ["stuck", "parked"]]);
    expect(p.receipts.find((r) => r.denTopicId === "caching")).toMatchObject({ wolf: "w1", entryId });
    expect(p.parked).toMatchObject([{ wolf: "w1", file: "stuck.md", denTopicId: "stuck" }]);
    expect(p.sweep.current).toBeUndefined();
    expect(p.sweep.last).toMatchObject({ parked: 1, remaining: 0 });

    // Everything stayed in the sandbox.
    expect(hashTree(live)).toEqual(liveBefore);
  });

  it("a non-librarian wolf answers kb_unavailable (409), not not_found", async () => {
    const { dev } = await liveAndDev();
    const t = await startWolf(dev, false);
    const res = await fetch(`${t.url}/v1/wolves/testwolf/kb/pipeline`, { headers: { "X-Protocol-Version": "1" } });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "kb_unavailable" });
    await expect(t.client.getKbPipeline!("testwolf")).rejects.toMatchObject({ code: "kb_unavailable" });
    await expect(t.client.getKbPipeline!("testwolf")).rejects.toBeInstanceOf(ProtocolError);
  });
});
