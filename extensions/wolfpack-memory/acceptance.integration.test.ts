/**
 * End-to-end sandbox acceptance for "Durable memory embedding" (feature work-wolfpack-4WHYc9m).
 *
 * One scenario, driven through the public surfaces (/v1 HTTP, the client SDK, task tools called by the scripted
 * model) against a sandboxed durable wolf named 1uk4. A fake "live" tree (ledger with a feature + task, ops inbox,
 * KB_BASE with 2 domains, den) is hashed, snapshotted with takeSnapshot (what `wolfpack sandbox snapshot` calls) into
 * a dev root, and the wolf is booted on that root.
 *
 * Done-when -> assertion (search the marker in the scenario below):
 *   [D1] home talk lands in dev den topics ........ observation_captured (threadId 1uk4/home) + consolidate -> session
 *                                                    topic file under <dev>/den/.memory/sessions, promote -> den topic
 *   [D2] bound conversation -> snapshot Record ..... bound via the scripted `task_bind` tool call; the feature (the task's
 *                                                    parent) read back from the snapshot work server has both MARK_BOUND and MARK_FORK
 *                                                    in its Record; the subagent's MARK_SUB is nowhere
 *   [D3] consolidate and promote are API actions ... POST .../memory/consolidate -> 200 counts; promote -> 202 jobId,
 *                                                    promote_finished carries the same jobId; contribution files land
 *                                                    in <dev>/ops/inbox/1uk4
 *   [D4] memory events stream ...................... client.watchMemory: observation_captured (den + work targets,
 *                                                    domains), topic_consolidated, promote_started,
 *                                                    contribution_emitted, promote_finished, in order; metadata only
 *   [D5] live ledger, inbox, KB, den untouched ..... sha256 of every file in the live tree equal before and after
 *   [D6] inert without sandbox / memory.live ....... no observations, routes answer 409 memory_unavailable
 *
 * The wolf runs consolidation.trigger: manual (threshold kept low) so the POST consolidate does the work itself;
 * the auto-threshold path is covered by memory-events.integration.test.ts.
 *
 * Not proven here (and why): "nothing written outside the dev root" is asserted for the redirect (den, KB_OPS and
 * WORK_ENDPOINT all resolve under the dev root, and the live tree + KB_BASE hash identically), not by tracing every
 * syscall: the wolf's own temp dirs (sqlite, home) legitimately live outside the dev root.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Engine } from "@wolfpack/engine";
import { takeSnapshot } from "@wolfpack/engine";
import { startLocalWorkServer } from "@wolfpack/agent";
import { ConsolidateResponseSchema, ErrorEnvelopeSchema, MemoryEventSchema, PROTOCOL_VERSION, type MemoryEvent } from "@wolfpack/protocol";
import { adaptToDurable } from "../../packages/harness/src/adapters/durable.js";
import { ENGINE_CONTEXT as ctx } from "../../packages/harness/src/engine/index.js";
import { conversationReaderFor } from "../../packages/harness/src/engine/conversation-reader.js";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "../../packages/harness/src/wolfd/scripted-model.js";
import { Park, parkExtension, startTestWolf, type TestWolf } from "../../packages/harness/src/wolfd/test-wolf.js";
import createMemoryExtension from "./unified.js";
import createTasksExtension from "./unified-tasks.js";
import { readBindingFile } from "./conversation-binding.js";

const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), `accept-${p}-`));
  dirs.push(d);
  return d;
};
let tw: TestWolf | undefined;
const aborts: AbortController[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const a of aborts.splice(0)) a.abort();
  await tw?.stop();
  tw = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const say = (marker: string) => `${marker}: we decided to cache the session lookups for five minutes because the profile endpoint was the hot path.`;
const reply = (marker: string) => fauxAssistantMessage(say(marker));

/**
 * Memory Engine stub (the established `engine.call(step, schema, {prompt})` seam). classify: one observation per
 * MARK_x seen in the chunk (DOM_x tags its domain). workRecord: one decision per MARK_x in the prompt, which includes
 * the current Record, so the rewritten Record is cumulative. consolidate / distill: fixed topic and contribution.
 */
