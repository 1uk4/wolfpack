import { describe, expect, it } from "vitest";
import { summarizePending } from "./memory-read.js";

const NOW = 10_000_000;
const sum = (o: Partial<Parameters<typeof summarizePending>[0]>) => ({ keys: {}, firstPendingAt: {}, assignees: {}, messages: {}, nextAttemptAt: {}, ...o });

describe("memory status: stuck saves summary", () => {
  it("is absent when nothing waits", () => {
    expect(summarizePending(sum({}), NOW)).toBeUndefined();
  });

  it("counts stuck groups, gives the oldest age and the soonest retry, and clips the first message", () => {
    const long = "x".repeat(300);
    const s = summarizePending(sum({
      keys: { a: "consolidation-failed", b: "forbidden" },
      firstPendingAt: { a: NOW - 7_200_000, b: NOW - 60_000 },
      nextAttemptAt: { a: NOW + 2_400_000, b: NOW + 600_000 },
      messages: { a: long },
      oldestAgeMs: 7_200_000,
    }), NOW);
    expect(s).toEqual({ stuck: 2, oldestAgeMs: 7_200_000, nextRetryInMs: 600_000, message: "x".repeat(200) });
  });

  it("reports a retry already due as 0 and omits a missing message", () => {
    const s = summarizePending(sum({ keys: { a: "work-api-unavailable" }, firstPendingAt: { a: NOW - 5000 }, nextAttemptAt: { a: NOW - 1000 }, oldestAgeMs: 5000 }), NOW);
    expect(s).toEqual({ stuck: 1, oldestAgeMs: 5000, nextRetryInMs: 0 });
  });
});
