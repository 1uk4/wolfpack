/**
 * Path resolution — the three storage tiers.
 *
 *   kbBase   — Syncthing: Dewey writes, read-only mirror to all wolves
 *   opsRoot  — Syncthing: bidirectional per-wolf lanes (inbox/feed/receipts/rejected)
 *   denLocal — Dewey-local, never synced (ledger/vectors/clusters) — Dewey's brain
 */
import { join } from "node:path";

export interface KbRoots {
  /** knowledge/base — authoritative entries + registry + indexes. */
  kbBase: string;
  /** librarian-ops — message channels. */
  opsRoot: string;
  /** Dewey-local working state (under $WOLF_DEN/kb). Librarian only. */
  denLocal: string;
}

// ── kb-base (shared, read-only to wolves) ───────────────────────────────────
export const entriesDir = (r: KbRoots, domain: string) =>
  join(r.kbBase, "domains", domain, "entries");
export const domainIndex = (r: KbRoots, domain: string) =>
  join(r.kbBase, "domains", domain, "INDEX.md");
/** Per-domain feed folder \u2014 lives INSIDE the domain so it mirrors to subscribers
 *  automatically (access-scoped). Dewey drops "what changed" notices here. */
export const domainFeedDir = (r: KbRoots, domain: string) =>
  join(r.kbBase, "domains", domain, "_feed");
/** Quarantine for contributions that fit no declared domain. Dewey-only; never
 *  inside a domain folder, so it is never mirrored to any wolf. */
export const unclassifiedDir = (r: KbRoots) => join(r.kbBase, "_unclassified");
/** Deployed copy of the declared-domain registry (CLI writes; Dewey reads). */
export const domainsRegistryFile = (r: KbRoots) => join(r.kbBase, "domains.yaml");
export const registryFile = (r: KbRoots) =>
  join(r.kbBase, "registry", "topics.md");
export const globalIndex = (r: KbRoots) => join(r.kbBase, "registry", "INDEX.md");

// ── librarian-ops (per-wolf lanes) ──────────────────────────────────────────
export const inboxDir = (r: KbRoots, wolf: string) =>
  join(r.opsRoot, "inbox", wolf);
export const feedDir = (r: KbRoots, wolf: string) =>
  join(r.opsRoot, "kb-feed", wolf);
export const receiptsDir = (r: KbRoots, wolf: string) =>
  join(r.opsRoot, "receipts", wolf);
export const rejectedDir = (r: KbRoots, wolf: string) =>
  join(r.opsRoot, "rejected", wolf);

// ── den-local (Dewey's brain, never synced) ─────────────────────────────────
export const ledgerFile = (r: KbRoots) =>
  join(r.denLocal, "ledger", "events.jsonl");
export const vectorsDir = (r: KbRoots) => join(r.denLocal, "vectors");
