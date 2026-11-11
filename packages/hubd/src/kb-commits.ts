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
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseFrontmatter } from "@wolfpack/engine";
import { appendLedger, invalidateLedgerCache } from "@wolfpack/kb/librarian";
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
  /** @internal TEST-ONLY: runs after a lock was judged dead, before the takeover starts (simulates a racing contender). */
  afterJudgedStale?: () => void;
  /** @internal TEST-ONLY: runs after the stale lock was unlinked, before we link our own (simulates a third linker). */
  afterUnlinked?: () => void;
  /** @internal TEST-ONLY: runs after a dead takeover mutex was judged dead, before it is cleared (simulates another contender). */
  afterMutexJudgedDead?: () => void;
}

const LOCK_MAX_ATTEMPTS = 6;
const clearHint = (file: string) => `if no hubd is running on this data directory, remove ${file} by hand`;

/**
 * Cross-process KB writer lock (`run/kb-writer.lock`, holds the owner pid). Throws when a live process holds it.
 *
 * A dead owner's lock is taken over WITHOUT renaming the lock file: a takeover mutex (`kb-writer.lock.takeover`, exclusive link,
 * holds the contender's pid) serialises contenders; under it the lock is re-read, and only if it is still exactly the content that
 * was judged dead is it unlinked, then our fresh lock is linked (atomic, EEXIST = someone else won). A live owner's lock is never
 * unlinked by this code. The mutex file carries pid + a per-attempt nonce; it is cleared (dead holder) or released (our own) only
 * after re-reading it and finding the exact content judged dead / our own nonce, so one contender does not delete another's live
 * mutex in the normal interleavings.
 *
 * RESIDUAL (precise): "re-read, then rm" is not atomic. Between the re-read and the rmSync of the mutex a third contender could
 * still swap in its own mutex and have it removed; the window is two syscalls wide and needs a dead-mutex clear to race a fresh
 * takeover. Even then the lock file itself is only unlinked after a re-read compare under whichever mutex is held, and a live
 * owner's lock is never judged dead, so the worst case is two contenders both trying to link their lock (linkSync is atomic: one
 * wins, the other gets EEXIST and re-judges). Not guaranteed: that a stale lock is taken over by exactly one contender.
 * A mutex that is unparseable or has no pid cannot be cleared automatically (its holder is unknown); it needs a hand clear, and
 * the error names the file. A mutex whose pid is dead IS cleared automatically by the next contender.
 */
