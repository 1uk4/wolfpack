/**
 * MemoryEvents on the wolf event stream (GET /v1/wolves/:name/events), driven through a real sandboxed durable wolf:
 * a scripted turn -> observation_captured -> topic_consolidated (low threshold) -> promote_started,
 * contribution_emitted, promote_finished. The memory Engine is the stubbed `engine.call` seam.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Engine } from "@wolfpack/engine";
import { takeSnapshot } from "@wolfpack/engine";
import { startLocalWorkServer } from "@wolfpack/agent";
import { MemoryEventSchema, type MemoryEvent } from "@wolfpack/protocol";
import { adaptToDurable } from "../../packages/harness/src/adapters/durable.js";
import { fauxAssistantMessage } from "../../packages/harness/src/wolfd/scripted-model.js";
import { startTestWolf, type TestWolf } from "../../packages/harness/src/wolfd/test-wolf.js";
import { writeBindingFile } from "./conversation-binding.js";
import { memoryActionsFor } from "./memory-actions.js";
import createMemoryExtension from "./unified.js";

const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), `mev-${p}-`));
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

const REPLY = "We decided to cache the session lookups for five minutes because the profile endpoint was the hot path in the load test.";
/** A single long observation line: well past the 120-char summary cap. */
const OBS = `Sessions are cached for five minutes. ${"The profile endpoint is the hot path in the load test, so lookups hit the cache first. ".repeat(4)}END_OF_OBSERVATION`;

function stubEngine(): Engine {
  return {
    call: async (step: string, schema: { parse: (v: unknown) => unknown }) => {
      if (step === "classify") return schema.parse({ observations: [{ timestamp: "2026-10-25 10:00", content: OBS }] });
      if (step === "consolidate") {
        return schema.parse({
          actions: [{ sessionTopicId: "x", action: "create", reasoning: "new", result: { id: "caching", title: "Caching", summary: "Session lookups are cached", body: "Cache session lookups for five minutes." } }],
        });
      }
      if (step === "distill") return schema.parse({ contributions: [{ slug: "main", title: "Caching", summary: "Session lookups are cached", body: "## Details\nCache session lookups." }] });
      throw new Error(`unexpected step ${step}`);
    },
  } as unknown as Engine;
}

async function devRoot(): Promise<string> {
  const live = tmp("live");
  const work = join(live, "work");
  const srv = await startLocalWorkServer({ ledgerDir: work, token: "live-fixture" });
  await srv.close();
  mkdirSync(join(live, "ops"), { recursive: true });
  mkdirSync(join(live, "den"), { recursive: true });
  const dev = join(tmp("dev"), "snap");
  takeSnapshot({ source: { workDir: work, workBaseDir: join(work, "base"), opsDir: join(live, "ops"), denDir: join(live, "den") }, devRoot: dev });
  return dev;
}

async function startWolf(memoryYaml: string) {
  const dev = await devRoot();
  const kbBase = tmp("kb"); // KB_BASE + the sandbox's KB_OPS make promote enabled
  tw = await startTestWolf({
    script: [fauxAssistantMessage(REPLY)],
    yaml: `sandbox:\n  root: ${dev}\n${memoryYaml}`,
    hooks: {
      extensions: ({ config, den, env }) => [
        adaptToDurable(
          createMemoryExtension({ ...config.memory, engine: stubEngine() }, { wolfDen: den, wolfName: "testwolf", domains: ["wolfpack"], wolfConfig: { sandbox: config.sandbox }, env: { ...env, KB_BASE: kbBase } }),
          { wolfDen: den, wolfName: "testwolf" },
        ),
      ],
    },
  });
  return tw;
}

/** Subscribes through the client SDK; resolves once the stream is open. */
function collect(t: TestWolf) {
  const events: MemoryEvent[] = [];
  const ctl = new AbortController();
  aborts.push(ctl);
  const done = (async () => {
    for await (const e of t.client.watchMemory!("testwolf", { signal: ctl.signal })) events.push(e);
  })();
  done.catch(() => {});
  return { events, ctl };
}
async function waitFor(cond: () => boolean, ms = 6000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}
const types = (evs: MemoryEvent[]) => evs.map((e) => e.type);

