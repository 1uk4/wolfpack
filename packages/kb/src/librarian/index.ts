/**
 * @wolfpack/kb/librarian — Dewey's side. The heavy pipeline, oracles, ledger,
 * registry, embeddings. Runs ONLY where Dewey runs (the harness sweep timer or
 * the kb CLI, both through runSweepTick). Imports @wolfpack/engine. Never imported by the wolf client.
 */
export { sweep, type SweepContext, type SweepResult, type SweepEvent } from "./sweep.js";
export { readLastSweep, writeLastSweep, lastSweepFile, type LastSweep } from "../shared/last-sweep.js";
export { runSweepTick, type SweepTickOptions, type SweepTickResult } from "./tick.js";
export { defaultSweepWriter, type SweepWriter } from "./sweep-writer.js";
export { renderEntry, markProcessed } from "./commit.js";
export { renderDomainDigest } from "./domains.js";
export { syncDelivered } from "./groups.js";
export { writeSections, readSections, foldSections } from "./sections.js";
export { groupOf } from "./anchors.js";
export { entryDomain, survivorOf, resolveAliasedEntry } from "./alias.js";
export { acquireLease, freshLease, freshLeaseIn, readLease, wolfLeaseDirs, assertNoLiveHub, leaseFile, LEASE_FILE, LEASE_STALE_MS, type Lease, type LeaseHandle, type LeaseOwner } from "./curator-lease.js";
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
export { drainInbox, countPending, parseContribution, DEFAULT_LANE, type LaneOptions } from "./intake.js";
export {
  createEmbedder,
  resolveEmbedConfig,
  isNomicModel,
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
  describeGateSource,
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

export {
  buildActivityIndex,
  pageActivity,
  foldKbActivity,
  readIncoming,
  readSweepCurrent,
  type SweepCurrent,
  scanEntryInfo,
  scanEntryDomains,
  readEntryTitle,
  fsEntryResolver,
  listDomains,
  type BadContribution,
  type DomainActivity,
  INCOMING_STAT_CAP,
  type EntryResolver,
  UNPLACED,
  CHANGES_PER_DOMAIN,
  INCOMING_ITEMS_PER_WOLF,
  type ActivityIndex,
  type ActivityPage,
  type ActivityQuery,
  type ActivityDecision,
  type ActivityChange,
  type ActivityOutcome,
  type EntryInfo,
  type IncomingWolf,
} from "./activity.js";
export { oneLine } from "./redact.js";
export { previewToFile, applyPlanFile, loadPlanFile, serializePlan, entrySetFingerprint, PLAN_FILE_VERSION, PlanRefusedError, type PlanFile, type PlanFlags, type PreviewOptions, type ApplyOptions } from "./rebuild-plan-file.js";
export { commitRebuild, restoreRebuild, loadRebuildEntries, listRebuildBackups, engineNamer } from "./rebuild.js";
export { restoreAndRender } from "./rebuild-recover.js";
export { enginePartitioner, fileSplitCache } from "./llm-split.js";
