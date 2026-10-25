/**
 * Mapper tests driven by real engine captures (spikes/durable-bridge/evidence, pi-durable 1.4.0), copied to
 * __fixtures__ so the suite is self-contained. If an engine upgrade changes event shapes, this suite fails first.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ThreadEventSchema } from "@wolfpack/protocol";
import { createEventMapper, mapEngineEvents, stampEvent, type EngineEvent, type MappedEvent, type ThreadEventDraft } from "./events.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const load = (name: string): any => JSON.parse(readFileSync(join(dir, name), "utf8"));
const batchesOf = (rec: { batches: { events: EngineEvent[] }[] }): EngineEvent[][] => rec.batches.map((b) => b.events);

function run(bs: EngineEvent[][]): MappedEvent[] {
  const m = createEventMapper();
  return [...bs.flatMap((b) => m.push(b)), ...m.flush()];
}
const types = (evs: MappedEvent[]) => evs.map((e) => e.type);
const text = (evs: MappedEvent[]) => evs.flatMap((e) => (e.type === "text-delta" ? [e.text] : [])).join("");
/** Events of the first turn only (some recordings continue into a follow-up). */
const firstTurn = (evs: MappedEvent[]) => evs.slice(0, evs.findIndex((e) => e.type === "turn-end") + 1);
/** Final text of every assistant message_end, concatenated per run — the authoritative answer. */
const finalAssistantText = (bs: EngineEvent[][]) =>
  bs
    .flat()
    .filter((e): e is Extract<EngineEvent, { type: "message_end" }> => e.type === "message_end" && e.entry.kind === "pi.assistant")
    .map((e) => (e.entry.model?.[0] as any).content.filter((c: any) => c.type === "text").map((c: any) => c.text).join(""));

describe("plain streamed turn (1-submit)", () => {
  const bs = batchesOf(load("1-submit.json").root.rec);
  const evs = run(bs);

  it("maps to turn-start, text-deltas, turn-end", () => {
    expect(evs[0]).toEqual({ type: "turn-start", turnId: "turn-8" });
    expect(new Set(types(evs.slice(1, -1)))).toEqual(new Set(["text-delta"]));
    expect(evs.at(-1)).toEqual({ type: "turn-end", turnId: "turn-8", reason: "complete" });
  });

  it("includes partial text from message_start and a reconciled tail from message_end", () => {
    // message_start carried "Sle"; the throttled stream stopped before the last sentence.
    expect(evs[1]).toMatchObject({ type: "text-delta", text: "Sle" });
    expect(text(evs)).toBe(finalAssistantText(bs).join(""));
    expect(text(evs).endsWith("fall of night.")).toBe(true);
  });
});

describe("zero-delta fast turn (6-tools, final round)", () => {
  const bs = batchesOf(load("6-tools.json").rec);
  it("emits the text carried on message_start exactly once", () => {
    const updates = bs.flat().filter((e) => e.type === "message_update");
    expect(updates).toHaveLength(0); // the capture really has no deltas
    const evs = run(bs);
    expect(evs.filter((e) => e.type === "text-delta")).toEqual([{ type: "text-delta", turnId: "turn-8", text: "Result: 42" }]);
  });
});

describe("tool turn (6-tools)", () => {
  const evs = run(batchesOf(load("6-tools.json").rec));
  it("spans model rounds as ONE protocol turn", () => {
    expect(types(evs)).toEqual(["turn-start", "tool-start", "tool-end", "tool-start", "tool-end", "text-delta", "turn-end"]);
  });
  it("carries name, callId, args, result text and isError", () => {
    const starts = evs.filter((e) => e.type === "tool-start");
    expect(starts.map((e: any) => [e.name, e.args])).toEqual([
      ["add", { a: 17, b: 25 }],
      ["echo", { text: "42" }],
    ]);
    const ends = evs.filter((e) => e.type === "tool-end");
    expect(ends.map((e: any) => [e.result, e.isError])).toEqual([
      ["42", false],
      ["echo: 42", false],
    ]);
    expect((ends[0] as any).callId).toBe((starts[0] as any).callId);
  });
});

