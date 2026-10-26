/**
 * Full-transcript observer, driven through a real sandboxed durable wolf (startTestWolf: real sqlite + pi-durable,
 * /v1 over HTTP, scripted model). The memory Engine is the stubbed `engine.call` seam; forks and task-owned
 * conversations are created through the opened Harness (engine.harness), because /v1 only drives the home thread.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Engine } from "@wolfpack/engine";
import { takeSnapshot } from "@wolfpack/engine";
import { startLocalWorkServer } from "@wolfpack/agent";
import { adaptToDurable } from "../../packages/harness/src/adapters/durable.js";
import { ENGINE_CONTEXT as ctx } from "../../packages/harness/src/engine/index.js";
import { conversationReaderFor } from "../../packages/harness/src/engine/conversation-reader.js";
import { fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "../../packages/harness/src/wolfd/scripted-model.js";
import { Park, parkExtension, startTestWolf, type TestWolf } from "../../packages/harness/src/wolfd/test-wolf.js";
import createMemoryExtension from "./unified.js";

const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), `obs-${p}-`));
  dirs.push(d);
  return d;
};
let tw: TestWolf | undefined;
afterEach(async () => {
  await tw?.stop();
  tw = undefined;
});

/** Pads a marker into a sentence long enough to pass the observer's minimum text length. */
const say = (marker: string) => `${marker}: we decided to cache the session lookups for five minutes because the profile endpoint was the hot path.`;
const reply = (marker: string) => fauxAssistantMessage(say(marker));
const toolTurn = (callMarker: string): FauxResponseStep =>
  fauxAssistantMessage([fauxText(say(callMarker)), fauxToolCall("write", { path: "out.txt", content: "TOOLFILE" })], { stopReason: "toolUse" });

