/**
 * Memory action routes through a real durable wolf over /v1: POST .../memory/consolidate (result) and
 * POST .../memory/promote (202 job id, promote lifecycle on the wolf event stream). The memory Engine is the stubbed
 * `engine.call` seam; KB_BASE/KB_OPS and the sandbox root are temp dirs, and a "live" tree is hashed before/after.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Engine } from "@wolfpack/engine";
import { takeSnapshot } from "@wolfpack/engine";
import { startLocalWorkServer } from "@wolfpack/agent";
import { ConsolidateResponseSchema, ErrorEnvelopeSchema, PROTOCOL_VERSION, type MemoryEvent } from "@wolfpack/protocol";
import { adaptToDurable } from "../../packages/harness/src/adapters/durable.js";
import { fauxAssistantMessage } from "../../packages/harness/src/wolfd/scripted-model.js";
import { startTestWolf, type TestWolf } from "../../packages/harness/src/wolfd/test-wolf.js";
import createMemoryExtension from "./unified.js";

const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), `mroute-${p}-`));
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

const REPLY = "We decided to cache the session lookups for five minutes because the profile endpoint was the hot path.";
const OBS = "Sessions are cached for five minutes because the profile endpoint is the hot path in the load test.";

/** `gate`: distill waits on it (holds a promote open so a second one can collide). */
function stubEngine(gate?: Promise<void>): Engine {
  return {
    call: async (step: string, schema: { parse: (v: unknown) => unknown }) => {
      if (step === "classify") return schema.parse({ observations: [{ timestamp: "2026-10-25 10:00", content: OBS }] });
      if (step === "consolidate") {
        return schema.parse({
          actions: [{ sessionTopicId: "x", action: "create", reasoning: "new", result: { id: "caching", title: "Caching", summary: "Session lookups are cached", body: "Cache session lookups for five minutes." } }],
        });
      }
      if (step === "distill") {
        await gate;
        return schema.parse({ contributions: [{ slug: "main", title: "Caching", summary: "Session lookups are cached", body: "## Details\nCache session lookups." }] });
      }
      throw new Error(`unexpected step ${step}`);
    },
  } as unknown as Engine;
}

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
  const dev = join(tmp("dev"), "snap");
  takeSnapshot({ source: { workDir: work, workBaseDir: join(work, "base"), opsDir: join(live, "ops"), denDir: join(live, "den") }, devRoot: dev });
  return { live, dev };
}

interface Opts {
  sandbox?: boolean;
  kb?: boolean;
  gate?: Promise<void>;
  dev?: string;
}
async function startWolf(opts: Opts = {}): Promise<TestWolf> {
  const sandbox = opts.sandbox ?? true;
  const kbBase = tmp("kb");
  tw = await startTestWolf({
    script: [fauxAssistantMessage(REPLY)],
    yaml: sandbox ? `sandbox:\n  root: ${opts.dev ?? (await liveAndDev()).dev}\n` : "",
    hooks: {
      extensions: ({ config, den, env }) => [
        adaptToDurable(
          createMemoryExtension(
            { ...config.memory, engine: stubEngine(opts.gate) },
            { wolfDen: den, wolfName: "testwolf", domains: ["wolfpack"], wolfConfig: { sandbox: config.sandbox }, env: { ...env, KB_BASE: opts.kb === false ? "" : kbBase } },
          ),
          { wolfDen: den, wolfName: "testwolf" },
        ),
      ],
    },
  });
  return tw;
}

const post = (t: TestWolf, action: "consolidate" | "promote") =>
  fetch(`${t.url}/v1/wolves/testwolf/memory/${action}`, { method: "POST", headers: { "X-Protocol-Version": String(PROTOCOL_VERSION) } });

function collect(t: TestWolf): MemoryEvent[] {
  const events: MemoryEvent[] = [];
  const ctl = new AbortController();
  aborts.push(ctl);
  (async () => {
    for await (const e of t.client.watchMemory!("testwolf", { signal: ctl.signal })) events.push(e);
  })().catch(() => {});
  return events;
}
async function waitFor(cond: () => boolean, ms = 6000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}
const types = (evs: MemoryEvent[]) => evs.map((e) => e.type);

