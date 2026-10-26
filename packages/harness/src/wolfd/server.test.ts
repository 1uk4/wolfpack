/** Serving behaviours beyond the contract: snapshots on engine resync, mid-run attach, message reconstruction. */
import { afterEach, describe, expect, it } from "vitest";
import { buildPath, parseThreadEvent, type ThreadEvent } from "@wolfpack/protocol";
import { applyEntry, messagesFromEntries } from "./messages.js";
import { ScriptedEngine } from "./scripted-engine.js";
import { WolfServer } from "./server.js";

const THREAD = buildPath("getThread", { id: "w/home" });
const SUBMIT = buildPath("submit", { id: "w/home" });
const STREAM = buildPath("streamThread", { id: "w/home" });
const servers: WolfServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function boot(engine: ScriptedEngine): Promise<{ url: string; server: WolfServer }> {
  const server = new WolfServer({ name: "w", conversation: engine });
  servers.push(server);
  await server.attach();
  return { url: await server.listen(), server };
}

async function readEvents(url: string, path: string, stopAfter?: number): Promise<ThreadEvent[]> {
  const res = await fetch(url + path);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const out: ThreadEvent[] = [];
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const data = buf.slice(0, i).split("\n").find((l) => l.startsWith("data: "))!.slice(6);
      buf = buf.slice(i + 2);
      if (data === "[DONE]") return out;
      const p = parseThreadEvent(JSON.parse(data));
      if (p.kind === "event") out.push(p.event);
      if (stopAfter && out.length >= stopAfter) {
        await reader.cancel();
        return out;
      }
    }
  }
  return out;
}