export function acquireKbWriterLock(dataDir: string, pid = process.pid, hooks: KbLockHooks = {}): { release(): void } {
  const file = kbLockFile(dataDir);
  const mutexFile = `${file}.takeover`;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${pid}.${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify({ pid, startedAt: new Date().toISOString() }), { mode: 0o600 });
  const mutexBody = JSON.stringify({ pid, nonce: randomBytes(8).toString("hex") });
  const mutexTmp = `${file}.mutex.${pid}.${randomBytes(4).toString("hex")}`;
  writeFileSync(mutexTmp, mutexBody, { mode: 0o600 });
  const readMutex = (): string | undefined => {
    try {
      return readFileSync(mutexFile, "utf8");
    } catch {
      return undefined;
    }
  };
  const withMutex = (fn: () => void): void => {
    try {
      linkSync(mutexTmp, mutexFile);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const seen = readMutex();
      let holder: number | undefined;
      try {
        holder = seen === undefined ? undefined : (JSON.parse(seen) as { pid?: number }).pid;
      } catch {
        holder = undefined;
      }
      if (seen !== undefined && typeof holder === "number" && !pidAlive(holder)) {
        hooks.afterMutexJudgedDead?.();
        if (readMutex() === seen) rmSync(mutexFile, { force: true }); // a dead contender's mutex, only if unchanged since judged
        return; // the caller's loop re-judges (bounded)
      }
      if (seen === undefined) return; // vanished meanwhile: re-judge
      throw new Error(`another process is taking over the KB writer lock ${file}; retry (${clearHint(mutexFile)})`);
    }
    try {
      fn();
    } finally {
      if (readMutex() === mutexBody) rmSync(mutexFile, { force: true }); // only our own (pid + nonce)
    }
  };
  try {
    for (let attempt = 0; ; attempt++) {
      if (attempt > LOCK_MAX_ATTEMPTS) throw new Error(`cannot take the KB writer lock ${file}: it kept changing; ${clearHint(file)}`);
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
      if (held) {
        throw new Error(`the KB in ${dataDir} already has a writer (${holder ? `pid ${holder}` : "unreadable lock, still fresh"}); a second hubd would corrupt it. If that process is gone, ${clearHint(file)}`);
      }
      hooks.afterJudgedStale?.();
      withMutex(() => {
        let cur: string | undefined;
        try {
          cur = readFileSync(file, "utf8");
        } catch {
          cur = undefined;
        }
        if (cur !== raw) return; // changed since we judged it: do nothing, the loop re-judges
        rmSync(file, { force: true });
        hooks.afterUnlinked?.();
      });
    }
  } finally {
    rmSync(tmp, { force: true });
    rmSync(mutexTmp, { force: true });
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

export function fsyncPath(p: string): void {
  const fd = openSync(p, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function fsyncDir(dir: string): void {
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

export function writeDurable(file: string, data: string | Buffer): void {
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

/** `<dataDir>/kb/base` must be the KB base: journal paths are relative to dataDir and anchored there. */
function assertKbLayout(roots: KbRoots, dataDir: string): void {
  if (resolve(roots.kbBase) !== resolve(dataDir, "kb", "base")) throw new Error("kb commits require roots.kbBase to be <dataDir>/kb/base");
}

/**
 * A journal path -> absolute path. Requires exactly `kb/base/domains/<valid domain>/<KB_COMMIT_PATH>` and applies the same
 * per-component lstat checks as a live commit (`confine`: no symlink, directories on the way, a regular file at the end).
 */
function resolveRel(roots: KbRoots, dataDir: string, rel: string): string {
  const parts = rel.split("/");
  if (parts.length < 5 || parts.slice(0, 3).join("/") !== "kb/base/domains") throw new Error(`journal path outside the KB: ${JSON.stringify(rel.slice(0, 80))}`);
  const domain = parts[3];
  const path = parts.slice(4).join("/");
  try {
    const abs = confinePath(roots, domain, path);
    if (resolve(abs) !== resolve(dataDir, ...parts)) throw new Error("path mismatch");
    return abs;
  } catch (e) {
    throw new Error(`journal path rejected (${JSON.stringify(rel.slice(0, 80))}): ${e instanceof Error ? e.message : String(e)}`);
  }
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
  invalidateLedgerCache(roots); // in-place cut, same inode: the async reader cache cannot tell (see ledger.ts)
  fsyncPath(file);
}

/**
 * Restore every journalled file, cut the ledger back, drop the journal. Idempotent. Every journal path is validated FIRST
 * (no partial recovery from a tampered journal). `at` is a test seam: "rollback" at the start, "files-restored" before the ledger step.
 */
function rollback(roots: KbRoots, dataDir: string, j: Journal, at?: (stage: string) => void): void {
  const abs = j.files.map((f) => resolveRel(roots, dataDir, f.rel));
  at?.("rollback");
  j.files.forEach((f, i) => {
    if (f.prev === null) removeDurable(abs[i]);
    else writeDurable(abs[i], Buffer.from(f.prev, "base64"));
  });
  at?.("files-restored");
  rollbackLedger(roots, j);
  rmSync(kbJournalFile(dataDir), { force: true });
  fsyncDir(join(dataDir, "run"));
}

function sweepTmp(dir: string): number {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let n = 0;
  for (const name of names) {
    if (TMP_RE.test(name)) {
      rmSync(join(dir, name), { force: true });
      n++;
    }
  }
  return n;
}

/**
 * Startup recovery: a journal left by a crash (or by a failed rollback) means an unacknowledged batch; roll it back, sweep the
 * `*.tmp-*` leftovers of the domains it touched. MUST run under the KB writer lock. Returns whether a rollback happened.
 * The journal is written tmp + fsync + rename, so an UNPARSEABLE or malformed one is not a crash artefact but real corruption:
 * it is never deleted, startup is refused, and the operator inspects it (the KB may be half-applied) and moves it aside by hand.
 * Torn `*.tmp-*` journals are plain sweep targets.
 */
export function recoverKbCommit(roots: KbRoots, dataDir: string, at?: (stage: string) => void): boolean {
  assertKbLayout(roots, dataDir);
  const jf = kbJournalFile(dataDir);
  const jrel = relative(dataDir, jf).split(sep).join("/");
  const swept = sweepTmp(join(dataDir, "run"));
  if (!existsSync(jf)) {
    if (swept > 0) console.warn(`hubd: swept ${swept} leftover temp file(s) in run/`);
    return false;
  }
  const refuse = (why: string): never => {
    throw new Error(`the KB commit journal ${jrel} is ${why}; the KB may be half-applied. Refusing to start: inspect it and move it aside by hand (it is not deleted)`);
  };
  let j: Journal;
  try {
    j = JSON.parse(readFileSync(jf, "utf8")) as Journal;
  } catch {
    return refuse("unparseable");
  }
  if (j?.v !== 1 || !Array.isArray(j.files) || typeof j.ledgerAppend !== "string" || typeof j.ledgerOffset !== "number" || j.files.some((f) => typeof f?.rel !== "string" || (f.prev !== null && typeof f.prev !== "string"))) return refuse("malformed");
  rollback(roots, dataDir, j, at);
  const dirs = new Set<string>();
  for (const f of j.files) {
    const abs = resolveRel(roots, dataDir, f.rel);
    dirs.add(dirname(abs));
    dirs.add(join(dataDir, ...f.rel.split("/").slice(0, 4))); // kb/base/domains/<domain>
  }
  let n = swept;
  for (const d of dirs) n += sweepTmp(d);
  console.warn(`hubd: recovered an interrupted KB commit: rolled back ${j.files.length} file(s) and the KB ledger append (${n} temp file(s) swept)`);
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
  return confinePath(roots, c.domain, c.path);
}

function confinePath(roots: KbRoots, domain: string, path: string): string {
  const c = { domain, path };
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
  /** @internal TEST-ONLY: called at "journal" | "file:<i>" | "ledger" | "journal-drop" | "committed" | "rollback"; throw to inject a failure. */
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
  assertKbLayout(roots, dataDir);
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
        resolveRel(roots, dataDir, rel); // the journal must be able to name it
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
      rollback(roots, dataDir, journal, stage);
    } catch (re) {
      console.error("hubd: kb commit rollback FAILED; the journal is kept for recovery:", re);
      throw new KbRollbackError();
    }
    if (e instanceof HubError) throw e;
    throw new HubError("engine_error", "kb commit failed and was rolled back");
  }
  try {
    stage("committed"); // TEST-ONLY seam: a crash after the journal drop, before the revision is recorded
  } catch {
    throw new HubError("engine_error", "kb commit applied but the process stopped before it was recorded (simulated crash)");
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
  /** Called inside the commit's queue job with the applied batch (the revision log records it). Failure is logged, never fails the commit: the poll scan picks the files up. */
  onCommitted?: (out: KbCommitResponse) => void;
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
        try {
          opts.onCommitted?.(out);
        } catch (e) {
          console.error("hubd: kb revision record failed (the next scan will catch up):", e);
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
    /** Run `fn` on the writer queue (revision scans); undefined result when the hub is shutting down. */
    exclusive<T>(fn: () => T | Promise<T>): Promise<T | undefined> { // the queue awaits an async fn: the lock spans it
      if (closing) return Promise.resolve(undefined);
      return queue.run(() => (closing ? undefined : fn()));
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
