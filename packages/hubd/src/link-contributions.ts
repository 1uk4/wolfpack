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
 */
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, writeSync } from "node:fs";
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
}

/** Append-only JSONL id set with bounded retention; durable (fsync) on add. */
class IdSet {
  private m = new Map<string, number>();
  private lines = 0;
  constructor(
    private file: string,
    private max: number,
    private maxAgeMs: number,
    private now: () => number,
    private log: (m: string) => void,
  ) {
    mkdirSync(join(file, ".."), { recursive: true });
    try {
      for (const l of readFileSync(file, "utf8").split("\n")) {
        if (!l) continue;
        try {
          const o = JSON.parse(l) as { k?: string; at?: number };
          if (typeof o.k === "string" && typeof o.at === "number") this.m.set(o.k, o.at), this.lines++;
        } catch {
          /* torn last line */
        }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    this.compact();
  }
  has(k: string): boolean {
    return this.m.has(k);
  }
  add(k: string): void {
    if (this.m.has(k)) return;
    const at = this.now();
    const fd = openSync(this.file, "a", 0o600);
    try {
      writeSync(fd, JSON.stringify({ k, at }) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.m.set(k, at);
    this.lines++;
    if (this.lines > this.max * 1.25) this.compact();
  }
  private compact(): void {
    const cutoff = this.now() - this.maxAgeMs;
    let keep = [...this.m].filter(([, at]) => at >= cutoff).sort((a, b) => a[1] - b[1]);
    if (keep.length > this.max) keep = keep.slice(keep.length - this.max);
    if (keep.length === this.m.size && this.lines === this.m.size) return;
    try {
      const tmp = `${this.file}.tmp`;
      const fd = openSync(tmp, "w", 0o600);
      try {
        writeSync(fd, keep.map(([k, at]) => JSON.stringify({ k, at })).join("\n") + (keep.length ? "\n" : ""));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, this.file);
      this.m = new Map(keep);
      this.lines = keep.length;
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
  // Receipts older than the first start of this feature are history (Syncthing delivered them); only newer ones are sent.
  const sinceFile = join(dir, "receipts-since");
  let since: number;
  try {
    since = Number(readFileSync(sinceFile, "utf8"));
    if (!Number.isFinite(since)) throw new Error("bad");
  } catch {
    since = now();
    writeFileSync(sinceFile, String(since));
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
    try {
      const stored = storeContribution(o.dataDir, { id: f.wolf, kind: "wolf" }, { text, json: f.contribution }, o.inboxRoot);
      seen.add(key); // durable before the ack
      return { t: "contribute.ack", id: f.id, status: stored.duplicate ? "duplicate" : "accepted" };
    } catch (e) {
      if (e instanceof ContributionError) return reject(f.id, "invalid", e.message);
      log(`hubd: link ${hostId}: storing contribution ${q(f.id)} failed: ${(e as Error).message}`);
      return reject(f.id, "internal", "could not store the contribution; retry later"); // terminal for the worker: it keeps a dead-letter copy
    }
  }

  const cache = new Map<string, { mtimeMs: number; size: number; id: string; content: string }>();
  function scanReceipts(): void {
    let wolves: string[];
    try {
      wolves = readdirSync(o.receiptsRoot, { withFileTypes: true }).filter((d) => d.isDirectory() && !/^[._]/.test(d.name)).map((d) => d.name);
    } catch {
      return; // no lane yet
    }
    const t = now();
    for (const wolf of wolves) {
      const host = o.hostOf(wolf);
      if (!host) continue;
      let files: string[];
      try {
        files = readdirSync(join(o.receiptsRoot, wolf)).filter((n) => n.endsWith(".md") && !n.startsWith("."));
      } catch {
        continue;
      }
      for (const name of files) {
        const path = join(o.receiptsRoot, wolf, name);
        try {
          const st = statSync(path);
          if (!st.isFile() || st.mtimeMs < since) continue;
          if (st.size > LINK_RECEIPT_MAX_BYTES) continue;
          let c = cache.get(path);
          if (!c || c.mtimeMs !== st.mtimeMs || c.size !== st.size) {
            const content = readFileSync(path, "utf8");
            c = { mtimeMs: st.mtimeMs, size: st.size, id: receiptId(wolf, name, content), content };
            cache.set(path, c);
          }
          if (delivered.has(c.id)) {
            cache.delete(path); // free the content; the id set remembers
            continue;
          }
          const fl = inflight.get(c.id);
          if (fl && fl.host === host && t - fl.at < ackTimeout) continue;
          const frame: LinkReceipt = { t: "receipt", id: c.id, wolf, name, content: c.content };
          if (o.send(host, frame)) inflight.set(c.id, { host, at: t });
        } catch (e) {
          log(`hubd: receipt ${q(wolf)}/${q(name)} not delivered: ${(e as Error).message}`);
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
