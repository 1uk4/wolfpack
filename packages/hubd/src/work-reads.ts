/**
 * Work reads over the hub's ledger, shaped as the protocol's WorkListResponse / WorkRecordResponse. Folds through the kb
 * work-ops (loadWorkState / resolveWorkItem), never a second fold; the shaping is the one in @wolfpack/memory
 * (`work-shape.ts`), shared with the wolf-side reader in @wolfpack/harness.
 */
import { loadWorkState, resolveWorkItem } from "@wolfpack/kb/client";
import type { KbRoots } from "@wolfpack/kb/shared";
import { shapeWorkList, shapeWorkRecord, toWorkChild } from "@wolfpack/memory";
import type { WorkListResponse, WorkRecordResponse } from "@wolfpack/protocol";

export { CHILDREN_CAP, LOG_TAIL } from "@wolfpack/memory";

export function listWorkItems(roots: KbRoots, domain: string, includeGraduated: boolean): WorkListResponse {
  return { items: shapeWorkList([...loadWorkState(roots).values()].filter((w) => w.domain === domain), domain, includeGraduated) };
}

/** Undefined when the item is unknown. */
export function readWorkRecordFor(roots: KbRoots, id: string): WorkRecordResponse | undefined {
  const all = loadWorkState(roots);
  const item = all.get(id as never);
  if (!item) return undefined;
  const body = resolveWorkItem(roots, item.domain as string, item.id as string)?.body ?? "";
  const listed = item.kind === "feature" || item.container ? [...all.values()].filter((c) => c.partOf === item.id).map(toWorkChild) : undefined;
  return shapeWorkRecord(item, body, listed);
}
