import { describe, expect, it } from "vitest";
import { newObserverChunks } from "./unified.js";

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

  it("once settled, falls back to the hook's copy and later skips its committed twin", () => {
    const first = newObserverChunks([m(5, "user", "question")], current, { lastEntryId: 4 }, true)!;
    expect(textOf(first)).toBe("[user] question\n\n[assistant] the reply");
    expect(first.next.tail).toBeTruthy();
    // the response is committed afterwards; the next call must not observe it again
    const next = newObserverChunks([m(6, "assistant", "the reply"), m(7, "user", "again")], { content: [{ type: "text", text: "second" }] }, first.next, true)!;
    expect(textOf(next)).toBe("[user] again\n\n[assistant] second");
  });
});
