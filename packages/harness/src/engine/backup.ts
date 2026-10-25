/**
 * Session-store backup before engine upgrades.
 *
 * pi-durable's sqlite schema migrations are one-way (1.4.0 moved to schema v2). Before the first open under a
 * given engine version we copy `session.sqlite*` (db, -wal, -shm) to a sibling `backups/` directory. Semantics:
 *
 * - One backup per (store, engine version): if a directory for the current version already exists, do nothing.
 *   The first open after a bump therefore snapshots the pre-migration store; later opens are free.
 * - Nothing to back up (store does not exist yet) -> no directory, returns undefined.
 * - Backups are never pruned or restored automatically; restoring is a manual copy back.
 *
 * Layout: `<dir of store>/backups/<store basename>-engine-<version>-<timestamp>/<files>`.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const SIDECARS = ["", "-wal", "-shm"] as const;

export interface BackupOptions {
  /** The engine version about to open the store. */
  engineVersion: string;
  /** Injectable clock for deterministic names. */
  now?: () => Date;
}

export interface BackupResult {
  dir: string;
  files: string[];
}

function backupRoot(storagePath: string): string {
  return join(dirname(storagePath), "backups");
}

function prefixFor(storagePath: string, engineVersion: string): string {
  return `${basename(storagePath)}-engine-${engineVersion}-`;
}

/** Existing backup directory for this store + engine version, if any. */
export function findBackup(storagePath: string, engineVersion: string): string | undefined {
  const root = backupRoot(storagePath);
  if (!existsSync(root)) return undefined;
  const prefix = prefixFor(storagePath, engineVersion);
  const hit = readdirSync(root).find((name) => name.startsWith(prefix));
  return hit ? join(root, hit) : undefined;
}

/**
 * Back up the store unless one exists for this engine version. Must be called BEFORE the store is opened
 * (copying a live WAL database is not safe). Returns undefined when skipped.
 */
export function backupSessionStore(storagePath: string, opts: BackupOptions): BackupResult | undefined {
  if (!existsSync(storagePath)) return undefined;
  if (findBackup(storagePath, opts.engineVersion)) return undefined;

  const stamp = (opts.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const dir = join(backupRoot(storagePath), `${prefixFor(storagePath, opts.engineVersion)}${stamp}`);
  mkdirSync(dir, { recursive: true });

  const files: string[] = [];
  for (const suffix of SIDECARS) {
    const src = storagePath + suffix;
    if (!existsSync(src)) continue;
    const name = basename(src);
    copyFileSync(src, join(dir, name));
    files.push(name);
  }
  return { dir, files };
}
