/** Graduation closes the feature's sub-agent threads: settled now, running ones as they settle, old ones at startup. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

async function boot(root?: string) {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const step = script(gate);
  const w = await startTestWolf({ script: Array.from({ length: 60 }, () => step), ...(root ? { root } : {}) });
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
