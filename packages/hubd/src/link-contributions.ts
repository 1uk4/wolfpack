/**
 * Contributions and receipts over the worker link.
 *
 * IN:  `contribute` frames. The wolf must be owned by the sending host (registry; retired wolves are refused). The item is stored in
 *      the librarian's inbox (`inboxRoot/<wolf>/<denTopicId>-<hash10>.md`, the same file the wolf-side emitter writes and Dewey's
 *      intake reads) - never straight into the KB. Idempotency: the (hostId, id) pair is kept in a persisted, bounded seen-set
 *      (`<dataDir>/link/contribution-ids.jsonl`, fsynced BEFORE the ack), so a replay after a reconnect or a hub restart is acked as
 *      `duplicate` without touching the inbox. (storeContribution is itself idempotent on topic+hash as a second line of defence.)
 * OUT: receipts. The librarian writes `receiptsRoot/<wolf>/<file>.md`; the hub polls that lane, and for every receipt newer than the
 *      hub's first start whose owning host has a live link it sends a `receipt` frame, resending until `receipt.ack`. The delivered
 *      set is persisted (`receipts-delivered.jsonl`). A host that is offline simply keeps its receipts queued in the lane; they flush
 *      when it comes online.
 *      Scan cost: a persisted high-water mark (`receipts-since`, an mtime) only moves forward, once every receipt older than it has
 *      been delivered (or skipped as oversize). Files and lane directories older than the mark are never re-read, so expiry of the
 *      delivered-id set cannot re-send old receipts. CAVEAT: the cut is by file mtime. A receipt that appears with an mtime older than
 *      the mark (a restore/copy that preserves mtimes, or a badly skewed clock on the librarian host) is never sent.
 *
 * Ack codes: `foreign_wolf`, `invalid`, `too_large` are terminal (the worker dead-letters; foreign_wolf only after a few retries, as
 * ownership can lag a registry change). `internal` is NOT terminal: the item stays in the worker's outbox and is retried with backoff.
 */
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import {
  LINK_CONTRIBUTION_MAX_BYTES,
  LINK_RECEIPT_MAX_BYTES,
  type LinkContribute,
  type LinkContributeAck,
  type LinkFrame,
  type LinkReceipt,
} from "@wolfpack/protocol";
import { ContributionError, storeContribution } from "./contributions.js";

const SETTLE_MS = 2000;

export interface LinkContributionsOptions {
  dataDir: string;
  /** Librarian inbox root (`<root>/<wolf>/`). */
  inboxRoot: string;
  /** Librarian receipts root (`<root>/<wolf>/*.md`). */
  receiptsRoot: string;
  /** The host that owns this wolf, or undefined (unknown / retired / unowned). */
  hostOf: (wolf: string) => string | undefined;
  /** Send a frame to a host's live link; false when it has none. */
  send: (hostId: string, frame: LinkFrame) => boolean;
  log?: (m: string) => void;
  maxItemBytes?: number;
  /** Persisted id sets keep at most this many entries / this long. Defaults 100000 / 30 days. */
  seenMax?: number;
  seenMaxAgeMs?: number;
  /** Receipts lane poll, ms. Default 3000; 0 disables the timer (call scanReceipts). */
  receiptPollMs?: number;
  /** Resend an unacked receipt after this long, ms. Default 10000. */
  receiptAckTimeoutMs?: number;
  now?: () => number;
  /** @internal TEST-ONLY failure injection. */
  faults?: { beforeSeenAdd?: () => void };
}

function syncDir(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* some platforms cannot fsync a directory */
  }
}

