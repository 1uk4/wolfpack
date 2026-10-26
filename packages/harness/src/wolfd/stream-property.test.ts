/**
 * Property: whatever mix of message_update changes the engine produces (text_start/thinking_start, deltas, whole
 * block replaces that grow/shrink/replace, whole `message`, tool calls, interleaved content indices), the mapped
 * events folded by a reference reducer AND the WolfServer's in-flight view both end equal to the final stored
 * text and thinking.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { EngineEvent } from "../engine/index.js";
import { createEventMapper } from "../engine/index.js";
import { ScriptedEngine } from "./scripted-engine.js";
import { WolfServer } from "./server.js";

type Blk = { type: "text"; text: string } | { type: "thinking"; thinking: string } | { type: "toolCall"; id: string; name: string };
const ev = (e: unknown) => e as EngineEvent;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const textOf = (blocks: Blk[]) => blocks.map((b) => (b.type === "text" ? b.text : "")).join("");
const thinkingOf = (blocks: Blk[]) => blocks.map((b) => (b.type === "thinking" ? b.thinking : "")).join("");

interface Case {
  batches: EngineEvent[][];
  text: string;
  thinking: string;
}

function gen(seed: number): Case {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const word = () => pick(["a", "bc", "HEAD-", "mid ", "tail.", "ü", "x y"]);
  const str = () => (r() < 0.15 ? "" : word() + (r() < 0.5 ? word() : ""));
  const mk = (kind: "text" | "thinking", s: string): Blk => (kind === "text" ? { type: "text", text: s } : { type: "thinking", thinking: s });
  const val = (b: Blk) => (b.type === "text" ? b.text : b.type === "thinking" ? b.thinking : "");
  const blocks: Blk[] = [];
  const updates: EngineEvent[] = [];
  const nUpdates = 1 + Math.floor(r() * 8);
  for (let u = 0; u < nUpdates; u++) {
    const changes: unknown[] = [];
    for (let k = 1 + Math.floor(r() * 3); k > 0; k--) {
      const i = blocks.length ? Math.floor(r() * blocks.length) : 0;
      const op = pick(["start", "start", "delta", "delta", "grow", "shrink", "replace", "message", "tool"] as const);
      const existing = blocks[i];
      if (op === "start" || !existing) {
        const kind = pick(["text", "thinking"] as const);
        const b = mk(kind, str());
        blocks.push(b);
        changes.push({ type: kind === "text" ? "text_start" : "thinking_start", contentIndex: blocks.length - 1, block: structuredClone(b) });
      } else if (op === "delta" && existing.type !== "toolCall") {
        const d = word();
        if (existing.type === "text") existing.text += d;
        else existing.thinking += d;
        changes.push({ type: existing.type === "text" ? "text_delta" : "thinking_delta", contentIndex: i, delta: d });
      } else if (op === "tool") {
        blocks.push({ type: "toolCall", id: `c${blocks.length}`, name: "t" });
        changes.push({ type: "toolcall_start", contentIndex: blocks.length - 1, block: structuredClone(blocks.at(-1)) });
        changes.push({ type: "toolcall_delta", contentIndex: blocks.length - 1, path: ["x"], delta: "1" });
      } else if (op === "message") {
        const n = Math.floor(r() * 4);
        blocks.length = 0;
        for (let j = 0; j < n; j++) blocks.push(mk(pick(["text", "thinking"] as const), str()));
        changes.push({ type: "message", message: { role: "assistant", content: structuredClone(blocks) } });
      } else if (existing.type !== "toolCall") {
        const old = val(existing);
        const next = op === "grow" ? old + word() : op === "shrink" ? (r() < 0.5 ? "" : old.slice(0, Math.floor(old.length / 2))) : str();
        blocks[i] = mk(r() < 0.8 ? existing.type : pick(["text", "thinking"] as const), next);
        changes.push({ type: "block", contentIndex: i, block: structuredClone(blocks[i]) });
      }
    }
    if (changes.length) updates.push(ev({ type: "message_update", changes }));
  }
  const final = structuredClone(blocks);
  if (r() < 0.4) {
    const last = [...final].reverse().find((b) => b.type === "text") as { text: string } | undefined;
    if (last) last.text += "TAIL";
  }
  const batches = [
    [ev({ type: "run_start", inputs: [1] }), ev({ type: "message_start", message: { role: "assistant", content: [] } })],
    ...updates.map((u) => [u]),
    [ev({ type: "message_end", entry: { id: 7, kind: "pi.assistant", conversationId: 1, model: [{ role: "assistant", content: final, stopReason: "stop" }] } })],
  ];
  return { batches, text: textOf(final), thinking: thinkingOf(final) };
}

/** Reference reducer for a protocol consumer: deltas append, a correction replaces. */
function reduce(events: ReturnType<ReturnType<typeof createEventMapper>["push"]>): { text: string; thinking: string } {
  let text = "";
  let thinking = "";
  for (const e of events) {
    if (e.type === "text-delta") text += e.text;
    else if (e.type === "thinking-delta") thinking += e.text;
    else if (e.type === "resync" && e.correction) {
      text = e.correction.text;
      thinking = e.correction.thinking;
    }
  }
  return { text, thinking };
}

