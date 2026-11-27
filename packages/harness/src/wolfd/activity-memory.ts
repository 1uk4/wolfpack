/**
 * Memory pipeline -> live pack map. Translates this wolf's MemoryEvents (the per-den bus) into pack.activity events:
 *   observation_captured -> memory-observe   detail {count: pool tokens now, capacity: consolidation threshold (tokens)}
 *   topic_consolidated   -> memory-consolidate (one per batch, debounced) detail {count: observations folded, topicIds}
 *   contribution_emitted -> memory-promote   target {domain}, detail {ref: contribution id, topicIds: [den topic]}
 * Best effort: nothing here can throw into, or delay, the memory pipeline. No content: ids and counts only.
 */
import type { MemoryEvent } from "@wolfpack/protocol";
import type { ActivityPublisher } from "./activity-publisher.js";

export const MEMORY_OBSERVE_MIN_GAP_MS = 3000;
export const MEMORY_CONSOLIDATE_DEBOUNCE_MS = 1500;

export interface MemoryActivityOptions {
  wolf: string;
  /** Pool size in tokens right now. Throwing or rejecting skips that event. */
  poolTokens: () => Promise<number>;
  /** Pool tokens at which consolidation triggers (memory.consolidation.threshold). */
  capacity: number;
  now?: () => number;
}

export function memoryActivityListener(pub: Pick<ActivityPublisher, "emit">, o: MemoryActivityOptions): (ev: MemoryEvent) => void {
  const now = o.now ?? Date.now;
  const actor = { kind: "wolf" as const, wolf: o.wolf };
  let lastObserve = -Infinity;
  let batch: { ids: string[]; count: number; domain: string } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flushBatch = () => {
    timer = undefined;
    const b = batch;
    batch = undefined;
    if (!b) return;
    try {
      pub.emit({ verb: "memory-consolidate", actor, domain: b.domain, detail: { count: b.count, topicIds: b.ids.slice(0, 20) } });
    } catch { /* never fail the pipeline */ }
  };

  return (ev) => {
    try {
      switch (ev.type) {
        case "observation_captured": {
          const t = now();
          if (t - lastObserve < MEMORY_OBSERVE_MIN_GAP_MS) return;
          lastObserve = t;
          o.poolTokens().then(
            (tokens) => { try { pub.emit({ verb: "memory-observe", actor, domain: ev.domain, detail: { count: Math.max(0, Math.round(tokens)), capacity: o.capacity } }); } catch { /* ignore */ } },
            () => {},
          );
          return;
        }
        case "topic_consolidated": {
          batch ??= { ids: [], count: 0, domain: ev.domain };
          if (!batch.ids.includes(ev.topicId)) batch.ids.push(ev.topicId);
          batch.count = Math.max(batch.count, ev.observationCount);
          if (!timer) {
            timer = setTimeout(flushBatch, MEMORY_CONSOLIDATE_DEBOUNCE_MS);
            timer.unref?.();
          }
          return;
        }
        case "contribution_emitted": {
          const topic = ev.target.kind === "work" ? undefined : ev.target.topicId;
          pub.emit({
            verb: "memory-promote", actor, domain: ev.domain,
            target: { kind: "domain", id: ev.domain },
            detail: { ref: ev.contributionId, ...(topic ? { topicIds: [topic] } : {}) },
          });
          return;
        }
      }
    } catch { /* never fail the pipeline */ }
  };
}
