/**
 * KB commits for hubd (POST /v1/kb/commits and the in-process `hub.commitKb`).
 *
 * A batch of create/update/delete changes to `kb/base/domains/<domain>/{entries/<id>.md,_registry.md,_digest.json,INDEX.md}`.
 *
 * VALIDATION (all-or-nothing, before any byte is written, under the KB writer lock + queue):
 *   request schema, path shape and confinement (no `..`, no absolute path, no symlinked component), declared domain
 *   (domains.yaml, see `readDomainRegistry`), entry schema, contentHash = sha256(content), prevHash compare-and-set against the
 *   file on disk, no duplicate (case-insensitive) path in the batch.
 *
 * ATOMICITY (journal, roll back): CRASH-atomic, NOT reader-atomic. A reader (the KB graph, a syncing wolf) can observe a batch
 * half applied while it runs; what is guaranteed is that after any crash, restart recovery returns the KB and the KB ledger to
 * the state before the batch. The batch is journalled to `<dataDir>/run/kb-commit.journal.json` (tmp + fsync + rename + dir fsync)
 * with the prior bytes of every touched file (paths relative to dataDir) and the exact ledger bytes the batch will append, with
 * their offset. Then each file is written tmp + fsync + rename + dir fsync, the ledger is appended once and fsynced, and the
 * journal is removed (dir fsync). Any failure rolls back from the journal; a crash leaves the journal and `recoverKbCommit` (hub
 * startup, under the lock) rolls back the same way. A rolled-back batch was never acknowledged. If a rollback itself fails the
 * journal is KEPT, the writer is poisoned (every later commit is `engine_error`), and a restart runs recovery. A journal found
 * at the start of a commit is never overwritten.
 *
 * DURABILITY: file contents, the journal, every rename/unlink (parent directory) and the ledger (after append and truncate) are
 * fsynced, so the batch survives power loss as well as a process crash. fsync is synchronous and blocks the event loop for the
 * duration (accepted).
 *
 * KB ledger: `<dataDir>/ledger/events.jsonl` (kb `ledgerFile`), one JSON KbEvent per line, appended with kb `appendLedger`:
 * `entry_written {entryId, canonicalId, action: create|merge}` for entry create/update, `entry_retired {entryId}` for delete.
 * INVARIANT: every writer of the hub's KB ledger MUST hold `run/kb-writer.lock`. Rollback truncates the ledger only when it still
 * ends with exactly the bytes this batch appended at the recorded offset; a later append is left alone (warning logged).
 */
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, truncateSync, writeFileSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { parseFrontmatter } from "@wolfpack/engine";
import { appendLedger } from "@wolfpack/kb/librarian";
import { KbEventSchema, contentHash, ev, ledgerFile, readDomainRegistry, type KbRoots } from "@wolfpack/kb/shared";
import { KB_COMMIT_PATH, KB_HASH, KbCommitRequestSchema, type Actor, type KbChange, type KbCommitRequest, type KbCommitResponse } from "@wolfpack/protocol";
import { HubError } from "./errors.js";
import { WriteQueue } from "./work-writes.js";

const DOMAIN = /^[a-z0-9][a-z0-9-]*$/;
const SUFFIX = /^[0-9A-Za-z]{7}$/;
const LOCK_TORN_MAX_AGE_MS = 60_000;
const TMP_RE = /\.tmp-\d+-[0-9a-f]{8}$/;

export const kbLockFile = (dataDir: string) => join(dataDir, "run", "kb-writer.lock");
export const kbJournalFile = (dataDir: string) => join(dataDir, "run", "kb-commit.journal.json");

/** `kb-<domain>-<7 alphanumerics>` with the domain part EXACTLY the declared domain. */
const isEntryIdOf = (id: string, domain: string) => id.startsWith(`kb-${domain}-`) && SUFFIX.test(id.slice(`kb-${domain}-`.length));

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface KbLockHooks {
  /** @internal TEST-ONLY: runs after a lock was judged dead, before it is moved aside (simulates a racing contender). */
  afterJudgedStale?: () => void;
}

