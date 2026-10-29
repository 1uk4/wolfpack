import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadEvent } from "@wolfpack/protocol";
import { ThreadRuntime } from "./thread.js";
import { storeAttachment } from "./attachments.js";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "./scripted-model.js";
import { startTestWolf, type TestWolf } from "./test-wolf.js";

/** A fake engine whose queued steers are withdrawn on abort, like pi-durable's. */
function fakeEngine(snapshotExtra: Record<string, unknown> = {}) {
  const queue: unknown[][] = [];
  let wake: (() => void) | undefined;
  let nextId = 1;
  const queued: number[] = [];
  const submitted: Array<{ input: unknown; whenBusy: string }> = [];
  const state = { runId: null as number | null, failSubmits: 0, attempts: 0, gate: undefined as Promise<void> | undefined, stopped: false };
  const push = (b: unknown[]) => { queue.push(b); wake?.(); };
  const conv = {
    id: "1",
    async submit({ input, whenBusy }: { input: unknown; whenBusy: string }) {
      state.attempts++;
      if (state.failSubmits > 0) { state.failSubmits--; throw new Error("engine down"); }
      submitted.push({ input, whenBusy });
      const id = nextId++;
      if (state.runId === null) {
        state.runId = id;
        push([{ type: "submission", record: { type: "input", status: "placed", id } }, { type: "run_start", inputs: [id] }, { type: "turn_start" }]);
        return { messageId: String(id), disposition: "started" };
      }
      queued.push(id);
      push([{ type: "submission", record: { type: "input", status: "queued", id } }]);
      if (state.gate) await state.gate;
      return { messageId: String(id), disposition: whenBusy === "steer" ? "steered" : "queued" };
    },
    async abort() {
      const id = state.runId;
      state.runId = null;
      const out: unknown[] = [{ type: "turn_end" }, { type: "run_end", inputs: [id] }, { type: "submission", record: { type: "input", status: "unanswered", reason: "aborted", id } }];
      for (const q of queued.splice(0)) out.push({ type: "submission", record: { type: "input", status: "unanswered", reason: "aborted", id: q } });
      push(out);
    },
    async watch() {
      if (snapshotExtra.run) state.runId = 1;
      return {
        snapshot: { type: "snapshot", entries: [], tools: [], nestedTools: [], compactions: [], inbox: [], agent: {}, usage: { models: {}, tools: {} }, ...snapshotExtra },
        batches: (async function* () {
          while (true) {
            const n = queue.shift();
            if (n) yield n;
            else if (state.stopped) return;
            else await new Promise<void>((r) => (wake = r));
          }
        })(),
        stop: async () => { state.stopped = true; wake?.(); },
      };
    },
  };
  return { conv, push, submitted, state };
}

async function rig(stallTimeoutMs?: number, snapshotExtra: Record<string, unknown> = {}, den?: string) {
  const eng = fakeEngine(snapshotExtra);
  const events: ThreadEvent[] = [];
  const errors: unknown[] = [];
  const host = { name: "w", den, settleMs: 200, closing: () => false, emitWolf() {}, onError: (e: unknown) => errors.push(e), ...(stallTimeoutMs !== undefined ? { stallTimeoutMs } : {}) } as never;
  const rt = new ThreadRuntime({ id: "w/home" } as never, eng.conv as never, host);
  rt.observe((e) => events.push(e));
  await rt.attach();
  return { eng, rt, events, errors };
}
const stalled = (events: ThreadEvent[]) => events.filter((e) => e.type === "error" && /stalled/.test(e.message));
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const toolStart = (id: string) => ({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: {} });
const toolEnd = (id: string) => ({ type: "tool_execution_end", toolCallId: id, toolName: "bash" });

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("owner messages survive an abort", () => {
  it("re-submits queued steers (never placed) as one next message, in order", async () => {
    const { eng, rt } = await rig(0);
    await rt.submit("start", "steer");
    await rt.submit("first", "steer");
    await rt.submit("second", "steer");
    await rt.abort();
    await tick(10);
    expect(eng.submitted.length).toBe(4);
    expect(eng.submitted[3].input).toBe("first\n\nsecond");
  });

  it("does not re-deliver a steer placed before the abort, nor internal submits", async () => {
    const { eng, rt } = await rig(0);
    await rt.submit("start", "steer");
    await rt.submit("placed one", "steer");
    await rt.submit("held result", "steer", [], { internal: true });
    eng.push([{ type: "submission", record: { type: "input", status: "placed", id: 2 } }]);
    await tick(20);
    await rt.abort();
    await tick(50);
    expect(eng.submitted.map((s) => s.input)).toEqual(["start", "placed one", "held result"]);
  });

  it("keeps a message whose withdrawal is pumped before submit() returns", async () => {
    const { eng, rt } = await rig(0);
    await rt.submit("start", "steer");
    let release!: () => void;
    eng.state.gate = new Promise<void>((r) => (release = r));
    const pending = rt.submit("raced", "steer");
    await tick(1);
    await rt.abort(); // withdrawal record is pumped while submit is still awaiting the engine
    await tick(1);
    eng.state.gate = undefined;
    release();
    await pending;
    await tick(10);
    expect(eng.submitted.at(-1)?.input).toBe("raced");
    expect(eng.submitted.length).toBe(3); // start, the raced steer, its single re-send
  });

  it("a failing re-send emits an error quoting the text, retries once, then stops", async () => {
    const { eng, rt, events } = await rig(0);
    await rt.submit("start", "steer");
    await rt.submit("precious", "steer");
    eng.state.failSubmits = 2;
    const base = eng.state.attempts;
    await rt.abort();
    await tick(100);
    expect(eng.state.attempts - base).toBe(2);
    const lost = events.filter((e) => e.type === "error" && e.message.includes("precious"));
    expect(lost.length).toBe(2);
    await tick(500);
    expect(eng.state.attempts - base).toBe(2);
  });

  it("carries attachments through a resubmit (same-named files from two messages)", async () => {
    const den = mkdtempSync(join(tmpdir(), "stall-att-"));
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1, 2, 3, 4]);
    const a = storeAttachment(den, "w/home", png, "image/png", "shot.png");
    const b = storeAttachment(den, "w/home", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 9, 9, 9, 9]), "image/png", "shot.png");
    const { eng, rt } = await rig(0, {}, den);
    await rt.submit("start", "steer");
    await rt.submit("one", "steer", [{ id: a.id }]);
    await rt.submit("two", "steer", [{ id: b.id }, { id: a.id }]);
    await rt.abort();
    await tick(10);
    const input = eng.submitted.at(-1)!.input as Array<{ type: string; text?: string }>;
    expect(input.filter((p) => p.type === "image").length).toBe(2);
    expect(input[0].text).toContain("one\n\ntwo");
  });
});