describe("memory action routes", { timeout: 30_000 }, () => {
  it("consolidate returns counts; promote returns a job id and reports its lifecycle once", async () => {
    const { live, dev } = await liveAndDev();
    const liveBefore = hashTree(live);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const t = await startWolf({ dev, gate });
    const events = collect(t);
    await new Promise((r) => setTimeout(r, 100));

    await t.submit("hello");
    await waitFor(() => types(events).includes("observation_captured"));

    // consolidate -> 200, counts + topic ids, no text; session topics exist
    const c = await post(t, "consolidate");
    expect(c.status).toBe(200);
    const body = ConsolidateResponseSchema.parse(await c.json());
    expect(body).toMatchObject({ observationsProcessed: 1, topicsCreated: 1, topicsMerged: 0, topicIds: ["caching"] });
    expect(JSON.stringify(body)).not.toContain("hot path");
    const topics = join(t.wolf.config.den, ".memory", "sessions", "durable");
    expect(readdirSync(topics)).toContain("caching.md");
    expect(events.filter((e) => e.type === "topic_consolidated")).toHaveLength(1);

    // promote -> 202 + job id; a second one while it runs -> 409 already_running with the same job
    const p = await post(t, "promote");
    expect(p.status).toBe(202);
    const job = (await p.json()) as { jobId: string; status: string };
    expect(job).toMatchObject({ status: "started" });
    expect(job.jobId).toBeTruthy();
    const again = await post(t, "promote");
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ jobId: job.jobId, status: "already_running" });
    // via the SDK too: already_running resolves, it does not throw
    expect(await t.client.promoteMemory!("testwolf")).toEqual({ jobId: job.jobId, status: "already_running" });

    release();
    await waitFor(() => types(events).includes("promote_finished"));
    // exactly one lifecycle, same job id, no duplicate emission from the route
    expect(types(events)).toEqual(["observation_captured", "topic_consolidated", "promote_started", "contribution_emitted", "promote_finished"]);
    expect(events[2]).toMatchObject({ type: "promote_started", jobId: job.jobId });
    expect(events[4]).toMatchObject({ type: "promote_finished", jobId: job.jobId, contributions: 1 });

    // the lock is released: a later promote starts a fresh job
    const next = await t.client.promoteMemory!("testwolf");
    expect(next.status).toBe("started");
    expect(next.jobId).not.toBe(job.jobId);

    expect(hashTree(live)).toEqual(liveBefore);
  });

  it("unknown wolf is not_found; the typed client consolidates", async () => {
    const t = await startWolf();
    const res = await fetch(`${t.url}/v1/wolves/nope/memory/promote`, { method: "POST" });
    expect(res.status).toBe(404);
    expect(ErrorEnvelopeSchema.parse(await res.json()).code).toBe("not_found");
    const events = collect(t);
    await new Promise((r) => setTimeout(r, 100));
    await t.submit("hello");
    await waitFor(() => types(events).includes("observation_captured"));
    expect(await t.client.consolidateMemory!("testwolf")).toMatchObject({ observationsProcessed: 1, topicIds: ["caching"] });
  });

  it("a wolf with memory inert answers 409 memory_unavailable (not 500)", async () => {
    const t = await startWolf({ sandbox: false });
    for (const action of ["consolidate", "promote"] as const) {
      const res = await post(t, action);
      expect(res.status).toBe(409);
      const env = ErrorEnvelopeSchema.parse(await res.json());
      expect(env.code).toBe("memory_unavailable");
      expect(env.message.length).toBeGreaterThan(0);
    }
    await expect(t.client.promoteMemory!("testwolf")).rejects.toMatchObject({ code: "memory_unavailable" });
  });

  it("a wolf with no KB roots: consolidate works, promote is 409 promote_unavailable", async () => {
    const t = await startWolf({ kb: false });
    const events = collect(t);
    await new Promise((r) => setTimeout(r, 100));
    await t.submit("hello");
    await waitFor(() => types(events).includes("observation_captured"));
    expect((await post(t, "consolidate")).status).toBe(200);
    const res = await post(t, "promote");
    expect(res.status).toBe(409);
    expect(ErrorEnvelopeSchema.parse(await res.json())).toMatchObject({ code: "promote_unavailable" });
    await expect(t.client.promoteMemory!("testwolf")).rejects.toMatchObject({ code: "promote_unavailable" });
  });
});
