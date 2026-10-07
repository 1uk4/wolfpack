/**
 * @wolfpack/kb/librarian — Dewey's side. The heavy pipeline, oracles, ledger,
 * registry, embeddings. Runs ONLY where Dewey runs (wolfpack-librarian ext + kb
 * CLI). Imports @wolfpack/engine. Never imported by the wolf client.
 */
export { sweepV2, type SweepContext, type SweepResult } from "./sweep-v2.js";
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
