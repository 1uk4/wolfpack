import { describe, expect, it } from "vitest";
import { parseActivityBatch, parseActivityEvent } from "./activity.js";

const base = { v: 1, id: "e1", pack: "p", ts: 1, ttlMs: 1000, actor: { kind: "wolf", wolf: "w" } };

describe("memory pipeline activity", () => {
  it("accepts the memory verbs with a detail, trimming over-long strings and capping topicIds", () => {
    const r = parseActivityEvent({
      ...base, verb: "curate-done",
      detail: { count: 3, capacity: 20000, outcome: ` ${"o".repeat(40)}`, section: "s1", sectionTitle: "t".repeat(300), reason: "r".repeat(400), tokens: 5, ms: 7, ref: "x".repeat(200), topicIds: Array.from({ length: 30 }, (_, i) => `t${i}`), junk: 1 },
    });
    expect(r.ok && r.event.detail).toMatchObject({ count: 3, capacity: 20000, outcome: "o".repeat(24), section: "s1", sectionTitle: "t".repeat(120), reason: "r".repeat(160), tokens: 5, ms: 7, ref: "x".repeat(80) });
    expect(r.ok && r.event.detail?.topicIds).toHaveLength(20);
    expect(r.ok && "junk" in (r.event.detail ?? {})).toBe(false);
    for (const verb of ["memory-observe", "memory-consolidate", "memory-promote", "curate-start"]) expect(parseActivityEvent({ ...base, verb }).ok).toBe(true);
  });
  it("keeps an event without detail valid and drops unknown verbs and a bad detail per event", () => {
    const r = parseActivityBatch([{ ...base, verb: "kb-read" }, { ...base, verb: "memory-teleport" }, { ...base, verb: "memory-observe", detail: { capacity: 0 } }]);
    expect(r).toMatchObject({ ok: true, dropped: 2 });
  });
});
