import { describe, expect, it } from "vitest";
import { ev } from "./ev.js";
import { now, isoNow } from "./ids.js";

describe("ledger event stamps", () => {
  it("carry a full ISO time with a zone; now() keeps its 16-char form", () => {
    const e = ev.decision({ from: "w", denTopicId: "t", hash: "h", outcome: "create" });
    expect(e.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(isoNow()).toMatch(/Z$/);
    expect(now()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});
