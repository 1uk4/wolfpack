/**
 * Promote guard, defense in depth. The real barrier is upstream: consolidation never lets a work- or feature-tagged
 * observation into a den pass (it is written to a Record, discarded, or stays pending). This refuses whatever
 * still carries a tag at the points that feed the den and the KB: session topics, den topics and distill input.
 * Tags reach topic files only through frontmatter (`work:` / `feature:`), which nothing in the fold writes today.
 */
export function refuseTagged<T extends { work?: string; feature?: string }>(items: readonly T[], onProgress?: (msg: string) => void): T[] {
  const kept = items.filter((o) => !o.work && !o.feature);
  if (kept.length < items.length) onProgress?.(`refused ${items.length - kept.length} work-tagged item(s): work knowledge reaches the KB only through graduation`);
  return kept;
}

