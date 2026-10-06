/**
 * route — the deterministic core of what the old design handed to a fat LLM
 * "assess" call. Registry alias lookup + embedding nearest-neighbour decide
 * create/merge; only the ambiguous residue escalates to an oracle.
 */
import type { ParsedContribution, Registry } from "../shared/index.js";
import type { RouteKind } from "../shared/index.js";
import { cosine, type Vector } from "./embed.js";

export interface EntryVector {
  entryId: string;
  canonicalId: string;
  domain: string;
  vector: Vector;
}

export interface RouteDecision {
  kind: RouteKind;
  /** Target entry id (merge/supersede) or null (create). */
  target: string | null;
  /** canonicalId when known via alias. */
  canonicalId: string | null;
  /** Best similarity score found, for logging/escalation. */
  score: number;
}

export interface RouteThresholds {
  /** At/above → treat as same entry (merge or conflict check). */
  duplicate: number;
  /** Between conflict and duplicate → maybe_conflict (escalate to oracle). */
  conflict: number;
}

// TODO(tuning): these are placeholders. nomic-embed-text has a COMPRESSED
// similarity range — a paraphrase scored only 0.62 on the live box, so 0.85
// will almost never fire. Recalibrate against a real corpus once Dewey has
// entries; expect something like duplicate ~0.75, conflict ~0.60. Revisit
// together with the search_document: prefix in embed.ts (both affect scores).
export const DEFAULT_ROUTE_THRESHOLDS: RouteThresholds = {
  duplicate: 0.85,
  conflict: 0.7,
};

/**
 * Decide the route for a contribution. Pure code.
 *   1. Alias in registry → merge_known (no LLM).
 *   2. Nearest entry ≥ duplicate → merge_near.
 *   3. conflict ≤ nearest < duplicate → maybe_conflict (oracle:contradict).
 *   4. Weak/absent domain hint → unclassified (oracle:classify).
 *   5. Otherwise → create.
 */
export function routeContribution(
  c: ParsedContribution,
  reg: Registry,
  vec: Vector,
  entryVectors: EntryVector[],
  thresholds: RouteThresholds = DEFAULT_ROUTE_THRESHOLDS
): RouteDecision {
  // 1. Known alias — strongest signal, zero LLM.
  for (const topic of reg.values()) {
    const alias = topic.aliases.find(
      (a) => a.wolf === c.from && a.denTopicId === c.denTopicId
    );
    if (alias) {
      return {
        kind: "merge_known",
        target: topic.entries[0] ?? null,
        canonicalId: topic.canonicalId,
        score: 1,
      };
    }
  }

  // 2/3. Nearest entry by embedding.
  let best: EntryVector | null = null;
  let bestScore = 0;
  for (const ev of entryVectors) {
    const s = cosine(vec, ev.vector);
    if (s > bestScore) {
      bestScore = s;
      best = ev;
    }
  }

  if (best && bestScore >= thresholds.duplicate) {
    return {
      kind: "merge_near",
      target: best.entryId,
      canonicalId: best.canonicalId,
      score: bestScore,
    };
  }
  if (best && bestScore >= thresholds.conflict) {
    return {
      kind: "maybe_conflict",
      target: best.entryId,
      canonicalId: best.canonicalId,
      score: bestScore,
    };
  }

  // 4. No match — classify if the hint is weak.
  if (!c.domainHint || c.domainHint.trim() === "") {
    return { kind: "unclassified", target: null, canonicalId: null, score: bestScore };
  }

  // 5. Novel, well-hinted → create.
  return { kind: "create", target: null, canonicalId: null, score: bestScore };
}
