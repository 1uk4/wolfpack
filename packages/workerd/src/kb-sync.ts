/**
 * KbSync: pulls each subscribed KB domain from the hub into a MIRROR next to (never inside) the Syncthing KB.
 *
 * LAYOUT  <mirrorDir>/<domain>/{entries,versions,_registry.md,_digest.json,INDEX.md}   whole files, exactly the hub's bytes
 *         <mirrorDir>/.sync/<domain>.json                                              {v, epoch, rev, active}
 * Only the hub writes mirror content; workerd writes it solely to apply hub data (atomic: temp + fsync + rename, hash verified first).
 * The state file is written only AFTER the files of a page are applied, so a crash re-applies at most one page (idempotent).
 *
 * ALGORITHM per domain: with saved {epoch, rev>0}: GET changes?since=rev&epoch=, follow `revision` while `truncated`.
 *   `reset` (below_floor / epoch_mismatch / ahead_of_hub), or no saved state: manifest diff (POST manifest-diff with the hashes of the
 *   files on disk; fetch differing files, delete extras, follow `pending`), then adopt the diff's {epoch, revision}.
 * FAILURES (404 not-scanned-yet, 403, 5xx, network, hash mismatch, disk errors) retry with backoff 1s -> 60s and NEVER delete anything.
 * SUBSCRIBED SET: ONLY what the hub registry grants this host (welcome.grantedDomains, updated by `grants` frames) via setGranted();
 *   wolf.yaml domains are never consulted, and the set is empty before the first welcome.
 * TRIGGERS: setGranted() (welcome / grants frame), notify() (kb.changed hint; ignored for unsubscribed domains and for domains in backoff),
 *   and a slow safety poll (which also respects backoff). The first sync of a domain after start, and every 12th poll, ALSO runs a manifest
 *   diff even with a saved revision, so deleted or corrupted mirror files get repaired.
 * The INCREMENTAL `changes` path is deliberately NOT guarded: its deletes come from the hub's real change log (one row per file actually
 *   removed), so a legitimate large prune arrives as such; only the manifest diff, which infers deletes from "the hub lacks it", can be fooled
 *   by an empty/partial hub view.
 * SAFETY: a diff that would delete more than half of the local files (or all of them, when there are 2+) is refused and retried with
 *   backoff (a mass-delete guard against a hub that wrongly reports an empty domain). Paths are KB_SYNC_PATH-checked and every parent
 *   directory is lstat'ed for symlinks before any write or delete. Nothing is written after stop().
 * An epoch rotation after a hub persist failure is not pushed; the worker sees it on the next write's push or its poll (epoch_mismatch -> diff).
 * REMOVAL: a domain that leaves the subscribed set stops syncing; its mirror is KEPT and marked `active:false` (stale, ignore it).
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeSync, lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { KB_SYNC_PATH, KbChangesResponseSchema, KbManifestDiffResponseSchema, type KbSyncFile } from "@wolfpack/protocol";

const DOMAIN = /^[a-z0-9][a-z0-9-]*$/;
const hashOf = (text: string): string => "sha256:" + createHash("sha256").update(text, "utf-8").digest("hex");
/** A relative KB path with no `.`/`..`/empty segments that matches the sync grammar. */
const safeRel = (p: string): boolean => KB_SYNC_PATH.test(p) && p.split("/").every((x) => x !== "" && x !== "." && x !== "..");
const MAX_BYTES = 2 * 1024 * 1024;

export interface KbSyncOptions {
  hubUrl: string;
  token: string;
  mirrorDir: string;
  log?: (m: string) => void;
  fetchImpl?: typeof fetch;
  baseMs?: number;
  capMs?: number;
  /** Safety poll interval; 0 disables. Default 5 min. */
  pollMs?: number;
  /** Run a manifest diff on the first sync after start even with a saved revision. Default true. */
  verifyOnStart?: boolean;
  /** Every Nth poll tick also runs a manifest diff. Default 12. */
  verifyEveryPolls?: number;
  /** maxBytes asked of the hub per page. Default 2 MiB (test seam). */
  maxBytes?: number;
}

