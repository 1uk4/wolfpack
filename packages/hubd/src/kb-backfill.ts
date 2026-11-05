/**
 * `hubd kb-backfill --receipts <dir> --inbox <dir> [--dewey-ledger <file>] --data-dir <dir> [--tz <IANA>] [--dry-run]`
 *
 * One-off, idempotent: fills the hub KB ledger (`<dataDir>/ledger/events.jsonl`) with Dewey's past curation decisions so /kb-activity
 * shows history. Sources are only read.
 *
 *  - receipts `<receipts>/<wolf>/<topic>-<hash10>.md` (frontmatter from, den_topic_id, outcome create|merge|parked, processed; body = entry id)
 *    joined by `<wolf>/<file>` to `<inbox>/<wolf>/_processed/<file>` (frontmatter content_hash, prev_hash, domain_hint, submitted?).
 *  - `_processed` files WITHOUT a receipt (kb-repair): joined by hash to Dewey's `aliased` events (needs --dewey-ledger); else skipped.
 *  - `_bad`, reorg events: not read.
 *
 * Per item, in this order (the order sweep.ts writes: entry first, then the batch with its decision): `contribution` (at `submitted`, else
 * `processed`), `entry_written` (create/merge only), `decision`. All at the processed time except the contribution. Items are appended in
 * ascending time order.
 * Ids are deterministic (`bf-` + sha256 of kind and source key), so a re-run appends nothing: events whose id is already in the ledger are dropped.
 * The schema has no "backfilled" field; the `bf-` id prefix is the marker. Written with kb `appendLedger` under the KB writer lock.
 * ORDER: the reader's "latest decision" and write attribution use ledger FILE order, the sort by `at` is only for display. Backfill into a
 * ledger that has newer events appends old-dated events after them; harmless for distinct keys, but a backfilled decision would count as
 * "latest" for a key that already had a newer one. Intended for an empty/missing ledger.
 * Timestamps: Dewey's "YYYY-MM-DD HH:MM" values are local time in --tz (default UTC, verified on sfo-01) -> ISO UTC.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appendLedger, scanEntryDomains, withKbLock } from "@wolfpack/kb/librarian";
import { ledgerFile, type KbEvent } from "@wolfpack/kb/shared";
import { hubRoots } from "./layout.js";

export const DEFAULT_BACKFILL_TZ = "UTC";

export interface BackfillOptions {
  receipts: string;
  inbox: string;
  deweyLedger?: string;
  dataDir: string;
  tz?: string;
  dryRun?: boolean;
}
export interface BackfillReport {
  dryRun: boolean;
  tz: string;
  items: number;
  eventsBuilt: number;
  eventsAppended: number;
  alreadyPresent: number;
  perWolf: Record<string, number>;
  perDomain: Record<string, number>;
  perOutcome: Record<string, number>;
  earliest?: string;
  latest?: string;
  /** Entry ids no longer in the hub KB (still emitted). */
  missingEntries: number;
  skipped: Array<{ key: string; reason: string }>;
  samples: KbEvent[];
}

/** Flat `key: value` frontmatter + body. Values may be quoted. */
export function parseSimple(text: string): { fields: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { fields: {}, body: text.trim() };
  const fields: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const k = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!k) continue;
    let v = k[2]!.trim();
    if (/^(".*"|'.*')$/.test(v)) v = v.slice(1, -1);
    fields[k[1]!] = v;
  }
  return { fields, body: m[2]!.trim() };
}

/** "YYYY-MM-DD HH:MM[:SS]" (or ISO with a zone) read as wall-clock time in `tz` -> ISO UTC. undefined if unparseable. */
export function toIsoUtc(s: string | undefined, tz: string): string | undefined {
  if (!s) return undefined;
  if (/[zZ]$|[+-]\d\d:?\d\d$/.test(s) && s.includes("T")) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
  }
  const m = /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d)(?::(\d\d))?$/.exec(s.trim());
  if (!m) return undefined;
  const wall = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0));
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
  const offsetAt = (utc: number): number => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(utc)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - utc;
  };
  let utc = wall - offsetAt(wall);
  utc = wall - offsetAt(utc);
  return new Date(utc).toISOString();
}

const evId = (kind: string, key: string): string => `bf-${createHash("sha256").update(`${kind}\0${key}`).digest("hex").slice(0, 16)}`;
const bare = (h: string): string => h.replace(/^sha256:/, "");
const dirs = (d: string): string[] => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name).sort() : []);
const mdFiles = (d: string): string[] => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".md") && !e.name.startsWith(".")).map((e) => e.name).sort() : []);
const bump = (r: Record<string, number>, k: string) => void (r[k] = (r[k] ?? 0) + 1);

