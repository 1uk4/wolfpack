import { describe, expect, it } from "vitest";
import type { EngineEvent } from "../engine/index.js";
import { createPreviewTracker } from "./preview.js";

const ev = (e: unknown) => e as EngineEvent;
const upd = (...changes: object[]) => ev({ type: "message_update", changes });
const end = (text: string) =>
  ev({ type: "message_end", entry: { kind: "pi.assistant", id: 5, conversationId: 1, model: [{ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" }] } });

describe("telegram preview tracker", () => {
  it("keeps restreamed head text and ends equal to the final text", () => {
    const t = createPreviewTracker();
    t.push([
      ev({ type: "run_start", inputs: [1] }),
      ev({ type: "message_start", message: { role: "assistant", content: [] } }),
      upd({ type: "text_start", contentIndex: 0, block: { type: "text", text: "HEAD-" } }),
      upd({ type: "text_delta", contentIndex: 0, delta: "MIDDLE-" }),
      upd({ type: "block", contentIndex: 0, block: { type: "text", text: "HEAD-MIDDLE-" } }),
      end("HEAD-MIDDLE-MORE-TAIL"),
    ]);
    expect(t.text).toBe("HEAD-MIDDLE-MORE-TAIL");
  });

  it("each tool-round message is appended; a diverged final rewrites only its own message", () => {
    const t = createPreviewTracker();
    t.push([
      ev({ type: "run_start", inputs: [1] }),
      ev({ type: "message_start", message: { role: "assistant", content: [] } }),
      end("one "),
      ev({ type: "message_start", message: { role: "assistant", content: [] } }),
      upd({ type: "text_delta", contentIndex: 0, delta: "stale" }),
      end("two"),
    ]);
    expect(t.text).toBe("one two");
  });
});
