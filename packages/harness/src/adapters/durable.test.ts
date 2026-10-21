import { describe, expect, it } from "vitest";
import { toDurableResult } from "./durable.js";

describe("toDurableResult", () => {
  it("puts tool text on pi-durable's output channel", () => {
    expect(toDurableResult({ content: [{ type: "text", text: "done" }] })).toEqual({
      output: [{ type: "text", text: "done" }],
    });
  });

  it("keeps the error text and flag", () => {
    expect(toDurableResult({ content: [{ type: "text", text: "Consolidation failed: 400" }], isError: true })).toEqual({
      output: [{ type: "text", text: "Consolidation failed: 400" }],
      isError: true,
    });
  });

  it("never returns an empty error (the API rejects it and wedges the conversation)", () => {
    for (const content of [[], [{ type: "text" as const, text: "  " }]]) {
      const r = toDurableResult({ content, isError: true });
      expect(r.isError).toBe(true);
      expect(r.output.length).toBe(1);
      expect(r.output[0]!.text.trim()).not.toBe("");
    }
  });
});
