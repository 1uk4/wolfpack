/**
 * Crystallization selection — pure threshold logic (NO LLM).
 *
 * Mirrors selectPromotionOverflow in the memory package: a code decision about
 * *when* a cluster has enough mass to become a named canonical topic. This
 * controls routing quality (subcategory, subscriptions), NEVER reachability —
 * entries are already live from the moment they're committed.
 */
import type { ClusterState } from "./ledger.js";

export interface CrystallizationThresholds {
  /** Minimum contributions in a cluster. */
  minMembers: number;
  /** Minimum distinct contributing wolves. */
  minWolves: number;
}

export const DEFAULT_THRESHOLDS: CrystallizationThresholds = {
  minMembers: 3,
  minWolves: 1,
};

/** Clusters that have crossed the threshold and are not yet crystallized. */
export function selectCrystallizationCandidates(
  clusters: Map<string, ClusterState>,
  thresholds: CrystallizationThresholds = DEFAULT_THRESHOLDS
): ClusterState[] {
  const out: ClusterState[] = [];
  for (const c of clusters.values()) {
    if (c.canonicalId) continue; // already crystallized
    if (
      c.members.length >= thresholds.minMembers &&
      c.wolves.size >= thresholds.minWolves
    ) {
      out.push(c);
    }
  }
  return out;
}
