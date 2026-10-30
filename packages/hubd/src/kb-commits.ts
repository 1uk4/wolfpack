/**
 * KB commits for hubd (POST /v1/kb/commits and the in-process `hub.commitKb`).
 *
 * A batch of create/update/delete changes to `kb/base/domains/<domain>/{entries/<id>.md,_registry.md,_digest.json,INDEX.md}`.
 *
 * VALIDATION (all-or-nothing, before any byte is written, under the KB writer lock + queue):
 *   path shape and confinement (no `..`, no absolute path, no symlinked component), declared domain (domains.yaml, see
 *   `readDomainRegistry`), entry schema, contentHash = sha256(content), prevHash compare-and-set against the file on disk.
 *
 * ATOMICITY (journal, roll back): the batch is journalled to `<dataDir>/run/kb-commit.journal.json` (tmp + fsync + rename) with
 * the prior bytes of every touched file and the KB ledger size. Then each file is written tmp + rename, the ledger is appended once,
 * and the journal is removed. Any failure rolls back from the journal (restore/delete files, truncate the ledger); a crash leaves
 * the journal, and `recoverKbCommit` (run at hub startup, under the lock) rolls back the same way. The caller is only answered
 * after the journal is gone, so a rolled-back batch was never acknowledged. Chosen over write-then-fix-up because a single
 * journal makes recovery one idempotent routine, and roll back (not forward) needs no staged copies of the new content.
 *
 * KB ledger: `<dataDir>/ledger/events.jsonl` (kb `ledgerFile`), one JSON KbEvent per line, appended with kb `appendLedger`:
 * `entry_written {entryId, canonicalId, action: create|merge}` for entry create/update, `entry_retired {entryId}` for delete.
 */
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, truncateSync, writeFileSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { parseFrontmatter } from "@wolfpack/engine";
import { appendLedger } from "@wolfpack/kb/librarian";
import { contentHash, ev, ledgerFile, readDomainRegistry, type KbRoots } from "@wolfpack/kb/shared";
import { KB_COMMIT_PATH, KB_HASH, type Actor, type KbChange, type KbCommitRequest, type KbCommitResponse } from "@wolfpack/protocol";
import { HubError } from "./errors.js";
import { WriteQueue } from "./work-writes.js";

const ENTRY_ID = /^kb-[a-z0-9][a-z0-9-]*-[0-9A-Za-z]{7}$/;
const DOMAIN = /^[a-z0-9][a-z0-9-]*$/;
const LOCK_TORN_MAX_AGE_MS = 60_000;

export const kbLockFile = (dataDir: string) => join(dataDir, "run", "kb-writer.lock");
export const kbJournalFile = (dataDir: string) => join(dataDir, "run", "kb-commit.journal.json");

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Cross-process KB writer lock (`run/kb-writer.lock`, holds the owner pid). Throws when a live process holds it. */
export function acquireKbWriterLock(dataDir: string, pid = process.pid): { release(): void } {
  const file = kbLockFile(dataDir);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${pid}.${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify({ pid, startedAt: new Date().toISOString() }), { mode: 0o600 });
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        linkSync(tmp, file); // atomic: the lock appears complete or not at all
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      let held = true;
      let holder: number | undefined;
      try {
        holder = (JSON.parse(readFileSync(file, "utf8")) as { pid?: number }).pid;
        held = typeof holder === "number" && pidAlive(holder);
      } catch {
        held = Date.now() - (statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0) < LOCK_TORN_MAX_AGE_MS;
      }
      if (held) throw new Error(`the KB in ${dataDir} already has a writer (${holder ? `pid ${holder}` : "unreadable lock, still fresh"}); a second hubd would corrupt it`);
      if (attempt > 3) throw new Error(`cannot take the KB writer lock ${file}`);
      const moved = `${file}.stale.${pid}.${randomBytes(4).toString("hex")}`;
      try {
        renameSync(file, moved);
        rmSync(moved, { force: true });
      } catch {
        /* someone else moved it first */
      }
    }
  } finally {
    rmSync(tmp, { force: true });
  }
  return {
    release() {
      try {
        if ((JSON.parse(readFileSync(file, "utf8")) as { pid?: number }).pid === pid) rmSync(file, { force: true });
      } catch {
        /* gone */
      }
    },
  };
}

// ------------------------------------------------------------------ journal

interface Journal {
  ledgerSize: number;
  files: { abs: string; prev: string | null /* base64 */ }[];
}

function ledgerSize(roots: KbRoots): number {
  return statSync(ledgerFile(roots), { throwIfNoEntry: false })?.size ?? 0;
}

