/**
 * KbSync: pulls each subscribed KB domain from the hub into a MIRROR directory (Syncthing no longer carries the KB, only den backups).
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
import { constants as FS, existsSync, closeSync, fchmodSync, fchownSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeSync, lstatSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { KB_SYNC_PATH, KbChangesResponseSchema, KbManifestDiffResponseSchema, type KbSyncFile } from "@wolfpack/protocol";

const DOMAIN = /^[a-z0-9][a-z0-9-]*$/;
const hashOf = (text: string): string => "sha256:" + createHash("sha256").update(text, "utf-8").digest("hex");
/** A relative KB path with no `.`/`..`/empty segments that matches the sync grammar. */
const safeRel = (p: string): boolean => KB_SYNC_PATH.test(p) && p.split("/").every((x) => x !== "" && x !== "." && x !== "..");
const MAX_BYTES = 2 * 1024 * 1024;

export type KbMirrorLayout = "flat" | "base";

export interface KbSyncOptions {
  hubUrl: string;
  token: string;
  mirrorDir: string;
  /** Where domain folders live: "flat" = `<mirrorDir>/<d>/` (default), "base" = `<mirrorDir>/domains/<d>/` (KB_BASE shape). `.sync/` stays at `<mirrorDir>/.sync/` either way. */
  layout?: KbMirrorLayout;
  /**
   * Opt-in shared read (env WORKERD_KB_MIRROR_GROUP_READ=1): mirror CONTENT files are written 0640 and the directories holding them 0750,
   * whatever the process umask, and chowned to the GROUP of the mirror root (owner may chown to a group it belongs to; no capability).
   * NO setgid bit is ever requested (the unit's RestrictSUIDSGID=yes makes seccomp refuse any chmod that sets S_ISGID), so group
   * inheritance is done explicitly. `.sync/` (state) is never widened, and neither is the mirror root itself (the operator creates it).
   * Failures to chown/chmod are logged (once per start per message) and fail the write, so the mirror is never silently unreadable.
   * Off (default): modes are whatever the umask gives, as before.
   */
  groupRead?: boolean;
  log?: (m: string) => void;
  fetchImpl?: typeof fetch;
  baseMs?: number;
  capMs?: number;
  /** Test hook: random source (0..1) for backoff jitter. */
  rand?: () => number;
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
/** State of one syncOnce run. `allow` covers every round of its manifest diff; `flag` = the flag file existed at the start. */
interface RunCtx {
  allow: boolean;
  flag: boolean;
  reset: boolean;
}
/** The mass-delete guard refused a manifest diff (nothing was changed). */
class Refused extends Retry {}
/** AbortSignal.any needs Node >= 20.3 (no `engines` is declared; sfo-01 runs v22): fall back by hand. */
function anySignal(signals: AbortSignal[]): { signal: AbortSignal; dispose(): void } {
  const any = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (any) return { signal: any.call(AbortSignal, signals), dispose() {} };
  const ac = new AbortController();
  const subs: Array<[AbortSignal, () => void]> = [];
  for (const sg of signals) {
    if (sg.aborted) {
      ac.abort(sg.reason);
      break;
    }
    const fn = () => ac.abort(sg.reason);
    sg.addEventListener("abort", fn, { once: true });
    subs.push([sg, fn]);
  }
  // The listeners on the long-lived signal (stop()'s controller) must not pile up, one per fetch.
  return { signal: ac.signal, dispose: () => subs.forEach(([sg, fn]) => sg.removeEventListener("abort", fn)) };
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
  private readonly warned = new Set<string>();
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
    return this.o.layout === "base" ? join(this.o.mirrorDir, "domains", domain) : join(this.o.mirrorDir, domain);
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
    this.writeAtomic(this.stateFile(d), JSON.stringify({ v: 1, ...s }), false);
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
    this.warned.clear();
    if (this.o.groupRead) this.fixModes();
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
  /** Log a problem once per start (per distinct message). */
  private warnOnce(m: string): void {
    if (this.warned.has(m)) return;
    this.warned.add(m);
    this.log(`WARNING ${m}`);
  }
  /**
   * The group every shared file/dir is given: the mirror root's. In group-read mode the root is NEVER auto-created (the operator makes it
   * workerd:wolfpack-kb 0750): a missing root throws. Warns (once) when the root cannot give Hal read access: its group is workerd's own
   * effective group, or the group bits lack r-x.
   */
  private rootGid(): number {
    let st;
    try {
      st = statSync(this.o.mirrorDir);
    } catch (e) {
      this.warnOnce(`group-read: the mirror root ${this.o.mirrorDir} is missing or unreadable (${(e as Error).message}); create it as <owner>:wolfpack-kb 0750. Not creating it.`);
      throw e;
    }
    if (typeof process.getegid === "function" && st.gid === process.getegid()) this.warnOnce(`group-read: the mirror root ${this.o.mirrorDir} has workerd's own group (gid ${st.gid}), not a shared one; the reader group cannot read it`);
    if ((st.mode & 0o050) !== 0o050) this.warnOnce(`group-read: the mirror root ${this.o.mirrorDir} mode is ${(st.mode & 0o7777).toString(8)}, its group has no r-x; the reader group cannot read it`);
    return st.gid;
  }
  /** lstat that never throws: undefined when missing or unreadable (EACCES/ENOTDIR/...), the latter logged once. */
  private safeLstat(p: string): ReturnType<typeof lstatSync> | undefined {
    try {
      return lstatSync(p);
    } catch (e) {
      const c = (e as NodeJS.ErrnoException).code;
      if (c !== "ENOENT" && c !== "ENOTDIR") this.warnOnce(`group-read: cannot stat ${p}: ${(e as Error).message}`);
      return undefined;
    }
  }
  /** fchown (group only, to the mirror root's gid) + fchmod an open fd. Plain modes, no special bits. */
  private share(fd: number, mode: number, gid: number): void {
    if (fstatSync(fd).gid !== gid) fchownSync(fd, -1, gid);
    fchmodSync(fd, mode);
  }
  /** Share one directory, opened O_NOFOLLOW|O_DIRECTORY so a symlink swapped in after our checks is never followed. */
  private shareDir(dir: string, gid: number): void {
    const fd = openSync(dir, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_DIRECTORY);
    try {
      this.share(fd, 0o750, gid);
    } finally {
      closeSync(fd);
    }
  }
  private shareFileAt(file: string, gid: number): void {
    const fd = openSync(file, FS.O_RDONLY | FS.O_NOFOLLOW);
    try {
      if (!fstatSync(fd).isFile()) return;
      this.share(fd, 0o640, gid);
    } finally {
      closeSync(fd);
    }
  }

  /**
   * groupRead only, at EVERY start: bring existing mirror content to 0640 / 0750 with the root's group. Only the domain folders are walked
   * (`domains/<d>` in base layout, `<d>` in flat) and only entries/, versions/<id>/ and the sync-path files inside; `.sync/` and any other
   * entry under the root are left alone. Domains whose .sync state is active:false (revoked) are LEFT ALONE (not re-shared, not tightened). Symlinks are never followed (O_NOFOLLOW). Failures are logged once per message, never swallowed.
   */
  private fixModes(): void {
    let gid: number;
    try {
      gid = this.rootGid();
    } catch (e) {
      return this.warnOnce(`group-read: cannot read the mirror root ${this.o.mirrorDir}: ${(e as Error).message}`);
    }
    const names = (dir: string): string[] => {
      try {
        return readdirSync(dir);
      } catch {
        return [];
      }
    };
    const tryShare = (p: string, f: () => void) => {
      try {
        f();
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "ELOOP" || (e as NodeJS.ErrnoException).code === "ENOTDIR") return; // gone or a symlink: skipped
        this.warnOnce(`group-read: cannot share ${p}: ${(e as Error).message}`);
      }
    };
    const base = this.o.layout === "base";
    const parent = base ? join(this.o.mirrorDir, "domains") : this.o.mirrorDir;
    if (base) tryShare(parent, () => this.shareDir(parent, gid));
    for (const d of names(parent)) {
      if (!DOMAIN.test(d)) continue;
      const root = join(parent, d);
      if (this.safeLstat(root)?.isDirectory() !== true) continue;
      if (this.load(d)?.active === false) continue; // revoked domain: stale copy, not re-shared
      tryShare(root, () => this.shareDir(root, gid));
      for (const n of names(root)) {
        const p = join(root, n);
        if (n === "entries") {
          tryShare(p, () => this.shareDir(p, gid));
          for (const f of names(p)) if (KB_SYNC_PATH.test(`entries/${f}`)) tryShare(join(p, f), () => this.shareFileAt(join(p, f), gid));
        } else if (n === "versions") {
          tryShare(p, () => this.shareDir(p, gid));
          for (const v of names(p)) {
            const vd = join(p, v);
            if (this.safeLstat(vd)?.isDirectory() !== true) continue;
            tryShare(vd, () => this.shareDir(vd, gid));
            for (const f of names(vd)) if (KB_SYNC_PATH.test(`versions/${v}/${f}`)) tryShare(join(vd, f), () => this.shareFileAt(join(vd, f), gid));
          }
        } else if (KB_SYNC_PATH.test(n)) tryShare(p, () => this.shareFileAt(p, gid));
      }
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
   * Allow the NEXT sync run of `domain` (all rounds of its manifest diff) to delete more than half of the local files (a legitimate big
   * prune on a first sync). Scoped to that one run: it is taken when the run starts and gone when the run ends, used or not.
   * The durable operator route is the flag file `<mirrorDir>/.sync/<domain>.allow-mass-delete`: it is honoured by the next run and
   * deleted only after a manifest diff has been applied and its state saved (a failed diff keeps it).
   */
  allowMassDelete(domain: string): void {
    this.overrides.add(domain);
    if (this.subscribed.has(domain)) this.syncAll();
  }
  private flagFile(d: string): string {
    return join(this.o.mirrorDir, ".sync", `${d}.allow-mass-delete`);
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
    // +-20% jitter so hosts that failed together do not retry together; the cap stays a hard ceiling. Retries never stop (this syncs the mirror).
    const raw = Math.min(cap, base * 2 ** Math.min(n - 1, 16));
    const delay = Math.min(cap, Math.round(raw * (0.8 + 0.4 * (this.o.rand ?? Math.random)())));
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
    const sig = anySignal([this.ac.signal, AbortSignal.timeout(30_000)]);
    try {
      return await this.doCall(method, path, body, sig.signal);
    } finally {
      sig.dispose();
    }
  }
  private async doCall(method: string, path: string, body: unknown, signal: AbortSignal): Promise<unknown> {
    let res: Response;
    try {
      res = await this.f(this.o.hubUrl.replace(/\/+$/, "") + path, {
        method,
        headers: { Authorization: `Bearer ${this.o.token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal,
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
    // Per-run context: the override (memory, flag file) is read once here and lives only for this run.
    const ctx: RunCtx = { allow: this.overrides.delete(d), flag: existsSync(this.flagFile(d)), reset: false };
    ctx.allow ||= ctx.flag;
    const st = this.load(d);
    const saved = !!st && st.rev > 0;
    if (saved && !this.full.has(d)) {
      if (await this.incremental(d, st!, ctx)) return;
    }
    try {
      await this.diffSync(d, ctx);
    } catch (e) {
      // A refused VERIFY diff (saved state, nothing forced it, and no hub reset in this run) is not fatal: the mirror is still consistent
      // with its saved revision, so drop the verify request and carry on incrementally. Without saved state, or after a hub `reset`,
      // the diff is the only way forward, so the refusal stands (retry with backoff) until the operator allows it.
      if (e instanceof Refused && saved && this.full.has(d) && !ctx.reset) {
        this.full.delete(d);
        this.log(`WARNING ${d}: verify diff refused (${e.message}); continuing incrementally. If the prune is legitimate: allowMassDelete("${d}") or create ${this.flagFile(d)}`);
        if (await this.incremental(d, this.load(d)!, ctx)) return;
        await this.diffSync(d, ctx); // the hub reset us meanwhile: the diff is now required and the guard stands
      } else throw e;
    }
    this.full.delete(d);
  }

  /** Follow the change log from the saved revision. True when caught up; false when the hub asked for a manifest diff (ctx.reset set). */
  private async incremental(d: string, from: DomState, ctx: RunCtx): Promise<boolean> {
    const base = `/v1/kb/domains/${d}`;
    let st = from;
    for (;;) {
      const raw = await this.call("GET", `${base}/changes?since=${st.rev}&epoch=${encodeURIComponent(st.epoch)}&maxBytes=${this.o.maxBytes ?? MAX_BYTES}`);
      this.alive(d);
      const r = KbChangesResponseSchema.safeParse(raw);
      if (!r.success) throw new Retry("unexpected changes response");
      const c = r.data;
      if (c.status === "reset") {
        ctx.reset = true;
        this.log(`${d}: ${c.reason}; falling back to manifest diff`);
        return false;
      }
      this.applyFiles(d, c.files, c.deletes.map((x) => x.path));
      st = { epoch: c.epoch, rev: c.revision, active: this.subscribed.has(d) };
      this.save(d, st);
      if (!c.truncated) return true;
    }
  }

  /** Throws Abandon when stopped or unsubscribed. Called after every await and before any write, so nothing lands after stop()/removal. */
  private alive(d: string): void {
    if (this.stopped || !this.subscribed.has(d)) throw new Abandon();
  }

  private async diffSync(d: string, ctx: RunCtx): Promise<void> {
    const base = `/v1/kb/domains/${d}`;
    for (let round = 0; round < 10_000; round++) {
      const local = this.localManifest(d);
      const raw = await this.call("POST", `${base}/manifest-diff`, { files: local, maxBytes: this.o.maxBytes ?? MAX_BYTES });
      this.alive(d);
      const r = KbManifestDiffResponseSchema.safeParse(raw);
      if (!r.success) throw new Retry("unexpected manifest-diff response");
      const x = r.data;
      const have = Object.keys(local).length;
      if (have >= 2 && x.deletes.length * 2 > have && !ctx.allow) {
        const r = this.refusals.get(d);
        this.refusals.set(d, { n: (r?.n ?? 0) + 1, at: Date.now() });
        throw new Refused(`mass-delete guard: the hub's diff would delete ${x.deletes.length} of ${have} local files; refusing (nothing changed). If this is a legitimate prune, create the flag file ${this.flagFile(d)} (or call allowMassDelete) and it will be applied on the next run`);
      }
      this.applyFiles(d, x.files, x.deletes.map((e) => e.path));
      if (x.pending.length === 0) {
        this.save(d, { epoch: x.epoch, rev: x.revision, active: this.subscribed.has(d) });
        if (ctx.flag) rmSync(this.flagFile(d), { force: true }); // consumed only now that the diff is applied and saved
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

  private writeAtomic(file: string, content: string, shared = true): void {
    const dir = dirname(file);
    const gr = !!this.o.groupRead && shared;
    let gid = -1;
    try {
      if (gr) gid = this.rootGid(); // before mkdir: a missing root must not be created implicitly
    } catch (e) {
      throw new Retry(`group-read: ${(e as Error).message}`);
    }
    mkdirSync(dir, { recursive: true });
    try {
      if (gr) {
        // Every directory between the mirror root (exclusive) and the file, parent first. Plain 0750 + the root's group; no setgid.
        let cur = this.o.mirrorDir;
        for (const seg of relative(this.o.mirrorDir, dir).split(sep).filter(Boolean)) {
          if (seg === "..") throw new Error("path escapes the mirror root");
          this.shareDir((cur = join(cur, seg)), gid);
        }
      }
    } catch (e) {
      const m = `group-read: cannot share directories for ${file}: ${(e as Error).message}`;
      this.warnOnce(m);
      throw new Retry(m);
    }
    const tmp = join(dir, `.${randomBytes(6).toString("hex")}.tmp`);
    try {
      const fd = openSync(tmp, "w", 0o644);
      try {
        writeSync(fd, content);
        if (gr) this.share(fd, 0o640, gid);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, file);
    } catch (e) {
      rmSync(tmp, { force: true });
      if (gr) this.warnOnce(`group-read: cannot write/share ${file}: ${(e as Error).message}`);
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