const servers: WolfServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function bootServer(): Promise<any> {
  const server = new WolfServer({ name: "w", conversation: new ScriptedEngine() });
  servers.push(server);
  await server.attach();
  return server;
}

const reviewerCase = (): Case => ({
  // thinking diverges while text only grows from empty, in one update
  batches: [
    [ev({ type: "run_start", inputs: [1] }), ev({ type: "message_start", message: { role: "assistant", content: [] } })],
    [ev({ type: "message_update", changes: [{ type: "thinking_start", contentIndex: 0, block: { type: "thinking", thinking: "old" } }] })],
    [
      ev({
        type: "message_update",
        changes: [
          { type: "block", contentIndex: 0, block: { type: "thinking", thinking: "new" } },
          { type: "text_start", contentIndex: 1, block: { type: "text", text: "HEAD-" } },
        ],
      }),
    ],
    [ev({ type: "message_end", entry: { id: 7, kind: "pi.assistant", conversationId: 1, model: [{ role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "new" }, { type: "text", text: "HEAD-" }] }] } })],
  ],
  text: "HEAD-",
  thinking: "new",
});

const shrinkCase = (): Case => ({
  // a block shrinks a side to empty: the stale text must not survive
  batches: [
    [ev({ type: "run_start", inputs: [1] }), ev({ type: "message_start", message: { role: "assistant", content: [] } })],
    [ev({ type: "message_update", changes: [{ type: "text_start", contentIndex: 0, block: { type: "text", text: "stale" } }] })],
    [ev({ type: "message_update", changes: [{ type: "block", contentIndex: 0, block: { type: "text", text: "" } }] })],
    [ev({ type: "message_end", entry: { id: 7, kind: "pi.assistant", conversationId: 1, model: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "" }] }] } })],
  ],
  text: "",
  thinking: "",
});

describe("stream property: mapped events converge on the final stored message", () => {
  const cases: Array<[string, () => Case]> = [
    ["reviewer case (thinking diverges, text grows from empty)", reviewerCase],
    ["block shrinks a side to empty", shrinkCase],
    ...Array.from({ length: 400 }, (_, seed): [string, () => Case] => [`seed ${seed}`, () => gen(seed)]),
  ];

  it.each(cases)("%s", async (_name, make) => {
    const c = make();
    const mapper = createEventMapper();
    const mapped = c.batches.flatMap((b) => mapper.push(b));
    expect(reduce(mapped)).toEqual({ text: c.text, thinking: c.thinking });

    const server = await bootServer();
    for (const b of c.batches) server.applyBatch(b);
    const f = server.inFlight() as { text: string; thinking?: string };
    expect({ text: f.text, thinking: f.thinking ?? "" }).toEqual({ text: c.text, thinking: c.thinking });
  });
});