export interface KbDomainStatus {
  active: boolean;
  epoch?: string;
  rev: number;
  syncing: boolean;
  lastError?: string;
  failures: number;
  /** Mass-delete guard refusals for this domain since start, and when the last one happened (ms epoch). */
  refusals: number;
  lastRefusalAt?: number;
}

interface DomState {
  epoch: string;
  rev: number;
  active: boolean;
}
class Retry extends Error {}
/** The mass-delete guard refused a manifest diff (nothing was changed). */
class Refused extends Retry {}
/** AbortSignal.any needs Node >= 20.3 (no `engines` is declared; sfo-01 runs v22): fall back by hand. */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const any = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (any) return any.call(AbortSignal, signals);
  const ac = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      ac.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => ac.abort(s.reason), { once: true });
  }
  return ac.signal;
}
/** The domain was unsubscribed or the sync stopped mid-flight: abandon quietly. */
class Abandon extends Error {}

export class KbSync {
  private readonly subscribed = new Set<string>();
  private readonly running = new Set<string>();
  private readonly dirty = new Set<string>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly failures = new Map<string, number>();
  private readonly errors = new Map<string, string>();
  private readonly full = new Set<string>();
  private readonly refusals = new Map<string, { n: number; at: number }>();
  private readonly overrides = new Set<string>();
  private poll?: NodeJS.Timeout;
  private pollTicks = 0;
  private ac = new AbortController();
  private granted: string[] = [];
  private stopped = true;
  private readonly f: typeof fetch;

  constructor(private readonly o: KbSyncOptions) {
    this.f = o.fetchImpl ?? fetch;
  }

  private log(m: string) {
    (this.o.log ?? (() => {}))(`[workerd] kb sync: ${m}`);
  }
  mirrorPath(domain: string): string {
    return join(this.o.mirrorDir, domain);
  }
  private stateFile(d: string) {
    return join(this.o.mirrorDir, ".sync", `${d}.json`);
  }
  private load(d: string): DomState | undefined {
    try {
      const j = JSON.parse(readFileSync(this.stateFile(d), "utf8")) as Partial<DomState>;
      if (typeof j.epoch === "string" && typeof j.rev === "number" && j.rev >= 0) return { epoch: j.epoch, rev: j.rev, active: j.active !== false };
    } catch {
      /* none or corrupt: sync from scratch via manifest diff (never destructive) */
    }
    return undefined;
  }
  private save(d: string, s: DomState): void {
    this.writeAtomic(this.stateFile(d), JSON.stringify({ v: 1, ...s }));
  }

  /** Revisions on disk, for the link hello. */
  revisions(): Record<string, number> {
    const out: Record<string, number> = {};
    try {
      for (const n of readdirSync(join(this.o.mirrorDir, ".sync"))) {
        const d = n.replace(/\.json$/, "");
        const s = DOMAIN.test(d) ? this.load(d) : undefined;
        if (s && s.active) out[d] = s.rev;
      }
    } catch {
      /* none */
    }
    return out;
  }

  status(): Record<string, KbDomainStatus> {
    const out: Record<string, KbDomainStatus> = {};
    const names = new Set<string>(this.subscribed);
    try {
      for (const n of readdirSync(join(this.o.mirrorDir, ".sync"))) names.add(n.replace(/\.json$/, ""));
    } catch {
      /* none */
    }
    for (const d of names) {
      if (!DOMAIN.test(d)) continue;
      const s = this.load(d);
      out[d] = { active: this.subscribed.has(d), ...(s ? { epoch: s.epoch } : {}), rev: s?.rev ?? 0, syncing: this.running.has(d), ...(this.errors.has(d) ? { lastError: this.errors.get(d) } : {}), failures: this.failures.get(d) ?? 0, refusals: this.refusals.get(d)?.n ?? 0, ...(this.refusals.has(d) ? { lastRefusalAt: this.refusals.get(d)!.at } : {}) };
    }
    return out;
  }

