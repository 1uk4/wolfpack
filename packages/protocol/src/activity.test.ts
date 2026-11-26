import { describe, expect, it } from "vitest";
import { parseActivityBatch, parseActivityEvent } from "./activity.js";

const base = { v: 1, id: "e1", pack: "p1", ts: 1700000000000, ttlMs: 60000, verb: "thread-active" };
const wolf = { kind: "wolf", wolf: "1uk4" };

describe("activity events", () => {
  it("parses each actor kind", () => {
    for (const actor of [wolf, { kind: "thread", threadId: "t1" }, { kind: "subagent", subagent: "s", parentThreadId: "t1" }, { kind: "owner" }]) {
      const r = parseActivityEvent({ ...base, actor });
      expect(r.ok && r.event.actor.kind).toBe(actor.kind);
    }
  });
  it("rejects missing required fields and an over-cap ttl", () => {
    expect(parseActivityEvent({ ...base, actor: wolf, pack: undefined })).toEqual({ ok: false, reason: "invalid" });
    expect(parseActivityEvent({ ...base, verb: undefined, actor: wolf }).ok).toBe(false);
    expect(parseActivityEvent({ ...base, ttlMs: 7200000, actor: wolf }).ok).toBe(false);
  });
  it("trims over-long titles to 120 chars", () => {
    const r = parseActivityEvent({ ...base, actor: wolf, verb: "kb-read", target: { kind: "kb-entry", id: "k", title: `  ${"x".repeat(300)}` } });
    expect(r.ok && r.event.target?.title).toBe("x".repeat(120));
  });
  it("tolerates unknown fields", () => {
    const r = parseActivityEvent({ ...base, actor: { ...wolf, future: 1 }, extra: "y" });
    expect(r.ok).toBe(true);
  });
  it("drops an unknown verb, actor kind and v:2 event without failing the batch", () => {
    const good = { ...base, actor: wolf };
    const r = parseActivityBatch([good, { ...good, verb: "teleport" }, { ...good, v: 2 }, { ...good, actor: { kind: "alien" } }]);
    expect(r).toMatchObject({ ok: true, dropped: 3 });
    expect(r.ok && r.events).toHaveLength(1);
    expect(parseActivityEvent({ ...good, v: 2 })).toEqual({ ok: false, reason: "unsupported-version" });
  });
  it("rejects a batch over the limit", () => {
    expect(parseActivityBatch(new Array(101).fill({}))).toEqual({ ok: false, reason: "too-large" });
  });
});
