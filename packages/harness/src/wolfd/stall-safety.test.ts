import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadEvent } from "@wolfpack/protocol";
import { ThreadRuntime } from "./thread.js";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "./scripted-model.js";
import { startTestWolf, type TestWolf } from "./test-wolf.js";

/** A fake engine whose queued steers are withdrawn on abort, like pi-durable's. */
function fakeEngine() {
  let push: (b: unknown[]) => void = () => {};
  const queue: unknown[][] = [];
  let wake: (() => void) | undefined;
  let nextId = 1;
  const queued: number[] = [];
  const submitted: Array<{ input: string; whenBusy: string }> = [];
  let runId: number | null = null;
  push = (b) => { queue.push(b); wake?.(); };
  const conv = {
    id: "1",
    async submit({ input, whenBusy }: { input: string; whenBusy: string }) {
      submitted.push({ input, whenBusy });
      const id = nextId++;
      if (runId === null) {
        runId = id;
        push([{ type: "submission", record: { type: "input", status: "placed", id } }, { type: "run_start", inputs: [id] }, { type: "turn_start" }]);
        return { messageId: String(id), disposition: "started" };
      }
      queued.push(id);
      push([{ type: "submission", record: { type: "input", status: "queued", id } }]);
      return { messageId: String(id), disposition: whenBusy === "steer" ? "steered" : "queued" };
    },
    async abort() {
      const id = runId;
      runId = null;
      const out: unknown[] = [{ type: "turn_end" }, { type: "run_end", inputs: [id] }, { type: "submission", record: { type: "input", status: "unanswered", reason: "aborted", id } }];
      for (const q of queued.splice(0)) out.push({ type: "submission", record: { type: "input", status: "unanswered", reason: "aborted", id: q } });
      push(out);
    },
    async watch() {
      return {
        snapshot: { type: "snapshot", entries: [], tools: [], nestedTools: [], compactions: [], inbox: [], agent: {}, usage: { models: {}, tools: {} } },
        batches: (async function* () {
          while (true) {
            const n = queue.shift();
            if (n) yield n;
            else await new Promise<void>((r) => (wake = r));
          }
        })(),
        stop: async () => {},
      };
    },
  };
  return { conv, push, submitted, queued, endRun: () => { runId = null; } };
}

async function rig(stallTimeoutMs?: number) {
  const eng = fakeEngine();
  const events: ThreadEvent[] = [];
  const host = { name: "w", den: undefined, settleMs: 200, closing: () => false, emitWolf() {}, onError(e: unknown) { throw e; }, ...(stallTimeoutMs !== undefined ? { stallTimeoutMs } : {}) } as never;
  const rt = new ThreadRuntime({ id: "w/home" } as never, eng.conv as never, host);
  rt.observe((e) => events.push(e));
  await rt.attach();
  return { eng, rt, events };
}

describe("owner messages survive an abort", () => {
  it("re-submits a queued steer (never placed) as the next turn, combined in order", async () => {
    const { eng, rt } = await rig(0);
    await rt.submit("start", "steer");
    await rt.submit("first", "steer");
    await rt.submit("second", "steer");
    await rt.abort();
    await vi.waitFor(() => expect(eng.submitted.length).toBe(4));
    expect(eng.submitted[3].input).toBe("first\n\nsecond");
  });

  it("does not re-deliver a steer that was placed before the abort, nor internal submits", async () => {
    const { eng, rt } = await rig(0);
    await rt.submit("start", "steer");
    await rt.submit("placed one", "steer");
    await rt.submit("held result", "steer", [], { internal: true });
    eng.push([{ type: "submission", record: { type: "input", status: "placed", id: 2 } }]);
    await new Promise((r) => setTimeout(r, 20));
    await rt.abort();
    await new Promise((r) => setTimeout(r, 50));
    expect(eng.submitted.map((s) => s.input)).toEqual(["start", "placed one", "held result"]);
  });
});

describe("stall watchdog", () => {
  it("emits a stall error and aborts a silent turn, then re-submits queued messages", async () => {
    const { eng, rt, events } = await rig(60);
    await rt.submit("start", "steer");
    expect(rt.isRunning).toBe(true);
    await rt.submit("while hung", "steer");
    await vi.waitFor(() => expect(events.some((e) => e.type === "error" && /stalled/.test(e.message))).toBe(true), { timeout: 2000 });
    await vi.waitFor(() => expect(eng.submitted.at(-1)?.input).toBe("while hung"));
    expect(events.some((e) => e.type === "turn-end")).toBe(true);
  });

  it("does not trip while a tool runs, and activity resets the clock", async () => {
    const { eng, rt, events } = await rig(60);
    await rt.submit("start", "steer");
    eng.push([{ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} }]);
    await new Promise((r) => setTimeout(r, 250));
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(rt.isRunning).toBe(true);
    eng.push([{ type: "tool_execution_end", toolCallId: "t1", toolName: "bash" }]);
    await vi.waitFor(() => expect(events.some((e) => e.type === "error")).toBe(true), { timeout: 2000 });
  });

  it("stallTimeoutMs 0 disables it", async () => {
    const { rt, events } = await rig(0);
    await rt.submit("start", "steer");
    await new Promise((r) => setTimeout(r, 250));
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(rt.isRunning).toBe(true);
  });
});

let tw: TestWolf | undefined;
afterEach(async () => {
  await tw?.stop();
  tw = undefined;
});

describe("stalled parent turn and a finished subagent", () => {
  it("the watchdog ends the hung turn and the held result is delivered", async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const step: FauxResponseStep = async (ctx, options) => {
      const system = JSON.stringify(ctx.messages.filter((m) => m.role === "system"));
      const child = system.includes("You are the sub-agent");
      const last = ctx.messages[ctx.messages.length - 1];
      const text = typeof last.content === "string" ? last.content : (last.content as Array<{ type: string; text?: string }>).map((b) => b.text ?? "").join("");
      if (!child) {
        if (last.role === "toolResult") return fauxAssistantMessage("ok");
        if (text.startsWith("spawn:")) return fauxAssistantMessage(fauxToolCall("subagent", { agent: "tester", task: "SLOW work", name: "tester" }), { stopReason: "toolUse" });
        if (text.startsWith("hang:")) {
          open();
          await new Promise<void>((r) => options?.signal?.addEventListener("abort", () => r()));
          return fauxAssistantMessage("aborted");
        }
        return fauxAssistantMessage("parent ack");
      }
      await gate;
      return fauxAssistantMessage("CHILD_RESULT_DONE");
    };
    tw = await startTestWolf({ script: Array.from({ length: 40 }, () => step), env: { WOLFPACK_STALL_TIMEOUT_MS: "600" } });
    const dir = join(tw.root, "agent", "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "tester.md"), "---\nname: tester\ndescription: A scripted test agent\nmodel: fast\ntools: read, grep\n---\n\nYou are a test agent.\n");
    await tw.client.submit(tw.home, "spawn: x", { whenBusy: "reject" });
    for await (const _ of tw.client.watch(tw.home));
    await tw.client.submit(tw.home, "hang: now", { whenBusy: "reject" });
    const types: string[] = [];
    for await (const ev of tw.client.watch(tw.home)) types.push(ev.type === "error" ? `error:${ev.message}` : ev.type);
    expect(types.some((t) => t.startsWith("error:Turn stalled"))).toBe(true);
    await vi.waitFor(async () => {
      const d = await tw!.client.getThread(tw!.home);
      expect(JSON.stringify(d.messages)).toContain("[delivery");
    }, { timeout: 8000 });
  });
});
