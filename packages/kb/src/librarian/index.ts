/**
 * @wolfpack/kb/librarian — Dewey's side. The heavy pipeline, oracles, ledger,
 * registry, embeddings. Runs ONLY where Dewey runs (wolfpack-librarian ext + kb
 * CLI). Imports @wolfpack/engine. Never imported by the wolf client.
 */
export { sweep, type SweepContext, type SweepResult } from "./sweep.js";
export {
  readLedger,
  appendLedger,
  seenHashes,
  foldRegistry,
  foldClusters,
  type ClusterState,
} from "./ledger.js";
export {
  selectCrystallizationCandidates,
  DEFAULT_THRESHOLDS,
  type CrystallizationThresholds,
} from "./clusters.js";
export { drainInbox } from "./intake.js";
export {
  createEmbedder,
  resolveEmbedConfig,
  embedInput,
  buildEntryVectors,
  cosine,
  type Embedder,
  type EmbedConfig,
  type Vector,
} from "./embed.js";
export {
  routeContribution,
  DEFAULT_ROUTE_THRESHOLDS,
  type RouteDecision,
  type RouteThresholds,
  type EntryVector,
} from "./route.js";
export { createOracles, type Oracles } from "./oracles.js";
export { produce, type ProduceResult } from "./produce.js";
export {
  commitEntry,
  readEntryMarkdown,
  writeReceipt,
  archiveRejected,
  gitCommit,
} from "./commit.js";
export { renderRegistry } from "./registry.js";
export { emitFeed } from "./feed.js";
export {
  readDeclaredDomains,
  isDeclared,
  renderDomainIndex,
} from "./domains.js";
export { quarantine } from "./commit.js";
