/**
 * Dev-root layout shared by the snapshot command and the sandbox resolver.
 *
 *   <root>/snapshot.json                     manifest (also the "this is a snapshot" marker)
 *   <root>/ledger/work-events.jsonl          work ledger  -> local work server `--ledger-dir <root>`
 *   <root>/base/domains/<d>/work/*.md        materialized work items (served by the same server)
 *   <root>/ops/{inbox,receipts,parked}/...   KB_OPS
 *   <root>/den/                              the wolf's den (WOLF_DEN; KB_DEN_LOCAL = den/kb)
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
}

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
  };
}
