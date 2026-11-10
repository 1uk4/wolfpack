/**
 * Ledger — append-only truth + pure projections.
 *
 * Stored as JSONL at den-local ledger/events.jsonl (never synced). Dewey's
 * entire brain (registry, clusters, aliases, subscriptions) is derived from
 * this log via the fold functions below — mirroring foldLedger in the memory
 * package. Replayable: delete vectors/clusters caches and rebuild from here.
 */
import { existsSync, readFileSync, mkdirSync, appendFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import {
  KbEventSchema,
  type KbEvent,
  type KbRoots,
  type Registry,
  type RegistryTopic,
  ledgerFile,
  now,
} from "../shared/index.js";

// ── persistence ──────────────────────────────────────────────────────────────

export function readLedger(roots: KbRoots): KbEvent[] {
  const file = ledgerFile(roots);
  if (!existsSync(file)) return [];
  const out: KbEvent[] = [];
  const lines = readFileSync(file, "utf-8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch (err) {
      // A torn or garbage line (crash mid-append, bad merge) must not break
      // every sweep, reorg and status call.
      console.warn(`ledger: skipping unparseable line ${i + 1} of ${file}: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    const parsed = KbEventSchema.safeParse(json);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

interface LedgerCache {
  ino: number;
  mtimeMs: number;
  /** Bytes consumed: everything up to and including the last newline read. */
  offset: number;
  /** The last bytes before `offset`, to notice a rewrite that kept the file at least as long. */
  tail: Buffer;
  lines: number;
  events: KbEvent[];
}
/**
 * Module-level: lives for the life of the process, one entry per ledger path, holding every parsed event. Accepted: the ledger is
 * append-only and bounded in practice, and the cache is what makes repeat reads cheap.
 */
const ledgerCache = new Map<string, LedgerCache>();
/** Per-path chain so overlapping calls never parse the same byte range twice. */
const inflight = new Map<string, Promise<unknown>>();
const TAIL_BYTES = 64;
const SLICE_MS = 5;
/** First-read slice size: bounds the synchronous alloc + decode between yields. */
const READ_CHUNK = 256 * 1024;
const yieldToLoop = () => new Promise<void>((r) => setImmediate(r));

/**
 * Same events as readLedger, without blocking the event loop: the file is read asynchronously, only the bytes appended
 * since the last call are parsed (the ledger is append-only), and parsing yields to the loop every few ms. A changed inode,
 * a shorter file or a changed tail means it was rewritten or compacted: full re-read. A rewrite that grows the file and
 * keeps the same inode and the same last 64 bytes before the cached offset is NOT detected. A final line without a newline
 * is used if it parses as JSON, otherwise held until complete. Calls on the same path are serialized.
 * Returns the cache's own array, frozen (copy it before mutating, as sweep.ts does); the events in it are frozen too.
 */
export function readLedgerAsync(roots: KbRoots): Promise<KbEvent[]> {
  const file = ledgerFile(roots);
  const prev = inflight.get(file) ?? Promise.resolve();
  const run = prev.then(() => readLedgerOnce(file));
  const settled = run.catch(() => undefined);
  inflight.set(file, settled);
  void settled.then(() => {
    if (inflight.get(file) === settled) inflight.delete(file);
  });
  return run;
}

async function readLedgerOnce(file: string): Promise<KbEvent[]> {
  let fh;
  try {
    fh = await open(file, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      ledgerCache.delete(file);
      return [];
    }
    throw err;
  }
  try {
    const st = await fh.stat(); // same file as the bytes read below
    let c = ledgerCache.get(file);
    // Cross-process fallback for rewrites: new inode, shorter file, or an mtime older than the cached one.
    if (c && (c.ino !== st.ino || st.size < c.offset || st.mtimeMs < c.mtimeMs)) c = undefined;
    if (c && c.tail.length > 0) {
      const probe = Buffer.alloc(c.tail.length);
      await fh.read(probe, 0, probe.length, c.offset - c.tail.length);
      if (!probe.equals(c.tail)) c = undefined;
    }
    const baseOffset = c?.offset ?? 0;
    let lines = c?.lines ?? 0;
    let tail = c?.tail ?? Buffer.alloc(0);
    // Everything is parsed into locals and published to the cache in one assignment at the end, so a throw or
    // an overlapping reader never sees a half-updated entry.
    const fresh: KbEvent[] = [];
    let consumed = 0; // bytes from baseOffset that are parsed
    let carry: Buffer = Buffer.alloc(0); // bytes read past `consumed`, not yet ended by a newline
    let readPos = baseOffset;
    let sliceStart = performance.now();

    const parseLine = (raw: Buffer) => {
      lines++;
      const line = raw.toString("utf-8");
      if (!line.trim()) return;
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch (err) {
        console.warn(`ledger: skipping unparseable line ${lines} of ${file}: ${err instanceof Error ? err.message : err}`);
        return;
      }
      const parsed = KbEventSchema.safeParse(json);
      if (parsed.success) fresh.push(Object.freeze(parsed.data));
    };

    while (readPos < st.size) {
      const chunk = Buffer.alloc(Math.min(READ_CHUNK, st.size - readPos));
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, readPos);
      if (bytesRead === 0) break;
      readPos += bytesRead;
      const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      const end = data.lastIndexOf(0x0a) + 1; // complete lines in this slice
      let pos = 0;
      while (pos < end) {
        const nl = data.indexOf(0x0a, pos);
        parseLine(data.subarray(pos, nl));
        pos = nl + 1;
        if (performance.now() - sliceStart > SLICE_MS) {
          await yieldToLoop();
          sliceStart = performance.now();
        }
      }
      consumed += end;
      carry = Buffer.from(data.subarray(end));
      if (end > 0) tail = Buffer.from(data.subarray(Math.max(0, end - TAIL_BYTES), end));
      // the next fh.read is itself a real yield to the loop, so no extra setImmediate here
    }
    if (carry.length > 0) {
      // Unterminated last line: the sync read parses it, so take it when it is valid JSON; a torn one waits.
      let whole = false;
      try {
        JSON.parse(carry.toString("utf-8"));
        whole = true;
      } catch {
        /* torn: hold */
      }
      if (whole) {
        parseLine(carry);
        consumed += carry.length;
        tail = Buffer.from(carry.subarray(Math.max(0, carry.length - TAIL_BYTES)));
      }
    }
    const next: LedgerCache = {
      ino: st.ino,
      mtimeMs: st.mtimeMs,
      offset: baseOffset + consumed,
      tail,
      lines,
      events: c ? (fresh.length === 0 ? c.events : c.events.concat(fresh)) : fresh,
    };
    ledgerCache.set(file, next);
    return Object.freeze(next.events) as KbEvent[]; // shared with the cache: sweep.ts copies before it appends
  } finally {
    await fh.close();
  }
}

/**
 * Drop the cached events for this ledger so the next read parses the file from byte 0. Call it after anything that
 * rewrites the ledger in place. The one such writer is the kb-commits rollback (packages/hubd/src/kb-commits.ts,
 * rollbackLedger, `truncateSync(file, j.ledgerOffset)`, about line 302): it keeps the inode, and a later append can grow
 * the file past the cached offset with different bytes, which the size/mtime/tail probe catches only probabilistically.
 * It runs in the hubd process, so invalidating here is exact. Appends (appendLedger, appendFileSync, line 182) never
 * change the inode and need nothing; writeDurable (tmp + rename, kb-commits.ts:217) gives a new inode, caught by the inode check.
 */
export function invalidateLedgerCache(roots: KbRoots): void {
  ledgerCache.delete(ledgerFile(roots));
}

export function appendLedger(roots: KbRoots, events: KbEvent[]): void {
  if (events.length === 0) return;
  // Validate all before writing any: readLedger skips bad lines silently, so a
  // bad write would otherwise vanish from every projection.
  const valid = events.map((e) => {
    const r = KbEventSchema.safeParse(e);
    if (!r.success) {
      const issues = r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new Error(`Invalid ${(e as { t?: string }).t ?? "?"} ledger event — ${issues}`);
    }
    return r.data;
  });
  const file = ledgerFile(roots);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, valid.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

// ── projections (pure) ─────────────────────────────────────────────────────

/** Every content hash ever ingested — idempotency guard. */
export function seenHashes(events: KbEvent[]): Set<string> {
  const s = new Set<string>();
  for (const e of events) if (e.t === "contribution") s.add(e.hash);
  return s;
}

/** The registry: canonical topics ↔ entries ↔ aliases ↔ subscribers. */
export function foldRegistry(events: KbEvent[]): Registry {
  const reg: Registry = new Map();
  const ensure = (canonicalId: string): RegistryTopic => {
    let t = reg.get(canonicalId);
    if (!t) {
      t = {
        canonicalId,
        domain: "",
        subcategory: "",
        crystallized: false,
        entries: [],
        aliases: [],
        subscribers: [],
        updated: now(),
      };
      reg.set(canonicalId, t);
    }
    return t;
  };

  for (const e of events) {
    switch (e.t) {
      case "entry_written": {
        const t = ensure(e.canonicalId);
        if (!t.entries.includes(e.entryId)) t.entries.push(e.entryId);
        t.updated = e.at;
        break;
      }
      case "aliased": {
        // A den topic resolves to ONE topic: the one holding its latest aliased
        // event. Re-pointing removes the alias from every older topic.
        for (const other of reg.values()) {
          if (other.canonicalId === e.canonicalId) continue;
          other.aliases = other.aliases.filter((a) => !(a.wolf === e.wolf && a.denTopicId === e.denTopicId));
        }
        const t = ensure(e.canonicalId);
        const existing = t.aliases.find(
          (a) => a.wolf === e.wolf && a.denTopicId === e.denTopicId
        );
        if (existing) {
          existing.lastHash = e.hash;
          existing.lastSeen = e.at;
        } else {
          t.aliases.push({
            wolf: e.wolf,
            denTopicId: e.denTopicId,
            lastHash: e.hash,
            lastSeen: e.at,
          });
        }
        // Contributing implies implicit subscription.
        if (!t.subscribers.includes(e.wolf)) t.subscribers.push(e.wolf);
        break;
      }
      case "crystallized": {
        const t = ensure(e.canonicalId);
        t.domain = e.domain;
        t.subcategory = e.subcategory;
        t.crystallized = true;
        t.updated = e.at;
        break;
      }
      case "subscribed": {
        const t = ensure(e.canonicalId);
        if (!t.subscribers.includes(e.wolf)) t.subscribers.push(e.wolf);
        break;
      }
      case "entry_retired": {
        for (const [id, t] of reg) {
          if (!t.entries.includes(e.entryId)) continue;
          t.entries = t.entries.filter((x) => x !== e.entryId);
          t.updated = e.at;
          // Nothing left to know: drop the topic and its aliases, so a later
          // re-contribution starts a fresh topic instead of an empty one.
          if (t.entries.length === 0) reg.delete(id);
        }
        break;
      }
    }
  }
  return reg;
}

