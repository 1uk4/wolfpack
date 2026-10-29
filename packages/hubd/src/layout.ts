/**
 * The hub data directory: the single place that knows where the pack authority keeps its state.
 *
 *   <dataDir>/ledger/work-events.jsonl   the work ledger (hubd is its only writer)
 *   <dataDir>/kb/base/                   materialized KB (domains/<d>/work/<id>.md, entries)
 *   <dataDir>/kb/ops/                    librarian ops lanes
 *
 * The layout is expressed as the `KbRoots` the @wolfpack/kb work-ops already take, so later tickets (writes, graduation, KB
 * commits) run those ops in-process on `hubRoots(dataDir)`.
 */
import { join } from "node:path";
import type { KbRoots } from "@wolfpack/kb/shared";

export function hubRoots(dataDir: string): KbRoots {
  return { kbBase: join(dataDir, "kb", "base"), opsRoot: join(dataDir, "kb", "ops"), denLocal: dataDir };
}

/**
 * The hub's contribution intake: `<dataDir>/kb/ops/contributions/<wolf>/<denTopicId>-<hash10>.md`, with `_bad/` (quarantine, each
 * file beside a `.reason.txt`) and `_processed/` (handled by the curator) inside the wolf's lane. This is the sfo-01 `inbox/<wolf>/`
 * layout renamed for the hub; the files are byte-identical to what the kb librarian intake reads (it takes the lane's parent dir).
 */
export function contributionsRoot(dataDir: string): string {
  return join(dataDir, "kb", "ops", "contributions");
}

export function contributionsDir(dataDir: string, wolf: string): string {
  return join(contributionsRoot(dataDir), wolf);
}
