/** Context stats + manual compaction over /v1 on a real engine with a scripted model; wolf.yaml compaction policy pass-through. */
import { afterEach, describe, expect, it } from "vitest";
import { adaptToDurable } from "../adapters/durable.js";
import { DEFAULT_COMPACTION_POLICY } from "@earendil-works/pi-durable";
import { backgroundTokensFor, compactionSettings, contextTokens, DEFAULT_BACKGROUND_TOKENS, DEFAULT_RESERVE_TOKENS, thresholds } from "../engine/compaction.js";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage } from "./scripted-model.js";
import { startTestWolf, type TestWolf } from "./test-wolf.js";

let tw: TestWolf | undefined;
afterEach(async () => {
  await tw?.stop();
  tw = undefined;
});

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const v = await fn();
    if (ok(v)) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out");
}

describe("compaction policy", () => {
  it("derives backgroundTokens per model so startAt is absolute", () => {
    expect(backgroundTokensFor(1_000_000, 16384, 200_000)).toBe(1_000_000 - 16384 - 200_000);
    // a startAt past the blocking threshold never goes below pi-durable's default background window
    expect(backgroundTokensFor(100_000, 16384, 90_000)).toBe(32768);
    expect(thresholds(1_000_000, { startAt: 200_000 })).toEqual({ startAt: 200_000, waitAt: 1_000_000 - 16384 });
    expect(thresholds(1_000_000, undefined)).toEqual({ startAt: 1_000_000 - 16384 - 32768, waitAt: 1_000_000 - 16384 });
  });

  it("defaults match pi-durable; enabled:false omits startAt overrides and thresholds", async () => {
    expect(DEFAULT_RESERVE_TOKENS).toBe(DEFAULT_COMPACTION_POLICY.reserveTokens);
    expect(DEFAULT_BACKGROUND_TOKENS).toBe(DEFAULT_COMPACTION_POLICY.backgroundTokens);
    const { models } = (await import("./scripted-model.js")).createScriptedModel([]);
    expect(compactionSettings(models, { startAt: 1000, enabled: false })).toEqual({ enabled: false });
    expect(thresholds(1_000_000, { startAt: 1000, enabled: false })).toEqual({});
  });

  it("contextTokens ignores usage from before the head marker", () => {
    const usage = (n: number) => ({ input: n, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: n, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
    const asst = (n: number, text: string) => ({ role: "assistant", content: [{ type: "text", text }], usage: usage(n), stopReason: "stop" }) as never;
    const old = asst(900_000, "old tail");
    const summary = { role: "user", content: "summary", timestamp: 0 } as never;
    const fresh = asst(7_000, "fresh");
    const view = {
      head: { id: 5 },
      entries: [{ id: 5 }, { id: 3 }, { id: 6 }],
      contributions: [[summary], [old], [fresh]],
      messages: [summary, old, fresh],
    };
    expect(contextTokens(view)).toBe(7_000);
    expect(contextTokens({ ...view, entries: view.entries.slice(0, 2), contributions: view.contributions.slice(0, 2), messages: [summary, old] })).toBeLessThan(100);
  });

  it("passes the block to Harness.open settings: modelOverrides per registered model; absent block = no settings", async () => {
    tw = await startTestWolf({ script: [] });
    const models = tw.scripted.models;
    const m = models.getModels()[0]!;
    expect(compactionSettings(models, undefined)).toBeUndefined();
    expect(compactionSettings(createModels(), { startAt: 1 })).toEqual({});
    const s = compactionSettings(models, { startAt: 10_000, reserveTokens: 1000, keepRecentTokens: 5000, enabled: true })!;
    expect(s).toMatchObject({ enabled: true, reserveTokens: 1000, keepRecentTokens: 5000 });
    expect(s.modelOverrides![`${m.provider}/${m.id}`]).toEqual({ backgroundTokens: backgroundTokensFor(m.contextWindow, 1000, 10_000) });
  });

  it("wolf.yaml compaction: is accepted (no unknown-field warning) and reaches the stats thresholds", async () => {
    tw = await startTestWolf({ script: [], yaml: "compaction:\n  startAt: 50000\n" });
    expect(tw.wolf.config.compaction).toEqual({ startAt: 50000 });
    const c = await tw.client.getThreadContext!(tw.home);
    const m = tw.scripted.models.getModels()[0]!;
    expect(c.window).toBe(m.contextWindow);
    expect(c.startAt).toBe(Math.max(0, m.contextWindow - 16384 - backgroundTokensFor(m.contextWindow, 16384, 50000)));
  });
});

describe("context stats and manual compact", () => {
  it("reports stats, compacts with instructions, runs beforeCompact first, and announces updates", async () => {
    const order: string[] = [];
    let summaryContext = "";
    const ext = adaptToDurable(
      { name: "cap", hooks: { beforeCompact: async ({ reason }) => void order.push(`before:${reason}`) } },
      { wolfDen: "/tmp/none", wolfName: "testwolf" },
    );
    tw = await startTestWolf({
      script: [
        fauxAssistantMessage("pong"),
        fauxAssistantMessage("pong2"),
        (context) => {
          order.push("summary");
          summaryContext = JSON.stringify(context);
          return fauxAssistantMessage("SUMMARY-TEXT");
        },
      ],
      hooks: { extensions: [ext] },
      // A two-message transcript is shorter than the default keep-recent window: nothing would be summarised.
      yaml: "compaction:\n  keepRecentTokens: 1\n",
    });
    await tw.submit("ping");
    await tw.submit("and again");
    const before = await tw.client.getThreadContext!(tw.home);
    expect(before.tokens).toBeGreaterThan(0);
    expect(before.window).toBeGreaterThan(0);
    expect(before.waitAt).toBe(before.window! - 16384);
    expect(before.compactions).toEqual({ count: 0 });
    expect(before.compacting).toBe(false);

    const updates: string[] = [];
    const ac = new AbortController();
    void (async () => {
      try {
        for await (const e of tw!.client.watchActivity!("testwolf", { signal: ac.signal })) if (e.type === "thread-updated") updates.push(e.thread.id);
      } catch { /* closed */ }
    })();
    await new Promise((r) => setTimeout(r, 50));
    await tw.client.compactThread!(tw.home, "focus on the plan");
    const after = await until(() => tw!.client.getThreadContext!(tw!.home), (c) => c.compactions.count === 1 && !c.compacting);
    ac.abort();
    expect(after.compactions.lastAt).toBeTruthy();
    expect(order).toEqual(["before:manual", "summary"]);
    expect(summaryContext).toContain("focus on the plan");
    expect(updates.length).toBeGreaterThanOrEqual(2);
  });
});

describe("real engine: tokens after compaction, automatic compactions", () => {
  // The faux provider derives usage from the prompt size, so a big first input gives the early assistant message a big usage.
  it("does not keep reporting the old usage of a kept-tail assistant message after a compaction", async () => {
    tw = await startTestWolf({
      script: [fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("SUMMARY-TEXT")],
      yaml: "compaction:\n  keepRecentTokens: 1\n",
    });
    await tw.submit("x".repeat(100_000));
    await tw.submit("second");
    const before = await tw.client.getThreadContext!(tw.home);
    expect(before.tokens).toBeGreaterThanOrEqual(25_000);
    await tw.client.compactThread!(tw.home);
    const after = await until(() => tw!.client.getThreadContext!(tw!.home), (c) => c.compactions.count === 1 && !c.compacting);
    expect(after.tokens).toBeLessThan(15_000);
  });

  it("reports compacting for an automatic (background) compaction", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    tw = await startTestWolf({
      script: [fauxAssistantMessage("one"), fauxAssistantMessage("two"), async () => { await gate; return fauxAssistantMessage("SUMMARY-TEXT"); }],
      yaml: "compaction:\n  startAt: 40000\n  keepRecentTokens: 1\n",
    });
    await tw.submit("x".repeat(100_000));
    expect((await tw.client.getThreadContext!(tw.home)).compacting).toBe(false);
    void tw.submit("y".repeat(100_000)).catch(() => {});
    const during = await until(() => tw!.client.getThreadContext!(tw!.home), (c) => c.compacting);
    expect(during.compacting).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    release();
    const after = await until(() => tw!.client.getThreadContext!(tw!.home), (c) => !c.compacting && c.compactions.count === 1);
    expect(after.compactions.count).toBe(1);
  }, 20_000);
});

describe("context/compact routes on a scripted engine", () => {
  it("compacts while a turn runs (home and feature), passes instructions, reports compacting until done, bad bodies are rejected", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { ScriptedEngine } = await import("./scripted-engine.js");
    const { WolfServer } = await import("./server.js");
    const den = mkdtempSync(join(tmpdir(), "wolfd-compact-"));
    const home = new ScriptedEngine({ delayMs: 20, id: "900" });
    const feat = new ScriptedEngine({ delayMs: 1, id: "901" });
    const s = new WolfServer({ name: "w", den, conversation: home, conversations: { create: async () => feat, get: async (id: string) => (id === "901" ? feat : undefined) } });
    try {
      await s.attach();
      const url = await s.listen();
      const post = (id: string, body: unknown) => fetch(`${url}/v1/threads/${encodeURIComponent(id)}/compact`, { method: "POST", body: JSON.stringify(body) });
      const ctx = async (id: string) => (await fetch(`${url}/v1/threads/${encodeURIComponent(id)}/context`)).json();

      expect(await ctx("w/home")).toMatchObject({ tokens: 12_000, window: 1_000_000, compactions: { count: 0 }, compacting: false });
      expect((await post("w/home", { instructions: 3 })).status).toBe(400);
      expect((await post("w/nope", {})).status).toBe(404);

      // a turn is running: the compaction is still accepted
      await fetch(`${url}/v1/threads/w%2Fhome/messages`, { method: "POST", body: JSON.stringify({ text: "go", whenBusy: "reject" }) });
      let release!: () => void;
      home.compactGate = new Promise<void>((r) => (release = r));
      const r = await post("w/home", { instructions: "keep decisions" });
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ accepted: true });
      expect(home.compactCalls).toEqual(["keep decisions"]);
      expect((await ctx("w/home")).compacting).toBe(true);
      release();
      const done = await until(() => ctx("w/home"), (c) => c.compacting === false);
      expect(done.compactions.count).toBe(1);
      expect(typeof done.compactions.lastAt).toBe("string");

      // a second request while one is in flight returns the same compaction; a failure is reported in the stats
      home.compactFail = "boom";
      let rel2!: () => void;
      home.compactGate = new Promise<void>((r) => (rel2 = r));
      await post("w/home", {});
      await post("w/home", {});
      expect(home.compactCalls).toEqual(["keep decisions", undefined]);
      rel2();
      const failed = await until(() => ctx("w/home"), (c) => c.compacting === false);
      expect(failed.compactError).toBe("boom");
      expect(failed.compactions.count).toBe(1);
      // an empty body is {}
      home.compactGate = undefined;
      expect((await fetch(`${url}/v1/threads/w%2Fhome/compact`, { method: "POST" })).status).toBe(200);

      const f = await (await fetch(`${url}/v1/wolves/w/threads`, { method: "POST", body: JSON.stringify({ kind: "feature", workItemId: "work-wolfpack-feat0001" }) })).json();
      expect((await post(f.id, {})).status).toBe(200);
      expect(feat.compactCalls).toEqual([undefined]);
    } finally {
      await s.close();
      rmSync(den, { recursive: true, force: true });
    }
  });
});
