import { describe, expect, it } from "vitest";
import { MemoryEventSchema, type MemoryEvent } from "@wolfpack/protocol";
import { disposeMemoryEvents, memoryEventsFor, oneLine } from "@wolfpack/harness/memory";
import { memoryEmitter } from "./memory-events.js";

describe("memoryEmitter", () => {
  it("promote_failed carries a one-line message, stamped wolf and timestamp; no subscriber is a no-op", () => {
    const den = "/tmp/mev-unit-den";
    const mem = memoryEmitter(den, "w", "wolfpack");
    mem.promoteFailed("j0", new Error("early")); // no subscriber: must not throw
    const got: MemoryEvent[] = [];
    const off = memoryEventsFor(den, "w").subscribe((e) => got.push(e));
    mem.promoteStarted("j1");
    mem.promoteFailed("j1", new Error(`first line\nsecret second line ${"x".repeat(300)}`));
    off();
    mem.promoteStarted("j2");
    expect(got.map((e) => e.type)).toEqual(["promote_started", "promote_failed"]);
    expect(got[1]).toMatchObject({ wolf: "w", jobId: "j1", message: "first line" });
    for (const e of got) expect(MemoryEventSchema.safeParse(e).success).toBe(true);
  });

  it("topic_archived omits absorbedInto for a reject; record_written targets the work item", () => {
    const den = "/tmp/mev-unit-archive-den";
    const mem = memoryEmitter(den, "w", "wolfpack");
    const got: MemoryEvent[] = [];
    const off = memoryEventsFor(den, "w").subscribe((e) => got.push(e));
    mem.topicArchived({ id: "a", entryId: "kb-wolfpack-AAAAAAA" });
    mem.topicArchived({ id: "b", entryId: null });
    mem.recordWritten({ work: "work-x-1", observationCount: 2 });
    off();
    expect(got[0]).toMatchObject({ type: "topic_archived", topicId: "a", absorbedInto: "kb-wolfpack-AAAAAAA" });
    expect(got[1]).toMatchObject({ type: "topic_archived", topicId: "b" });
    expect("absorbedInto" in got[1]).toBe(false);
    expect(got[2]).toMatchObject({ type: "record_written", observationCount: 2, target: { kind: "work", workId: "work-x-1" } });
    expect("chars" in got[2]).toBe(false);
    for (const e of got) expect(MemoryEventSchema.safeParse(e).success).toBe(true);
  });

  it("redacts obvious secrets in the summary", () => {
    expect(oneLine("use key sk-abcdefghijklmnopqrstuvwxyz123456 now")).not.toContain("sk-abcdef");
    expect(oneLine("AKIAABCDEFGHIJKLMNOP leaked")).toContain("[REDACTED");
  });

  it("disposeMemoryEvents keeps a bus with listeners and drops an idle one", () => {
    const den = "/tmp/mev-dispose-den";
    const bus = memoryEventsFor(den, "w");
    const off = bus.subscribe(() => {});
    disposeMemoryEvents(den);
    expect(memoryEventsFor(den, "other")).toBe(bus);
    off();
    disposeMemoryEvents(den);
    expect(memoryEventsFor(den, "other")).not.toBe(bus);
  });

  it("oneLine takes the first non-empty line and caps it", () => {
    expect(oneLine("\n  hello   world \nsecond")).toBe("hello world");
    expect(oneLine("a".repeat(500)).length).toBe(120);
  });
});