interface Item {
  key: string;
  at: string;
  submitted: string;
  from: string;
  denTopicId: string;
  hash: string;
  prevHash: string | null;
  domainHint: string;
  outcome: "create" | "merge" | "parked";
  entryId?: string;
  canonicalId?: string;
}

export async function kbBackfill(opts: BackfillOptions): Promise<BackfillReport> {
  const tz = opts.tz ?? DEFAULT_BACKFILL_TZ;
  new Intl.DateTimeFormat("en-US", { timeZone: tz }); // throws RangeError on a bad zone
  const roots = hubRoots(opts.dataDir);
  const rep: BackfillReport = { dryRun: !!opts.dryRun, tz, items: 0, eventsBuilt: 0, eventsAppended: 0, alreadyPresent: 0, perWolf: {}, perDomain: {}, perOutcome: {}, missingEntries: 0, skipped: [], samples: [] };
  const skip = (key: string, reason: string) => rep.skipped.push({ key, reason });

  // Dewey's ledger: aliased by hash (kb-repair join), entry_written by entry id / canonical id.
  const aliasByHash = new Map<string, { canonicalId: string; at: string; denTopicId: string; wolf: string }>();
  const canonOfEntry = new Map<string, string>();
  const writesOfCanon = new Map<string, Array<{ entryId: string; at: string; action: string }>>();
  if (opts.deweyLedger) {
    for (const line of readFileSync(opts.deweyLedger, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      let e: Record<string, string>;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.t === "aliased" && e.hash) aliasByHash.set(bare(e.hash), { canonicalId: e.canonicalId!, at: e.at!, denTopicId: e.denTopicId!, wolf: e.wolf! });
      else if (e.t === "entry_written" && e.entryId && e.canonicalId) {
        canonOfEntry.set(e.entryId, e.canonicalId);
        const l = writesOfCanon.get(e.canonicalId) ?? [];
        l.push({ entryId: e.entryId, at: e.at!, action: e.action! });
        writesOfCanon.set(e.canonicalId, l);
      }
    }
  }

  const items: Item[] = [];
  const receiptKeys = new Set<string>();
  for (const wolf of dirs(opts.receipts)) {
    for (const f of mdFiles(join(opts.receipts, wolf))) {
      const key = `${wolf}/${f}`;
      receiptKeys.add(key);
      const r = parseSimple(readFileSync(join(opts.receipts, wolf, f), "utf-8"));
      const outcome = r.fields.outcome;
      const processed = toIsoUtc(r.fields.processed, tz);
      if (outcome !== "create" && outcome !== "merge" && outcome !== "parked") { skip(key, `unknown outcome ${JSON.stringify(outcome)}`); continue; }
      if (!processed) { skip(key, "receipt has no parseable processed time"); continue; }
      const pf = join(opts.inbox, wolf, "_processed", f);
      if (!existsSync(pf)) { skip(key, "no matching _processed file"); continue; }
      const p = parseSimple(readFileSync(pf, "utf-8")).fields;
      if (!p.content_hash) { skip(key, "_processed file has no content_hash"); continue; }
      const entryId = r.body.split(/\s+/)[0] ?? "";
      if (outcome !== "parked" && !entryId) { skip(key, `${outcome} receipt has no entry id`); continue; }
      const submitted = toIsoUtc(p.submitted, tz) ?? processed;
      items.push({
        key, at: processed, submitted, from: r.fields.from || wolf, denTopicId: r.fields.den_topic_id || p.den_topic_id || f.replace(/-[0-9a-f]{10}\.md$/, ""),
        hash: p.content_hash, prevHash: p.prev_hash && p.prev_hash !== "null" ? p.prev_hash : null, domainHint: p.domain_hint ?? "", outcome,
        ...(outcome !== "parked" ? { entryId, canonicalId: canonOfEntry.get(entryId) ?? entryId } : {}),
      });
    }
  }
  // _processed files without a receipt: via Dewey's aliased events.
  for (const wolf of dirs(opts.inbox)) {
    for (const f of mdFiles(join(opts.inbox, wolf, "_processed"))) {
      const key = `${wolf}/${f}`;
      if (receiptKeys.has(key)) continue;
      const p = parseSimple(readFileSync(join(opts.inbox, wolf, "_processed", f), "utf-8")).fields;
      if (!p.content_hash) { skip(key, "no receipt; _processed has no content_hash"); continue; }
      const a = aliasByHash.get(bare(p.content_hash));
      if (!a) { skip(key, opts.deweyLedger ? "no receipt and no aliased event with this hash" : "no receipt and no --dewey-ledger"); continue; }
      const at = toIsoUtc(a.at, tz);
      if (!at) { skip(key, "aliased event has no parseable time"); continue; }
      const w = (writesOfCanon.get(a.canonicalId) ?? []).find((x) => x.at === a.at) ?? [...(writesOfCanon.get(a.canonicalId) ?? [])].reverse().find((x) => x.at <= a.at);
      const entryId = w?.entryId ?? a.canonicalId;
      items.push({
        key, at, submitted: toIsoUtc(p.submitted, tz) ?? at, from: p.from || wolf, denTopicId: p.den_topic_id || a.denTopicId || f.replace(/-[0-9a-f]{10}\.md$/, ""),
        hash: p.content_hash, prevHash: p.prev_hash && p.prev_hash !== "null" ? p.prev_hash : null, domainHint: p.domain_hint ?? "",
        outcome: w?.action === "create" ? "create" : "merge", entryId, canonicalId: a.canonicalId,
      });
    }
  }
  items.sort((a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key));

  const domains = scanEntryDomains(roots.kbBase);
  const events: KbEvent[] = [];
  for (const it of items) {
    events.push({ id: evId("contribution", it.key), at: it.submitted, t: "contribution", from: it.from, denTopicId: it.denTopicId, hash: it.hash, prevHash: it.prevHash, domainHint: it.domainHint });
    if (it.outcome !== "parked" && it.entryId) {
      events.push({ id: evId("entry_written", it.key), at: it.at, t: "entry_written", entryId: it.entryId, canonicalId: it.canonicalId ?? it.entryId, action: it.outcome });
    }
    events.push({ id: evId("decision", it.key), at: it.at, t: "decision", from: it.from, denTopicId: it.denTopicId, hash: it.hash, outcome: it.outcome, ...(it.entryId ? { entryId: it.entryId } : {}) });
    bump(rep.perWolf, it.from);
    bump(rep.perOutcome, it.outcome);
    if (it.entryId) {
      const d = domains.get(it.entryId);
      if (!d) rep.missingEntries++;
      bump(rep.perDomain, d ?? "(entry not in hub KB)");
    } else bump(rep.perDomain, "(no entry)");
    if (!rep.earliest || it.submitted < rep.earliest) rep.earliest = it.submitted;
    if (!rep.latest || it.at > rep.latest) rep.latest = it.at;
  }
  rep.items = items.length;
  rep.eventsBuilt = events.length;
  rep.samples = events.slice(0, 3);

  const run = (): void => {
    const have = new Set<string>();
    const file = ledgerFile(roots);
    if (existsSync(file)) for (const line of readFileSync(file, "utf-8").split("\n")) {
      const m = /"id":"(bf-[0-9a-f]{16})"/.exec(line);
      if (m) have.add(m[1]!);
    }
    const fresh = events.filter((e) => !have.has(e.id));
    rep.alreadyPresent = events.length - fresh.length;
    if (opts.dryRun) { rep.eventsAppended = 0; return; }
    appendLedger(roots, fresh);
    rep.eventsAppended = fresh.length;
  };
  if (opts.dryRun) run();
  else await withKbLock(roots, async () => run());
  return rep;
}

export function formatBackfillReport(r: BackfillReport): string[] {
  const kv = (o: Record<string, number>) => Object.entries(o).sort().map(([k, v]) => `${k}=${v}`).join(" ");
  return [
    `kb-backfill${r.dryRun ? " (dry run, nothing written)" : ""}: tz ${r.tz}; ${r.items} items -> ${r.eventsBuilt} events; appended ${r.eventsAppended}, already present ${r.alreadyPresent}`,
    `per wolf: ${kv(r.perWolf)}`,
    `per domain: ${kv(r.perDomain)}`,
    `per outcome: ${kv(r.perOutcome)}`,
    `range: ${r.earliest ?? "-"} .. ${r.latest ?? "-"}`,
    `entries not in the hub KB (emitted anyway): ${r.missingEntries}`,
    `skipped: ${r.skipped.length}`,
    ...r.skipped.slice(0, 20).map((s) => `  ${s.key}: ${s.reason}`),
    ...(r.skipped.length > 20 ? [`  ... ${r.skipped.length - 20} more`] : []),
    ...r.samples.map((e) => `sample: ${JSON.stringify(e)}`),
  ];
}
