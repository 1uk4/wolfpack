import { describe, expect, it } from "vitest";
import { newObserverChunks, seedWatermark, chunkEntryId } from "./unified.js";

const m = (entryId: number, role: string, text: string) => ({ entryId, message: { role, content: role === "user" ? text : [{ type: "text", text }] } });
const current = { content: [{ type: "text" as const, text: "the reply" }] };
const textOf = (r: ReturnType<typeof newObserverChunks>) => r?.chunks.map((c) => c.text).join("\n");

describe("newObserverChunks", () => {
  it("waits for the reported response to be committed, then reads only committed messages", () => {
    const pending = [m(5, "user", "question")];
    expect(newObserverChunks(pending, current, { lastEntryId: 4 }, false)).toBeUndefined();
    const done = newObserverChunks([...pending, m(6, "assistant", "the reply")], current, { lastEntryId: 4 }, false);
    expect(textOf(done)).toBe("[user] question\n\n[assistant] the reply");
    expect(done?.next).toEqual({ lastEntryId: 6 });
  });

  it("settled fallback: hook-copy observation, then the committed read gives no duplicate", () => {
    const first = newObserverChunks([m(5, "user", "question")], current, { lastEntryId: 4 }, true)!;
    expect(textOf(first)).toBe("[user] question\n\n[assistant] the reply");
    expect(first.next).toMatchObject({ lastEntryId: 5, tailAfter: 5 });
    expect(first.chunks.at(-1)!.id).toBe("5:current");
    expect(chunkEntryId("5:current")).toBe(5);
    const next = newObserverChunks([m(6, "assistant", "the reply"), m(7, "user", "again")], { content: [{ type: "text", text: "second" }] }, { ...first.next, lastEntryId: 5 }, true)!;
    expect(textOf(next)).toBe("[user] again\n\n[assistant] second");
  });

  it("an aborted turn (never committed) followed by an identical committed reply keeps the new reply", () => {
    const first = newObserverChunks([m(5, "user", "question")], current, { lastEntryId: 4 }, true)!;
    // the reply was never committed; the user asks again and gets an identical reply
    const next = newObserverChunks([m(6, "user", "ask again"), m(7, "assistant", "the reply")], current, first.next, false)!;
    expect(textOf(next)).toBe("[user] ask again\n\n[assistant] the reply");
  });

  it("a lagging observer still finds the reported response among later assistant entries (no hook-copy duplicate)", () => {
    const rest = [m(6, "assistant", "the reply"), m(7, "toolResult", "ok"), m(8, "assistant", "something else")];
    const out = newObserverChunks(rest, current, { lastEntryId: 5 }, true)!;
    expect(textOf(out).match(/the reply/g)).toHaveLength(1);
    expect(out.next).toEqual({ lastEntryId: 8 });
  });
});

describe("seedWatermark", () => {
  it("starts at the newest user message (start from now)", () => {
    const hist = [m(2, "user", "old"), m(3, "assistant", "old reply"), m(10, "user", "now"), m(11, "assistant", "calling")];
    expect(seedWatermark(hist)).toEqual({ lastEntryId: 9 });
    expect(seedWatermark([])).toEqual({ lastEntryId: 0 });
  });
});