describe("MemoryEvents on the wolf stream", { timeout: 30_000 }, () => {
  it("observation_captured -> topic_consolidated -> promote lifecycle, metadata only", async () => {
    const t = await startWolf("memory:\n  consolidation:\n    threshold: 20\n    poolTarget: 1\n");
    const { events } = collect(t);
    await new Promise((r) => setTimeout(r, 100)); // let the subscription open

    await t.submit("hello");
    await waitFor(() => types(events).includes("topic_consolidated"));
    expect(types(events).slice(0, 2)).toEqual(["observation_captured", "topic_consolidated"]);
    expect(events[0]).toMatchObject({ type: "observation_captured", wolf: "testwolf", threadId: "testwolf/home", count: 1, target: { kind: "den" } });
    expect(events[1]).toMatchObject({ type: "topic_consolidated", topicId: "caching", change: "create", observationCount: 1, target: { kind: "session", topicId: "caching" } });

    const den = t.wolf.config.den;
    const actions = memoryActionsFor(den)!;
    expect(actions.promoteEnabled).toBe(true);
    const start = actions.promote();
    expect(start.status).toBe("started");
    if (start.status !== "started") return;
    await start.done;
    await waitFor(() => types(events).includes("promote_finished"));

    expect(types(events)).toEqual(["observation_captured", "topic_consolidated", "promote_started", "contribution_emitted", "promote_finished"]);
    expect(events[2]).toMatchObject({ jobId: start.jobId });
    expect(events[3]).toMatchObject({ type: "contribution_emitted", lane: "inbox/testwolf", target: { kind: "den", topicId: "caching" } });
    expect((events[3] as { contributionId: string }).contributionId).toMatch(/^caching-/);
    expect(events[4]).toMatchObject({ type: "promote_finished", jobId: start.jobId, consolidated: 0, contributions: 1 });

    // every event is schema-valid, and no payload carries the observation text (only the capped summary)
    for (const e of events) {
      expect(MemoryEventSchema.safeParse(e).success).toBe(true);
      const wire = JSON.stringify(e);
      expect(wire).not.toContain("END_OF_OBSERVATION");
      expect(wire).not.toContain(OBS);
    }
    const summary = (events[0] as { summary: string }).summary;
    expect(summary.length).toBeLessThanOrEqual(120);
    expect(OBS.startsWith(summary.replace(/…$/, ""))).toBe(true);
  });

  it("a bound conversation's observation_captured targets the work item (+ feature)", async () => {
    const t = await startWolf("");
    writeBindingFile(t.wolf.config.den, 1, { workId: "work-wolfpack-AAAAAAA", domain: "wolfpack", boundAt: new Date().toISOString(), featureId: "work-wolfpack-FFFFFFF" });
    const { events } = collect(t);
    await new Promise((r) => setTimeout(r, 100));
    await t.submit("hello");
    await waitFor(() => types(events).includes("observation_captured"));
    expect(events[0]).toMatchObject({ target: { kind: "work", workId: "work-wolfpack-AAAAAAA", featureId: "work-wolfpack-FFFFFFF" }, threadId: "testwolf/home" });
  });

  it("a promote with nothing to do still pairs promote_started with promote_finished", async () => {
    const t = await startWolf("");
    const { events } = collect(t);
    await new Promise((r) => setTimeout(r, 100));
    const start = memoryActionsFor(t.wolf.config.den)!.promote();
    if (start.status !== "started") throw new Error("not started");
    await start.done;
    await waitFor(() => types(events).includes("promote_finished"));
    expect(types(events).filter((x) => x.startsWith("promote_"))).toEqual(["promote_started", "promote_finished"]);
  });
});
