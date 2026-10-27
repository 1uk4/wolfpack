/** Feature threads over /v1: a registry of threads in one wolfd, concurrent turns, per-thread busy, persistence. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BusyError } from "@wolfpack/client";
import { fauxAssistantMessage, type FauxResponseStep } from "./scripted-model.js";
import { ScriptedEngine } from "./scripted-engine.js";
import { WolfServer } from "./server.js";
import { startTestWolf, type TestWolf } from "./test-wolf.js";
import { readFileSync } from "node:fs";

let tw: TestWolf | undefined;
afterEach(async () => {
  await tw?.stop();
  tw = undefined;
});

/** A model reply that waits for `gate` (the turn stays running until it opens). */
function gated(text: string): { step: FauxResponseStep; open: () => void } {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  return { step: async () => (await gate, fauxAssistantMessage(text)), open };
}
const drain = async (w: TestWolf, id: string) => {
  for await (const _ of w.client.watch(id));
};

describe("feature threads on a real wolf", () => {
  it("home and a feature thread run turns at the same time; busy is per thread", async () => {
    const home = gated("HOME_REPLY");
    tw = await startTestWolf({ script: [home.step, fauxAssistantMessage("FEATURE_REPLY")] });
    const feature = await tw.client.createThread!("testwolf", { kind: "feature", workItemId: "work-wolfpack-feat0001" });
    expect(feature).toMatchObject({ kind: "feature", boundWorkItem: "work-wolfpack-feat0001" });

    await tw.client.submit(tw.home, "slow one", { whenBusy: "reject" });
    await vi.waitFor(() => expect(tw!.scripted.faux.state.callCount).toBe(1)); // home's model call is in flight
    expect((await tw.client.getThread(tw.home)).busy).toBe(true);
    expect((await tw.client.getThread(feature.id)).busy).toBe(false);

    // the feature thread takes a turn while home is mid-turn
    await tw.client.submit(feature.id, "quick one", { whenBusy: "reject" });
    await drain(tw, feature.id);
    expect((await tw.client.getThread(feature.id)).messages.map((m) => m.text)).toEqual(["quick one", "FEATURE_REPLY"]);
    expect((await tw.client.getThread(tw.home)).busy).toBe(true);

    // busy stays per thread: home refuses a second turn, and the status of the wolf follows its threads
    await expect(tw.client.submit(tw.home, "again", { whenBusy: "reject" })).rejects.toBeInstanceOf(BusyError);
    expect((await tw.client.listWolves())[0].status).toBe("busy");

    home.open();
    await drain(tw, tw.home);
    const homeMessages = (await tw.client.getThread(tw.home)).messages.map((m) => m.text);
    expect(homeMessages).toEqual(["slow one", "HOME_REPLY"]);
    expect((await tw.client.listWolves())[0].status).toBe("online");
  });

  it("lists home and the feature threads; the same feature is one thread", async () => {
    tw = await startTestWolf({ script: [] });
    const a = await tw.client.createThread!("testwolf", { kind: "feature", workItemId: "work-wolfpack-feat0001" });
    const again = await tw.client.createThread!("testwolf", { kind: "feature", workItemId: "work-wolfpack-feat0001" });
    const b = await tw.client.createThread!("testwolf", { kind: "feature", workItemId: "work-wolfpack-feat0002" });
    expect(again.id).toBe(a.id);
    const threads = await tw.client.listThreads("testwolf");
    expect(threads.map((t) => [t.kind, t.id])).toEqual([
      ["home", tw.home],
      ["feature", a.id],
      ["feature", b.id],
    ]);
  });

  it("a feature thread's cards are listed with their own thread id; answering one leaves home alone", async () => {
    const { fauxToolCall } = await import("./scripted-model.js");
    tw = await startTestWolf({ script: [fauxAssistantMessage([fauxToolCall("ask_user_question", { question: "Which branch?" })], { stopReason: "toolUse" }), fauxAssistantMessage("done")] });
    const feature = await tw.client.createThread!("testwolf", { kind: "feature", workItemId: "work-wolfpack-feat0001" });
    await tw.client.submit(feature.id, "go", { whenBusy: "reject" });
    await drain(tw, feature.id);
    const cards = await tw.client.listCards!("testwolf");
    expect(cards).toHaveLength(1);
    expect(cards[0].threadId).toBe(feature.id);
    expect((await tw.client.getThread(feature.id)).pendingCards).toHaveLength(1);
    expect((await tw.client.listThreads("testwolf")).map((t) => t.status)).toEqual(["idle", "needs-you"]);
    await tw.client.answerCard!(feature.id, cards[0].callId, { answer: { value: "main" } });
    await drain(tw, feature.id);
    expect(await tw.client.listCards!("testwolf")).toEqual([]);
  });

  it("refuses a feature that another conversation already holds", async () => {
    tw = await startTestWolf({ script: [] });
    const den = tw.wolf.config.den;
    const { bindFeature } = await import("./threads.js");
    bindFeature(den, "1", { workId: "work-wolfpack-held0001", domain: "wolfpack" });
    await expect(tw.client.createThread!("testwolf", { kind: "feature", workItemId: "work-wolfpack-held0001" })).rejects.toThrow(/already bound/);
  });
});

describe("feature threads survive a restart", () => {
  it("a new WolfServer on the same den re-attaches the persisted threads", async () => {
    const den = mkdtempSync(join(tmpdir(), "wolfd-threads-"));
    const engines = new Map<string, ScriptedEngine>();
    let n = 0;
    const conversations = {
      create: async () => {
        const e = new ScriptedEngine({ delayMs: 1, id: `f${++n}` });
        engines.set(e.id, e);
        return e;
      },
      get: async (id: string) => engines.get(id),
    };
    const boot = async () => {
      const s = new WolfServer({ name: "w", den, conversation: new ScriptedEngine({ delayMs: 1 }), conversations });
      await s.attach();
      return { s, url: await s.listen() };
    };
    try {
      const first = await boot();
      const post = (url: string) => fetch(`${url}/v1/wolves/w/threads`, { method: "POST", body: JSON.stringify({ kind: "feature", workItemId: "work-wolfpack-feat0001" }) });
      const created = await post(first.url);
      expect(created.status).toBe(201);
      const summary = await created.json();
      await first.s.close();
      expect(JSON.parse(readFileSync(join(den, "wolfd", "threads.json"), "utf8")).threads).toHaveLength(1);

      const second = await boot();
      const list = await (await fetch(`${second.url}/v1/wolves/w/threads`)).json();
      expect(list.threads.map((t: { id: string }) => t.id)).toEqual(["w/home", summary.id]);
      expect((await post(second.url)).status).toBe(200); // idempotent across the restart
      await second.s.close();
    } finally {
      rmSync(den, { recursive: true, force: true });
    }
  });
});