/** Cross-process KB writer lock (`run/kb-writer.lock`, holds the owner pid). Throws when a live process holds it. */
export function acquireKbWriterLock(dataDir: string, pid = process.pid, hooks: KbLockHooks = {}): { release(): void } {
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
      let raw: string;
      try {
        raw = readFileSync(file, "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; // released meanwhile: retry the link
        throw e;
      }
      let held: boolean;
      let holder: number | undefined;
      try {
        holder = (JSON.parse(raw) as { pid?: number }).pid;
        held = typeof holder === "number" && pidAlive(holder);
      } catch {
        held = Date.now() - (statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0) < LOCK_TORN_MAX_AGE_MS;
      }
      if (held) throw new Error(`the KB in ${dataDir} already has a writer (${holder ? `pid ${holder}` : "unreadable lock, still fresh"}); a second hubd would corrupt it`);
      if (attempt > 3) throw new Error(`cannot take the KB writer lock ${file}`);
      hooks.afterJudgedStale?.();
      // Take it over: move it aside (atomic, one contender wins), then verify we moved exactly what we judged dead.
      const moved = `${file}.stale.${pid}.${randomBytes(4).toString("hex")}`;
      try {
        renameSync(file, moved);
      } catch {
        continue; // someone else moved it first
      }
      let movedRaw: string | undefined;
      try {
        movedRaw = readFileSync(moved, "utf8");
      } catch {
        movedRaw = undefined;
      }
      if (movedRaw === raw) {
        rmSync(moved, { force: true });
        continue;
      }
      // A different (possibly live) lock slipped in between judging and moving: put it back, never delete it.
      try {
        linkSync(moved, file);
      } catch {
        rmSync(moved, { force: true });
        throw new Error(`the KB writer lock ${file} changed during takeover and could not be restored; retry`);
      }
      rmSync(moved, { force: true });
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

// ------------------------------------------------------------------ durable io

function fsyncPath(p: string): void {
  const fd = openSync(p, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDir(dir: string): void {
  try {
    fsyncPath(dir);
  } catch (e) {
    const c = (e as NodeJS.ErrnoException).code;
    if (c === "EINVAL" || c === "EPERM" || c === "ENOTSUP" || c === "ENOENT") return; // a platform/dir that cannot be fsynced
    throw e;
  }
}

/** mkdir -p, then fsync the parent of every directory it created. */
function mkdirDurable(dir: string): void {
  const created: string[] = [];
  for (let c = dir; !existsSync(c); c = dirname(c)) created.push(c);
  if (created.length === 0) return;
  mkdirSync(dir, { recursive: true });
  for (const d of created) fsyncDir(dirname(d));
}

function writeDurable(file: string, data: string | Buffer): void {
  mkdirDurable(dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    const fd = openSync(tmp, "w", 0o644);
    try {
      writeSync(fd, typeof data === "string" ? Buffer.from(data, "utf8") : data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  fsyncDir(dirname(file));
}

function removeDurable(file: string): void {
  rmSync(file, { force: true });
  fsyncDir(dirname(file));
}

// ------------------------------------------------------------------ journal

interface Journal {
  v: 1;
  /** Ledger size before the append, and the exact bytes appended (base64; empty when the batch has no ledger events). */
  ledgerOffset: number;
  ledgerAppend: string;
  /** Touched files, relative to dataDir; `prev` = the prior bytes (base64) or null when absent. */
  files: { rel: string; prev: string | null }[];
}

/** A journal path -> absolute path, refusing anything that is not under kb/base/domains/ (a tampered journal must not escape). */
function resolveRel(dataDir: string, rel: string): string {
  const parts = rel.split(/[\\/]/);
  if (isAbsolute(rel) || parts.includes("..") || parts.slice(0, 3).join("/") !== "kb/base/domains") throw new Error(`journal path outside the KB: ${JSON.stringify(rel.slice(0, 80))}`);
  return join(dataDir, ...parts);
}

function ledgerSize(roots: KbRoots): number {
  return statSync(ledgerFile(roots), { throwIfNoEntry: false })?.size ?? 0;
}

/** Cut our appended bytes off the ledger, but only if the file still ends with exactly them at the recorded offset. */
function rollbackLedger(roots: KbRoots, j: Journal): void {
  const exp = Buffer.from(j.ledgerAppend, "base64");
  if (exp.length === 0) return;
  const file = ledgerFile(roots);
  const size = statSync(file, { throwIfNoEntry: false })?.size;
  if (size === undefined || size <= j.ledgerOffset) return; // our append never landed
  const len = Math.min(size - j.ledgerOffset, exp.length);
  const got = Buffer.alloc(len);
  const fd = openSync(file, "r");
  try {
    readSync(fd, got, 0, len, j.ledgerOffset);
  } finally {
    closeSync(fd);
  }
  if (!got.equals(exp.subarray(0, len))) {
    console.warn(`hubd: KB ledger does not hold this batch's bytes at offset ${j.ledgerOffset}; left it alone`);
    return;
  }
  if (size > j.ledgerOffset + exp.length) {
    console.warn("hubd: KB ledger has later appends after the batch being rolled back; left it alone (all KB ledger writers must hold kb-writer.lock)");
    return;
  }
  truncateSync(file, j.ledgerOffset);
  fsyncPath(file);
}

/** Restore every journalled file, cut the ledger back, drop the journal. Idempotent. */
function rollback(roots: KbRoots, dataDir: string, j: Journal, hook?: () => void): void {
  hook?.();
  for (const f of j.files) {
    const abs = resolveRel(dataDir, f.rel);
    if (f.prev === null) removeDurable(abs);
    else writeDurable(abs, Buffer.from(f.prev, "base64"));
  }
  rollbackLedger(roots, j);
  rmSync(kbJournalFile(dataDir), { force: true });
  fsyncDir(join(dataDir, "run"));
}

function sweepTmp(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) if (TMP_RE.test(n) || /^kb-commit\.journal\.json\.tmp-/.test(n)) rmSync(join(dir, n), { force: true });
}

/**
 * Startup recovery: a journal left by a crash (or by a failed rollback) means an unacknowledged batch; roll it back, sweep the
 * `*.tmp-*` leftovers of the domains it touched. MUST run under the KB writer lock. Returns whether a rollback happened.
 * An unparseable journal cannot come from a crash (it is renamed into place complete); it is removed with a warning.
 */
export function recoverKbCommit(roots: KbRoots, dataDir: string): boolean {
  sweepTmp(join(dataDir, "run"));
  const jf = kbJournalFile(dataDir);
  if (!existsSync(jf)) return false;
  let j: Journal;
  try {
    j = JSON.parse(readFileSync(jf, "utf8")) as Journal;
  } catch {
    console.warn("hubd: unparseable KB commit journal removed");
    rmSync(jf, { force: true });
    return true;
  }
  if (j?.v !== 1 || !Array.isArray(j.files) || typeof j.ledgerAppend !== "string" || typeof j.ledgerOffset !== "number") throw new Error("the KB commit journal is malformed; refusing to start (inspect run/kb-commit.journal.json)");
  rollback(roots, dataDir, j);
  const dirs = new Set<string>();
  for (const f of j.files) {
    const abs = resolveRel(dataDir, f.rel);
    dirs.add(dirname(abs));
    dirs.add(join(dataDir, ...f.rel.split(/[\\/]/).slice(0, 5))); // kb/base/domains/<domain>
  }
  for (const d of dirs) sweepTmp(d);
  console.warn(`hubd: recovered an interrupted KB commit: rolled back ${j.files.length} file(s) and the KB ledger append`);
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
  if (!isEntryIdOf(id, c.domain)) bad(`${c.path}: the file name must be an entry id kb-${c.domain}-<7 alphanumerics>`);
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
    if (seen.has(key.toLowerCase())) bad(`${key} appears twice in the batch (paths compare case-insensitively)`);
    seen.add(key.toLowerCase());
    let entryId: string | undefined;
    if (c.op !== "delete") {
      if (contentHash(c.content) !== c.contentHash) bad(`${key}: contentHash does not match the content`);
      if (c.path === "_digest.json") {
        let v: unknown;
        try {
          v = JSON.parse(c.content);
        } catch {
          bad(`${key}: _digest.json must be a JSON object`);
        }
        if (v === null || typeof v !== "object" || Array.isArray(v)) bad(`${key}: _digest.json must be a JSON object`);
      }
    }
    if (c.path.startsWith("entries/")) {
      entryId = c.op === "delete" ? c.path.slice(8, -3) : checkEntry(c);
      if (!isEntryIdOf(entryId, c.domain)) bad(`${key}: not an entry id of ${c.domain}`);
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
  /** @internal TEST-ONLY: called at "journal" | "file:<i>" | "ledger" | "journal-drop" | "rollback"; throw to inject a failure. */
  at?: (stage: string) => void;
  /** @internal TEST-ONLY: when true an injected failure behaves like a crash (no in-process rollback; recovery must fix it). */
  crash?: boolean;
}

/** The in-process rollback failed: the journal is kept for recovery and the writer must stop. */
export class KbRollbackError extends HubError {
  constructor() {
    super("engine_error", "kb commit failed and could NOT be rolled back; restart the hub so recovery can run");
  }
}

/** Validate then apply one batch. MUST run under the KB writer lock and queue. */
export function applyKbCommit(roots: KbRoots, dataDir: string, req: KbCommitRequest, faults: KbCommitFaults = {}): KbCommitResponse {
  if (existsSync(kbJournalFile(dataDir))) throw new HubError("engine_error", "an interrupted KB commit is awaiting recovery; restart the hub");
  const stage = (s: string) => faults.at?.(s);
  let planned: Planned[];
  let journal: Journal;
  let events: ReturnType<typeof ev.entryWritten>[];
  let appendBytes: Buffer;
  try {
    planned = plan(roots, req);
    events = planned.flatMap((p) => {
      if (!p.entryId) return [];
      if (p.change.op === "delete") return [ev.entryRetired(p.entryId, "kb commit")];
      return [ev.entryWritten(p.entryId, p.entryId, p.change.op === "create" ? "create" : "merge")];
    });
    // The exact bytes appendLedger will write (it validates with KbEventSchema and writes one JSON line per event).
    appendBytes = events.length === 0 ? Buffer.alloc(0) : Buffer.from(events.map((e) => JSON.stringify(KbEventSchema.parse(e))).join("\n") + "\n", "utf8");
    journal = {
      v: 1,
      ledgerOffset: ledgerSize(roots),
      ledgerAppend: appendBytes.toString("base64"),
      files: planned.map((p) => {
        const rel = relative(dataDir, p.abs);
        resolveRel(dataDir, rel); // the journal must be able to name it
        return { rel: rel.split(sep).join("/"), prev: p.prev === null ? null : p.prev.toString("base64") };
      }),
    };
  } catch (e) {
    if (e instanceof HubError) throw e;
    console.error("hubd: kb commit validation failed:", e);
    throw new HubError("engine_error", "kb commit failed before anything was written");
  }
  try {
    // From here the journal may exist: any failure rolls back from `journal`.
    writeDurable(kbJournalFile(dataDir), JSON.stringify(journal));
    stage("journal");
    planned.forEach((p, i) => {
      if (p.change.op === "delete") removeDurable(p.abs);
      else writeDurable(p.abs, p.change.content);
      stage(`file:${i}`);
    });
    stage("ledger");
    appendLedger(roots, events);
    if (appendBytes.length > 0) fsyncPath(ledgerFile(roots));
    stage("journal-drop");
    rmSync(kbJournalFile(dataDir), { force: true });
    fsyncDir(join(dataDir, "run"));
  } catch (e) {
    console.error("hubd: kb commit failed:", e);
    if (faults.crash) throw new HubError("engine_error", "kb commit failed (simulated crash)");
    try {
      rollback(roots, dataDir, journal, () => stage("rollback"));
    } catch (re) {
      console.error("hubd: kb commit rollback FAILED; the journal is kept for recovery:", re);
      throw new KbRollbackError();
    }
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

/** The KB writer: takes the lock, recovers an interrupted batch, serialises commits. */
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
  let poisoned = false;
  return {
    commit(actor: Actor, request: unknown): Promise<KbCommitResponse> {
      // Only the curator (system, in-process) and the operator may commit; a wolf is refused.
      if (actor.kind !== "system" && actor.kind !== "operator") return Promise.reject(new HubError("forbidden", "only the curator or the operator may commit to the KB"));
      const parsed = KbCommitRequestSchema.safeParse(request);
      if (!parsed.success) {
        return Promise.reject(new HubError("invalid_request", parsed.error.issues.map((i) => `${i.path.map(String).join(".") || "body"}: ${i.message}`).join("; ")));
      }
      const req = parsed.data;
      if (closing) return Promise.reject(new HubError("busy", "hub is shutting down; retry against the restarted hub"));
      return queue.run(() => {
        if (poisoned) throw new HubError("engine_error", "a previous KB commit could not be rolled back; restart the hub so recovery can run");
        let out: KbCommitResponse;
        try {
          out = applyKbCommit(opts.roots, opts.dataDir, req, opts.faults);
        } catch (e) {
          if (e instanceof KbRollbackError) poisoned = true;
          throw e;
        }
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
    /** Release the lock after the commits already queued have drained. */
    close(): Promise<void> {
      closing = true;
      return queue.run(() => lock.release());
    },
    /** Release the lock NOW (failed start: nothing is queued). */
    abort(): void {
      closing = true;
      lock.release();
    },
  };
}

export { KB_HASH };