function stubEngine(): Engine {
  return {
    call: async (step: string, schema: { parse: (v: unknown) => unknown }, args: { prompt: string }) => {
      const marks = [...new Set(args.prompt.match(/MARK_[A-Z0-9]+/g) ?? [])];
      if (step === "classify") {
        const dom = args.prompt.match(/DOM_([a-z]+)/)?.[1];
        return schema.parse({ observations: [{ timestamp: "2026-10-25 10:00", content: `Obs ${marks.join(",") || "none"}`, ...(dom ? { domain: dom } : {}) }] });
      }
      if (step === "workRecord") {
        return schema.parse({ decisions: marks.map((m) => ({ decision: `Seen ${m}`, why: "hot path" })), changes: [], findings: [], problems: [] });
      }
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

function hashTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        out[p + "/"] = "dir";
        walk(p);
      } else out[p] = createHash("sha256").update(readFileSync(p)).digest("hex") + ":" + statSync(p).size;
    }
  };
  walk(dir);
  return out;
}

interface Live {
  root: string;
  dev: string;
  kb: string;
  featureId: string;
  taskId: string;
}

/** The fake live host: ledger (feature + task, made through the real work server), ops inbox, KB_BASE, den. */
async function buildLive(): Promise<Live> {
  const root = tmp("live");
  const work = join(root, "work");
  const srv = await startLocalWorkServer({ ledgerDir: work, token: "live-fixture" });
  const http = async (body: unknown) =>
    (await (await fetch(`${srv.url}/work`, { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": "live-fixture" }, body: JSON.stringify(body) })).json()) as { id: string };
  const feature = await http({ kind: "feature", domain: "wolfpack", title: "acceptance feature", assignee: "owner" });
  const task = await http({ kind: "task", domain: "wolfpack", title: "acceptance task", assignee: "1uk4", successCriteria: "ok", partOf: feature.id });
  await srv.close();
  mkdirSync(join(root, "ops", "inbox", "1uk4"), { recursive: true });
  writeFileSync(join(root, "ops", "inbox", "1uk4", "old.md"), "an existing live contribution\n");
  mkdirSync(join(root, "den", "kb"), { recursive: true });
  writeFileSync(join(root, "den", "notes.md"), "live den note\n");
  const kb = join(root, "kb");
  writeFileSync(join(mkdirSync(kb, { recursive: true }) ?? kb, "domains.yaml"), "domains:\n  wolfpack:\n    label: Wolfpack\n    description: The wolf system\n  snapjack:\n    label: Snapjack\n    description: The sports app\n");
  for (const d of ["wolfpack", "snapjack"]) {
    mkdirSync(join(kb, "domains", d, "entries"), { recursive: true });
    writeFileSync(join(kb, "domains", d, "INDEX.md"), `# ${d}\n`);
  }
  const dev = join(tmp("dev"), "snap");
  takeSnapshot({ source: { workDir: work, workBaseDir: join(work, "base"), opsDir: join(root, "ops"), denDir: join(root, "den") }, devRoot: dev });
  return { root, dev, kb, featureId: feature.id, taskId: task.id };
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}
const watermarkFile = (den: string, cid: number) => join(den, ".memory", "watermarks", `${cid}.json`);
/** The observer has caught up with everything said in conversation `cid`. */
async function observed(t: TestWolf, cid: number): Promise<void> {
  const den = t.wolf.config.den;
  const reader = conversationReaderFor(den)!;
  await waitFor(async () => {
    const msgs = await reader.messagesSince(cid, 0);
    if (!msgs.length || !existsSync(watermarkFile(den, cid))) return false;
    return JSON.parse(readFileSync(watermarkFile(den, cid), "utf8")).lastEntryId >= msgs[msgs.length - 1].entryId;
  });
}
async function runOn(conv: { submit: Function; waitForIdle: Function }, text: string) {
  await conv.submit({ type: "input", content: text, whenBusy: "reject" }, ctx);
  await conv.waitForIdle(ctx);
}
const types = (evs: MemoryEvent[]) => evs.map((e) => e.type);
const post = (t: TestWolf, action: "consolidate" | "promote") =>
  fetch(`${t.url}/v1/wolves/1uk4/memory/${action}`, { method: "POST", headers: { "X-Protocol-Version": String(PROTOCOL_VERSION) } });
/** consolidate, retrying while an observer-triggered consolidation (low threshold) holds the lock. */
async function consolidate(t: TestWolf) {
  for (let i = 0; i < 40; i++) {
    const res = await post(t, "consolidate");
    if (res.status === 200) return ConsolidateResponseSchema.parse(await res.json());
    expect(res.status).toBe(409);
    expect(ErrorEnvelopeSchema.parse(await res.json()).code).toBe("memory_busy");
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("consolidate stayed busy");
}

describe("durable memory: sandbox acceptance", { timeout: 60_000 }, () => {
  it("home talk, bound/fork Record, consolidate, promote, events, live tree untouched", async () => {
    vi.stubEnv("PI_SUBAGENT_AGENT", ""); // the main session, not a pi subagent child
    const live = await buildLive();
    const liveBefore = hashTree(live.root);
    expect(Object.keys(liveBefore).length).toBeGreaterThan(5);

    // Script, consumed in order (one reply per model request): home; bound (tool call, then its reply); fork; subagent.
    tw = await startTestWolf({
      name: "1uk4",
      script: [
        reply("MARK_HOME DOM_snapjack"),
        fauxAssistantMessage([fauxText("Binding the task."), fauxToolCall("task_bind", { id: live.taskId })], { stopReason: "toolUse" }),
        reply("MARK_BOUND"),
        reply("MARK_FORK"),
        reply("MARK_SUB"),
      ],
      yaml: `domains: [wolfpack, snapjack]\nsandbox:\n  root: ${live.dev}\nmemory:\n  defaultDomain: wolfpack\n  consolidation:\n    trigger: manual\n    threshold: 20\n    poolTarget: 1\n`,
      hooks: {
        extensions: ({ config, den, env }) => {
          const c = { wolfDen: den, wolfName: "1uk4", domains: config.identity.domains, wolfConfig: { sandbox: config.sandbox, memory: config.memory }, env: { ...env, KB_BASE: live.kb } };
          return [
            parkExtension,
            adaptToDurable(createMemoryExtension({ ...config.memory, engine: stubEngine() }, c), { wolfDen: den, wolfName: "1uk4" }),
            adaptToDurable(createTasksExtension({}, c), { wolfDen: den, wolfName: "1uk4" }),
          ];
        },
      },
    });
    const t = tw;
    const den = t.wolf.config.den;
    const sb = t.wolf.sandbox!;
    // the redirect: den, KB_OPS and the work server all resolve under the dev root
    expect(relative(live.dev, den).startsWith("..")).toBe(false);
    expect(sb.env.KB_OPS).toBe(join(live.dev, "ops"));
    expect(sb.env.WOLF_DEN.startsWith(live.dev)).toBe(true);

    // [D4] subscribe through the client SDK
    const events: MemoryEvent[] = [];
    const ctl = new AbortController();
    aborts.push(ctl);
    (async () => {
      for await (const e of t.client.watchMemory!("1uk4", { signal: ctl.signal })) events.push(MemoryEventSchema.parse(e));
    })().catch(() => {});
    await new Promise((r) => setTimeout(r, 100));

    // [D1] home talk -> observation_captured with the home threadId, in the classified domain
    await t.submit(say("hello from home"));
    await waitFor(() => events.some((e) => e.type === "observation_captured"));
    expect(events[0]).toMatchObject({ type: "observation_captured", wolf: "1uk4", threadId: "1uk4/home", target: { kind: "den" }, domain: "snapjack" });
    await observed(t, 1);

    // [D2] a second root conversation binds the snapshot task via the scripted task_bind tool call, then talks
    const h = t.wolf.engine.harness;
    const agent = { model: { provider: t.scripted.provider, modelId: t.scripted.modelId }, tools: [] as never[] };
    const created = await t.wolf.engine.conversations.create({ model: agent.model, tools: ["task_bind", "task_current"] });
    const boundId = Number(created.id);
    const bound = (await h.conversation(boundId as never, ctx))!;
    await runOn(bound, "bind the acceptance task and talk");
    await observed(t, boundId);
    expect(readBindingFile(den, boundId)).toMatchObject({ workId: live.taskId, featureId: live.featureId });
    await waitFor(() => events.some((e) => e.type === "observation_captured" && e.target.kind === "work"));
    const workEvent = events.find((e) => e.type === "observation_captured" && e.target.kind === "work")!;
    expect(workEvent).toMatchObject({ domain: "wolfpack", target: { kind: "work", workId: live.taskId, featureId: live.featureId } });
    // only the conversation backing the home thread is "1uk4/home"; a second root has no threadId, just its conversationId
    expect(workEvent.threadId).toBeUndefined();
    expect(workEvent.conversationId).toBe(boundId);
    expect(events[0].conversationId).toBe(1);

    // fork it and talk in the fork: same lineage, same Record
    const newest = (await bound.entries({ order: "descending" }, 1, undefined, ctx)).items[0];
    const fork = await bound.fork(newest.id, { ownership: { kind: "ownerless" }, agent }, ctx);
    await runOn(fork, "talk in the fork");
    await observed(t, Number(fork.id));
    await waitFor(() => events.some((e) => e.conversationId === Number(fork.id)));
    const forkEvent = events.find((e) => e.conversationId === Number(fork.id))!;
    expect(forkEvent).toMatchObject({ type: "observation_captured", target: { kind: "work", workId: live.taskId } });
    expect(forkEvent.threadId).toBeUndefined();
    expect(Number(fork.id)).not.toBe(boundId);

    // a subagent (task-owned) conversation talks too and contributes nothing
    const taskId = await h.commit((tx) => tx.createTask(Park, {}, { ownership: { kind: "conversation" }, conversationId: boundId as never }), ctx);
    const sub = await h.createConversation({ ownership: { kind: "task", taskId }, agent }, ctx);
    await runOn(sub, "subagent talk");
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(watermarkFile(den, Number(sub.id)))).toBe(false);

    // [D3] consolidate over the API
    const counts = await consolidate(t);
    // trigger: manual, so nothing consolidated until this call: home talk -> 1 session topic, the work-tagged ones -> Record
    expect(counts).toMatchObject({ topicsCreated: 1, topicIds: ["caching"] });
    expect(counts.observationsProcessed).toBeGreaterThanOrEqual(3);
    await waitFor(() => events.some((e) => e.type === "topic_consolidated"));
    // [D1] session topic from home talk exists in the dev den
    const sessions = join(den, ".memory", "sessions", "durable");
    expect(readdirSync(sessions)).toContain("caching.md");

    // [D2] the bound task's feature Record (the Record lives on the feature; read through the sandbox work server) has bound + fork content, not the subagent's
    const item = await (await fetch(`${sb.resolved.workEndpoint}/work/${live.featureId}`, { headers: { "X-API-Key": sb.env.WORK_TOKEN } })).json();
    const body = JSON.stringify(item);
    expect(body).toContain("MARK_BOUND");
    expect(body).toContain("MARK_FORK");
    expect(body).not.toContain("MARK_SUB");
    expect(body).not.toContain("MARK_HOME");
    // the subagent's words reached no pool either
    const poolFile = join(den, ".memory", "pool", "observations.jsonl");
    expect(existsSync(poolFile) ? readFileSync(poolFile, "utf8") : "").not.toContain("MARK_SUB");

    // [D3] promote over the API: 202 + jobId, completion on the event stream with the same id
    const p = await post(t, "promote");
    expect(p.status).toBe(202);
    const job = (await p.json()) as { jobId: string; status: string };
    expect(job.jobId).toBeTruthy();
    await waitFor(() => events.some((e) => e.type === "promote_finished"));
    const fin = events.find((e) => e.type === "promote_finished")!;
    expect(fin).toMatchObject({ jobId: job.jobId, contributions: 1 });
    // dev den topics + contribution in the dev ops inbox lane for 1uk4
    const denTopics = readdirSync(join(den, "kb"), { recursive: true }).map(String);
    expect(denTopics.some((f) => f.endsWith("caching.md") || f.includes("caching"))).toBe(true);
    const lane = readdirSync(join(live.dev, "ops", "inbox", "1uk4"));
    expect(lane).toContain("old.md"); // the snapshot's copy
    expect(lane.length).toBeGreaterThan(1); // + the new contribution

    // [D4] event order and shape
    const order = types(events);
    expect(order[0]).toBe("observation_captured");
    expect(order.indexOf("topic_consolidated")).toBeGreaterThan(order.indexOf("observation_captured"));
    expect(order.indexOf("promote_started")).toBeGreaterThan(order.lastIndexOf("topic_consolidated"));
    expect(order.indexOf("contribution_emitted")).toBeGreaterThan(order.indexOf("promote_started"));
    expect(order.at(-1)).toBe("promote_finished");
    expect(events.find((e) => e.type === "promote_started")).toMatchObject({ jobId: job.jobId });
    expect(events.find((e) => e.type === "contribution_emitted")).toMatchObject({ lane: "inbox/1uk4" });
    expect(JSON.stringify(events)).not.toContain("hot path"); // metadata only

    // [D5] the live tree (ledger, inbox, KB, den) is byte-identical
    expect(hashTree(live.root)).toEqual(liveBefore);
    // and the dev copy did change
    expect(hashTree(live.dev)).not.toEqual({});
  });

  it("[D6] a wolf without sandbox or memory.live has inert memory; routes answer memory_unavailable", async () => {
    const kb = tmp("kb");
    tw = await startTestWolf({
      name: "1uk4",
      script: [reply("MARK_INERT")],
      hooks: {
        extensions: ({ config, den, env }) => [
          adaptToDurable(
            createMemoryExtension({ ...config.memory, engine: stubEngine() }, { wolfDen: den, wolfName: "1uk4", domains: ["wolfpack"], wolfConfig: { sandbox: config.sandbox }, env: { ...env, KB_BASE: kb } }),
            { wolfDen: den, wolfName: "1uk4" },
          ),
        ],
      },
    });
    const events: MemoryEvent[] = [];
    const ctl = new AbortController();
    aborts.push(ctl);
    (async () => {
      for await (const e of tw!.client.watchMemory!("1uk4", { signal: ctl.signal })) events.push(e);
    })().catch(() => {});
    await new Promise((r) => setTimeout(r, 100));
    await tw.submit("hello");
    await new Promise((r) => setTimeout(r, 300));
    expect(events).toEqual([]);
    expect(existsSync(join(tw.wolf.config.den, ".memory", "pool"))).toBe(false);
    for (const action of ["consolidate", "promote"] as const) {
      const res = await post(tw, action);
      expect(res.status).toBe(409);
      expect(ErrorEnvelopeSchema.parse(await res.json()).code).toBe("memory_unavailable");
    }
    await expect(tw.client.promoteMemory!("1uk4")).rejects.toMatchObject({ code: "memory_unavailable" });
  });
});
