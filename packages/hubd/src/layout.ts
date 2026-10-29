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
