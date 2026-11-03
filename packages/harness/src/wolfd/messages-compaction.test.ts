/** A pi.compaction entry becomes its own marker row: summary unwrapped, never merged into the assistant text around it. */
import { describe, expect, it } from "vitest";
import { ThreadMessageSchema } from "@wolfpack/protocol";
import { messagesFromEntries } from "./messages.js";

type E = Parameters<typeof messagesFromEntries>[0][number];
const entry = (id: number, kind: string, model: unknown[], data?: unknown) => ({ id, kind, model, ...(data ? { data } : {}) }) as unknown as E;
const wrapped = (s: string) => `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${s}\n</summary>`;

describe("compaction marker rows", () => {
  it("emits the unwrapped summary between messages without merging assistant rounds across it", () => {
    const list = messagesFromEntries([
      entry(1, "pi.user", [{ role: "user", content: "hi", timestamp: 1000 }]),
      entry(2, "pi.assistant", [{ role: "assistant", content: [{ type: "text", text: "before" }], timestamp: 2000 }]),
      entry(3, "pi.compaction", [{ role: "user", content: [{ type: "text", text: wrapped("## Goal\n\nthings") }], timestamp: 3000 }], { reason: "threshold" }),
      entry(4, "pi.assistant", [{ role: "assistant", content: [{ type: "text", text: "after" }], timestamp: 4000 }]),
    ]);
    expect(list.map((m) => m.text)).toEqual(["hi", "before", "", "after"]);
    expect(list[2]).toMatchObject({ id: "entry-3", role: "assistant", at: new Date(3000).toISOString(), compaction: { summary: "## Goal\n\nthings", reason: "threshold" } });
    for (const m of list) expect(ThreadMessageSchema.safeParse(m).success).toBe(true);
  });
  it("plain transcripts carry no compaction field (older payload shape)", () => {
    const list = messagesFromEntries([entry(1, "pi.user", [{ role: "user", content: "hi", timestamp: 1 }])]);
    expect("compaction" in list[0]!).toBe(false);
  });
});
