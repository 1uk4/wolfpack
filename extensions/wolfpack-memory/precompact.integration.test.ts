/**
 * Pre-compaction capture: a durable conversation's uncaptured messages are observed before the compaction summary
 * replaces them (pi's session_before_compact analogue). Driven through a Harness opened the createWolfHarness way
 * (Harness.open + attachConversationReader + the adapted memory extension): the wolf runtime exposes no compaction
 * settings, and a manual compaction only summarizes when keepRecentTokens is small enough to leave something to replace.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Engine } from "@wolfpack/engine";
import { createRegistry, Harness } from "../../packages/harness/node_modules/@earendil-works/pi-durable/dist/index.js";
import { NodeExecutionEnv } from "../../packages/harness/node_modules/@earendil-works/pi-durable/dist/env/node.js";
import { openNodeSqliteStorage } from "../../packages/harness/node_modules/@earendil-works/pi-durable/dist/storage/sqlite/node.js";
import { adaptToDurable } from "../../packages/harness/src/adapters/durable.js";
import { attachConversationReader } from "../../packages/harness/src/engine/conversation-reader.js";
import { ENGINE_CONTEXT as ctx } from "../../packages/harness/src/engine/index.js";
import { createScriptedModel, fauxAssistantMessage } from "../../packages/harness/src/wolfd/scripted-model.js";
import { Park, parkExtension } from "../../packages/harness/src/wolfd/test-wolf.js";
import createMemoryExtension from "./unified.js";

const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), `pc-${p}-`));
  dirs.push(d);
  return d;
};
let closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function stubEngine() {
  const prompts: string[] = [];
  const engine = {
    call: async (step: string, schema: { parse: (v: unknown) => unknown }, args: { prompt: string }) => {
      if (step !== "classify") throw new Error(`unexpected step ${step}`);
      prompts.push(args.prompt);
      return schema.parse({ observations: [{ timestamp: "2026-10-25 10:00", content: `Observation ${prompts.length}` }] });
    },
  } as unknown as Engine;
  return { engine, prompts, text: () => prompts.join("\n=====\n") };
}

async function openHost(script: ReturnType<typeof fauxAssistantMessage>[]) {
  const dir = tmp("host");
  const stub = stubEngine();
  const sm = createScriptedModel(script);
  const registry = createRegistry();
  registry.install(parkExtension);
  registry.install(adaptToDurable(createMemoryExtension({ live: true, engine: stub.engine }, { wolfDen: dir, wolfName: "w", domains: ["wolfpack"], wolfConfig: {}, env: {} }), { wolfDen: dir, wolfName: "w" }));
  const harness = await Harness.open(
    await openNodeSqliteStorage(join(dir, "session.sqlite")),
    { models: sm.models, registry, settings: { compaction: { keepRecentTokens: 1 } }, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? dir }) },
    ctx,
  );
  const detach = attachConversationReader(harness, dir, { hostConsolidationTimer: true });
  closers.push(async () => {
    detach();
    await harness.close(ctx);
  });
  const agent = { model: { provider: sm.provider, modelId: sm.modelId } };
  return { dir, stub, harness, agent };
}

async function waitFor(cond: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}
const quiet = () => new Promise((r) => setTimeout(r, 300));
const count = (hay: string, needle: string) => hay.split(needle).length - 1;

/** The observer caught up: the watermark reached the conversation's newest committed entry. */
async function watermarkAtEnd(dir: string, conv: any, newest: number): Promise<void> {
  await waitFor(() => {
    try {
      return JSON.parse(readFileSync(join(dir, ".memory/watermarks", `${Number(conv.id)}.json`), "utf8")).lastEntryId >= newest;
    } catch {
      return false;
    }
  });
}

/** Short turns: together under the observer's minimum text length, so afterResponse alone captures nothing. */
async function turns(conv: any, prefix: string, n: number, den?: string) {
  for (let i = 1; i <= n; i++) {
    await conv.submit({ type: "input", content: `${prefix}${i}`, whenBusy: "reject" }, ctx);
    await conv.waitForIdle(ctx);
    // The first observation seeds the watermark ("start from now"): let it land before the next turn.
    if (i === 1 && den) await waitFor(() => existsSync(join(den, ".memory/watermarks", `${Number(conv.id)}.json`)));
  }
}
/** Manual compaction; returns whether it replaced anything (a summary was written). */
async function compact(harness: any, conv: any): Promise<boolean> {
  const id = await conv.compact(undefined, ctx);
  const task = await harness.waitForTask(id, ctx);
  return task.state.outcome.status === "completed" && !!(task.state.outcome.result?.entryId ?? task.state.outcome.result?.submissionId);
}

describe("pre-compaction capture", () => {
  it("observes uncaptured messages before compaction, and nothing twice afterwards", async () => {
    const { dir, stub, harness, agent } = await openHost(["R1", "R2", "R3", "SUMMARY", "R4"].map((t) => fauxAssistantMessage(t)));
    const root = await harness.root(ctx, { agent });
    harness.resume();
    await turns(root, "U", 3, dir);
    await quiet();
    expect(stub.prompts).toHaveLength(0); // below the minimum: still accumulating

    const newest = Number((await root.entries({ order: "descending" }, 1, undefined, ctx)).items[0].id);
    expect(await compact(harness, root)).toBe(true);
    await watermarkAtEnd(dir, root, newest);
    for (const m of ["U1", "R1", "U3", "R3"]) expect(count(stub.text(), m)).toBe(1);
    expect(readFileSync(join(dir, ".memory/pool/observations.jsonl"), "utf8")).toContain("Observation 1");

    // after the compaction a new turn observes only itself
    const calls = stub.prompts.length;
    await root.submit({ type: "input", content: "NEWUSER after the compaction, a decision long enough to pass the observer's minimum text length.", whenBusy: "reject" }, ctx);
    await root.waitForIdle(ctx);
    await waitFor(() => stub.prompts.length > calls);
    const added = stub.prompts.slice(calls).join("\n");
    expect(added).toContain("NEWUSER");
    for (const m of ["U1", "U3", "R1", "R3"]) expect(added).not.toContain(m);
    for (const m of ["U1", "R3"]) expect(count(stub.text(), m)).toBe(1);
  });

  it("a task-owned conversation stays quiet through compaction", async () => {
    const { dir, stub, harness, agent } = await openHost(["S1", "S2", "S3", "SUMMARY"].map((t) => fauxAssistantMessage(t)));
    await harness.root(ctx, { agent });
    harness.resume();
    const taskId = await harness.commit((tx: any) => tx.createTask(Park, {}, { ownership: { kind: "conversation" }, conversationId: 1 as never }), ctx);
    const sub = await harness.createConversation({ ownership: { kind: "task", taskId }, agent: { ...agent, tools: [] } }, ctx);
    await turns(sub, "T", 3);
    expect(await compact(harness, sub)).toBe(true); // it did compact, and still captured nothing
    await quiet();
    expect(stub.prompts).toHaveLength(0);
    expect(existsSync(join(dir, ".memory", "watermarks", `${Number(sub.id)}.json`))).toBe(false);
  });

  it("a flush failure never blocks the compaction", async () => {
    const { dir, stub, harness, agent } = await openHost(["R1", "R2", "R3", "SUMMARY"].map((t) => fauxAssistantMessage(t)));
    stub.engine.call = (async () => {
      throw new Error("engine down");
    }) as never;
    const root = await harness.root(ctx, { agent });
    harness.resume();
    await turns(root, "U", 3, dir);
    expect(await compact(harness, root)).toBe(true);
  });
});
