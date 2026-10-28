/** A child that finishes after a steer is `done`, never stopped by the operator (regression for a spurious owner stop). */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "./scripted-model.js";
import { startTestWolf, type TestWolf } from "./test-wolf.js";

let tw: TestWolf | undefined;
afterEach(async () => {
  await tw?.stop();
  tw = undefined;
});

const PROFILE = "---\nname: tester\ndescription: A scripted test agent\nmodel: fast\ntools: read, grep\n---\n\nYou are a test agent.\n";

describe("steer to a running child, then it finishes", () => {
  it("ends done with no operator stop, even with a console client following its stream to the end", async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const step: FauxResponseStep = async (ctx, options) => {
      const system = JSON.stringify(ctx.messages.filter((m) => m.role === "system"));
      const child = system.includes("You are the sub-agent");
      const last = ctx.messages[ctx.messages.length - 1];
      const text = typeof last.content === "string" ? last.content : (last.content as Array<{ type: string; text?: string }>).map((b) => b.text ?? "").join("");
      const tool = (name: string, args: Record<string, string>) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
      if (!child) {
        if (last.role === "toolResult") return fauxAssistantMessage("ok");
        if (text.startsWith("spawn:")) return tool("subagent", { agent: "tester", task: "SLOW work", name: "tester" });
        if (text.startsWith("message:")) return tool("subagent_message", { name: "tester", message: "Correction: use main" });
        return fauxAssistantMessage("parent ack");
      }
      if (last.role === "user" && text.includes("SLOW")) {
        await Promise.race([gate, new Promise<void>((r) => options?.signal?.addEventListener("abort", () => r()))]);
      }
      return fauxAssistantMessage(`CHILD_RESULT(${text.slice(0, 30)})`);
    };
    tw = await startTestWolf({ script: Array.from({ length: 40 }, () => step) });
    const dir = join(tw.root, "agent", "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "tester.md"), PROFILE);

    await tw.client.submit(tw.home, "spawn: x", { whenBusy: "reject" });
    for await (const _ of tw.client.watch(tw.home));
    const [child] = await tw.client.listChildren!(tw.home);
    // a console client attached to the child's stream
    const frames: string[] = [];
    void (async () => {
      for await (const ev of tw!.client.watch(child.id)) frames.push(ev.type);
    })().catch(() => {});
    await tw.client.submit(tw.home, "message: go", { whenBusy: "reject" });
    for await (const _ of tw.client.watch(tw.home));
    open();
    // the console detaches the moment the turn ends
    await vi.waitFor(async () => expect(frames).toContain("turn-end"), { timeout: 5000 });
    await vi.waitFor(async () => expect((await tw!.client.listChildren!(tw!.home))[0].state).not.toBe("running"), { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 300));
    const ledger = await tw.client.getLedger!(child.id);
    expect((await tw.client.listChildren!(tw.home))[0].state).toBe("done");
    expect(ledger.some((e) => e.kind === "stop")).toBe(false);
    // the steer ran as its own turn, and the owner task was released once nothing was left to run
    expect(ledger.map((e) => `${e.from}:${e.kind}`)).toEqual(["parent:brief", "parent:steer", "child:result", "child:result"]);
    const rec = () => (tw!.wolf.server as unknown as { subagents: { records: Array<{ ownerTaskId?: string }> } }).subagents.records[0];
    await vi.waitFor(() => expect(rec().ownerTaskId).toBeFalsy());
  });
});

type Mgr = { port: { thread(id: string): { abort(): Promise<void> } | undefined }; abortFromOwner(id: string): Promise<void> };
const mgr = (w: TestWolf) => (w.wolf.server as unknown as { subagents: Mgr }).subagents;

