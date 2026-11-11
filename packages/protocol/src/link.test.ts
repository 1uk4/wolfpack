import { describe, expect, it } from "vitest";
import { LINK_RELAY_CHUNK_BYTES, LINK_RELAY_HARD_SLACK, LINK_RELAY_PAUSE_HIGH, encodeLinkFrame, parseLinkFrame, LinkWolfSchema } from "./link.js";

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

describe("hello wolves: additive KB flags", () => {
  it("old shape parses with no flags; new shape keeps them; non-boolean is refused", () => {
    expect(LinkWolfSchema.parse({ name: "a" })).toEqual({ name: "a", domains: [] });
    expect(LinkWolfSchema.parse({ name: "a", librarian: true, kbReadable: false })).toMatchObject({ librarian: true, kbReadable: false });
    expect(LinkWolfSchema.safeParse({ name: "a", librarian: "yes" }).success).toBe(false);
    const hello = { t: "hello", v: 1, hostId: "box", laptop: false, wolves: [{ name: "a", domains: [], kbReadable: true }], kbRevisions: {} };
    expect(parseLinkFrame(JSON.stringify(hello)).ok).toBe(true);
  });

  it("hello carries an optional machine name", () => {
    const hello = { t: "hello", v: 1, hostId: "sfo-01-wolves", laptop: false, wolves: [], kbRevisions: {} };
    const withMachine = parseLinkFrame(JSON.stringify({ ...hello, machine: "sfo-01" }));
    expect(withMachine.ok && withMachine.frame).toMatchObject({ machine: "sfo-01" });
    const without = parseLinkFrame(JSON.stringify(hello));
    expect(without.ok && (without.frame as { machine?: string }).machine).toBeUndefined();
  });
});
