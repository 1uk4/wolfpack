/**
 * Per-conversation binding with lineage, driven through a real sandboxed durable wolf (startTestWolf: real sqlite +
 * pi-durable, scripted model, stubbed memory Engine). Forks, second roots and task-owned conversations are created
 * through the opened Harness. Task tools run with the same conversation reader the durable adapter hands them.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Engine } from "@wolfpack/engine";
import { takeSnapshot } from "@wolfpack/engine";
import { startLocalWorkServer } from "@wolfpack/agent";
import type { ToolContext } from "@wolfpack/harness/extension";
import { adaptToDurable } from "../../packages/harness/src/adapters/durable.js";
import { ENGINE_CONTEXT as ctx } from "../../packages/harness/src/engine/index.js";
import { conversationReaderFor } from "../../packages/harness/src/engine/conversation-reader.js";
import { fauxAssistantMessage } from "../../packages/harness/src/wolfd/scripted-model.js";
import { Park, parkExtension, startTestWolf, type TestWolf } from "../../packages/harness/src/wolfd/test-wolf.js";
import createMemoryExtension from "./unified.js";
import createTasksExtension from "./unified-tasks.js";
import { bindingFile, readBindingFile } from "./conversation-binding.js";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), `bind-${p}-`));
let tw: TestWolf | undefined;
beforeEach(() => vi.stubEnv("PI_SUBAGENT_AGENT", "")); // the main session, not a pi subagent child
afterEach(async () => {
  vi.unstubAllEnvs();
  await tw?.stop();
  tw = undefined;
});

const say = (marker: string) => `${marker}: we decided to cache the session lookups for five minutes because the profile endpoint was the hot path.`;
const reply = (marker: string) => fauxAssistantMessage(say(marker));

/** Every classify call yields one observation carrying the MARK_x found in the chunk; workRecord yields a decision. */
function stubEngine(): Engine {
  return {
    call: async (step: string, schema: { parse: (v: unknown) => unknown }, args: { prompt: string }) => {
      if (step === "classify") {
        const marks = [...new Set(args.prompt.match(/MARK_[A-Z0-9]+/g) ?? [])];
        return schema.parse({ observations: [{ timestamp: "2026-10-25 10:00", content: `Obs ${marks.join(",") || "none"}` }] });
      }
      if (step === "workRecord") return schema.parse({ decisions: [{ decision: "Cache five minutes", why: "hot path" }], changes: [], findings: [], problems: [] });
      throw new Error(`unexpected step ${step}`);
    },
  } as unknown as Engine;
}

function hashTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { out[p + "/"] = "dir"; walk(p); }
      else out[p] = createHash("sha256").update(readFileSync(p)).digest("hex") + ":" + statSync(p).size;
    }
  };
  walk(dir);
  return out;
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}
const watermarkFile = (den: string, cid: number) => join(den, ".memory", "watermarks", `${cid}.json`);
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
const quiet = () => new Promise((r) => setTimeout(r, 300));

interface Setup {
  live: string;
  dev: string;
  den: string;
  featureId: string;
  taskA: string;
  taskB: string;
  tasks: ReturnType<typeof createTasksExtension>;
  memory: ReturnType<typeof createMemoryExtension>;
  call: (path: string) => Promise<any>;
}

