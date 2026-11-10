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
  /** Bytes consumed: everything up to and including the last newline read. */
  offset: number;
  /** The last bytes before `offset`, to notice a rewrite that kept the file at least as long. */
  tail: Buffer;
  lines: number;
  events: KbEvent[];
}
/**
 * One entry per ledger path, holding every parsed event for the life of the process. Accepted: the ledger is
 * append-only and bounded in practice, and the cache is what makes repeat reads cheap.
 */
const ledgerCache = new Map<string, LedgerCache>();
/** Per-path chain so overlapping calls never parse the same byte range twice. */
const inflight = new Map<string, Promise<unknown>>();
const TAIL_BYTES = 64;
const SLICE_MS = 5;
const yieldToLoop = () => new Promise<void>((r) => setImmediate(r));

/**
 * Same events as readLedger, without blocking the event loop: the file is read asynchronously, only the bytes appended
 * since the last call are parsed (the ledger is append-only), and parsing yields to the loop every few ms. A changed inode,
 * a shorter file or a changed tail means it was rewritten or compacted: full re-read. A rewrite that grows the file and
 * keeps the same inode and the same last 64 bytes before the cached offset is NOT detected. A final line without a newline
 * is used if it parses as JSON, otherwise held until complete. Calls on the same path are serialized.
 * Returns a fresh array the caller may mutate; the events in it are frozen and shared with the cache.
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
    if (c && (c.ino !== st.ino || st.size < c.offset)) c = undefined;
    if (c && c.tail.length > 0) {
      const probe = Buffer.alloc(c.tail.length);
      await fh.read(probe, 0, probe.length, c.offset - c.tail.length);
      if (!probe.equals(c.tail)) c = undefined;
    }
    if (!c) c = { ino: st.ino, offset: 0, tail: Buffer.alloc(0), lines: 0, events: [] };
    const len = st.size - c.offset;
    if (len > 0) {
      const buf = Buffer.alloc(len);
      let got = 0;
      while (got < len) {
        const { bytesRead } = await fh.read(buf, got, len - got, c.offset + got);
        if (bytesRead === 0) break;
        got += bytesRead;
      }
      let end = buf.subarray(0, got).lastIndexOf(0x0a) + 1; // complete lines
      if (end < got) {
        // Unterminated last line: the sync read parses it, so take it when it is valid JSON; a torn one waits.
        try {
          JSON.parse(buf.subarray(end, got).toString("utf-8"));
          end = got;
        } catch {
          /* torn: hold */
        }
      }
      if (end > 0) {
        const text = buf.subarray(0, end).toString("utf-8");
        let sliceStart = performance.now();
        let pos = 0;
        while (pos < text.length) {
          let nl = text.indexOf("\n", pos);
          if (nl < 0) nl = text.length;
          const line = text.slice(pos, nl);
          pos = nl + 1;
          c.lines++;
          if (line.trim()) {
            let json: unknown;
            let ok = true;
            try {
              json = JSON.parse(line);
            } catch (err) {
              ok = false;
              console.warn(`ledger: skipping unparseable line ${c.lines} of ${file}: ${err instanceof Error ? err.message : err}`);
            }
            if (ok) {
              const parsed = KbEventSchema.safeParse(json);
              if (parsed.success) c.events.push(Object.freeze(parsed.data));
            }
          }
          if (performance.now() - sliceStart > SLICE_MS) {
            await yieldToLoop();
            sliceStart = performance.now();
          }
        }
        c.offset += end;
        c.tail = Buffer.from(buf.subarray(Math.max(0, end - TAIL_BYTES), end));
      }
    }
    ledgerCache.set(file, c);
    return c.events.slice();
  } finally {
    await fh.close();
  }
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