function writeDurable(file: string, data: string | Buffer): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const fd = openSync(tmp, "w", 0o644);
  try {
    writeSync(fd, typeof data === "string" ? Buffer.from(data, "utf8") : data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

/** Restore every journalled file, truncate the ledger back, drop the journal. Idempotent. */
function rollback(roots: KbRoots, dataDir: string, j: Journal): void {
  for (const f of j.files) {
    if (f.prev === null) rmSync(f.abs, { force: true });
    else writeDurable(f.abs, Buffer.from(f.prev, "base64"));
  }
  const size = statSync(ledgerFile(roots), { throwIfNoEntry: false })?.size;
  if (size !== undefined && size > j.ledgerSize) truncateSync(ledgerFile(roots), j.ledgerSize);
  rmSync(kbJournalFile(dataDir), { force: true });
}

/**
 * Startup recovery: a journal left by a crash means an unacknowledged batch; roll it back. MUST run under the KB writer lock.
 * Returns whether a rollback happened. A torn (unparseable) journal means the crash came before any file was touched
 * (the journal is renamed into place complete), so it is just removed.
 */
export function recoverKbCommit(roots: KbRoots, dataDir: string): boolean {
  const jf = kbJournalFile(dataDir);
  if (!existsSync(jf)) return false;
  let j: Journal | undefined;
  try {
    j = JSON.parse(readFileSync(jf, "utf8")) as Journal;
  } catch {
    j = undefined;
  }
  if (j) rollback(roots, dataDir, j);
  else rmSync(jf, { force: true });
  return true;
}

// -------------------------------------------------------------- validation

interface Planned {
  change: KbChange;
  abs: string;
  prev: Buffer | null;
  entryId?: string;
}

function bad(msg: string): never {
  throw new HubError("invalid_request", msg);
}

/** The absolute path of a change; every existing component under kbBase/domains must be a real directory (no symlink escape). */
function confine(roots: KbRoots, c: KbChange): string {
  if (!DOMAIN.test(c.domain)) bad(`bad domain name ${JSON.stringify(c.domain.slice(0, 60))}`);
  if (!KB_COMMIT_PATH.test(c.path)) bad(`path not allowed: ${JSON.stringify(c.path.slice(0, 80))}`);
  const parts = ["domains", c.domain, ...c.path.split("/")];
  let cur = roots.kbBase;
  for (let i = 0; i < parts.length; i++) {
    cur = join(cur, parts[i]);
    const st = lstatSync(cur, { throwIfNoEntry: false });
    if (!st) break; // the rest does not exist yet
    if (st.isSymbolicLink()) bad(`path crosses a symlink: ${c.domain}/${c.path}`);
    if (i < parts.length - 1 && !st.isDirectory()) bad(`not a directory on the way to ${c.domain}/${c.path}`);
    if (i === parts.length - 1 && !st.isFile()) bad(`not a regular file: ${c.domain}/${c.path}`);
  }
  return join(roots.kbBase, ...parts);
}

/** The entry schema: frontmatter with id (kb-<domain>-<7>, = file name), title, domain (= declared domain), a body. Returns the id. */
function checkEntry(c: Extract<KbChange, { content: string }>): string {
  const id = c.path.slice("entries/".length, -".md".length);
  if (!ENTRY_ID.test(id) || !id.startsWith(`kb-${c.domain}-`)) bad(`${c.path}: the file name must be an entry id kb-${c.domain}-<7 alphanumerics>`);
  let fields: Record<string, unknown>;
  let body: string;
  try {
    ({ fields, body } = parseFrontmatter(c.content) as { fields: Record<string, unknown>; body: string });
  } catch {
    bad(`${c.path}: unreadable frontmatter`);
  }
  if (fields.id !== id) bad(`${c.path}: frontmatter id must equal the file name`);
  if (typeof fields.title !== "string" || !fields.title.trim()) bad(`${c.path}: frontmatter title is required`);
  if (fields.domain !== c.domain) bad(`${c.path}: frontmatter domain must be ${c.domain}`);
  if (!body.trim()) bad(`${c.path}: the entry has no body`);
  return id;
}

function plan(roots: KbRoots, req: KbCommitRequest): Planned[] {
  const declared = readDomainRegistry(roots.kbBase);
  const seen = new Set<string>();
  const out: Planned[] = [];
  for (const c of req.changes) {
    const abs = confine(roots, c);
    if (!Object.hasOwn(declared, c.domain)) bad(`domain ${c.domain} is not declared (domains.yaml)`);
    const key = `${c.domain}/${c.path}`;
    if (seen.has(key)) bad(`${key} appears twice in the batch`);
    seen.add(key);
    let entryId: string | undefined;
    if (c.op !== "delete") {
      if (contentHash(c.content) !== c.contentHash) bad(`${key}: contentHash does not match the content`);
      if (c.path === "_digest.json") {
        try {
          if (typeof JSON.parse(c.content) !== "object") throw new Error();
        } catch {
          bad(`${key}: _digest.json must be a JSON object`);
        }
      }
    }
    if (c.path.startsWith("entries/")) {
      entryId = c.op === "delete" ? c.path.slice(8, -3) : checkEntry(c);
      if (c.op === "delete" && !ENTRY_ID.test(entryId)) bad(`${key}: not an entry id`);
    }
    // prevHash compare-and-set (a missing file reads as null).
    const prev = existsSync(abs) ? readFileSync(abs) : null;
    const actual = prev === null ? null : contentHash(prev.toString("utf8"));
    if (actual !== c.prevHash) {
      throw new HubError("conflict", `stale write: ${key} changed (prevHash ${c.prevHash ?? "null"}, current ${actual ?? "absent"})`, { path: key, currentHash: actual ?? "absent" });
    }
    out.push({ change: c, abs, prev, entryId });
  }
  return out;
}

// ------------------------------------------------------------------ commit

export interface KbCommitFaults {
  /** @internal TEST-ONLY: called at "journal" | "file:<i>" | "ledger" | "journal-drop"; throw to inject a failure. */
  at?: (stage: string) => void;
  /** @internal TEST-ONLY: when true an injected failure behaves like a crash (no in-process rollback; recovery must fix it). */
  crash?: boolean;
}

/** Validate then apply one batch. MUST run under the KB writer lock and queue. */
export function applyKbCommit(roots: KbRoots, dataDir: string, req: KbCommitRequest, faults: KbCommitFaults = {}): KbCommitResponse {
  const planned = plan(roots, req);
  const journal: Journal = { ledgerSize: ledgerSize(roots), files: planned.map((p) => ({ abs: p.abs, prev: p.prev === null ? null : p.prev.toString("base64") })) };
  const events = planned.flatMap((p) => {
    if (!p.entryId) return [];
    if (p.change.op === "delete") return [ev.entryRetired(p.entryId, "kb commit")];
    return [ev.entryWritten(p.entryId, p.entryId, p.change.op === "create" ? "create" : "merge")];
  });
  const stage = (s: string) => faults.at?.(s);
  let applied = false;
  try {
    writeDurable(kbJournalFile(dataDir), JSON.stringify(journal));
    applied = true;
    stage("journal");
    planned.forEach((p, i) => {
      if (p.change.op === "delete") rmSync(p.abs, { force: true });
      else writeDurable(p.abs, p.change.content);
      stage(`file:${i}`);
    });
    stage("ledger");
    appendLedger(roots, events);
    stage("journal-drop");
    rmSync(kbJournalFile(dataDir), { force: true });
  } catch (e) {
    if (applied && !faults.crash) rollback(roots, dataDir, journal);
    else if (!applied) rmSync(kbJournalFile(dataDir), { force: true });
    if (e instanceof HubError) throw e;
    throw new HubError("engine_error", "kb commit failed and was rolled back");
  }
  const domains = [...new Set(planned.map((p) => p.change.domain))];
  return {
    committed: planned.length,
    entryIds: planned.flatMap((p) => (p.entryId ? [p.entryId] : [])),
    domains,
    files: planned.map((p) => ({ domain: p.change.domain, path: p.change.path, op: p.change.op, contentHash: p.change.contentHash })),
  };
}

export interface KbWriterOptions {
  dataDir: string;
  roots: KbRoots;
  /** Called per domain after a committed batch with the entry ids in it (only when there are some). */
  onChanged: (entryIds: string[], domain: string) => void;
  faults?: KbCommitFaults;
}

/** The KB writer: takes the lock, recovers an interrupted batch, serialises commits. `close()` releases the lock after the queue drains. */
export function createKbWriter(opts: KbWriterOptions) {
  const lock = acquireKbWriterLock(opts.dataDir);
  try {
    recoverKbCommit(opts.roots, opts.dataDir);
  } catch (e) {
    lock.release();
    throw e;
  }
  const queue = new WriteQueue();
  let closing = false;
  return {
    commit(actor: Actor, req: KbCommitRequest): Promise<KbCommitResponse> {
      // Only the curator (system, in-process) and the operator may commit; a wolf is refused.
      if (actor.kind !== "system" && actor.kind !== "operator") return Promise.reject(new HubError("forbidden", "only the curator or the operator may commit to the KB"));
      if (closing) return Promise.reject(new HubError("busy", "hub is shutting down; retry against the restarted hub"));
      return queue.run(() => {
        const out = applyKbCommit(opts.roots, opts.dataDir, req, opts.faults);
        for (const domain of out.domains) {
          const ids = out.files.filter((f) => f.domain === domain && f.path.startsWith("entries/")).map((f) => f.path.slice(8, -3));
          if (ids.length === 0) continue;
          try {
            opts.onChanged(ids, domain);
          } catch (e) {
            console.error("hubd: kb.changed emit failed:", e);
          }
        }
        return out;
      });
    },
    close(): Promise<void> {
      closing = true;
      return queue.run(() => lock.release());
    },
  };
}

export { KB_HASH };