/** A wolf whose child calls a tool, then holds its next model call until the gate opens (so a steer lands mid-run). */
async function bootToolChild(): Promise<{ w: TestWolf; open: () => void; childId: string }> {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const step: FauxResponseStep = async (ctx, options) => {
    const child = JSON.stringify(ctx.messages.filter((m) => m.role === "system")).includes("You are the sub-agent");
    const last = ctx.messages[ctx.messages.length - 1]!;
    const text = typeof last.content === "string" ? last.content : (last.content as Array<{ type: string; text?: string }>).map((b) => b.text ?? "").join("");
    if (!child) {
      if (last.role === "toolResult") return fauxAssistantMessage("spawned");
      if (text.startsWith("spawn:")) return fauxAssistantMessage(fauxToolCall("subagent", { agent: "tester", task: "SLOW work", name: "tester" }), { stopReason: "toolUse" });
      return fauxAssistantMessage("parent ack");
    }
    if (last.role === "user") return fauxAssistantMessage(fauxToolCall("grep", { pattern: "x", path: "." }), { stopReason: "toolUse" });
    await Promise.race([gate, new Promise<void>((r) => options?.signal?.addEventListener("abort", () => r()))]);
    if (options?.signal?.aborted) return fauxAssistantMessage("", { stopReason: "aborted" });
    return fauxAssistantMessage("The first attempt failed. I'll retry. FINAL_REPORT");
  };
  const w = await startTestWolf({ script: Array.from({ length: 40 }, () => step) });
  tw = w;
  const dir = join(w.root, "agent", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "tester.md"), PROFILE);
  await w.client.submit(w.home, "spawn: x", { whenBusy: "reject" });
  for await (const _ of w.client.watch(w.home));
  const [child] = await w.client.listChildren!(w.home);
  return { w, open, childId: child!.id };
}
const entries = async (w: TestWolf, id: string) => (await w.client.getLedger!(id)).map((e) => `${e.from}:${e.kind}`);

describe("a steer delivered into the running turn", () => {
  it("is consumed by that run; the child ends done with no stop entry", async () => {
    const { w, open, childId } = await bootToolChild();
    await new Promise((r) => setTimeout(r, 150)); // the child is past its tool call, holding its next model call
    await w.client.submit(childId, "Correction: ignore the absolute path", { whenBusy: "steer" });
    await w.client.submit(w.home, "noop", { whenBusy: "followUp" }).catch(() => {});
    open();
    await vi.waitFor(async () => expect((await w.client.listChildren!(w.home))[0]!.state).toBe("done"), { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 600));
    expect((await w.client.listChildren!(w.home))[0]!.state).toBe("done");
    expect((await entries(w, childId)).filter((e) => e.endsWith(":stop") || e.endsWith(":error"))).toEqual([]);
  });
});

describe("what counts as a stop", () => {
  it("an abort nobody requested is an error entry, not an operator stop", async () => {
    const { w, childId } = await bootToolChild();
    await new Promise((r) => setTimeout(r, 150));
    await mgr(w).port.thread(childId)!.abort();
    await vi.waitFor(async () => expect((await w.client.listChildren!(w.home))[0]!.state).toBe("failed"), { timeout: 5000 });
    const e = await entries(w, childId);
    expect(e).toContain("system:error");
    expect(e.some((x) => x.endsWith(":stop"))).toBe(false);
  });

  it("an abort of a continuation after a delivered result keeps the child done (error entry, no stop)", async () => {
    const { w, childId, open } = await bootToolChild();
    open();
    await vi.waitFor(async () => expect((await w.client.listChildren!(w.home))[0]!.state).toBe("done"), { timeout: 5000 });
    // a run that starts after the result, with no new input from the parent or owner
    const m = mgr(w) as unknown as { port: { thread(id: string): { conv: { submit(o: unknown): Promise<unknown> } } } };
    await m.port.thread(childId).conv.submit({ input: "continue", whenBusy: "steer" });
    await mgr(w).port.thread(childId)!.abort();
    await new Promise((r) => setTimeout(r, 400));
    expect((await w.client.listChildren!(w.home))[0]!.state).toBe("done");
    const e = await entries(w, childId);
    expect(e).toContain("system:error");
    expect(e.some((x) => x.endsWith(":stop"))).toBe(false);
  });

  it("an explicit operator stop still stops the child", async () => {
    const { w, childId } = await bootToolChild();
    await new Promise((r) => setTimeout(r, 150));
    await mgr(w).abortFromOwner(childId);
    await vi.waitFor(async () => expect((await w.client.listChildren!(w.home))[0]!.state).toBe("stopped"), { timeout: 5000 });
    expect(await entries(w, childId)).toContain("owner:stop");
  });
});
