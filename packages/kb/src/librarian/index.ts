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
} from "./ledger.js";
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
export { type EntryVector } from "./route.js";
export { createOracles, type Oracles } from "./oracles.js";
export {
  commitEntry,
  readEntryMarkdown,
  writeReceipt,
  gitCommit,
} from "./commit.js";
export { renderRegistry } from "./registry.js";
export { withBudget, BudgetExceeded, park, unpark, listParked, type ParkedItem } from "./park.js";
export {
  readDeclaredDomains,
  isDeclared,
  renderDomainIndex,
} from "./domains.js";
export { quarantine } from "./commit.js";
export { reorg, type ReorgOptions, type ReorgResult } from "./reorg.js";
export { retireEntries, type RetireResult } from "./retire.js";
export {
  buildTreeBottomUp,
  placeEntry,
  splitAsParentChild,
  checkInvariants,
  shouldRecalculate,
} from "./section-tree.js";
