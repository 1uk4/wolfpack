import { describe, expect, it, vi } from "vitest";
import type { MemoryEvent } from "@wolfpack/protocol";
import { memoryActivityListener } from "./activity-memory.js";
import type { ActivityDraft } from "./activity-publisher.js";

const base = { wolf: "w", timestamp: "2026-11-27T00:00:00.000Z", domain: "personal" };
const obs = { ...base, type: "observation_captured", count: 1, summary: "s", target: { kind: "den" } } as MemoryEvent;
const topic = (id: string, n: number) => ({ ...base, type: "topic_consolidated", topicId: id, observationCount: n, change: "create", target: { kind: "den", topicId: id } }) as MemoryEvent;
const contrib = { ...base, type: "contribution_emitted", contributionId: "c-1", lane: "inbox/w", target: { kind: "den", topicId: "tp1" } } as MemoryEvent;

function rig(extra: { emit?: (d: ActivityDraft) => void } = {}) {
  const sent: ActivityDraft[] = [];
  let t = 1_000_000;
  const l = memoryActivityListener({ emit: extra.emit ?? ((d) => void sent.push(d)) }, { wolf: "w", poolTokens: async () => 1234, capacity: 20000, now: () => t });
  return { sent, l, advance: (ms: number) => (t += ms) };
}

describe("memory activity events", () => {
  it("observation -> memory-observe with pool size and capacity, at most one per 3 s", async () => {
    const { sent, l, advance } = rig();
    l(obs);
    l(obs);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ verb: "memory-observe", actor: { kind: "wolf", wolf: "w" }, domain: "personal", detail: { count: 1234, capacity: 20000 } });
    advance(3001);
    l(obs);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
  });
  it("a consolidation batch becomes one memory-consolidate with the topic ids", () => {
    vi.useFakeTimers();
    try {
      const { sent, l } = rig();
      l(topic("a", 7));
      l(topic("b", 7));
      expect(sent).toHaveLength(0);
      vi.advanceTimersByTime(1600);
      expect(sent).toEqual([{ verb: "memory-consolidate", actor: { kind: "wolf", wolf: "w" }, domain: "personal", detail: { count: 7, topicIds: ["a", "b"] } }]);
    } finally {
      vi.useRealTimers();
    }
  });
  it("a contribution -> memory-promote on the domain with the contribution id and den topic; a throwing publisher never escapes", () => {
    const { sent, l } = rig();
    l(contrib);
    expect(sent[0]).toMatchObject({ verb: "memory-promote", target: { kind: "domain", id: "personal" }, detail: { ref: "c-1", topicIds: ["tp1"] } });
    const bad = rig({ emit: () => { throw new Error("boom"); } });
    expect(() => bad.l(contrib)).not.toThrow();
  });
});
