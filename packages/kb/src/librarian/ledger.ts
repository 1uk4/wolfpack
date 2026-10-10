/**
 * Ledger — append-only truth + pure projections.
 *
 * Stored as JSONL at den-local ledger/events.jsonl (never synced). Dewey's
 * entire brain (registry, clusters, aliases, subscriptions) is derived from
 * this log via the fold functions below — mirroring foldLedger in the memory
 * package. Replayable: delete vectors/clusters caches and rebuild from here.
 */
import { existsSync, readFileSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
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
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    const parsed = KbEventSchema.safeParse(JSON.parse(line));
    if (parsed.success) out.push(parsed.data);
  }
  return out;
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

