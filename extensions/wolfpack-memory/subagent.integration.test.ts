/**
 * Subagents are memory-quiet and cannot bind, on a real sandboxed durable wolf (startTestWolf: real sqlite + pi-durable,
 * scripted model, stubbed memory Engine): a child of a feature thread records no observations and never binds, while the
 * feature thread itself observes and stays bound. Quiet comes from the child's conversation being task-owned.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Engine } from "@wolfpack/engine";
import { takeSnapshot } from "@wolfpack/engine";
import { startLocalWorkServer } from "@wolfpack/agent";
import { adaptToDurable } from "../../packages/harness/src/adapters/durable.js";
import { conversationReaderFor } from "../../packages/harness/src/engine/conversation-reader.js";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "../../packages/harness/src/wolfd/scripted-model.js";
import { parkExtension, startTestWolf, type TestWolf } from "../../packages/harness/src/wolfd/test-wolf.js";
import createMemoryExtension from "./unified.js";
import createTasksExtension from "./unified-tasks.js";
import { readBindingFile } from "./conversation-binding.js";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), `feat-${p}-`));
let tw: TestWolf | undefined;
beforeEach(() => vi.stubEnv("PI_SUBAGENT_AGENT", "")); // the main session, not a pi subagent child
afterEach(async () => {
  vi.unstubAllEnvs();
  await tw?.stop();
  tw = undefined;
});

const say = (marker: string) => `${marker}: we decided to cache the session lookups for five minutes because the profile endpoint was the hot path.`;

function gated(text: string): { step: FauxResponseStep; open: () => void } {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  return { step: async () => (await gate, fauxAssistantMessage(text)), open };
}

/** Every classify call yields one observation carrying the MARK_x found in the chunk. */
const stubEngine = (): Engine =>
  ({
    call: async (step: string, schema: { parse: (v: unknown) => unknown }, args: { prompt: string }) => {
      if (step !== "classify") throw new Error(`unexpected step ${step}`);
      const marks = [...new Set(args.prompt.match(/MARK_[A-Z0-9]+/g) ?? [])];
      return schema.parse({ observations: [{ timestamp: "2026-10-25 10:00", content: `Obs ${marks.join(",") || "none"}` }] });
    },
  }) as unknown as Engine;

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
const pool = (den: string): Array<{ content: string; work?: string; feature?: string }> => {
  const f = join(den, ".memory", "pool", "observations.jsonl");
  return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const drain = async (id: string) => {
  for await (const _ of tw!.client.watch(id));
};

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

let tasks!: ReturnType<typeof createTasksExtension>;
function boot(dev: string, script: FauxResponseStep[]) {
  const engine = stubEngine();
  return startTestWolf({
    script,
    yaml: `sandbox:\n  root: ${dev}\n`,
    hooks: {
      extensions: ({ config, den, env }) => {
        const c = { wolfDen: den, wolfName: "testwolf", domains: ["wolfpack"], wolfConfig: { sandbox: config.sandbox }, env };
        tasks = createTasksExtension({ autoShip: true }, c);
        const memory = createMemoryExtension({ ...config.memory, engine }, c);
        return [parkExtension, adaptToDurable(memory, { wolfDen: den, wolfName: "testwolf" }), adaptToDurable(tasks, { wolfDen: den, wolfName: "testwolf" })];
      },
    },
  });
}

async function newFeature(t: TestWolf): Promise<string> {
  const sb = t.wolf.sandbox!;
  const res = await fetch(`${sb.resolved.workEndpoint}/work`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": sb.env.WORK_TOKEN },
    body: JSON.stringify({ kind: "feature", domain: "wolfpack", title: "multi feature", assignee: "owner" }),
  });
  return ((await res.json()) as { id: string }).id;
}

/** The conversation id behind a feature thread (wolfd's registry). */
const conversationOf = (den: string, threadId: string): number =>
  Number(JSON.parse(readFileSync(join(den, "wolfd", "threads.json"), "utf8")).threads.find((t: { id: string }) => t.id === threadId).conversationId);


const PROFILE = "---\nname: binder\ndescription: tries to bind\nmodel: fast\ntools: read, task_bind, task_current\n---\n\nYou are a test agent.\n";