/** Engine stub: every classify call is recorded (its prompt) and yields one distinct observation. */
function stubEngine() {
  const prompts: string[] = [];
  const steps: string[] = [];
  const engine = {
    call: async (step: string, schema: { parse: (v: unknown) => unknown }, args: { prompt: string }) => {
      steps.push(step);
      if (step === "classify") {
        prompts.push(args.prompt);
        return schema.parse({ observations: [{ timestamp: `2026-10-25 10:${String(prompts.length).padStart(2, "0")}`, content: `Observation number ${prompts.length} about caching` }] });
      }
      if (step === "consolidate") {
        return schema.parse({
          actions: [{ sessionTopicId: "x", action: "create", reasoning: "new", result: { id: "caching", title: "Caching", summary: "Session lookups are cached", body: "Cache session lookups for five minutes." } }],
        });
      }
      throw new Error(`unexpected step ${step}`);
    },
  } as unknown as Engine;
  return { engine, prompts, steps, text: () => prompts.join("\n=====\n") };
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

function startObserverWolf(opts: { dev: string; script: FauxResponseStep[]; engine: Engine; memoryYaml?: string }) {
  return startTestWolf({
    script: opts.script,
    yaml: `sandbox:\n  root: ${opts.dev}\n${opts.memoryYaml ?? ""}`,
    hooks: {
      extensions: ({ config, den, env }) => [
        parkExtension,
        adaptToDurable(
          createMemoryExtension(
            // config.memory is the wolf.yaml memory block as the loader normalizes it (incl. consolidation).
            { ...config.memory, engine: opts.engine },
            { wolfDen: den, wolfName: "testwolf", domains: ["wolfpack"], wolfConfig: { sandbox: config.sandbox }, env },
          ),
          { wolfDen: den, wolfName: "testwolf" },
        ),
      ],
    },
  });
}

async function waitFor(cond: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}
/** Observation is fire-and-forget after the turn: let it settle before asserting on absence/exact counts. */
const settle = () => new Promise((r) => setTimeout(r, 400));
const count = (hay: string, needle: string) => hay.split(needle).length - 1;
const watermarkFile = (den: string, cid: number) => join(den, ".memory", "watermarks", `${cid}.json`);

/** Harness-level helpers for conversations /v1 can't create. */
async function harnessOf(t: TestWolf) {
  const h = t.wolf.engine.harness;
  const root = (await h.conversation(1 as never, ctx))!;
  const newest = async () => (await root.entries({ order: "descending" }, 1, undefined, ctx)).items[0];
  const agent = { model: { provider: t.scripted.provider, modelId: t.scripted.modelId }, tools: [] as never[] };
  return { h, root, newest, agent };
}
async function runOn(conv: { submit: Function; waitForIdle: Function }, text: string) {
  await conv.submit({ type: "input", content: text, whenBusy: "reject" }, ctx);
  await conv.waitForIdle(ctx);
}

describe("full-transcript observer", () => {
  it("(a) a tool round observes user, assistant and tool result, each exactly once", async () => {
    const dev = await devRoot();
    const stub = stubEngine();
    tw = await startObserverWolf({ dev, engine: stub.engine, script: [toolTurn("ASSISTANT_CALL"), reply("ASSISTANT_FINAL")] });
    await tw.submit(say("USER_ONE"));
    await waitFor(() => count(stub.text(), "ASSISTANT_FINAL") >= 1);
    await settle();

    expect(tw.afterResponse).toHaveLength(2); // a tool round fires afterResponse twice
    const all = stub.text();
    for (const marker of ["USER_ONE", "ASSISTANT_CALL", "ASSISTANT_FINAL"]) expect(count(all, marker)).toBe(1);
    expect(count(all, "[Tool call: write(")).toBe(1);
    expect(count(all, "[Tool result:")).toBe(1);
    expect(all).toContain("[user]");
    // the unbound observations went to the pool
    const pool = readFileSync(join(dev, "den/.memory/pool/observations.jsonl"), "utf8");
    expect(pool.trim().split("\n")).toHaveLength(stub.prompts.length);
  });

  it("(b) a second turn captures only the new messages", async () => {
    const dev = await devRoot();
    const stub = stubEngine();
    tw = await startObserverWolf({ dev, engine: stub.engine, script: [reply("A_ONE"), reply("A_TWO")] });
    await tw.submit(say("USER_ONE"));
    await waitFor(() => count(stub.text(), "A_ONE") >= 1);
    await settle();
    const firstTurn = stub.prompts.length;

    await tw.submit(say("USER_TWO"));
    await waitFor(() => count(stub.text(), "A_TWO") >= 1);
    await settle();

    const second = stub.prompts.slice(firstTurn).join("\n");
    expect(second).toContain("USER_TWO");
    expect(second).toContain("A_TWO");
    expect(second).not.toContain("USER_ONE");
    expect(second).not.toContain("A_ONE");
    for (const marker of ["USER_ONE", "A_ONE", "USER_TWO", "A_TWO"]) expect(count(stub.text(), marker)).toBe(1);
  });

  it("(c) a fork captures too, but only its own messages after the fork point; (d) a task-owned conversation captures nothing", async () => {
    const dev = await devRoot();
    const stub = stubEngine();
    tw = await startObserverWolf({ dev, engine: stub.engine, script: [reply("A_ROOT"), reply("A_FORK"), reply("A_SUBAGENT")] });
    await tw.submit(say("USER_ROOT"));
    await waitFor(() => count(stub.text(), "A_ROOT") >= 1);
    await settle();
    const before = stub.prompts.length;
    const den = join(dev, "den");

    const { h, root, newest, agent } = await harnessOf(tw);
    const fork = await root.fork((await newest()).id, { ownership: { kind: "ownerless" }, agent }, ctx);
    await runOn(fork, say("USER_FORK"));
    await waitFor(() => count(stub.text(), "A_FORK") >= 1);
    await settle();

    const reader = conversationReaderFor(den)!;
    expect(await reader.classify(1)).toEqual({ kind: "root" });
    expect(await reader.classify(Number(fork.id))).toMatchObject({ kind: "fork", parentConversationId: 1, lineageRoot: 1 });

    const forkPrompts = stub.prompts.slice(before).join("\n");
    expect(forkPrompts).toContain("USER_FORK");
    expect(forkPrompts).toContain("A_FORK");
    expect(forkPrompts).not.toContain("USER_ROOT");
    expect(forkPrompts).not.toContain("A_ROOT");
    expect(existsSync(watermarkFile(den, Number(fork.id)))).toBe(true);

    // (d) a conversation owned by a task (a subagent) never captures
    const taskId = await h.commit((tx) => tx.createTask(Park, {}, { ownership: { kind: "conversation" }, conversationId: 1 as never }), ctx);
    const sub = await h.createConversation({ ownership: { kind: "task", taskId }, agent }, ctx);
    expect(await reader.classify(Number(sub.id))).toMatchObject({ kind: "task", taskId: Number(taskId) });
    const calls = stub.prompts.length;
    await runOn(sub, say("USER_SUBAGENT"));
    await settle();
    expect(stub.prompts.length).toBe(calls);
    expect(stub.text()).not.toContain("A_SUBAGENT");
    expect(stub.text()).not.toContain("USER_SUBAGENT");
    expect(existsSync(watermarkFile(den, Number(sub.id)))).toBe(false);
  });

  it("(e) the pool crossing memory.consolidation.threshold consolidates into dev den topics", async () => {
    const dev = await devRoot();
    const stub = stubEngine();
    tw = await startObserverWolf({
      dev,
      engine: stub.engine,
      script: [reply("A_ONE")],
      memoryYaml: "memory:\n  consolidation:\n    threshold: 20\n    poolTarget: 1\n",
    });
    expect(tw.wolf.config.memory.consolidation).toMatchObject({ threshold: 20, poolTarget: 1, trigger: "hybrid", interval: "4h" });
    await tw.submit(say("USER_ONE"));
    const topics = join(dev, "den/memory/topics");
    await waitFor(() => existsSync(topics) && readdirSync(topics).some((f) => f.endsWith(".md")));
    expect(readFileSync(join(topics, "caching.md"), "utf8")).toContain("Cache session lookups");
    expect(stub.steps).toContain("consolidate");
    // the archived observations left the pool
    const poolFile = join(dev, "den/.memory/pool/observations.jsonl");
    expect(existsSync(poolFile) ? readFileSync(poolFile, "utf8").trim() : "").toBe("");
  });

  it("(e, control) below the threshold nothing consolidates", async () => {
    const dev = await devRoot();
    const stub = stubEngine();
    tw = await startObserverWolf({ dev, engine: stub.engine, script: [reply("A_ONE")] });
    await tw.submit(say("USER_ONE"));
    await waitFor(() => stub.prompts.length >= 1);
    await settle();
    expect(stub.steps).not.toContain("consolidate");
    expect(existsSync(join(dev, "den/memory/topics"))).toBe(false);
  });

  it("(f) the watermark survives a wolf restart over the same dev root", async () => {
    const dev = await devRoot();
    const stub = stubEngine();
    tw = await startObserverWolf({ dev, engine: stub.engine, script: [reply("A_ONE")] });
    await tw.submit(say("USER_ONE"));
    await waitFor(() => count(stub.text(), "A_ONE") >= 1);
    await settle();
    const wm = JSON.parse(readFileSync(watermarkFile(join(dev, "den"), 1), "utf8"));
    expect(wm.lastEntryId).toBeGreaterThan(0);
    await tw.stop();
    tw = undefined;

    const stub2 = stubEngine();
    tw = await startObserverWolf({ dev, engine: stub2.engine, script: [reply("A_TWO")] });
    await tw.submit(say("USER_TWO"));
    await waitFor(() => count(stub2.text(), "A_TWO") >= 1);
    await settle();
    expect(stub2.text()).toContain("USER_TWO");
    expect(stub2.text()).not.toContain("USER_ONE");
    expect(stub2.text()).not.toContain("A_ONE");
  });
});
