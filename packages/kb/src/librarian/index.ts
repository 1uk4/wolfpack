/**
 * @wolfpack/kb/librarian — Dewey's side. The heavy pipeline, oracles, ledger,
 * registry, embeddings. Runs ONLY where Dewey runs (the harness sweep timer or
 * the kb CLI, both through runSweepTick). Imports @wolfpack/engine. Never imported by the wolf client.
 */
export { sweep, type SweepContext, type SweepResult } from "./sweep.js";
export { runSweepTick, type SweepTickOptions, type SweepTickResult } from "./tick.js";
export {
  workIdOfTopic,
  parseKbNotes,
  linkNote,
  queueWorkLink,
  pendingWorkLinks,
  flushWorkLinks,
  httpNotePoster,
  type WorkLink,
  type NotePoster,
} from "./work-links.js";
export { createLibrarianEngine } from "./engine.js";
export {
  readLedger,
  appendLedger,
  seenHashes,
  foldRegistry,
} from "./ledger.js";
export { drainInbox, countPending } from "./intake.js";
export {
  createEmbedder,
  resolveEmbedConfig,
  embedInput,
  buildEntryVectors,
  currentEntryHashes,
  cosine,
  type Embedder,
  type CachedEmbedder,
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
export {
  classifyError,
  InfraError,
  readBackoff,
  backoffRemainingMs,
  backoffDelayMs,
  noteInfraFailure,
  noteSweepSuccess,
  type BackoffState,
  type ErrorClass,
  type Alert,
} from "./backoff.js";
export { drainFile, readDrain, formatDrain, type DrainState } from "./drain.js";
export { withBudget, BudgetExceeded, park, unpark, listParked, type ParkedItem } from "./park.js";
export {
  readDeclaredDomains,
  isDeclared,
  renderDomainIndex,
} from "./domains.js";
export { quarantine } from "./commit.js";
export { reorg, type ReorgOptions, type ReorgResult } from "./reorg.js";
export { retireEntries, type RetireResult } from "./retire.js";
export { snapshotEntry, snapshotIfChanged, archiveRetiredEntry, listVersions, readVersion, type EntryVersion } from "./versions.js";
export { withKbLock, KbLockBusy, kbLockFile, releaseOwnedLock } from "./lock.js";
export {
  scanFat,
  splitFatEntry,
  splitFatAuto,
  SPLIT_FAT,
  type FatCandidate,
  type SplitFatResult,
  type SplitFatOptions,
  type SplitFatAutoOptions,
} from "./split-fat.js";
export {
  buildTreeBottomUp, type BuildTreeResult,
  placeEntry,
  splitAsParentChild,
  checkInvariants,
  shouldRecalculate,
} from "./section-tree.js";
