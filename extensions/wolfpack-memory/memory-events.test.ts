import { describe, expect, it } from "vitest";
import { MemoryEventSchema, type MemoryEvent } from "@wolfpack/protocol";
import { memoryEventsFor, oneLine } from "@wolfpack/harness/memory";
import { memoryEmitter } from "./memory-events.js";

describe("memoryEmitter", () => {
  it("promote_failed carries a one-line message, stamped wolf and timestamp; no subscriber is a no-op", () => {
    const den = "/tmp/mev-unit-den";
    const mem = memoryEmitter(den, "w", "wolfpack");
    mem.promoteFailed("j0", new Error("early")); // no subscriber: must not throw
    const got: MemoryEvent[] = [];
    const off = memoryEventsFor(den).subscribe((e) => got.push(e));
    mem.promoteStarted("j1");
    mem.promoteFailed("j1", new Error(`first line\nsecret second line ${"x".repeat(300)}`));
    off();
    mem.promoteStarted("j2");
    expect(got.map((e) => e.type)).toEqual(["promote_started", "promote_failed"]);
    expect(got[1]).toMatchObject({ wolf: "w", jobId: "j1", message: "first line" });
    for (const e of got) expect(MemoryEventSchema.safeParse(e).success).toBe(true);
  });

  it("oneLine takes the first non-empty line and caps it", () => {
    expect(oneLine("\n  hello   world \nsecond")).toBe("hello world");
    expect(oneLine("a".repeat(500)).length).toBe(120);
  });
});
