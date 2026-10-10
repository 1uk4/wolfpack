/**
 * Path resolution — the three storage tiers.
 *
 *   kbBase   — Syncthing: Dewey writes, read-only mirror to all wolves
 *   opsRoot  — Syncthing: bidirectional per-wolf lanes (inbox/receipts/rejected)
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
export const workDir = (r: KbRoots, domain: string) =>
  join(r.kbBase, "domains", domain, "work");
export const domainIndex = (r: KbRoots, domain: string) =>
  join(r.kbBase, "domains", domain, "INDEX.md");
export const domainDigest = (r: KbRoots, domain: string) =>
  join(r.kbBase, "domains", domain, "_digest.json");
/** Quarantine for contributions that fit no declared domain. Dewey-only; never
 *  inside a domain folder, so it is never mirrored to any wolf. */
export const unclassifiedDir = (r: KbRoots) => join(r.kbBase, "_unclassified");
/** Deployed copy of the declared-domain list (CLI writes; Dewey reads). */
export const domainsRegistryFile = (r: KbRoots) => join(r.kbBase, "domains.yaml");
/** Per-domain topic registry. Lives INSIDE the domain folder so it rides that
 *  domain's Syncthing share to subscribed wolves — the registry is their route
 *  (and coverage map) into the KB. No separate global registry. */
export const domainRegistryFile = (r: KbRoots, domain: string) =>
  join(r.kbBase, "domains", domain, "_registry.md");

// ── librarian-ops (per-wolf lanes) ──────────────────────────────────────────
export const inboxDir = (r: KbRoots, wolf: string) =>
  join(r.opsRoot, "inbox", wolf);
export const receiptsDir = (r: KbRoots, wolf: string) =>
  join(r.opsRoot, "receipts", wolf);

// ── den-local (Dewey's brain, never synced) ─────────────────────────────────
export const ledgerFile = (r: KbRoots) =>
  join(r.denLocal, "ledger", "events.jsonl");
export const workLedgerFile = (r: KbRoots) =>
  join(r.denLocal, "ledger", "work-events.jsonl");
export const vectorsDir = (r: KbRoots) => join(r.denLocal, "vectors");
