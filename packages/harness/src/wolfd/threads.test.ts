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
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { bindFeature } from "./threads.js";

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

describe("a graduated feature's thread is read-only history", () => {
  it("graduation (the unbind marker) closes it: reads work, submit and answer answer thread_closed, home is untouched", async () => {
    tw = await startTestWolf({ script: [fauxAssistantMessage("HOME_OK")] });
    const den = tw.wolf.config.den;
    const feature = await tw.client.createThread!("testwolf", { kind: "feature", workItemId: "work-wolfpack-grad0001" });
    expect(feature.closed).toBeUndefined();
    const { unbindCompleted, readBindingFile } = await import("@wolfpack/memory");
    const cid = Number(JSON.parse(readFileSync(join(den, "wolfd", "threads.json"), "utf8")).threads.find((t: { id: string }) => t.id === feature.id).conversationId);
    expect(readBindingFile(den, cid)?.workId).toBe("work-wolfpack-grad0001");
    unbindCompleted(den, { workIds: ["work-wolfpack-grad0001"], viaFeature: true, title: "Grad", id: "work-wolfpack-grad0001" });
    expect(readBindingFile(den, cid)).toBeNull();

    const err = await tw.client.submit(feature.id, "more", { whenBusy: "reject" }).catch((e) => e);
    expect(err).toMatchObject({ code: "thread_closed", message: "This feature has graduated; its thread is read-only history. Start a new feature or use home." });
    const detail = await tw.client.getThread(feature.id);
    expect(detail).toMatchObject({ closed: true });
    expect((await tw.client.listThreads("testwolf")).find((t) => t.id === feature.id)?.closed).toBe(true);
    await expect(tw.client.answerCard!(feature.id, "call-1", { answer: { value: "x" } })).rejects.toMatchObject({ code: "thread_closed" });
    await tw.client.submit(tw.home, "hi", { whenBusy: "reject" }); // home still takes turns
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

describe("feature thread robustness", () => {
  const withDen = async (fn: (den: string) => Promise<void>) => {
    const den = mkdtempSync(join(tmpdir(), "wolfd-robust-"));
    try {
      await fn(den);
    } finally {
      rmSync(den, { recursive: true, force: true });
    }
  };
  const factory = (den: string, opts: { get?: (id: string) => Promise<ScriptedEngine | undefined>; failAttach?: boolean } = {}) => {
    const engines = new Map<string, ScriptedEngine>();
    let n = 0;
    const errors: string[] = [];
    const conversations = {
      create: async () => {
        const e = new ScriptedEngine({ delayMs: 1, id: `${100 + ++n}` });
        if (opts.failAttach) e.watch = async () => { throw new Error("watch failed"); };
        engines.set(e.id, e);
        return e;
      },
      get: opts.get ?? (async (id: string) => engines.get(id)),
    };
    const server = () => new WolfServer({ name: "w", den, conversation: new ScriptedEngine({ delayMs: 1 }), conversations, onError: (e) => errors.push(String(e)) });
    return { server, errors, engines };
  };
  const post = (url: string, workItemId: string) => fetch(`${url}/v1/wolves/w/threads`, { method: "POST", body: JSON.stringify({ kind: "feature", workItemId }) });

  it("a corrupt registry is moved aside and reported; earlier threads are not lost to the next save", async () => {
    await withDen(async (den) => {
      const f = factory(den);
      mkdirSync(join(den, "wolfd"), { recursive: true });
      writeFileSync(join(den, "wolfd", "threads.json"), "{ not json");
      const s = f.server();
      await s.attach();
      const url = await s.listen();
      try {
        expect(f.errors.join("\n")).toMatch(/moved to .*threads\.json\.corrupt-/);
        const aside = readdirSync(join(den, "wolfd")).filter((n) => n.includes(".corrupt-"));
        expect(aside).toHaveLength(1);
        expect(readFileSync(join(den, "wolfd", aside[0]), "utf8")).toBe("{ not json");
        expect((await post(url, "work-wolfpack-feat0001")).status).toBe(201);
        expect(JSON.parse(readFileSync(join(den, "wolfd", "threads.json"), "utf8")).threads).toHaveLength(1);
        expect(readFileSync(join(den, "wolfd", aside[0]), "utf8")).toBe("{ not json"); // untouched
      } finally {
        await s.close();
      }
    });
  });

  it("a persisted thread that fails to attach is skipped; wolfd still starts with the others", async () => {
    await withDen(async (den) => {
      const f = factory(den);
      const first = f.server();
      await first.attach();
      const url1 = await first.listen();
      await post(url1, "work-wolfpack-feat0001");
      await post(url1, "work-wolfpack-feat0002");
      await first.close();

      const bad = [...f.engines.values()][0];
      const f2 = factory(den, {
        get: async (id) => {
          if (id === bad.id) throw new Error("reconcile blew up");
          return f.engines.get(id);
        },
      });
      const s = f2.server();
      await s.attach();
      const url = await s.listen();
      try {
        const list = await (await fetch(`${url}/v1/wolves/w/threads`)).json();
        expect(list.threads.map((t: { id: string }) => t.id)).toEqual(["w/home", "w/feature-work-wolfpack-feat0002"]);
        expect(f2.errors.join("\n")).toMatch(/feature-work-wolfpack-feat0001 not attached: reconcile blew up/);
      } finally {
        await s.close();
      }
    });
  });

  it("a create that fails after binding rolls the binding and registry entry back, so a retry works", async () => {
    await withDen(async (den) => {
      const f = factory(den, { failAttach: true });
      const s = f.server();
      await s.attach();
      const url = await s.listen();
      try {
        const res = await post(url, "work-wolfpack-feat0001");
        expect(res.status).toBe(502);
        expect(existsSync(join(den, "wolfd", "threads.json")) ? JSON.parse(readFileSync(join(den, "wolfd", "threads.json"), "utf8")).threads : []).toEqual([]);
        const cid = [...f.engines.keys()][0];
        expect(existsSync(join(den, "factory", "conversations", cid, "active-task.json")) ? readFileSync(join(den, "factory", "conversations", cid, "active-task.json"), "utf8") : "null").toBe("null");
        expect((await (await fetch(`${url}/v1/wolves/w/threads`)).json()).threads).toHaveLength(1); // home only
      } finally {
        await s.close();
      }
    });
  });

  it("an orphan binding (not home, not in the registry) is taken over; a non-numeric directory is ignored", async () => {
    await withDen(async (den) => {
      const f = factory(den);
      bindFeature(den, "55", { workId: "work-wolfpack-orph0001", domain: "wolfpack" }); // a crash left this behind
      bindFeature(den, "scripted", { workId: "work-wolfpack-home0001", domain: "wolfpack" }); // not an integer dir: ignored
      const s = f.server();
      await s.attach();
      const url = await s.listen();
      try {
        expect((await post(url, "work-wolfpack-orph0001")).status).toBe(201);
        expect(readFileSync(join(den, "factory", "conversations", "55", "active-task.json"), "utf8")).toBe("null");
        const id = [...f.engines.keys()][0];
        expect(JSON.parse(readFileSync(join(den, "factory", "conversations", id, "active-task.json"), "utf8")).workId).toBe("work-wolfpack-orph0001");
      } finally {
        await s.close();
      }
    });
  });
});
