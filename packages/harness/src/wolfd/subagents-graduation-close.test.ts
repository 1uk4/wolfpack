/** Graduation closes the feature's sub-agent threads: settled now, running ones as they settle, old ones at startup. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { registerGraduationActions } from "../memory/actions.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "./scripted-model.js";
import { startTestWolf, type TestWolf } from "./test-wolf.js";

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (stops.length) await stops.pop()!();
});

const PROFILE = "---\nname: tester\ndescription: A scripted test agent\nmodel: fast\ntools: read, grep\n---\n\nYou are a test agent.\n";

function script(gate: Promise<void>): FauxResponseStep {
  return async (ctx, options) => {
    const child = JSON.stringify(ctx.messages.filter((m) => m.role === "system")).includes("You are the sub-agent");
    const last = ctx.messages[ctx.messages.length - 1]!;
    const text = typeof last.content === "string" ? last.content : (last.content as Array<{ type: string; text?: string }>).map((b) => b.text ?? "").join("");
    if (!child) {
      if (last.role === "toolResult") return fauxAssistantMessage("spawned");
      const m = /^spawn (\w+)/.exec(text);
      if (m) return fauxAssistantMessage(fauxToolCall("subagent", { agent: "tester", task: m[1] === "slow" ? "SLOW work" : "quick work", name: m[1]! }), { stopReason: "toolUse" });
      return fauxAssistantMessage("ack");
    }
    if (text.includes("SLOW")) await Promise.race([gate, new Promise<void>((r) => options?.signal?.addEventListener("abort", () => r()))]);
    return fauxAssistantMessage("CHILD_DONE");
  };
}

async function boot(root?: string, env?: Record<string, string>) {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const step = script(gate);
  const w = await startTestWolf({ script: Array.from({ length: 60 }, () => step), ...(root ? { root } : {}), ...(env ? { env } : {}) });
  stops.push(() => w.stop());
  mkdirSync(join(w.root, "agent", "agents"), { recursive: true });
  writeFileSync(join(w.root, "agent", "agents", "tester.md"), PROFILE);
  return { w, open };
}
type Mgr = { records: Array<{ id: string; parentThreadId: string }> };
const mgr = (w: TestWolf) => (w.wolf.server as unknown as { subagents: Mgr }).subagents;
const byTitle = async (w: TestWolf) => new Map((await w.client.listThreads("testwolf")).map((t) => [t.title ?? t.id, t]));

describe("graduation closes the feature's sub-agent threads", () => {
  it("closes settled children (and nested ones), leaves a running one until it settles", async () => {
    const { w, open } = await boot();
    const feature = await w.client.createThread!("testwolf", { kind: "feature", workItemId: "work-wolfpack-grad0002" });
    await w.client.submit(feature.id, "spawn quick", { whenBusy: "reject" });
    for await (const _ of w.client.watch(feature.id));
    await w.client.submit(feature.id, "spawn nested", { whenBusy: "reject" });
    for await (const _ of w.client.watch(feature.id));
    await w.client.submit(feature.id, "spawn slow", { whenBusy: "reject" });
    for await (const _ of w.client.watch(feature.id));
    await vi.waitFor(async () => expect((await byTitle(w)).get("nested")?.state).toBe("done"), { timeout: 5000 });
    expect((await byTitle(w)).get("slow")?.state).toBe("running");

    // nested: re-parent "nested" under "quick"
    const ids = await byTitle(w);
    mgr(w).records.find((r) => r.id === ids.get("nested")!.id)!.parentThreadId = ids.get("quick")!.id;

    const closed = (w.wolf.server as unknown as { closeFeatureThreads(i: string[]): string[] }).closeFeatureThreads(["work-wolfpack-grad0002"]);
    expect(closed).toContain(feature.id);
    expect(closed).toContain(ids.get("quick")!.id);
    expect(closed).toContain(ids.get("nested")!.id);
    expect(closed).not.toContain(ids.get("slow")!.id);

    let now = await byTitle(w);
    expect(now.get("quick")?.closed).toBe(true);
    expect(now.get("nested")?.closed).toBe(true);
    expect(now.get("slow")).toMatchObject({ state: "running" });
    expect(now.get("slow")?.closed).toBeUndefined();
    expect(now.get("home")?.closed ?? (await w.client.getThread(w.home)).closed).toBeFalsy();

    open();
    await vi.waitFor(async () => expect((await byTitle(w)).get("slow")).toMatchObject({ state: "done", closed: true }), { timeout: 5000 });
    now = await byTitle(w);
    expect(now.get("slow")?.closedReason).toBeTruthy();
  });

  it("backfill: after a restart the children of an already closed feature come back closed", async () => {
    const root = mkdtempSync(join(tmpdir(), "grad-close-"));
    stops.push(async () => rmSync(root, { recursive: true, force: true }));
    const first = await boot(root);
    const feature = await first.w.client.createThread!("testwolf", { kind: "feature", workItemId: "work-wolfpack-grad0003" });
    await first.w.client.submit(feature.id, "spawn quick", { whenBusy: "reject" });
    for await (const _ of first.w.client.watch(feature.id));
    await vi.waitFor(async () => expect((await byTitle(first.w)).get("quick")?.state).toBe("done"), { timeout: 5000 });
    (first.w.wolf.server as unknown as { closeFeatureThreads(i: string[]): string[] }).closeFeatureThreads(["work-wolfpack-grad0003"]);
    await stops.pop()!(); // stop the first wolf (root is kept)

    const second = await boot(root);
    const quick = (await byTitle(second.w)).get("quick");
    expect(quick).toMatchObject({ state: "done", closed: true });
  });

  it("closeChildrenOf announces only changed children, is idempotent and survives a parent cycle", async () => {
    const { w, open } = await boot();
    const feature = await w.client.createThread!("testwolf", { kind: "feature", workItemId: "work-wolfpack-grad0004" });
    await w.client.submit(feature.id, "spawn quick", { whenBusy: "reject" });
    for await (const _ of w.client.watch(feature.id));
    await w.client.submit(feature.id, "spawn slow", { whenBusy: "reject" });
    for await (const _ of w.client.watch(feature.id));
    await vi.waitFor(async () => expect((await byTitle(w)).get("quick")?.state).toBe("done"), { timeout: 5000 });
    const ids = await byTitle(w);
    const quickId = ids.get("quick")!.id;
    const slowId = ids.get("slow")!.id;
    (w.wolf.server as unknown as { closeFeatureThreads(i: string[]): string[] }).closeFeatureThreads(["work-wolfpack-grad0004"]);

    const sm = (w.wolf.server as unknown as { subagents: { closeChildrenOf(id: string): string[] } }).subagents;
    const events: string[] = [];
    const port = (sm as unknown as { port: { emitWolf(e: { type: string; thread?: { id: string } }): void } }).port;
    const orig = port.emitWolf.bind(port);
    port.emitWolf = (e) => {
      if (e.type === "thread-updated" && e.thread) events.push(e.thread.id);
      orig(e);
    };
    // already closed: reported again, but nothing is re-announced; the running child is neither announced nor reported
    const again = sm.closeChildrenOf(feature.id);
    expect(again).toContain(quickId);
    expect(again).not.toContain(slowId);
    expect(events).toEqual([]);

    // a parent cycle (quick <-> slow's parent chain) terminates
    const recs = mgr(w).records;
    recs.find((r) => r.id === quickId)!.parentThreadId = quickId;
    expect(() => sm.closeChildrenOf(quickId)).not.toThrow();
    recs.find((r) => r.id === quickId)!.parentThreadId = feature.id;
    open();
  });

});

/** Closing is announced once per thread, from the one place every close path uses. */
describe("a closed thread is announced as thread-updated, once", () => {
  const stage = new Map<string, string>();
  let workServer: Server | undefined;
  let endpoint = "";
  afterEach(async () => {
    const s = workServer;
    workServer = undefined;
    stage.clear();
    if (s) await new Promise<void>((r) => s.close(() => r()));
  });
  /** A wolf wired to a Work API stand-in (GET /work/<id> answers the stage the test set) and a fake graduation. */
  async function bootWork(root?: string) {
    if (!workServer) {
      workServer = createServer((req, res) => {
        const id = decodeURIComponent((req.url ?? "").split("/").pop() ?? "");
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ item: { id, stage: stage.get(id) ?? "build", graduated: null }, body: "" }));
      });
      await new Promise<void>((r) => workServer!.listen(0, "127.0.0.1", r));
      endpoint = `http://127.0.0.1:${(workServer.address() as AddressInfo).port}`;
    }
    const b = await boot(root, { WORK_ENDPOINT: endpoint, WORK_TOKEN: "t" });
    registerGraduationActions(b.w.wolf.config.den, {
      preview: async () => {
        throw new Error("unused");
      },
      confirm: async () => ({ entries: [], archived: [], lateFolded: 0, unbound: 0 }),
      pendingPreview: async () => undefined,
      observations: async () => ({ total: 0, byWork: [] }),
    });
    return b;
  }
  /** Collects the thread ids of closed thread-updated events; a watcher error fails the test at until()/stop(). */
  function collect(w: TestWolf, from?: string) {
    const ac = new AbortController();
    const closed: string[] = [];
    const updated: string[] = []; // every event type seen
    const threadEvents: Array<{ id: string; closed: boolean }> = []; // thread-updated, in order
    let failure: unknown;
    const done = (async () => {
      for await (const e of w.client.watchActivity!("testwolf", { signal: ac.signal, ...(from !== undefined ? { from } : {}) })) {
        updated.push(e.type);
        if (e.type === "thread-updated") threadEvents.push({ id: e.thread.id, closed: !!e.thread.closed });
        if (e.type === "thread-updated" && e.thread.closed) closed.push(e.thread.id);
      }
    })().catch((e) => {
      if (!ac.signal.aborted) failure = e;
    });
    return {
      closed,
      updated,
      threadEvents,
      async until(pred: () => boolean) {
        await vi.waitFor(() => {
          if (failure) throw failure;
          expect(pred()).toBe(true);
        }, { timeout: 5000 });
      },
      async stop() {
        ac.abort();
        await done;
        if (failure) throw failure;
      },
    };
  }

  it("confirming a graduation announces the feature thread and its idle child at once, and a running child when it settles", async () => {
    const { w, open } = await bootWork();
    const feature = await w.client.createThread!("testwolf", { kind: "feature", workItemId: "work-wolfpack-grad0005" });
    await w.client.submit(feature.id, "spawn quick", { whenBusy: "reject" });
    for await (const _ of w.client.watch(feature.id));
    await w.client.submit(feature.id, "spawn slow", { whenBusy: "reject" });
    for await (const _ of w.client.watch(feature.id));
    await vi.waitFor(async () => expect((await byTitle(w)).get("quick")?.state).toBe("done"), { timeout: 5000 });
    const ids = await byTitle(w);
    const quickId = ids.get("quick")!.id;
    const slowId = ids.get("slow")!.id;
    const watcher = collect(w);
    try {
      await w.client.startGraduationConfirm("testwolf", "work-wolfpack-grad0005", "tok");
      await watcher.until(() => watcher.closed.includes(feature.id) && watcher.closed.includes(quickId));
      expect(watcher.closed).not.toContain(slowId); // still running
      open();
      await watcher.until(() => watcher.closed.includes(slowId));
      expect([...watcher.closed].sort()).toEqual([feature.id, quickId, slowId].sort()); // each exactly once
    } finally {
      await watcher.stop();
    }
  });

  it("a feature archived without graduating is announced when the next send finds it closed, once", async () => {
    const { w } = await bootWork();
    const feature = await w.client.createThread!("testwolf", { kind: "feature", workItemId: "work-wolfpack-grad0006" });
    stage.set("work-wolfpack-grad0006", "archived");
    const watcher = collect(w);
    try {
      await expect(w.client.submit(feature.id, "more", { whenBusy: "reject" })).rejects.toMatchObject({ code: "thread_closed" });
      await watcher.until(() => watcher.closed.includes(feature.id));
      await expect(w.client.submit(feature.id, "again", { whenBusy: "reject" })).rejects.toMatchObject({ code: "thread_closed" });
      expect(watcher.closed).toEqual([feature.id]);
    } finally {
      await watcher.stop();
    }
  });

  it("a restart restores a closed thread as closed without announcing it", async () => {
    const root = mkdtempSync(join(tmpdir(), "grad-restore-"));
    stops.push(async () => rmSync(root, { recursive: true, force: true }));
    const first = await bootWork(root);
    const feature = await first.w.client.createThread!("testwolf", { kind: "feature", workItemId: "work-wolfpack-grad0007" });
    const live = collect(first.w);
    try {
      await first.w.client.startGraduationConfirm("testwolf", "work-wolfpack-grad0007", "tok");
      await live.until(() => live.closed.includes(feature.id));
    } finally {
      await live.stop();
    }
    await stops.pop()!();
    const second = await bootWork(root);
    expect((await second.w.client.getThread(feature.id)).closed).toBe(true);
    const replay = collect(second.w, `${(second.w.wolf.server as unknown as { boot: string }).boot}:1`); // the cursor a fresh boot starts at: replays everything this boot announced
    try {
      const fresh = await second.w.client.createThread!("testwolf", { kind: "feature", workItemId: "work-wolfpack-grad0008" });
      await second.w.client.startGraduationConfirm("testwolf", "work-wolfpack-grad0008", "tok2"); // closes it live: a thread-updated, so the stream has been read
      await replay.until(() => replay.threadEvents.some((e) => e.id === fresh.id));
      const before = replay.threadEvents.slice(0, replay.threadEvents.findIndex((e) => e.id === fresh.id));
      expect(before.filter((e) => e.id === feature.id && e.closed)).toEqual([]);
      expect(replay.closed).toEqual([fresh.id]);
    } finally {
      await replay.stop();
    }
  });
});
