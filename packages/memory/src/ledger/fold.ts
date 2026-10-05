/**
 * Ledger fold — compute the active observation buffer from the event log.
 * Extracted from OM. Pure function, no side effects.
 *
 * Observations use first-valid-record-wins semantics keyed by timestamp.
 * Drops are tombstones — once dropped, an observation never comes back.
 */
import type {
  Observation,
  LedgerEvent,
  ObservationsRecorded,
  ObservationsDropped,
} from "./types.js";

export interface FoldedLedger {
  /** All recorded observations (including dropped) */
  observations: Observation[];
  /** Active observations (not tombstoned) — the live buffer */
  activeObservations: Observation[];
  /** Tombstoned timestamps */
  droppedTimestamps: Set<string>;
  /** Observations by timestamp (for dedup) */
  byTimestamp: Map<string, Observation>;
  /** Latest coverage watermark */
  latestCoverageId: string | undefined;
}

/**
 * Fold a sequence of ledger events into the current observation state.
 */
export function foldLedger(events: LedgerEvent[]): FoldedLedger {
  const byTimestamp = new Map<string, Observation>();
  const droppedTimestamps = new Set<string>();
  let latestCoverageId: string | undefined;

  for (const event of events) {
    if (event.type === "observations_recorded") {
      const recorded = event as ObservationsRecorded;
      for (const obs of recorded.observations) {
        // First-valid-record wins
        if (!byTimestamp.has(obs.timestamp)) {
          byTimestamp.set(obs.timestamp, obs);
        }
      }
      latestCoverageId = recorded.coversUpToId;
    }

    if (event.type === "observations_dropped") {
      const dropped = event as ObservationsDropped;
      for (const ts of dropped.observationTimestamps) {
        droppedTimestamps.add(ts);
      }
    }
  }

  const observations = Array.from(byTimestamp.values());
  const activeObservations = observations.filter(
    (o) => !droppedTimestamps.has(o.timestamp)
  );

  return {
    observations,
    activeObservations,
    droppedTimestamps,
    byTimestamp,
    latestCoverageId,
  };
}

/**
 * Compute the token count of the active observation pool.
 */
export function poolTokens(observations: Observation[]): number {
  return observations.reduce((sum, o) => sum + o.tokenCount, 0);
}

/**
 * Select observations to promote (consolidate) — the oldest above the target.
 * Returns the overflow batch and the remaining buffer.
 */
export function selectPromotionOverflow(
  active: Observation[],
  targetTokens: number
): { promote: Observation[]; keep: Observation[] } {
  const sorted = [...active].sort((a, b) =>
    a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0
  );

  // Keep the most recent up to targetTokens, promote the rest
  let keepTokens = 0;
  const keep: Observation[] = [];
  const promote: Observation[] = [];

  // Walk from newest to oldest, keeping until we hit the target
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (keepTokens + sorted[i].tokenCount <= targetTokens) {
      keep.unshift(sorted[i]);
      keepTokens += sorted[i].tokenCount;
    } else {
      promote.unshift(sorted[i]);
    }
  }

  return { promote, keep };
}

/**
 * Sort observations chronologically.
 */
export function sortObservations(observations: Observation[]): Observation[] {
  return [...observations].sort((a, b) =>
    a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0
  );
}
