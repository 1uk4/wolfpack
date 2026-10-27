/**
 * Feature threads on a real sandboxed durable wolf (startTestWolf: real sqlite + pi-durable, scripted model, stubbed
 * memory Engine): a feature thread is an ownerless conversation bound to its feature; it observes and binds like home,
 * runs at the same time as home, and is still there (and bound) after a restart.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Engine } from "@wolfpack/engine";
import { takeSnapshot } from "@wolfpack/engine";
import { startLocalWorkServer } from "@wolfpack/agent";
import type { ToolContext } from "@wolfpack/harness/extension";
import { adaptToDurable } from "../../packages/harness/src/adapters/durable.js";
import { conversationReaderFor } from "../../packages/harness/src/engine/conversation-reader.js";
import { fauxAssistantMessage, type FauxResponseStep } from "../../packages/harness/src/wolfd/scripted-model.js";
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

function toolCtx(den: string, cid: number): ToolContext {
  const reader = conversationReaderFor(den)!;
  return {
    cwd: den, wolfDen: den, wolfName: "testwolf", conversationId: cid,
    conversation: { classify: () => reader.classify(cid), classifyOther: (id) => reader.classify(id), messagesSince: (a) => reader.messagesSince(cid, a) },
  };
}
const tool = async (den: string, cid: number, name: string, args: Record<string, unknown> = {}) => {
  const r = await tasks.tools!.find((t) => t.name === name)!.execute(args, toolCtx(den, cid));
  return { text: r.content[0].text, isError: !!r.isError };
};
/** The conversation id behind a feature thread (wolfd's registry). */
const conversationOf = (den: string, threadId: string): number =>
  Number(JSON.parse(readFileSync(join(den, "wolfd", "threads.json"), "utf8")).threads.find((t: { id: string }) => t.id === threadId).conversationId);

describe("feature threads", () => {
  it("bind to their feature at creation, observe like home, and run while home is mid-turn", async () => {
    const dev = await devRoot();
    const home = gated(say("A_HOME"));
    tw = await boot(dev, [home.step, fauxAssistantMessage(say("A_FEAT"))]);
    const den = tw.wolf.config.den;
    const featureId = await newFeature(tw);

    const thread = await tw.client.createThread!("testwolf", { kind: "feature", workItemId: featureId });
    const cid = conversationOf(den, thread.id);
    expect(cid).not.toBe(1);
    // bound at creation, in the memory extension's own shape (a feature binds itself: workId = featureId)
    expect(readBindingFile(den, cid)).toMatchObject({ workId: featureId, domain: "wolfpack", featureId });
    expect(readBindingFile(den, 1)).toBeNull();
    expect((await tool(den, cid, "task_current")).text).toContain(featureId);

    // home starts a turn and stays mid-turn while the feature thread takes its own
    await tw.client.submit(tw.home, say("MARK_HOME"), { whenBusy: "reject" });
    await vi.waitFor(() => expect(tw!.scripted.faux.state.callCount).toBe(1));
    await tw.client.submit(thread.id, say("MARK_FEAT"), { whenBusy: "reject" });
    await drain(thread.id);
    expect((await tw.client.getThread(tw.home)).busy).toBe(true);
    home.open();
    await drain(tw.home);

    await observed(tw, 1);
    await observed(tw, cid);
    // the task cache is per work item: the feature thread's first render filled its own file
    await waitFor(() => existsSync(join(den, "factory", "task-cache", `${featureId}.json`)));
    // the feature thread's talk is tagged to its feature; home's stays untagged; neither leaks into the other
    expect(pool(den).filter((o) => o.content.includes("MARK_FEAT"))).toMatchObject([{ work: featureId, feature: featureId }]);
    const homeObs = pool(den).filter((o) => o.content.includes("MARK_HOME"));
    expect(homeObs).toHaveLength(1);
    expect(homeObs[0].work).toBeUndefined();
    expect(pool(den).some((o) => o.content.includes("MARK_HOME") && o.content.includes("MARK_FEAT"))).toBe(false);
    expect((await tw.client.getMemoryStatus!("testwolf", { thread: thread.id })).bound).toMatchObject({ workId: featureId });
    expect((await tw.client.getMemoryStatus!("testwolf", { thread: tw.home })).bound).toBeNull();
  });

  it("are still there, and still bound, after a restart", async () => {
    const dev = await devRoot();
    tw = await boot(dev, []);
    const featureId = await newFeature(tw);
    const thread = await tw.client.createThread!("testwolf", { kind: "feature", workItemId: featureId });
    const den = tw.wolf.config.den;
    const cid = conversationOf(den, thread.id);
    await tw.stop();
    tw = undefined;

    tw = await boot(dev, [fauxAssistantMessage(say("A_AFTER"))]);
    expect((await tw.client.listThreads("testwolf")).map((t) => [t.kind, t.id])).toEqual([["home", tw.home], ["feature", thread.id]]);
    expect(readBindingFile(den, cid)).toMatchObject({ workId: featureId });
    await tw.client.submit(thread.id, say("MARK_AFTER"), { whenBusy: "reject" });
    await drain(thread.id);
    await observed(tw, cid);
    expect(pool(den).filter((o) => o.content.includes("MARK_AFTER"))).toMatchObject([{ work: featureId }]);
    expect((await tw.client.createThread!("testwolf", { kind: "feature", workItemId: featureId })).id).toBe(thread.id);
  });
});
