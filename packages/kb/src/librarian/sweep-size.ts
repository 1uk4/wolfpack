/**
 * sweep-size — the sweep's size rules, split out of sweep.ts: the merge-target size limit, the verbatim-anchor
 * exemption from the size guard, the "kept oversize" notice and the `~split-` placement decision.
 */
import { SWEEP } from "@wolfpack/engine";
import type { ParsedContribution } from "../shared/index.js";

/** The merge threshold derives from the run budget: budget * mergeBudgetFraction / msPerMergeChar (600s -> 24,000 chars). */
export function maxMergeTargetCharsFor(itemBudgetMs: number): number {
  return Math.floor((itemBudgetMs * SWEEP.mergeBudgetFraction) / SWEEP.msPerMergeChar);
}

/** The merge size limit, with the KB_MAX_MERGE_TARGET_CHARS override. */
export function mergeSizeLimit(maxMergeTargetChars: number): number {
  return Number(process.env.KB_MAX_MERGE_TARGET_CHARS) || maxMergeTargetChars;
}

/** A verbatim anchored entry is replaced whole, not merged: the size guard does not apply. */
export function exemptFromSizeGuard(c: Pick<ParsedContribution, "anchor" | "verbatim">): boolean {
  return !!(c.anchor && c.verbatim);
}

/** Notify when produce kept an entry oversize. */
export function notifyKeptOversize(
  notify: ((msg: string) => void) | undefined,
  c: Pick<ParsedContribution, "from" | "denTopicId">,
  entryId: string,
  oversizeChars: number | undefined,
): void {
  if (oversizeChars) notify?.(`sweep: ${c.from}/${c.denTopicId} → kept oversize: ${entryId} ${oversizeChars}`);
}

/** Whether placement may route (overflow allowed): a second subject split out of another contribution may not split again. */
export function shouldRoutePlacement(c: Pick<ParsedContribution, "denTopicId">): boolean {
  return !c.denTopicId.includes("~split-");
}
