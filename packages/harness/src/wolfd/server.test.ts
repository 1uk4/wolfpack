/** Serving behaviours beyond the contract: snapshots on engine resync, mid-run attach, message reconstruction. */
import { afterEach, describe, expect, it } from "vitest";
import { buildPath, parseThreadEvent, type ThreadEvent } from "@wolfpack/protocol";
import { messagesFromEntries } from "./messages.js";
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

describe("messagesFromEntries", () => {
  const entry = (id: number, kind: string, message: unknown): any => ({ id, kind, model: [message] });
  it("keeps user + assistant text only, merges rounds, skips tool-only rounds", () => {
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
      { id: "entry-5", role: "assistant", text: "a\n\nb", at: expect.any(String) },
    ]);
  });
});
