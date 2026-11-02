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

/** The lane directory name under the ops root (`<opsRoot>/contributions/<wolf>/`): sfo-01's equivalent is `inbox`. */
export const CONTRIBUTIONS_LANE = "contributions";

/**
 * The hub's contribution intake: `<dataDir>/kb/ops/contributions/<wolf>/<denTopicId>-<hash10>.md`, with `_bad/` (quarantine: a
 * truncated raw copy beside a `.reason.txt`) and `_processed/` (handled by the curator) inside the wolf's lane. It is the sfo-01
 * `inbox/<wolf>/` layout under another lane name. The files are byte-identical to the wolf-side inbox files, and the kb intake reads
 * them with its lane option: `drainInbox(hubRoots(dataDir), { lane: CONTRIBUTIONS_LANE })`.
 */
export function contributionsRoot(dataDir: string): string {
  return join(dataDir, "kb", "ops", CONTRIBUTIONS_LANE);
}

export function contributionsDir(dataDir: string, wolf: string): string {
  return join(contributionsRoot(dataDir), wolf);
}

/** The hub-owned registry (hosts, wolves, domains, subscriptions): `<dataDir>/registry/registry.json`. Seeded once, then hubd is its only writer. */
export function registryFile(dataDir: string): string {
  return join(dataDir, "registry", "registry.json");
}

/** The generated domains.yaml, regenerated from the registry on every write: `<kbBase>/domains.yaml`, where `readDomainRegistry(hubRoots(dataDir).kbBase)` looks. */
export function domainsYamlFile(dataDir: string): string {
  return join(hubRoots(dataDir).kbBase, "domains.yaml");
}

/** Device tokens (hashes only) and pending pairing codes (hashes only): `<dataDir>/auth/tokens.json`. Written by hubd and by the local `hubd pair|tokens` CLI. */
export function tokensFile(dataDir: string): string {
  return join(dataDir, "auth", "tokens.json");
}