/** The feature thread spawns "binder"; the child tries to bind, then answers with MARK_CHILD. */
function agents(otherWork: string): FauxResponseStep {
  return async (ctx) => {
    const system = JSON.stringify(ctx.messages.filter((m) => m.role === "system"));
    const child = system.includes("You are the sub-agent");
    const last = ctx.messages[ctx.messages.length - 1];
    const text = typeof last.content === "string" ? last.content : (last.content as Array<{ type: string; text?: string }>).map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("");
    const call = (name: string, args: Record<string, string>) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
    if (!child) {
      if (last.role === "toolResult") return fauxAssistantMessage(say("A_FEAT_SPAWNED"));
      if (text.includes("spawn the binder")) return call("subagent", { agent: "binder", task: "try to bind, then report" });
      return fauxAssistantMessage(say("A_FEAT_SAW_RESULT"));
    }
    if (last.role === "toolResult" && last.toolName === "task_bind") return fauxAssistantMessage(say("MARK_CHILD done"));
    return call("task_bind", { id: otherWork });
  };
}

describe("subagents", () => {
  it("record no observations and cannot bind, while the feature thread observes and stays bound", async () => {
    const dev = await devRoot();
    tw = await boot(dev, Array.from({ length: 30 }, () => agents("MARK_CHILDARG")));
    const den = tw.wolf.config.den;
    mkdirSync(join(tw.root, "agent", "agents"), { recursive: true });
    writeFileSync(join(tw.root, "agent", "agents", "binder.md"), PROFILE);
    const featureId = await newFeature(tw);
    const thread = await tw.client.createThread!("testwolf", { kind: "feature", workItemId: featureId });
    const cid = conversationOf(den, thread.id);

    await tw.client.submit(thread.id, say("MARK_FEAT spawn the binder"), { whenBusy: "reject" });
    await drain(thread.id);
    await vi.waitFor(async () => expect((await tw!.client.listChildren!(thread.id))[0]?.state).toBe("done"), { timeout: 8000 });
    const [child] = await tw.client.listChildren!(thread.id);
    // the child serves the work item its parent is bound to
    expect(child).toMatchObject({ kind: "subagent", parentThreadId: thread.id, agent: "binder", taskId: featureId });

    // the child tried to bind and was refused; it holds no binding, the feature thread keeps its own
    const calls = (await tw.client.getThread(child.id)).messages.flatMap((m) => m.tools ?? []);
    expect(calls.find((t) => t.name === "task_bind")?.result).toContain("don't bind");
    const childCid = Number(JSON.parse(readFileSync(join(den, "wolfd", "subagents.json"), "utf8")).children[0].conversationId);
    expect(readBindingFile(den, childCid)).toBeNull();
    expect(readBindingFile(den, cid)).toMatchObject({ workId: featureId });
    expect(readBindingFile(den, 1)).toBeNull();
    expect(await conversationReaderFor(den)!.classify(childCid)).toMatchObject({ kind: "task" });

    // the parent takes the result in a turn of its own, then the feature thread's talk is observed; the child's is not
    await vi.waitFor(async () => {
      const d = await tw!.client.getThread(thread.id);
      expect(d.busy).toBe(false);
      expect(d.messages.some((m) => m.text.includes("A_FEAT_SAW_RESULT"))).toBe(true);
    });
    await observed(tw, cid);
    await new Promise((r) => setTimeout(r, 300));
    const obs = pool(den);
    expect(obs.length).toBeGreaterThan(0);
    for (const o of obs) expect(o).toMatchObject({ work: featureId, feature: featureId });
    // MARK_CHILDARG appears only in the child's own tool call: it was never observed (the child's final answer, MARK_CHILD,
    // reaches the parent as a message and is part of the parent's record)
    expect(obs.some((o) => o.content.includes("MARK_CHILDARG"))).toBe(false);
    expect(obs.some((o) => o.content.includes("MARK_CHILD"))).toBe(true);
    expect(existsSync(watermarkFile(den, childCid))).toBe(false);
  }, 30_000);
});
