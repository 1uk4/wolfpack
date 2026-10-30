/**
 * Per-domain KB revisions and change log (the hub side of KB distribution to workers).
 *
 * DETECTION (owner decision, option B): hubd polls the domain folders every few seconds (`start`) to see Dewey's direct writes, AND
 * `applyKbCommit` results are recorded inline (`record`). Both run on the KB writer's WriteQueue, so revisions are totally ordered.
 * No fs.watch; no change to Dewey.
 *
 * ON DISK `<dataDir>/kb-rev/<domain>/`:
 *   changes.jsonl  one row per changed path, one revision per row: {rev, ts, path, op: create|update|delete, contentHash|null}
 *   manifest.json  {v, rev, files: {path: contentHash}}: the hub's view of the folder at `rev`
 *   state.json     {v, epoch, rev, floor}: written durably and LAST (rows, then manifest, then state). `epoch` is random per domain
 *                  history; a worker holding another epoch must resync. `floor` = highest revision dropped from the log.
 * Recovery on start: rev = max(state.rev, last parseable row); a torn last row is dropped; a stale manifest is brought forward by
 * replaying rows, and a missing/corrupt/unreplayable one is rebuilt from disk with floor := rev (workers fall back to a manifest diff).
 *
 * RETENTION: a row is kept when its ts is within 30 days OR it is among the last 10,000 rows (whichever keeps more). Only a prefix
 * is ever dropped. Pruning raises state.floor FIRST, then rewrites the log.
 *
 * Synced paths are KB_SYNC_PATH under `kb/base/domains/<domain>/`. Symlinks, dotfiles/dot-dirs, `*.tmp-*` and non-UTF-8 files are
 * ignored. A file modified less than `settleMs` ago is left for the next scan (non-atomic writers); atomic renames need no wait.
 * The KB base itself may be a symlink (it is only ever reached through its configured path); nothing below domains/<d> may be.
 */
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { contentHash, type KbRoots } from "@wolfpack/kb/shared";
import { KB_COMMIT_BODY_LIMIT, KB_SYNC_PATH, type KbChangesResponse, type KbCommitResponse, type KbManifestDiffResponse, type KbManifestResponse, type KbSyncFile } from "@wolfpack/protocol";
import { HubError } from "./errors.js";
import { fsyncDir, writeDurable } from "./kb-commits.js";

const DOMAIN = /^[a-z0-9][a-z0-9-]*$/;
const TMP_RE = /\.tmp-\d+-[0-9a-f]{8}$/;
const DAY = 86_400_000;
export const KB_REV_DIR = "kb-rev";

export interface KbRetention {
  days: number;
  maxChanges: number;
}
export const DEFAULT_RETENTION: KbRetention = { days: 30, maxChanges: 10_000 };