describe("steer (3-steer)", () => {
  const evs = run(batchesOf(load("3-steer.json").rec));
  it("accumulates tool output across set/append updates, dropping details-only updates", () => {
    const outs = evs.filter((e) => e.type === "tool-update").map((e: any) => e.output);
    expect(outs).toEqual(["tick 1/4\n", "tick 1/4\ntick 2/4\n", "tick 1/4\ntick 2/4\ntick 3/4\n", "tick 1/4\ntick 2/4\ntick 3/4\ntick 4/4\n"]);
  });
  it("delivers the steered answer after the tool round, in the same turn; queued follow-up is its own turn", () => {
    expect(types(evs)).toEqual([
      "turn-start", "tool-start", "tool-update", "tool-update", "tool-update", "tool-update", "tool-end", "text-delta", "turn-end",
      "turn-start", "text-delta", "turn-end",
    ]);
    expect(text(firstTurn(evs))).toBe("PINEAPPLE");
    expect(evs.filter((e) => e.type === "turn-start").map((e: any) => e.turnId)).toEqual(["turn-8", "turn-14"]);
  });
});

describe("abort (4-abort)", () => {
  it("mid-tool: error tool-end keeps partial output, turn-end reason aborted, next turn is clean", () => {
    const evs = run(batchesOf(load("4-abort.json")["mid-tool"].rec));
    expect(types(evs)).toEqual(["turn-start", "tool-start", "tool-update", "tool-end", "turn-end", "turn-start", "text-delta", "turn-end"]);
    const end = evs.find((e) => e.type === "tool-end") as any;
    expect(end.isError).toBe(true);
    expect(end.result).toContain("tick 1/20");
    expect(evs.filter((e) => e.type === "turn-end").map((e: any) => e.reason)).toEqual(["aborted", "complete"]);
  });

  it("mid-generation: partial text is reconciled from the aborted message_end; turn-end aborted", () => {
    const bs = batchesOf(load("4-abort.json")["mid-generation"].rec);
    const evs = run(bs);
    const first = firstTurn(evs);
    expect(first.at(-1)).toMatchObject({ type: "turn-end", reason: "aborted" });
    expect(text(first)).toBe(finalAssistantText(bs)[0]);
  });
});

describe("ask via terminate (6b)", () => {
  it("ends the turn complete right after the tool, with no assistant text; next submit is a new turn", () => {
    const evs = run(batchesOf(load("6b-ask-terminate.json").rec));
    const first = firstTurn(evs);
    expect(types(first)).toEqual(["turn-start", "tool-start", "tool-end", "turn-end"]);
    expect((first[1] as any).name).toBe("ask_user");
    expect((first.at(-1) as any).reason).toBe("complete");
    expect(types(evs).filter((t) => t === "turn-start")).toHaveLength(2);
  });
});

describe("protocol conformance", () => {
  it("every mapped event validates against ThreadEventSchema once stamped", () => {
    for (const f of [load("1-submit.json").root.rec, load("3-steer.json").rec, load("4-abort.json")["mid-tool"].rec, load("6-tools.json").rec]) {
      let id = 0;
      for (const e of run(batchesOf(f))) {
        const stamped = stampEvent(e as ThreadEventDraft, { threadId: "t1", id: ++id, actor: { id: "1uk4", kind: "wolf" } });
        expect(() => ThreadEventSchema.parse(stamped)).not.toThrow();
      }
    }
  });

  it("mapEngineEvents (async) equals the synchronous mapper", async () => {
    const bs = batchesOf(load("3-steer.json").rec);
    async function* gen() {
      for (const b of bs) yield b;
    }
    const out: MappedEvent[] = [];
    for await (const e of mapEngineEvents(gen())) out.push(e);
    expect(out).toEqual(run(bs));
  });
});