async function setup(script = 8): Promise<Setup> {
  const live = tmp("live");
  const work = join(live, "work");
  const srv = await startLocalWorkServer({ ledgerDir: work, token: "live-fixture" });
  await srv.close();
  mkdirSync(join(live, "ops"), { recursive: true });
  mkdirSync(join(live, "den"), { recursive: true });
  const dev = join(tmp("dev"), "snap");
  takeSnapshot({ source: { workDir: work, workBaseDir: join(work, "base"), opsDir: join(live, "ops"), denDir: join(live, "den") }, devRoot: dev });
  const engine = stubEngine();
  let tasks!: Setup["tasks"];
  let memory!: Setup["memory"];
  tw = await startTestWolf({
    script: Array.from({ length: script }, (_, i) => reply(`A_${i}`)),
    yaml: `sandbox:\n  root: ${dev}\n`,
    hooks: {
      extensions: ({ config, den, env }) => {
        const c = { wolfDen: den, wolfName: "testwolf", domains: ["wolfpack"], wolfConfig: { sandbox: config.sandbox }, env };
        tasks = createTasksExtension({ autoShip: true }, c);
        memory = createMemoryExtension({ ...config.memory, engine }, c);
        return [parkExtension, adaptToDurable(memory, { wolfDen: den, wolfName: "testwolf" }), adaptToDurable(tasks, { wolfDen: den, wolfName: "testwolf" })];
      },
    },
  });
  const sb = tw.wolf.sandbox!;
  const http = async (method: string, path: string, body?: unknown) =>
    (await fetch(`${sb.resolved.workEndpoint}/work${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-API-Key": sb.env.WORK_TOKEN },
      body: body === undefined ? undefined : JSON.stringify(body),
    })).json() as Promise<any>;
  const feature = await http("POST", "", { kind: "feature", domain: "wolfpack", title: "rec feature", assignee: "owner" });
  const mk = async (title: string) => (await http("POST", "", { kind: "task", domain: "wolfpack", title, assignee: "testwolf", successCriteria: "ok", partOf: feature.id })).id as string;
  return { live, dev, den: tw.wolf.config.den, featureId: feature.id, taskA: await mk("task A"), taskB: await mk("task B"), tasks, memory, call: (p) => http("GET", p) };
}

/** The tool context the durable adapter builds for a call made in conversation `cid`. */
function toolCtx(s: Setup, cid: number): ToolContext {
  const reader = conversationReaderFor(s.den)!;
  return {
    cwd: s.den, wolfDen: s.den, wolfName: "testwolf", conversationId: cid,
    conversation: { classify: () => reader.classify(cid), classifyOther: (id) => reader.classify(id), messagesSince: (a) => reader.messagesSince(cid, a) },
  };
}
const tool = async (s: Setup, cid: number, name: string, args: Record<string, unknown> = {}) => {
  const r = await s.tasks.tools!.find((t) => t.name === name)!.execute(args, toolCtx(s, cid));
  return { text: r.content[0].text, isError: !!r.isError };
};
const pool = (den: string): Array<{ content: string; work?: string; feature?: string }> => {
  const f = join(den, ".memory", "pool", "observations.jsonl");
  return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};

describe("legacy binding migration", () => {
  it("goes only to the home conversation, never to a feature thread's root", async () => {
    const { migrateLegacyBinding } = await import("./conversation-binding.js");
    const den = tmp("legacy");
    mkdirSync(join(den, "tasks"), { recursive: true });
    writeFileSync(join(den, "tasks", "active.json"), JSON.stringify({ taskId: "work-w-1", domain: "w", boundAt: "2026-10-01T00:00:00Z" }));
    migrateLegacyBinding(den, 7);
    expect(existsSync(join(den, "tasks", "active.json"))).toBe(true);
    expect(readBindingFile(den, 7)).toBeNull();
    migrateLegacyBinding(den, 1);
    expect(readBindingFile(den, 1)).toMatchObject({ workId: "work-w-1" });
    expect(existsSync(join(den, "tasks", "active.json.migrated"))).toBe(true);
  });
});

describe("per-conversation binding", () => {
  it("(a,b,c,d,e,g) lineage, exclusivity, read-only tasks, no caching, live untouched", async () => {
    const s = await setup();
    const before = hashTree(s.live);
    const { den } = s;

    // Bind in the root conversation: stored in pi's shape under the conversation.
    const bound = await tool(s, 1, "task_bind", { id: s.taskA });
    expect(bound.isError).toBe(false);
    expect(Object.keys(readBindingFile(den, 1)!).sort()).toEqual(["boundAt", "domain", "featureId", "workId"]);
    expect(readBindingFile(den, 1)).toMatchObject({ workId: s.taskA, domain: "wolfpack", featureId: s.featureId });
    expect(existsSync(join(den, "tasks", "active.json"))).toBe(false);

    // (a) bound talk is tagged to the item and lands in the feature's Record on consolidate.
    await tw!.submit(say("MARK_ROOT"));
    await observed(tw!, 1);
    expect(pool(den).filter((o) => o.content.includes("MARK_ROOT"))).toMatchObject([{ work: s.taskA, feature: s.featureId }]);
    const consolidate = s.memory.tools!.find((t) => t.name === "memory_consolidate")!;
    expect((await consolidate.execute({}, toolCtx(s, 1))).isError).toBeFalsy();
    expect(JSON.stringify(await s.call(`/${s.featureId}`))).toContain("Cache five minutes");
    expect(pool(den).filter((o) => o.work)).toEqual([]); // tagged observations skip den consolidation: they left the pool for the Record

    const reader = conversationReaderFor(den)!;
    const h = tw!.wolf.engine.harness;
    const root = (await h.conversation(1 as never, ctx))!;
    const newest = (await root.entries({ order: "descending" }, 1, undefined, ctx)).items[0];
    const agent = { model: { provider: tw!.scripted.provider, modelId: tw!.scripted.modelId }, tools: [] as never[] };

    // (b) a fork shares the lineage binding: tagged to the same item, no file of its own.
    const fork = await root.fork(newest.id, { ownership: { kind: "ownerless" }, agent }, ctx);
    const forkId = Number(fork.id);
    expect(await reader.classify(forkId)).toMatchObject({ kind: "fork", lineageRoot: 1 });
    expect((await tool(s, forkId, "task_current")).text).toContain(s.taskA);
    await runOn(fork, say("MARK_FORK"));
    await observed(tw!, forkId);
    expect(pool(den).filter((o) => o.content.includes("MARK_FORK"))).toMatchObject([{ work: s.taskA }]);
    expect(existsSync(bindingFile(den, forkId))).toBe(false);

    // A second root conversation: unbound talk lands untagged in the pool.
    const root2 = await h.createConversation({ ownership: { kind: "ownerless" }, agent }, ctx);
    const r2 = Number(root2.id);
    expect(await reader.classify(r2)).toEqual({ kind: "root" });
    await runOn(root2, say("MARK_ROOT2"));
    await observed(tw!, r2);
    const untagged = pool(den).filter((o) => o.content.includes("MARK_ROOT2"));
    expect(untagged).toHaveLength(1);
    expect(untagged[0].work).toBeUndefined();

    // (c) the same item from another root conversation is refused.
    const clash = await tool(s, r2, "task_bind", { id: s.taskA });
    expect(clash.isError).toBe(true);
    expect(clash.text).toContain("bound in thread 1");
    expect(existsSync(bindingFile(den, r2))).toBe(false);
    // ...but a different item binds fine in the second root, independently.
    expect((await tool(s, r2, "task_bind", { id: s.taskB })).isError).toBe(false);
    expect(readBindingFile(den, 1)!.workId).toBe(s.taskA);
    expect(readBindingFile(den, r2)!.workId).toBe(s.taskB);
    await tool(s, r2, "task_unbind");
    expect(readBindingFile(den, r2)).toBeNull();

    // (d) a task conversation sees the binding read-only and captures nothing.
    const taskId = await h.commit((tx) => tx.createTask(Park, {}, { ownership: { kind: "conversation" }, conversationId: 1 as never }), ctx);
    const sub = await h.createConversation({ ownership: { kind: "task", taskId }, agent }, ctx);
    const sid = Number(sub.id);
    expect((await tool(s, sid, "task_current")).text).toContain(s.taskA);
    for (const [name, args] of [["task_bind", { id: s.taskB }], ["task_unbind", {}]] as const) {
      const r = await tool(s, sid, name, args);
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/Task conversations don't bind/);
    }
    expect(readBindingFile(den, 1)!.workId).toBe(s.taskA);
    expect(existsSync(bindingFile(den, sid))).toBe(false);
    const poolBefore = pool(den).length;
    await runOn(sub, say("MARK_SUB"));
    await quiet();
    expect(pool(den)).toHaveLength(poolBefore);
    expect(existsSync(watermarkFile(den, sid))).toBe(false);

    // (e) unbind takes effect on the very next turn (nothing cached), for the whole lineage.
    expect((await tool(s, 1, "task_unbind")).isError).toBe(false);
    expect((await tool(s, forkId, "task_current")).text).not.toContain(s.taskA);
    await tw!.submit(say("MARK_AFTER"));
    await observed(tw!, 1);
    const after = pool(den).filter((o) => o.content.includes("MARK_AFTER"));
    expect(after).toHaveLength(1);
    expect(after[0].work).toBeUndefined();
    // and the freed item can now be bound from the other root
    expect((await tool(s, r2, "task_bind", { id: s.taskA })).isError).toBe(false);

    // (g) nothing under the live root changed.
    expect(hashTree(s.live)).toEqual(before);
  });

  it("(f) migrates the old per-wolf tasks/active.json once to the root conversation", async () => {
    const s = await setup(1);
    mkdirSync(join(s.den, "tasks"), { recursive: true });
    writeFileSync(join(s.den, "tasks", "active.json"), JSON.stringify({ taskId: s.taskB, domain: "wolfpack", boundAt: "2026-10-01T00:00:00Z", featureId: s.featureId }));
    const cur = await tool(s, 1, "task_current");
    expect(cur.text).toContain(s.taskB);
    expect(readBindingFile(s.den, 1)).toEqual({ workId: s.taskB, domain: "wolfpack", boundAt: "2026-10-01T00:00:00Z", featureId: s.featureId });
    expect(existsSync(join(s.den, "tasks", "active.json"))).toBe(false);
    expect(existsSync(join(s.den, "tasks", "active.json.migrated"))).toBe(true);
    // a later unbind is not undone by a re-migration
    await tool(s, 1, "task_unbind");
    expect(readBindingFile(s.den, 1)).toBeNull();
    expect((await tool(s, 1, "task_current")).text).not.toContain(s.taskB);
  });

  it("each conversation's active_task section shows its own lineage binding; task_done reports a refused rebind", async () => {
    const s = await setup(1);
    const { den } = s;
    const reader = conversationReaderFor(den)!;
    const h = tw!.wolf.engine.harness;
    const root = (await h.conversation(1 as never, ctx))!;
    const agent = { model: { provider: tw!.scripted.provider, modelId: tw!.scripted.modelId }, tools: [] as never[] };
    await tw!.submit(say("MARK_SEED"));
    const newest = (await root.entries({ order: "descending" }, 1, undefined, ctx)).items[0];
    const fork = Number((await root.fork(newest.id, { ownership: { kind: "ownerless" }, agent }, ctx)).id);
    const root2 = Number((await h.createConversation({ ownership: { kind: "ownerless" }, agent }, ctx)).id);
    const root3 = Number((await h.createConversation({ ownership: { kind: "ownerless" }, agent }, ctx)).id);
    const taskId = await h.commit((tx) => tx.createTask(Park, {}, { ownership: { kind: "conversation" }, conversationId: root2 as never }), ctx);
    const sub = Number((await h.createConversation({ ownership: { kind: "task", taskId }, agent }, ctx)).id);

    await tool(s, 1, "task_bind", { id: s.taskA });
    await tool(s, root2, "task_bind", { id: s.taskB });
    // Render exactly as the adapter does: sections get the prompted conversation's id and reader.
    const section = (cid: number) => s.tasks.sections!.find((x) => x.name === "active_task")!.render({
      wolfDen: den, wolfName: "testwolf", conversationId: cid, conversation: toolCtx(s, cid).conversation,
    }) as Promise<string>;
    // The item a section presents as active: the "← active" line, or "Bound to X (loading...)" when the per-wolf
    // cache holds another conversation's item.
    const activeOf = async (cid: number) => {
      const t = await section(cid);
      return t.match(/\[(work-[^\]]+)\][^\n]*← active/)?.[1] ?? t.match(/Bound to (\S+) \(loading/)?.[1] ?? (t.includes("No work item bound") ? "none" : t);
    };
    expect(await activeOf(1)).toBe(s.taskA);
    expect(await activeOf(fork)).toBe(s.taskA); // fork: lineage binding
    expect(await activeOf(root2)).toBe(s.taskB);
    expect(await activeOf(sub)).toBe(s.taskB); // task conversation: its owner's (root2) lineage
    expect(await activeOf(root3)).toBe("none");
    expect(reader).toBeDefined();

    // task_done: the next sibling is held by another root -> refusal surfaced, no stale binding.
    await tool(s, root3, "task_bind", { id: s.taskA }).then((r) => expect(r.text).toContain("bound in thread 1"));
    const done = await tool(s, root2, "task_done", { confirm: false, bindNext: true });
    expect(done.text).not.toContain("Bound to next");
    // taskB is root2's item; its only open sibling taskA is held by thread 1
    expect(done.text).toMatch(/Not bound to next .*bound in thread 1/);
    expect(readBindingFile(den, root2)).toBeNull();
    expect(readBindingFile(den, 1)!.workId).toBe(s.taskA);
  });
});