interface Row {
  rev: number;
  ts: number;
  path: string;
  op: "create" | "update" | "delete";
  contentHash: string | null;
}
/** ns-resolution stat (bigint) incl. ctime: a same-size rewrite with a restored mtime still moves ctime. */
type Stat = { mtimeNs: bigint; ctimeNs: bigint; size: bigint; ino: bigint };
const statOf = (st: { mtimeNs: bigint; ctimeNs: bigint; size: bigint; ino: bigint }): Stat => ({ mtimeNs: st.mtimeNs, ctimeNs: st.ctimeNs, size: st.size, ino: st.ino });
const sameStat = (a: Stat, b: Stat) => a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.size === b.size && a.ino === b.ino;
const missing = (e: unknown) => ["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException).code ?? "");
interface Dom {
  epoch: string;
  rev: number;
  floor: number;
  rows: Row[];
  files: Map<string, string>;
  stat: Map<string, Stat>;
}

export interface KbRevisionsOptions {
  dataDir: string;
  roots: KbRoots;
  now?: () => number;
  retention?: KbRetention;
  settleMs?: number;
  pollMs?: number;
  /** Runs `fn` on the KB writer queue; used by the poll timer. */
  exclusive?: <T>(fn: () => T) => Promise<T | undefined>;
}

const utf8 = (buf: Buffer): string | undefined => {
  const t = buf.toString("utf8");
  return Buffer.from(t, "utf8").equals(buf) ? t : undefined;
};
const rowLine = (r: Row) => JSON.stringify(r) + "\n";

export function createKbRevisions(opts: KbRevisionsOptions) {
  const now = opts.now ?? Date.now;
  const retention = opts.retention ?? DEFAULT_RETENTION;
  const settleMs = opts.settleMs ?? 1500;
  const domainsDir = join(opts.roots.kbBase, "domains");
  const revRoot = join(opts.dataDir, KB_REV_DIR);
  const doms = new Map<string, Dom>();
  const warned = new Set<string>();
  let lastPrune = 0;
  let timer: NodeJS.Timeout | undefined;
  let scanning = false;
  /** Domains whose persist failed: dropped from memory; the next load gets a fresh epoch so revision numbers are never reused under one epoch. */
  const rotateNext = new Set<string>();
  const warnOnce = (k: string, m: string) => {
    if (warned.has(k)) return;
    warned.add(k);
    console.warn(m);
  };
  const dirOf = (d: string) => join(revRoot, d);

  // ------------------------------------------------------------- disk walk
  const isRealDir = (p: string) => {
    const st = lstatSync(p, { throwIfNoEntry: false });
    return !!st && st.isDirectory() && !st.isSymbolicLink();
  };
  /** Relative synced paths of a domain (regular files only, no symlinks, no dot names, no tmp files). */
  function walk(domain: string): string[] {
    const base = join(domainsDir, domain);
    if (!isRealDir(base)) return [];
    const out: string[] = [];
    const ok = (rel: string, name: string) => !name.startsWith(".") && !TMP_RE.test(name) && KB_SYNC_PATH.test(rel);
    const list = (dir: string) => {
      try {
        return readdirSync(dir, { withFileTypes: true });
      } catch (e) {
        if (missing(e)) return []; // really gone; anything else (EACCES, EMFILE, ...) propagates and fails this domain's scan
        throw e;
      }
    };
    for (const e of list(base)) {
      if (e.isFile() && ok(e.name, e.name)) out.push(e.name);
      else if (e.isDirectory() && (e.name === "entries" || e.name === "versions")) {
        const d1 = join(base, e.name);
        if (!isRealDir(d1)) continue;
        for (const f of list(d1)) {
          if (e.name === "entries") {
            if (f.isFile() && ok(`entries/${f.name}`, f.name)) out.push(`entries/${f.name}`);
          } else if (f.isDirectory() && !f.name.startsWith(".")) {
            const d2 = join(d1, f.name);
            if (!isRealDir(d2)) continue;
            for (const g of list(d2)) if (g.isFile() && ok(`versions/${f.name}/${g.name}`, g.name)) out.push(`versions/${f.name}/${g.name}`);
          }
        }
      }
    }
    return out.sort();
  }
  /** lstat + read one synced file; undefined when it is gone, not a regular file, or not UTF-8. */
  function readSynced(domain: string, rel: string): { text: string; st: Stat } | undefined {
    const abs = join(domainsDir, domain, ...rel.split("/"));
    const st = lstatSync(abs, { bigint: true, throwIfNoEntry: false });
    if (!st || !st.isFile() || st.isSymbolicLink()) return undefined;
    let buf: Buffer;
    try {
      buf = readFileSync(abs);
    } catch (e) {
      if (missing(e)) return undefined;
      throw e;
    }
    const text = utf8(buf);
    if (text === undefined) {
      warnOnce(`${domain}/${rel}`, `hubd: kb revisions: ${domain}/${rel} is not valid UTF-8; ignored`);
      return undefined;
    }
    return { text, st: statOf(st) };
  }

  // ------------------------------------------------------------- persistence
  function appendRows(d: string, rows: Row[]): void {
    if (rows.length === 0) return;
    const f = join(dirOf(d), "changes.jsonl");
    const fresh = !existsSync(f);
    mkdirSync(dirOf(d), { recursive: true });
    const fd = openSync(f, "a", 0o644);
    try {
      writeSync(fd, rows.map(rowLine).join(""));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (fresh) {
      // the new directory entry (and the dirs created on the way) must survive power loss too, or state.rev could outlive the log
      fsyncDir(dirOf(d));
      fsyncDir(revRoot);
      fsyncDir(opts.dataDir);
    }
  }
  const writeManifest = (d: string, s: Dom) => writeDurable(join(dirOf(d), "manifest.json"), JSON.stringify({ v: 1, rev: s.rev, files: Object.fromEntries(s.files) }));
  const writeState = (d: string, s: Dom) => writeDurable(join(dirOf(d), "state.json"), JSON.stringify({ v: 1, epoch: s.epoch, rev: s.rev, floor: s.floor }));
  const rewriteRows = (d: string, rows: Row[]) => writeDurable(join(dirOf(d), "changes.jsonl"), rows.map(rowLine).join(""));

  function loadDomain(d: string): Dom {
    const dir = dirOf(d);
    let state: { epoch?: unknown; rev?: unknown; floor?: unknown } | undefined;
    try {
      state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
    } catch {
      state = undefined;
    }
    const rows: Row[] = [];
    let torn = false;
    let middleBad = false;
    try {
      const lines = readFileSync(join(dir, "changes.jsonl"), "utf8").split("\n");
      const endsClean = lines[lines.length - 1] === "";
      if (endsClean) lines.pop();
      lines.forEach((ln, i) => {
        try {
          const r = JSON.parse(ln) as Row;
          if (typeof r.rev !== "number" || typeof r.path !== "string" || !["create", "update", "delete"].includes(r.op)) throw new Error("shape");
          rows.push(r);
        } catch {
          if (i === lines.length - 1) torn = true;
          else middleBad = true;
        }
      });
      if (!endsClean) torn = true;
    } catch {
      /* no log yet */
    }
    const stRev = typeof state?.rev === "number" ? state.rev : 0;
    const lastRow = rows.length ? rows.reduce((m, r) => Math.max(m, r.rev), 0) : 0;
    const floor0 = typeof state?.floor === "number" ? state.floor : 0;
    const s: Dom = {
      epoch: !rotateNext.has(d) && typeof state?.epoch === "string" ? state.epoch : randomBytes(8).toString("hex"),
      rev: Math.max(stRev, lastRow),
      floor: floor0,
      rows,
      files: new Map(),
      stat: new Map(),
    };
    let dirty = rotateNext.has(d) || typeof state?.epoch !== "string";
    // The log must be contiguous over (floor, rev]. A missing head or hole raises the floor past it; a missing tail (state.rev ahead
    // of the last row, e.g. the log file lost) means floor = rev. Rows at or below the floor are dropped.
    const kept = rows.filter((r) => r.rev > s.floor).sort((x, y) => x.rev - y.rev);
    let i = kept.length;
    let expect = s.rev;
    while (i > 0 && kept[i - 1].rev === expect) {
      i--;
      expect--;
    }
    const suffix = kept.slice(i);
    const newFloor = Math.max(s.floor, expect);
    const repaired = newFloor !== s.floor || suffix.length !== rows.length;
    if (newFloor !== s.floor) console.warn(`hubd: kb revisions: the change log of ${d} does not cover (${s.floor}, ${s.rev}]; floor raised to ${newFloor}`);
    s.floor = newFloor;
    s.rows = suffix;
    if (newFloor !== floor0) dirty = true;
    if (torn || repaired || middleBad) {
      if (torn) console.warn(`hubd: kb revisions: dropped a torn last row of ${d}`);
      mkdirSync(dir, { recursive: true });
      rewriteRows(d, s.rows);
    }
    let man: { rev?: unknown; files?: unknown } | undefined;
    try {
      man = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    } catch {
      man = undefined;
    }
    const validFiles = !!man && typeof man.rev === "number" && !!man.files && typeof man.files === "object" && !Array.isArray(man.files);
    let rebuilt = false;
    if (validFiles && (man!.rev as number) <= s.rev) {
      for (const [p, h] of Object.entries(man!.files as Record<string, unknown>)) if (typeof h === "string") s.files.set(p, h);
      const from = man!.rev as number;
      if (from < s.rev) {
        const todo = rows.filter((r) => r.rev > from);
        if (todo.length !== s.rev - from || todo[0]?.rev !== from + 1) rebuilt = true;
        else for (const r of todo) r.op === "delete" ? s.files.delete(r.path) : s.files.set(r.path, r.contentHash!);
      }
    } else if (s.rev > 0 || state) rebuilt = true;
    if (rebuilt) {
      s.files.clear();
      for (const p of walk(d)) {
        const r = readSynced(d, p);
        if (r) {
          s.files.set(p, contentHash(r.text));
          s.stat.set(p, r.st);
        }
      }
      // A synthetic revision, so a client sitting exactly at the old head (since == rev) is below the new floor and resets too.
      s.rev++;
      s.floor = s.rev;
      s.rows = [];
      mkdirSync(dir, { recursive: true });
      rewriteRows(d, []);
      console.warn(`hubd: kb revisions: rebuilt the manifest of ${d} from disk (revision ${s.rev}, floor ${s.floor})`);
    }
    if (rebuilt || dirty || !state || !validFiles || (man!.rev as number) !== s.rev || stRev !== s.rev) {
      mkdirSync(dir, { recursive: true });
      writeManifest(d, s);
      writeState(d, s);
    }
    rotateNext.delete(d);
    return s;
  }
  /** Load (and persist) a domain. Scan/record paths only; never called from a request. */
  function dom(d: string): Dom {
    let s = doms.get(d);
    if (!s) {
      s = loadDomain(d);
      doms.set(d, s);
    }
    return s;
  }

  // ------------------------------------------------------------- recording
  /** Apply path->hash|null changes to the domain, one revision each. Queue-only. */
  function apply(d: string, changes: { path: string; hash: string | null }[], stats?: Map<string, Stat>): number {
    const s = dom(d);
    const rows: Row[] = [];
    const ts = now();
    for (const c of changes) {
      const have = s.files.get(c.path);
      if (c.hash === null ? have === undefined : have === c.hash) continue; // not a change
      const op = c.hash === null ? "delete" : have === undefined ? "create" : "update";
      s.rev++;
      rows.push({ rev: s.rev, ts, path: c.path, op, contentHash: c.hash });
      if (c.hash === null) {
        s.files.delete(c.path);
        s.stat.delete(c.path);
      } else s.files.set(c.path, c.hash);
    }
    for (const [p, st] of stats ?? []) if (s.files.has(p)) s.stat.set(p, st);
    if (rows.length === 0) return 0;
    for (const r of rows) s.rows.push(r); // not push(...rows): a first scan of a big domain would overflow the argument limit
    try {
      appendRows(d, rows);
      writeManifest(d, s);
      writeState(d, s); // LAST
    } catch (e) {
      // Memory is now ahead of disk. Drop the domain; its next load reads the disk and takes a NEW epoch, so a revision number is never
      // reused for different content under one epoch.
      doms.delete(d);
      rotateNext.add(d);
      throw e;
    }
    return rows.length;
  }

  /** Record the files of a committed batch (inline, same queue job as applyKbCommit). */
  function record(out: KbCommitResponse): void {
    const by = new Map<string, { path: string; hash: string | null }[]>();
    const stats = new Map<string, Map<string, Stat>>();
    for (const f of out.files) {
      if (!DOMAIN.test(f.domain) || !KB_SYNC_PATH.test(f.path)) continue;
      let hash: string | null = null;
      if (f.op !== "delete") {
        // Hash and stat come from ONE read of the file as it is now (not the committed hash): if Dewey overwrote it since the commit,
        // the manifest says what is really on disk, and the cached stat belongs to those bytes.
        const r = readSynced(f.domain, f.path);
        if (!r) continue; // gone or unreadable already: the scan decides
        hash = contentHash(r.text);
        if (!stats.has(f.domain)) stats.set(f.domain, new Map());
        stats.get(f.domain)!.set(f.path, r.st);
      }
      if (!by.has(f.domain)) by.set(f.domain, []);
      by.get(f.domain)!.push({ path: f.path, hash });
    }
    for (const [d, ch] of by) apply(d, ch, stats.get(d));
  }

  // ------------------------------------------------------------- scanning
  function diskDomains(): string[] {
    let names: string[] = [];
    try {
      names = readdirSync(domainsDir);
    } catch {
      /* none */
    }
    const set = new Set(names.filter((n) => DOMAIN.test(n) && isRealDir(join(domainsDir, n))));
    for (const n of doms.keys()) set.add(n);
    try {
      for (const n of readdirSync(revRoot)) if (DOMAIN.test(n)) set.add(n);
    } catch {
      /* none */
    }
    return [...set].sort();
  }

  /** ok | gone (domains/ is readable and domains/<d> is really absent) | unavailable (anything else: unmounted target, EACCES, a symlink...). */
  function domainStatus(d: string): "ok" | "gone" | "unavailable" {
    let st;
    try {
      st = lstatSync(join(domainsDir, d), { throwIfNoEntry: false });
    } catch {
      return "unavailable";
    }
    if (st) return st.isDirectory() ? "ok" : "unavailable";
    try {
      readdirSync(domainsDir);
      return "gone";
    } catch {
      return "unavailable";
    }
  }

  /** Returns the number of revisions recorded. */
  function scanDomain(d: string, settle: boolean): number {
    const s = dom(d);
    const status = domainStatus(d);
    if (status === "unavailable") {
      // Never turn a transient failure (unmounted symlink target, permissions) into a mass delete.
      if (s.files.size > 0) warnOnce(`unavailable:${d}`, `hubd: kb revisions: domains/${d} is not readable; scan skipped (${s.files.size} file(s) kept)`);
      return 0;
    }
    warned.delete(`unavailable:${d}`);
    const cutoff = now() - settleMs;
    const seen = new Set<string>();
    const changes: { path: string; hash: string | null }[] = [];
    const stats = new Map<string, Stat>();
    for (const p of walk(d)) {
      const st = lstatSync(join(domainsDir, d, ...p.split("/")), { bigint: true, throwIfNoEntry: false });
      if (!st || !st.isFile()) continue;
      seen.add(p);
      const c = s.stat.get(p);
      if (c && sameStat(c, statOf(st)) && s.files.has(p)) continue;
      if (settle && Number(st.mtimeMs) > cutoff) continue; // still being written: look again next scan
      const r = readSynced(d, p);
      if (!r) continue; // unreadable / non-UTF-8: keep whatever we had
      stats.set(p, r.st);
      changes.push({ path: p, hash: contentHash(r.text) });
    }
    // Gone from disk -> delete. A file inside the settle window or unreadable is "seen" above, so it is not deleted.
    for (const p of [...s.files.keys()]) if (!seen.has(p)) changes.push({ path: p, hash: null });
    return apply(d, changes, stats);
  }

  /** One pass over every domain. Queue-only. `settle:false` (startup) also takes files modified a moment ago. */
  function scan(o: { settle?: boolean; prune?: boolean; log?: boolean } = {}): void {
    const t0 = Date.now();
    let changed = 0;
    const names = diskDomains();
    for (const d of names) {
      try {
        changed += scanDomain(d, o.settle !== false);
      } catch (e) {
        console.error(`hubd: kb scan of ${d} failed:`, e);
      }
    }
    if (o.prune || now() - lastPrune >= 3_600_000) prune();
    const ms = Date.now() - t0;
    if (o.log || changed > 0 || ms > 1000) console.log(`hubd: kb scan: ${names.length} domain(s), ${changed} change(s), ${ms}ms`);
  }

  function prune(): void {
    lastPrune = now();
    const cutoff = now() - retention.days * DAY;
    for (const [d, s] of doms) {
      let drop = 0;
      while (drop < s.rows.length && s.rows.length - drop > retention.maxChanges && s.rows[drop].ts < cutoff) drop++;
      if (drop === 0) continue;
      try {
        s.floor = Math.max(s.floor, s.rows[drop - 1].rev);
        writeState(d, s); // floor first: a crash before the rewrite only makes the floor conservative
        rewriteRows(d, s.rows.slice(drop));
        s.rows = s.rows.slice(drop);
      } catch (e) {
        console.error(`hubd: kb revision prune of ${d} failed:`, e);
      }
    }
  }

  // ------------------------------------------------------------- reads
  /** Request path: reads memory only. A domain exists once a scan (startup, poll) or a commit has created it; 404 until then. */
  const need = (d: string): Dom => {
    if (!DOMAIN.test(d)) throw new HubError("invalid_request", `bad domain name ${JSON.stringify(d.slice(0, 60))}`);
    const s = doms.get(d);
    if (!s) throw new HubError("not_found", `no KB domain ${d} (not scanned yet)`);
    return s;
  };
  const size = (f: KbSyncFile) => Buffer.byteLength(f.content, "utf8") + f.path.length + 128;
  const fileOf = (d: string, path: string): KbSyncFile | undefined => {
    const r = readSynced(d, path);
    return r ? { path, contentHash: contentHash(r.text), encoding: "utf8", content: r.text } : undefined;
  };

  function head(d: string): { epoch: string; revision: number; floor: number } {
    const s = need(d);
    return { epoch: s.epoch, revision: s.rev, floor: s.floor };
  }

  function changesSince(d: string, since: number, epoch?: string, maxBytes = KB_COMMIT_BODY_LIMIT): KbChangesResponse {
    const s = need(d);
    const reset = (reason: "below_floor" | "epoch_mismatch" | "ahead_of_hub"): KbChangesResponse => ({ status: "reset", domain: d, epoch: s.epoch, reason, floor: s.floor, revision: s.rev });
    if (epoch !== undefined && epoch !== s.epoch) return reset("epoch_mismatch");
    if (since > s.rev) return reset("ahead_of_hub");
    if (since < s.floor) return reset("below_floor");
    const last = new Map<string, Row>();
    for (let i = s.rows.length - 1; i >= 0 && s.rows[i].rev > since; i--) if (!last.has(s.rows[i].path)) last.set(s.rows[i].path, s.rows[i]);
    const items = [...last.values()].sort((a, b) => a.rev - b.rev);
    const files: KbSyncFile[] = [];
    const deletes: { path: string }[] = [];
    let bytes = 0;
    let revision = s.rev;
    let truncated = false;
    for (let i = 0; i < items.length; i++) {
      const r = items[i];
      if (r.op === "delete") {
        deletes.push({ path: r.path });
        bytes += r.path.length + 32;
        continue;
      }
      const f = fileOf(d, r.path); // current bytes (may be newer than the row; the later scan row re-delivers it)
      // fileOf is undefined when the file vanished or is unreadable / not valid UTF-8 now. Such a file never enters the log as live
      // content (the scanner skips it too), so skipping it cannot drop a real change: a vanish is recorded as a delete by the next
      // scan, and an unreadable file keeps its last good revision.
      if (!f) continue;
      if (files.length + deletes.length > 0 && bytes + size(f) > maxBytes) {
        truncated = true;
        revision = items[i - 1].rev;
        break;
      }
      files.push(f);
      bytes += size(f);
    }
    return { status: "ok", domain: d, epoch: s.epoch, since, revision, truncated, files, deletes };
  }

  function manifest(d: string): KbManifestResponse {
    const s = need(d);
    return { domain: d, epoch: s.epoch, revision: s.rev, floor: s.floor, files: Object.fromEntries([...s.files].sort(([a], [b]) => (a < b ? -1 : 1))) };
  }

  function diff(d: string, theirs: Record<string, string>, maxBytes = KB_COMMIT_BODY_LIMIT): KbManifestDiffResponse {
    const s = need(d);
    const want = [...s.files].filter(([p, h]) => theirs[p] !== h).map(([p]) => p).sort();
    const deletes = Object.keys(theirs).filter((p) => KB_SYNC_PATH.test(p) && !s.files.has(p)).sort().map((path) => ({ path }));
    const files: KbSyncFile[] = [];
    const pending: string[] = [];
    let bytes = 0;
    for (const p of want) {
      if (pending.length > 0) {
        pending.push(p);
        continue;
      }
      const f = fileOf(d, p);
      if (!f) continue;
      if (files.length > 0 && bytes + size(f) > maxBytes) {
        pending.push(p);
        continue;
      }
      files.push(f);
      bytes += size(f);
    }
    return { domain: d, epoch: s.epoch, revision: s.rev, files, deletes, pending };
  }

  // ------------------------------------------------------------- lifecycle
  function start(): void {
    const ms = opts.pollMs ?? 3000;
    if (ms <= 0 || timer || !opts.exclusive) return;
    timer = setInterval(() => {
      if (scanning) return;
      scanning = true;
      void opts
        .exclusive!(() => scan())
        .catch((e) => console.error("hubd: kb poll failed:", e))
        .finally(() => (scanning = false));
    }, ms);
    timer.unref();
  }
  function stop(): void {
    if (timer) clearInterval(timer);
    timer = undefined;
  }
  /** Startup: load every known domain and scan once (also prunes). Run after KB recovery, before listening. */
  function init(): void {
    mkdirSync(revRoot, { recursive: true });
    scan({ settle: false, prune: true, log: true });
  }

  return { head, record, scan, prune, changesSince, manifest, diff, start, stop, init };
}
export type KbRevisions = ReturnType<typeof createKbRevisions>;