/** Atomic durable replace: temp, fsync, rename, fsync dir. */
function writeDurable(file: string, data: string): void {
  const tmp = `${file}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
  syncDir(join(file, ".."));
}

/** Append-only JSONL id set with bounded retention; durable (fsync) on add. Survives a torn last line. */
export class IdSet {
  private m = new Map<string, number>();
  private lines = 0;
  /** The file does not end in a newline (a torn write): the next append must start a new line. */
  private needNewline = false;
  constructor(
    private file: string,
    private max: number,
    private maxAgeMs: number,
    private now: () => number,
    private log: (m: string) => void,
  ) {
    mkdirSync(join(file, ".."), { recursive: true });
    let dirty = false;
    try {
      const text = readFileSync(file, "utf8");
      if (text.length && !text.endsWith("\n")) dirty = this.needNewline = true;
      for (const l of text.split("\n")) {
        if (!l) continue;
        try {
          const o = JSON.parse(l) as { k?: string; at?: number };
          if (typeof o.k === "string" && typeof o.at === "number") this.m.set(o.k, o.at), this.lines++;
          else dirty = true;
        } catch {
          dirty = true; // torn or garbage line: drop it by rewriting the file
        }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    this.compact(dirty);
  }
  has(k: string): boolean {
    return this.m.has(k);
  }
  get size(): number {
    return this.m.size;
  }
  add(k: string): void {
    if (this.m.has(k)) return;
    const at = this.now();
    const fd = openSync(this.file, "a", 0o600);
    try {
      writeSync(fd, (this.needNewline ? "\n" : "") + JSON.stringify({ k, at }) + "\n");
      fsyncSync(fd);
      this.needNewline = false;
    } finally {
      closeSync(fd);
    }
    this.m.set(k, at);
    this.lines++;
    if (this.lines > this.max * 1.25) this.compact(false);
  }
  private compact(force: boolean): void {
    const cutoff = this.now() - this.maxAgeMs;
    let keep = [...this.m].filter(([, at]) => at >= cutoff).sort((a, b) => a[1] - b[1]);
    if (keep.length > this.max) keep = keep.slice(keep.length - this.max);
    if (!force && keep.length === this.m.size && this.lines === this.m.size) return;
    try {
      writeDurable(this.file, keep.map(([k, at]) => JSON.stringify({ k, at })).join("\n") + (keep.length ? "\n" : ""));
      this.m = new Map(keep);
      this.lines = keep.length;
      this.needNewline = false;
    } catch (e) {
      this.log(`hubd: could not compact ${this.file}: ${(e as Error).message}`);
    }
  }
}

export interface LinkContributions {
  onContribute(hostId: string, f: LinkContribute): LinkContributeAck;
  onReceiptAck(hostId: string, id: string): void;
  /** A host's link came up: resend everything it has not acknowledged. */
  onHostOnline(hostId: string): void;
  scanReceipts(): void;
  stop(): void;
}

export const receiptId = (wolf: string, name: string, content: string): string => createHash("sha256").update(`${wolf}\0${name}\0${content}`).digest("hex").slice(0, 32);

export function createLinkContributions(o: LinkContributionsOptions): LinkContributions {
  const log = o.log ?? ((m: string) => console.log(m));
  const now = o.now ?? Date.now;
  const maxItem = o.maxItemBytes ?? LINK_CONTRIBUTION_MAX_BYTES;
  const max = o.seenMax ?? 100_000;
  const age = o.seenMaxAgeMs ?? 30 * 24 * 3600_000;
  const dir = join(o.dataDir, "link");
  mkdirSync(dir, { recursive: true });
  const seen = new IdSet(join(dir, "contribution-ids.jsonl"), max, age, now, log);
  const delivered = new IdSet(join(dir, "receipts-delivered.jsonl"), max, age, now, log);
  // High-water mark (mtime ms): receipts older than this are history and are never read again. First start = now (the previous transport already
  // delivered everything before the hub took over). It only moves forward (see scanReceipts).
  const sinceFile = join(dir, "receipts-since");
  let since: number;
  try {
    since = Number(readFileSync(sinceFile, "utf8"));
    if (!Number.isFinite(since)) throw new Error("bad");
  } catch {
    since = now();
    writeDurable(sinceFile, String(since));
  }
  const inflight = new Map<string, { host: string; at: number }>();
  const ackTimeout = o.receiptAckTimeoutMs ?? 10_000;
  const q = (v: unknown) => JSON.stringify(String(v).slice(0, 64));

  const reject = (id: string, code: NonNullable<LinkContributeAck["code"]>, message: string): LinkContributeAck => ({ t: "contribute.ack", id, status: "rejected", code, message });

  function onContribute(hostId: string, f: LinkContribute): LinkContributeAck {
    const owner = o.hostOf(f.wolf);
    if (owner !== hostId) {
      log(`hubd: link ${hostId}: contribution ${q(f.id)} for wolf ${q(f.wolf)} refused (not owned by this host)`);
      return reject(f.id, "foreign_wolf", `wolf ${q(f.wolf)} is not owned by host ${hostId}`);
    }
    const key = `${hostId}\t${f.id}`;
    if (seen.has(key)) return { t: "contribute.ack", id: f.id, status: "duplicate" };
    const text = JSON.stringify(f.contribution);
    const bytes = Buffer.byteLength(text);
    if (bytes > maxItem) return reject(f.id, "too_large", `contribution is ${bytes} bytes; the limit is ${maxItem}`);
    // The actor is the frame's wolf (already checked against the host), and storeContribution requires contribution.from === that wolf.
    let stored;
    try {
      stored = storeContribution(o.dataDir, { id: f.wolf, kind: "wolf" }, { text, json: f.contribution }, o.inboxRoot);
    } catch (e) {
      if (e instanceof ContributionError) return reject(f.id, "invalid", e.message);
      log(`hubd: link ${hostId}: storing contribution ${q(f.id)} failed: ${(e as Error).message}`);
      return reject(f.id, "internal", "could not store the contribution; retry later"); // NOT terminal: the worker keeps it and retries
    }
    try {
      o.faults?.beforeSeenAdd?.();
      seen.add(key); // durable before the ack
    } catch (e) {
      // Stored but not recorded: answer internal so the worker retries. The retry finds the inbox file (storeContribution dedups on
      // topic+hash) and records the id then, so the inbox ends up with exactly one file.
      log(`hubd: link ${hostId}: could not record contribution id ${q(f.id)}: ${(e as Error).message}`);
      return reject(f.id, "internal", "stored, but could not record the id; retry later");
    }
    return { t: "contribute.ack", id: f.id, status: stored.duplicate ? "duplicate" : "accepted" };
  }

  const cache = new Map<string, { mtimeMs: number; size: number; id: string; content: string }>();
  const cleanDir = new Map<string, number>(); // wolf -> lane dir mtime at the last scan that left nothing pending
  const oversizeLogged = new Set<string>();
  function scanReceipts(): void {
    let wolves: string[];
    try {
      wolves = readdirSync(o.receiptsRoot, { withFileTypes: true }).filter((d) => d.isDirectory() && !/^[._]/.test(d.name)).map((d) => d.name);
    } catch {
      return; // no lane yet
    }
    const t = now();
    let minPending = Infinity;
    let maxHandled = since;
    let blockAdvance = false;
    for (const wolf of wolves) {
      const host = o.hostOf(wolf);
      if (!host) continue; // retired or unknown wolf: nothing can be delivered, so it must not pin the mark either
      const laneDir = join(o.receiptsRoot, wolf);
      let dirM: number;
      let files: string[];
      try {
        dirM = statSync(laneDir).mtimeMs;
        if (dirM <= since || cleanDir.get(wolf) === dirM) continue; // nothing new here since the last look (receipts land by rename, which bumps the dir)
        files = readdirSync(laneDir).filter((n) => n.endsWith(".md") && !n.startsWith("."));
      } catch {
        blockAdvance = true;
        continue;
      }
      const present = new Set(files.map((n) => join(laneDir, n)));
      for (const k of [...cache.keys()]) if (k.startsWith(laneDir + "/") && !present.has(k)) cache.delete(k); // deleted files
      let pending = false;
      for (const name of files) {
        const path = join(laneDir, name);
        let mtime = since;
        try {
          const st = statSync(path);
          mtime = st.mtimeMs;
          if (!st.isFile() || st.mtimeMs <= since) continue; // the mark is exclusive
          if (st.size > LINK_RECEIPT_MAX_BYTES) {
            if (!oversizeLogged.has(path)) {
              oversizeLogged.add(path);
              log(`hubd: receipt ${q(wolf)}/${q(name)} is ${st.size} bytes (limit ${LINK_RECEIPT_MAX_BYTES}); not sent over the link`);
            }
            maxHandled = Math.max(maxHandled, mtime);
            continue;
          }
          let c = cache.get(path);
          if (!c || c.mtimeMs !== st.mtimeMs || c.size !== st.size) {
            const content = readFileSync(path, "utf8");
            c = { mtimeMs: st.mtimeMs, size: st.size, id: receiptId(wolf, name, content), content };
            cache.set(path, c);
          }
          if (delivered.has(c.id)) {
            cache.delete(path); // free the content; the id set remembers
            maxHandled = Math.max(maxHandled, mtime);
            continue;
          }
          pending = true;
          minPending = Math.min(minPending, mtime);
          const fl = inflight.get(c.id);
          if (fl && fl.host === host && t - fl.at < ackTimeout) continue;
          const frame: LinkReceipt = { t: "receipt", id: c.id, wolf, name, content: c.content };
          if (o.send(host, frame)) inflight.set(c.id, { host, at: t });
        } catch (e) {
          pending = true;
          minPending = Math.min(minPending, mtime);
          log(`hubd: receipt ${q(wolf)}/${q(name)} not delivered: ${(e as Error).message}`);
        }
      }
      // Dewey writes receipts by temp file + rename (engine atomicWrite), which bumps the lane dir mtime, so the dir-mtime skip is sound.
      // Still, never trust a lane as clean while its dir mtime is within the settle window (same-tick writes).
      if (pending || t - dirM < SETTLE_MS) cleanDir.delete(wolf);
      else cleanDir.set(wolf, dirM);
    }
    if (!blockAdvance) {
      // Exclusive mark. Never past the oldest pending receipt, never ahead of now (a future mtime = clock skew must not push it),
      // and never within SETTLE_MS of now (a receipt written in the same mtime tick as this scan must not be skipped).
      const handled = Math.min(maxHandled, t);
      const next = Math.min(Number.isFinite(minPending) ? minPending - 1 : handled, handled, t - SETTLE_MS);
      if (next > since) {
        try {
          writeDurable(sinceFile, String(next));
          since = next;
        } catch (e) {
          log(`hubd: could not persist the receipts high-water mark: ${(e as Error).message}`);
        }
      }
    }
  }

  const poll = o.receiptPollMs ?? 3000;
  const timer = poll > 0 ? setInterval(scanReceipts, poll) : undefined;
  timer?.unref();

  return {
    onContribute,
    onReceiptAck(hostId, id) {
      const fl = inflight.get(id);
      if (!fl || fl.host !== hostId) return;
      inflight.delete(id);
      try {
        delivered.add(id);
      } catch (e) {
        log(`hubd: could not persist receipt delivery: ${(e as Error).message}`);
      }
    },
    onHostOnline(hostId) {
      for (const [id, fl] of [...inflight]) if (fl.host === hostId) inflight.delete(id);
      scanReceipts();
    },
    scanReceipts,
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}