  start(): void {
    this.stopped = false;
    if (this.ac.signal.aborted) this.ac = new AbortController();
    this.refresh();
    if ((this.o.pollMs ?? 300_000) > 0) {
      this.poll = setInterval(() => {
        if (++this.pollTicks % (this.o.verifyEveryPolls ?? 12) === 0) for (const d of this.subscribed) this.full.add(d);
        this.syncAll(false);
      }, this.o.pollMs ?? 300_000);
      this.poll.unref();
    }
  }
  stop(): void {
    this.stopped = true;
    this.ac.abort();
    if (this.poll) clearInterval(this.poll);
    this.poll = undefined;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /**
   * Allow ONE manifest diff of `domain` to delete more than half of the local files (a legitimate big prune on a first sync).
   * Consumed by the first diff that needs it. Also honoured: a flag file `<mirrorDir>/.sync/<domain>.allow-mass-delete`, consumed once.
   */
  allowMassDelete(domain: string): void {
    this.overrides.add(domain);
    if (this.subscribed.has(domain)) this.syncAll();
  }
  private takeOverride(d: string): boolean {
    if (this.overrides.delete(d)) return true;
    const f = join(this.o.mirrorDir, ".sync", `${d}.allow-mass-delete`);
    if (!existsSync(f)) return false;
    rmSync(f, { force: true });
    return true;
  }

  /** A welcome: only an explicit array replaces the set; absent (older hub / hub registry read failed) keeps it and just re-pulls. */
  applyWelcome(granted: string[] | undefined): void {
    if (granted) this.setGranted(granted);
    else this.syncAll();
  }

  /** The registry-granted domains for this host (welcome / grants frame). Replaces the previous set. */
  setGranted(domains: string[]): void {
    this.granted = [...new Set(domains)];
    this.refresh();
  }

  /** Recompute the subscribed set; start new domains, deactivate removed ones (mirror kept), and pull everything now. */
  refresh(): void {
    if (this.stopped) return;
    const want = new Set(this.granted.filter((d) => DOMAIN.test(d)));
    for (const d of [...this.subscribed]) {
      if (want.has(d)) continue;
      this.subscribed.delete(d);
      this.full.delete(d);
      clearTimeout(this.timers.get(d));
      this.timers.delete(d);
      this.failures.delete(d);
      this.errors.delete(d);
      const s = this.load(d);
      if (s?.active) {
        try {
          this.save(d, { ...s, active: false });
        } catch (e) {
          this.log(`could not mark ${d} inactive: ${(e as Error).message}`);
        }
      }
      this.log(`domain ${d} left the subscribed set; mirror kept, marked inactive`);
    }
    for (const d of want) {
      if (!this.subscribed.has(d)) {
        this.subscribed.add(d);
        if (this.o.verifyOnStart !== false) this.full.add(d);
        const s = this.load(d);
        if (s && !s.active) {
          try {
            this.save(d, { ...s, active: true });
          } catch {
            /* sync will retry the save */
          }
        }
      }
    }
    this.syncAll();
  }

  /** A kb.changed hint from the hub: pull now (the revision is only advisory). Unsubscribed domains are never fetched; a domain in backoff waits for its timer. */
  notify(domain: string, _rev?: number, _epoch?: string): void {
    if (this.stopped || !this.subscribed.has(domain)) return;
    if (this.timers.has(domain)) return;
    clearTimeout(this.timers.get(domain));
    this.timers.delete(domain);
    void this.run(domain);
  }
  /** Pull every subscribed domain now (welcome / grants / poll). `force:false` (poll) leaves domains in backoff to their timers. */
  syncAll(force = true): void {
    for (const d of this.subscribed) {
      if (!force && this.timers.has(d)) continue;
      clearTimeout(this.timers.get(d));
      this.timers.delete(d);
      void this.run(d);
    }
  }

  /** Resolves when no domain is syncing (test helper). */
  async idle(): Promise<void> {
    while (this.running.size) await new Promise((r) => setTimeout(r, 10));
  }

  private async run(d: string): Promise<void> {
    if (this.running.has(d)) {
      this.dirty.add(d);
      return;
    }
    this.running.add(d);
    try {
      do {
        this.dirty.delete(d);
        try {
          await this.syncOnce(d);
          this.failures.delete(d);
          this.errors.delete(d);
        } catch (e) {
          if (e instanceof Abandon) break;
          this.fail(d, e as Error);
          break;
        }
      } while (this.dirty.has(d) && !this.stopped && this.subscribed.has(d));
    } finally {
      this.running.delete(d);
    }
  }

  private fail(d: string, e: Error): void {
    const n = (this.failures.get(d) ?? 0) + 1;
    this.failures.set(d, n);
    this.errors.set(d, e.message.slice(0, 200));
    if (this.stopped || !this.subscribed.has(d)) return;
    const base = this.o.baseMs ?? 1000;
    const cap = this.o.capMs ?? 60_000;
    const delay = Math.min(cap, base * 2 ** Math.min(n - 1, 16));
    if (n === 1 || n % 10 === 0) this.log(`${d}: ${e.message} (retry in ${delay}ms)`);
    const t = setTimeout(() => {
      this.timers.delete(d);
      void this.run(d);
    }, delay);
    t.unref();
    this.timers.set(d, t);
  }

  // ---------------------------------------------------------------- http
  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await this.f(this.o.hubUrl.replace(/\/+$/, "") + path, {
        method,
        headers: { Authorization: `Bearer ${this.o.token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: anySignal([this.ac.signal, AbortSignal.timeout(30_000)]),
      });
    } catch (e) {
      throw new Retry(`network: ${(e as Error).message}`);
    }
    if (res.status === 404) {
      await res.text().catch(() => "");
      throw new Retry("hub has not scanned this domain yet (404); retrying");
    }
    if (!res.ok) {
      await res.text().catch(() => "");
      throw new Retry(`hub answered HTTP ${res.status}${res.status === 403 ? " (domain not granted to this host)" : ""}`);
    }
    try {
      return await res.json();
    } catch {
      throw new Retry("hub sent an unreadable body");
    }
  }

  // ---------------------------------------------------------------- sync
  private async syncOnce(d: string): Promise<void> {
    const base = `/v1/kb/domains/${d}`;
    let st = this.load(d);
    if (st && st.rev > 0 && !this.full.has(d)) {
      for (;;) {
        const raw = await this.call("GET", `${base}/changes?since=${st.rev}&epoch=${encodeURIComponent(st.epoch)}&maxBytes=${this.o.maxBytes ?? MAX_BYTES}`);
        this.alive(d);
        const r = KbChangesResponseSchema.safeParse(raw);
        if (!r.success) throw new Retry("unexpected changes response");
        const c = r.data;
        if (c.status === "reset") {
          this.log(`${d}: ${c.reason}; falling back to manifest diff`);
          break;
        }
        this.applyFiles(d, c.files, c.deletes.map((x) => x.path));
        st = { epoch: c.epoch, rev: c.revision, active: this.subscribed.has(d) };
        this.save(d, st);
        if (!c.truncated) return;
      }
    }
    try {
      await this.diffSync(d);
    } catch (e) {
      // A refused VERIFY diff (saved state, nothing forced it) is not fatal: the mirror is still consistent with its saved revision, so
      // drop the verify request and carry on incrementally. Without saved state, or after a hub `reset`, the diff is the only way
      // forward, so the refusal stands (retry with backoff) until the override is given.
      if (e instanceof Refused && st && st.rev > 0 && this.full.has(d)) {
        this.full.delete(d);
        this.log(`WARNING ${d}: verify diff refused (${e.message}); continuing incrementally. If the prune is legitimate: allowMassDelete("${d}") or create .sync/${d}.allow-mass-delete`);
        return this.syncOnce(d);
      }
      throw e;
    }
    this.full.delete(d);
  }

  /** Throws Abandon when stopped or unsubscribed. Called after every await and before any write, so nothing lands after stop()/removal. */
  private alive(d: string): void {
    if (this.stopped || !this.subscribed.has(d)) throw new Abandon();
  }

  private async diffSync(d: string): Promise<void> {
    const base = `/v1/kb/domains/${d}`;
    for (let round = 0; round < 10_000; round++) {
      const local = this.localManifest(d);
      const raw = await this.call("POST", `${base}/manifest-diff`, { files: local, maxBytes: this.o.maxBytes ?? MAX_BYTES });
      this.alive(d);
      const r = KbManifestDiffResponseSchema.safeParse(raw);
      if (!r.success) throw new Retry("unexpected manifest-diff response");
      const x = r.data;
      const have = Object.keys(local).length;
      if (have >= 2 && x.deletes.length * 2 > have && !this.takeOverride(d)) {
        const r = this.refusals.get(d);
        this.refusals.set(d, { n: (r?.n ?? 0) + 1, at: Date.now() });
        throw new Refused(`mass-delete guard: the hub's diff would delete ${x.deletes.length} of ${have} local files; refusing (nothing changed)`);
      }
      this.applyFiles(d, x.files, x.deletes.map((e) => e.path));
      if (x.pending.length === 0) {
        this.save(d, { epoch: x.epoch, rev: x.revision, active: this.subscribed.has(d) });
        return;
      }
      if (x.files.length === 0) throw new Retry("manifest-diff made no progress");
    }
    throw new Retry("manifest-diff did not converge");
  }

  /** hash of every synced file on disk in the mirror of `d`. */
  private localManifest(d: string): Record<string, string> {
    const out: Record<string, string> = {};
    const root = this.mirrorPath(d);
    const list = (dir: string) => {
      try {
        return readdirSync(dir, { withFileTypes: true });
      } catch {
        return [];
      }
    };
    const add = (rel: string) => {
      if (!KB_SYNC_PATH.test(rel)) return;
      try {
        const abs = join(root, ...rel.split("/"));
        if (!lstatSync(abs).isFile()) return;
        out[rel] = hashOf(readFileSync(abs, "utf8"));
      } catch {
        /* unreadable: treated as missing, the hub resends it */
      }
    };
    for (const e of list(root)) {
      if (e.isFile()) add(e.name);
      else if (e.isDirectory() && e.name === "entries") for (const f of list(join(root, "entries"))) add(`entries/${f.name}`);
      else if (e.isDirectory() && e.name === "versions") {
        for (const v of list(join(root, "versions"))) if (v.isDirectory()) for (const f of list(join(root, "versions", v.name))) add(`versions/${v.name}/${f.name}`);
      }
    }
    return out;
  }

  /** Verify EVERYTHING first (paths + hashes), then write files, then delete. A bad page changes nothing. */
  private applyFiles(d: string, files: KbSyncFile[], deletes: string[]): void {
    this.alive(d);
    for (const f of files) {
      if (!safeRel(f.path)) throw new Retry(`hub sent a path outside the sync set: ${f.path.slice(0, 80)}`);
      if (hashOf(f.content) !== f.contentHash) throw new Retry(`content hash mismatch for ${f.path}; page rejected`);
    }
    const dels = deletes.filter(safeRel);
    const root = this.mirrorPath(d);
    for (const f of files) this.noSymlinks(root, join(root, ...f.path.split("/")));
    for (const p of dels) this.noSymlinks(root, join(root, ...p.split("/")));
    for (const f of files) this.writeAtomic(join(root, ...f.path.split("/")), f.content);
    for (const p of dels) {
      try {
        rmSync(join(root, ...p.split("/")), { force: true });
      } catch (e) {
        throw new Retry(`cannot delete ${p}: ${(e as Error).message}`);
      }
    }
  }

  /** Refuse when the domain root or any existing parent directory below it is a symlink. */
  private noSymlinks(root: string, file: string): void {
    const parts = [root];
    let cur = root;
    for (const seg of file.slice(root.length + 1).split("/").slice(0, -1)) parts.push((cur = join(cur, seg)));
    for (const dir of parts) {
      const st = lstatSync(dir, { throwIfNoEntry: false });
      if (st?.isSymbolicLink() || (st && !st.isDirectory())) throw new Retry(`refusing to touch ${file.slice(root.length + 1)}: ${dir.slice(root.length) || "domain root"} is a symlink or not a directory`);
    }
  }

  private writeAtomic(file: string, content: string): void {
    const dir = dirname(file);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.${randomBytes(6).toString("hex")}.tmp`);
    try {
      const fd = openSync(tmp, "w", 0o644);
      try {
        writeSync(fd, content);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, file);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw new Retry(`cannot write ${file}: ${(e as Error).message}`);
    }
    try {
      const dfd = openSync(dir, "r");
      try {
        fsyncSync(dfd);
      } finally {
        closeSync(dfd);
      }
    } catch {
      /* directory fsync is best effort (not supported everywhere) */
    }
  }
}
