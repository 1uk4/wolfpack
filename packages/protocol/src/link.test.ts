import { describe, expect, it } from "vitest";
import { LINK_RELAY_CHUNK_BYTES, LINK_RELAY_HARD_SLACK, LINK_RELAY_PAUSE_HIGH, encodeLinkFrame, parseLinkFrame } from "./link.js";

describe("relay flow-control frames", () => {
  it("pause and resume round-trip and need a non-empty id", () => {
    for (const t of ["pause", "resume"] as const) {
      const p = parseLinkFrame(encodeLinkFrame({ t, id: "h-7" }));
      expect(p).toEqual({ ok: true, frame: { t, id: "h-7" } });
      expect(parseLinkFrame(JSON.stringify({ t, id: "" })).ok).toBe(false);
      expect(parseLinkFrame(JSON.stringify({ t })).ok).toBe(false);
    }
  });
  it("thresholds are ordered and a chunk always fits under the pause point plus slack", () => {
    expect(LINK_RELAY_CHUNK_BYTES).toBeLessThanOrEqual(LINK_RELAY_PAUSE_HIGH);
    expect(LINK_RELAY_HARD_SLACK).toBeGreaterThan(LINK_RELAY_CHUNK_BYTES);
  });
});