const post = (url: string, path: string, body: unknown) =>
  fetch(url + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("WolfServer", () => {
  it("reports wolf status busy while a turn runs, online after; one merged assistant message per turn", async () => {
    const { url } = await boot(new ScriptedEngine({ delayMs: 20 }));
    const status = async () => ((await (await fetch(`${url}/v1/wolves`)).json()) as any).wolves[0].status;
    expect(await status()).toBe("online");
    await post(url, SUBMIT, { input: "hi", whenBusy: "reject" });
    expect(await status()).toBe("busy");
    await readEvents(url, STREAM);
    expect(await status()).toBe("online");
    const t: any = await (await fetch(`${url}${THREAD}`)).json();
    expect(t.messages.map((m: any) => m.role)).toEqual(["user", "assistant"]);
    expect(t.messages[1].text).toBe("Let me take a look at that file.\n\nIt describes a pack of durable agents.");
  });

  it("an engine snapshot mid-stream becomes a protocol snapshot for live subscribers", async () => {
    const engine = new ScriptedEngine({ delayMs: 25 });
    const { url } = await boot(engine);
    await post(url, SUBMIT, { input: "hi", whenBusy: "reject" });
    const pending = readEvents(url, STREAM);
    await new Promise((r) => setTimeout(r, 80));
    engine.forceSnapshot();
    const events = await pending;
    const snap = events.find((e) => e.type === "snapshot");
    expect(snap).toBeDefined();
    expect(events.at(-1)?.type).toBe("turn-end");
  });

  it("a diverged message_end reaches subscribers as a protocol snapshot carrying the final text", async () => {
    const engine = new ScriptedEngine({ delayMs: 20, script: [{ kind: "text", text: "abandoned partial" }] });
    engine.divergeNextFinal("the real answer");
    const { url } = await boot(engine);
    await post(url, SUBMIT, { input: "hi", whenBusy: "reject" });
    const events = await readEvents(url, STREAM);
    const snaps = events.filter((e) => e.type === "snapshot") as any[];
    expect(snaps).toHaveLength(1);
    expect(snaps[0].thread.messages.at(-1).text).toBe("the real answer");
    expect(snaps[0].inFlight.text).toBe("the real answer");
    expect(events.at(-1)?.type).toBe("turn-end");
    const text = events.filter((e) => e.type === "text-delta").map((e: any) => e.text).join("");
    expect(text).toBe("abandoned partial"); // live deltas are not retracted; the snapshot is the reset
  });

  it("a restreamed head and an unstreamed tail both reach a live subscriber", async () => {
    const engine = new ScriptedEngine({ delayMs: 20, script: [{ kind: "text", text: "MIDDLE-" }] });
    engine.restreamNext("HEAD-", "TAIL");
    const { url } = await boot(engine);
    await post(url, SUBMIT, { input: "hi", whenBusy: "reject" });
    const events = await readEvents(url, STREAM);
    const text = events.filter((e) => e.type === "text-delta").map((e: any) => e.text).join("");
    expect(text).toBe("HEAD-MIDDLE-TAIL");
    expect(events.some((e) => e.type === "snapshot")).toBe(false);
  });

  it("attaching mid-run presents the in-flight turn", async () => {
    const engine = new ScriptedEngine({ delayMs: 30 });
    await engine.submit({ input: "early", whenBusy: "reject" });
    await new Promise((r) => setTimeout(r, 140)); // some text has streamed
    const { url } = await boot(engine);
    const t: any = await (await fetch(`${url}${THREAD}`)).json();
    expect(t.busy).toBe(true);
    const events = await readEvents(url, STREAM);
    expect(events[0].type).toBe("turn-start");
    expect(events.at(-1)).toMatchObject({ type: "turn-end", reason: "complete" });
  });
});

const entry = (id: number, kind: string, message: unknown): any => ({ id, kind, model: [message] });

describe("live tool results", () => {
  it("attaches results through the live event path (tool_execution_end), not a snapshot", async () => {
    const engine = new ScriptedEngine({
      delayMs: 1,
      script: [
        { kind: "tool", name: "bash", args: { command: "ls" }, updates: [], result: "out" },
        { kind: "text", text: "done" },
      ],
    });
    const { url } = await boot(engine);
    await post(url, SUBMIT, { input: "go", whenBusy: "reject" });
    await readEvents(url, STREAM);
    const t: any = await (await fetch(`${url}${THREAD}`)).json();
    const a = t.messages.find((m: any) => m.role === "assistant");
    expect(a.text).toBe("done");
    expect(a.tools).toHaveLength(1);
    expect(a.tools[0]).toMatchObject({ name: "bash", args: { command: "ls" }, result: "out", isError: false });
  });
});

describe("tool call dedup by callId", () => {
  const call = (id: string, command = "ls") => ({ type: "toolCall", id, name: "bash", arguments: { command } });
  const assistant = (id: number, ts: number, ...calls: any[]) => entry(id, "pi.assistant", { role: "assistant", timestamp: ts, content: calls });
  const result = (id: number, callId: string, text = "out") =>
    entry(id, "pi.tool_result", { role: "toolResult", toolCallId: callId, content: [{ type: "text", text }] });

  it("one tools entry per callId when the SAME round is delivered again under a different entry id", () => {
    const list: any[] = [];
    for (const e of [assistant(3, 100, call("a"), call("b")), result(4, "a"), result(5, "b"), assistant(9, 100, call("a"), call("b")), result(10, "a"), result(11, "b")]) applyEntry(list, e);
    expect(list).toHaveLength(1);
    expect(list[0].tools.map((t: any) => t.callId)).toEqual(["a", "b"]);
    expect(list[0].tools.every((t: any) => t.result === "out")).toBe(true);
  });

  it("a replayed round with a new call in it keeps the new call", () => {
    const list: any[] = [];
    applyEntry(list, assistant(1, 100, call("a")));
    applyEntry(list, assistant(4, 100, call("a"), call("c")));
    expect(list[0].tools.map((t: any) => t.callId)).toEqual(["a", "c"]);
  });

  it("a reused id (DeepSeek call_0) keeps every call, each paired with its own result: across turns and rounds", () => {
    const list: any[] = [];
    for (const e of [
      entry(1, "pi.user", { role: "user", content: "one", timestamp: 1 }),
      assistant(2, 100, call("call_0", "git status")),
      result(3, "call_0", "first"),
      entry(4, "pi.user", { role: "user", content: "two", timestamp: 2 }),
      assistant(5, 200, call("call_0", "git status")),
      result(6, "call_0", "second"),
      assistant(7, 300, call("call_0", "git status")),
      result(8, "call_0", "third"),
    ]) applyEntry(list, e);
    const calls = list.flatMap((m) => m.tools ?? []);
    expect(calls.map((t: any) => t.result)).toEqual(["first", "second", "third"]);
  });
});

describe("messagesFromEntries", () => {
  it("keeps oversized args an object, truncating largest-first, surrogate-safe", () => {
    const huge = "😀".repeat(3000);
    const msgs = messagesFromEntries([
      entry(1, "pi.assistant", {
        role: "assistant",
        content: [{ type: "toolCall", id: "c", name: "write", arguments: { path: "a.ts", content: huge, nested: { x: huge }, n: 1 } }],
      }),
    ]);
    const args: any = msgs[0].tools![0].args;
    expect(typeof args).toBe("object");
    expect(args._truncated).toBe(true);
    expect(args.path).toBe("a.ts");
    expect(args.n).toBe(1);
    expect(JSON.stringify(args).length).toBeLessThanOrEqual(4200);
    expect(args.content).not.toMatch(/[\ud800-\udbff]…$/);
  });
  it("small args carry no _truncated", () => {
    const msgs = messagesFromEntries([entry(1, "pi.assistant", { role: "assistant", content: [{ type: "toolCall", id: "c", name: "r", arguments: { path: "a" } }] })]);
    expect(msgs[0].tools![0].args).toEqual({ path: "a" });
  });
  const entry = (id: number, kind: string, message: unknown): any => ({ id, kind, model: [message] });
  it("keeps user + assistant text, merges rounds, tool-only rounds carry tools only", () => {
    const msgs = messagesFromEntries([
      entry(1, "pi.user", { role: "user", content: "q", timestamp: 1000 }),
      entry(2, "pi.system", { role: "system", content: "" }),
      entry(3, "pi.assistant", { role: "assistant", content: [{ type: "toolCall", id: "c", name: "read" }] }),
      entry(4, "pi.tool_result", { role: "toolResult", content: [{ type: "text", text: "r" }] }),
      entry(5, "pi.assistant", { role: "assistant", content: [{ type: "text", text: "a" }] }),
      entry(6, "pi.assistant", { role: "assistant", content: [{ type: "thinking", thinking: "t" }, { type: "text", text: "b" }] }),
    ]);
    expect(msgs).toEqual([
      { id: "entry-1", role: "user", text: "q", at: new Date(1000).toISOString() },
      {
        id: "entry-3",
        role: "assistant",
        text: "a\n\nb",
        at: expect.any(String),
        tools: [{ callId: "c", name: "read", args: {}, textOffset: 0 }],
      },
    ]);
  });
  it("pairs results, offsets calls into merged text, caps args and results", () => {
    const big = "x".repeat(5000);
    const msgs = messagesFromEntries([
      entry(1, "pi.user", { role: "user", content: "q", timestamp: 1000 }),
      entry(2, "pi.assistant", { role: "assistant", content: [{ type: "text", text: "hi" }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: big } }] }),
      entry(3, "pi.tool_result", { role: "toolResult", toolCallId: "c1", isError: true, content: [{ type: "text", text: big }] }),
      entry(4, "pi.assistant", { role: "assistant", content: [{ type: "toolCall", id: "c2", name: "read", arguments: { path: "a" } }] }),
      entry(5, "pi.tool_result", { role: "toolResult", toolCallId: "c2", isError: false, content: [{ type: "text", text: "ok" }] }),
      entry(6, "pi.assistant", { role: "assistant", content: [{ type: "text", text: "done" }] }),
    ]);
    expect(msgs).toHaveLength(2);
    const a = msgs[1];
    expect(a.text).toBe("hi\n\ndone");
    expect(a.tools).toHaveLength(2);
    expect(a.tools![0]).toMatchObject({ callId: "c1", name: "bash", textOffset: 2, isError: true, resultTruncated: true });
    expect(a.tools![0].result).toHaveLength(4096);
    expect(JSON.stringify(a.tools![0].args).length).toBeLessThan(1200);
    expect(a.tools![1]).toMatchObject({ callId: "c2", result: "ok", isError: false, textOffset: 2 });
    expect(a.tools![1].resultTruncated).toBeUndefined();
  });
});
