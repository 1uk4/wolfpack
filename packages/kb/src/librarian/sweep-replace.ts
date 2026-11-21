/**
 * sweep-replace — oversize-section handling, split out of sweep.ts: the "a rebuild is due" notice, plus the
 * replaceMisfits seam (empty, not called yet).
 */
import type { KbRoots } from "../shared/index.js";
import type { Section } from "../schema/knowledge.js";
import { DEFAULT_RULES } from "./tree-rules.js";

/** Whether a parent's direct-entry count outgrew the split threshold. */
export function exceedsSplitAbove(directEntries: number): boolean {
  return directEntries > DEFAULT_RULES.splitAbove;
}

/** Tell the host once per sweep that parent sections outgrew the split threshold; `big` is "id (n)" per parent. */
export function notifySplitDue(notify: ((msg: string) => void) | undefined, big: string[]): void {
  if (big.length) notify?.(`sweep: ${big.length} parent section(s) hold more than ${DEFAULT_RULES.splitAbove} direct entries (${big.join(", ")}); a rebuild is due`);
}

/** Seam for re-homing misfit entries. Does nothing yet and is not called. */
export async function replaceMisfits(_ctx: { roots: KbRoots; sections: Section[]; notify?: (msg: string) => void }): Promise<void> {}
