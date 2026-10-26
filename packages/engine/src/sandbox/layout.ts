/**
 * Dev-root layout shared by the snapshot command and the sandbox resolver.
 *
 *   <root>/snapshot.json                     manifest (also the "this is a snapshot" marker)
 *   <root>/ledger/work-events.jsonl          work ledger  -> local work server `--ledger-dir <root>`
 *   <root>/base/domains/<d>/work/*.md        materialized work items (served by the same server)
 *   <root>/ops/{inbox,receipts,parked}/...   KB_OPS
 *   <root>/den/                              the wolf's den (WOLF_DEN; KB_DEN_LOCAL = den/kb), single-wolf layout
 *   <root>/dens/<wolf>/                      per-wolf dens, shared layout: used instead of den/ when dens/ exists
 *   <root>/kb-base/                          optional COPY of the KB base -> KB_BASE (else KB_BASE stays ambient)
 *   <root>/run/work-server.{json,lock}       the ONE local work server (writer) for this ledger: run file + lock
 */
import { join } from "node:path";

export const SNAPSHOT_MANIFEST = "snapshot.json";

export interface SandboxPaths {
  root: string;
  manifest: string;
  /** Pass as the local work server's ledgerDir. */
  ledgerDir: string;
  ledgerFile: string;
  /** Work server's materialized-.md base (read by that server, not KB_BASE). */
  workBase: string;
  kbOps: string;
  den: string;
  kbDenLocal: string;
  /** Per-wolf dens live under here (shared layout). */
  dens: string;
  /** The KB base copy; KB_BASE points here when it exists. */
  kbBase: string;
  /** Run state of the single work-ledger writer. */
  runDir: string;
  workServerFile: string;
  workServerLock: string;
}

/** Wolf names become path segments: refuse anything that could escape `<root>/dens`. */
export function safeWolfName(wolf: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(wolf)) throw new Error(`sandbox: invalid wolf name '${wolf}'`);
  return wolf;
}

/** `<root>/dens/<wolf>` (shared layout). */
export const wolfDenDir = (root: string, wolf: string): string => join(root, "dens", safeWolfName(wolf));

export function sandboxPaths(root: string): SandboxPaths {
  return {
    root,
    manifest: join(root, SNAPSHOT_MANIFEST),
    ledgerDir: root,
    ledgerFile: join(root, "ledger", "work-events.jsonl"),
    workBase: join(root, "base"),
    kbOps: join(root, "ops"),
    den: join(root, "den"),
    kbDenLocal: join(root, "den", "kb"),
    dens: join(root, "dens"),
    kbBase: join(root, "kb-base"),
    runDir: join(root, "run"),
    workServerFile: join(root, "run", "work-server.json"),
    workServerLock: join(root, "run", "work-server.lock"),
  };
}