describe("stall watchdog", () => {
  it("emits a stall error and aborts a silent turn; queued messages follow", async () => {
    const { eng, rt, events } = await rig(100);
    await rt.submit("start", "steer");
    await rt.submit("while hung", "steer");
    await tick(150);
    const [ev] = stalled(events);
    expect(ev).toBeDefined();
    expect((ev as { message: string }).message).toContain("Queued messages will follow");
    await tick(10);
    expect(eng.submitted.at(-1)?.input).toBe("while hung");
    expect(events.some((e) => e.type === "turn-end")).toBe(true);
  });

  it("does not promise queued messages when there are none", async () => {
    const { rt, events } = await rig(100);
    await rt.submit("start", "steer");
    await tick(150);
    expect((stalled(events)[0] as { message: string }).message).not.toContain("Queued");
  });

  it("steers arriving during a silent turn do not keep it alive", async () => {
    const { rt, events } = await rig(100);
    await rt.submit("start", "steer");
    await tick(60);
    await rt.submit("typing 1", "steer");
    await tick(30);
    await rt.submit("typing 2", "steer");
    await tick(30);
    expect(stalled(events).length).toBe(1);
  });

  it("does not trip while a tool runs; two parallel tools, one ending, still hold it", async () => {
    const { eng, rt, events } = await rig(100);
    await rt.submit("start", "steer");
    eng.push([toolStart("t1"), toolStart("t2")]);
    await tick(300);
    eng.push([toolEnd("t1")]);
    await tick(300);
    expect(stalled(events).length).toBe(0);
    expect(rt.isRunning).toBe(true);
    eng.push([toolEnd("t2")]);
    await tick(250);
    expect(stalled(events).length).toBe(1);
  });

  it("an error + retry at ~90 s does not trip a 120 s watchdog", async () => {
    const { eng, rt, events } = await rig(120_000);
    await rt.submit("start", "steer");
    await tick(90_000);
    eng.push([{ type: "message_start", message: { role: "assistant", content: [] } }, { type: "run_start", inputs: [1] }]);
    await tick(100_000);
    expect(stalled(events).length).toBe(0);
    await tick(30_000);
    expect(stalled(events).length).toBe(1);
  });

  it("a tool still running in the snapshot of a reattach does not trip it", async () => {
    const { events } = await rig(100, { run: { inputs: [1] }, tools: [{ callId: "t1", status: "running" }] });
    await tick(500);
    expect(stalled(events).length).toBe(0);
  });

  it("close() clears the timer", async () => {
    const { rt, events } = await rig(100);
    await rt.submit("start", "steer");
    await rt.close();
    await tick(500);
    expect(stalled(events).length).toBe(0);
  });

  it("stallTimeoutMs 0 disables it", async () => {
    const { rt, events } = await rig(0);
    await rt.submit("start", "steer");
    await tick(100_000);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(rt.isRunning).toBe(true);
  });
});

let tw: TestWolf | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await tw?.stop();
  tw = undefined;
});

describe("stalled parent turn and a finished subagent", () => {
  beforeEach(() => { vi.useRealTimers(); });
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
