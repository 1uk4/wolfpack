/**
 * MemoryEvent emission for the memory extension: builds the metadata-only events (ids, counts, a one-line summary)
 * and puts them on the den's bus (packages/harness/src/memory/events.ts). unified.ts only calls these at the points
 * where the work already happens.
 */
import { disposeMemoryEvents, memoryEventsFor, oneLine, type ConsolidatedTopic, type PromoteOutcome } from "@wolfpack/harness/memory";
import type { MemoryTarget } from "@wolfpack/protocol";

export interface BoundWork {
  taskId: string;
  featureId?: string;
}

/** The home thread's id, `<wolf>/home`: what the observer's root conversation is on the wolf API. Forks have none. */
export const homeThreadId = (wolfName: string) => `${wolfName}/home`;

export function memoryEmitter(wolfDen: string, wolfName: string, defaultDomain: string) {
  // Looked up per emit: a disposed bus (server closed) is recreated and shared again.
  const bus = { emit: (d: Parameters<ReturnType<typeof memoryEventsFor>["emit"]>[0]) => memoryEventsFor(wolfDen, wolfName).emit(d) };
  return {
    /** Observations appended to the pool. Summary: the first line of the first observation, capped at 120 chars. */
    observed(observations: Array<{ content: string; domain?: string }>, bound: BoundWork | null, threadId?: string): void {
      if (observations.length === 0) return;
      const target: MemoryTarget = bound ? { kind: "work", workId: bound.taskId, ...(bound.featureId ? { featureId: bound.featureId } : {}) } : { kind: "den" };
      bus.emit({
        type: "observation_captured",
        ...(threadId ? { threadId } : {}),
        domain: observations[0].domain || defaultDomain,
        target,
        count: observations.length,
        summary: oneLine(observations[0].content),
      });
    },
    /** Release the den's bus at shutdown (kept if a subscriber is still attached). */
    dispose(): void {
      disposeMemoryEvents(wolfDen);
    },
    topic(t: ConsolidatedTopic): void {
      bus.emit({
        type: "topic_consolidated",
        domain: t.domain || defaultDomain,
        target: { kind: t.scope === "session" ? "session" : "den", topicId: t.id },
        topicId: t.id,
        observationCount: t.observationCount,
        change: t.change,
      });
    },
    contribution(c: { id: string; denTopicId: string; domain: string }): void {
      bus.emit({
        type: "contribution_emitted",
        domain: c.domain || defaultDomain,
        target: { kind: "den", topicId: c.denTopicId },
        contributionId: c.id,
        lane: `inbox/${wolfName}`,
      });
    },
    promoteStarted(jobId: string): void {
      bus.emit({ type: "promote_started", domain: defaultDomain, target: { kind: "den" }, jobId });
    },
    promoteFinished(jobId: string, out: PromoteOutcome): void {
      bus.emit({
        type: "promote_finished",
        domain: defaultDomain,
        target: { kind: "den" },
        jobId,
        consolidated: out.consolidated,
        contributions: out.promoted.claimsSubmitted,
        ...(out.promoted.distillPending ? { pending: out.promoted.distillPending } : {}),
      });
    },
    promoteFailed(jobId: string, err: unknown): void {
      bus.emit({ type: "promote_failed", domain: defaultDomain, target: { kind: "den" }, jobId, message: oneLine(err instanceof Error ? err.message : String(err)) });
    },
  };
}
