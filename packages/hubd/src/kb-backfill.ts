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
 * ledger that has newer events appends old-dated events after them; a backfilled decision would count as "latest" for a key that already
 * had a newer one. So a real run REFUSES a ledger that holds any non-`bf-` event unless `force` (--force) is given.
 * SIDE EFFECT (intended): the `contribution` events enter `seenHashes`, so the hub curator will NOT reprocess Dewey's past items (it retires
 * a pending file with a seen hash as a duplicate). Do not change this.
 * Registry: only `entry_written` is emitted (no `aliased`, no `clustered`). foldRegistry therefore gets topics with entries and NO aliases;
 * the sweep's alias routing reads `topic.aliases` only (sweep.ts ~543), so it is unaffected, and similarity routing uses entry vectors,
 * not the registry. `canonicalId` falls back to the entry id when Dewey's ledger has no entry_written for it (counted in the report).
 * Validation: every built event is checked with KbEventSchema; an item with an invalid event is dropped and reported (dry run too).
 * Timestamps: Dewey's "YYYY-MM-DD HH:MM" values are local time in --tz (default UTC, verified on sfo-01) -> ISO UTC.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appendLedger, scanEntryDomains, withKbLock } from "@wolfpack/kb/librarian";
import { KbEventSchema, ledgerFile, type KbEvent } from "@wolfpack/kb/shared";
import { hubRoots } from "./layout.js";

export const DEFAULT_BACKFILL_TZ = "UTC";

export interface BackfillOptions {
  receipts: string;
  inbox: string;
  deweyLedger?: string;
  dataDir: string;
  tz?: string;
  dryRun?: boolean;
  /** Real run only: append even though the ledger already holds events that are not backfill events. */
  force?: boolean;
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
  /** Items dropped because one of their events failed KbEventSchema (also listed in `skipped`). */
  invalidItems: number;
  /** Items whose canonicalId fell back to the entry id (no entry_written / aliased in the Dewey ledger). */
  canonicalFallback: number;
  warnings: string[];
  samples: KbEvent[];
}

/** Flat `key: value` frontmatter + body. Values may be quoted. */
export function parseSimple(text0: string): { fields: Record<string, string>; body: string } {
  const text = text0.replace(/^\uFEFF/, "");
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
  const [Y, Mo, D, H, Mi, S] = [+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0)];
  const chk = new Date(Date.UTC(Y, Mo - 1, D, H, Mi, S));
  if (Mo < 1 || Mo > 12 || D < 1 || H > 23 || Mi > 59 || S > 59 || chk.getUTCMonth() !== Mo - 1 || chk.getUTCDate() !== D) return undefined; // no normalising (Feb 30 -> Mar 2)
  const wall = chk.getTime();
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
const ENTRY_ID_RE = /^kb-[a-z0-9][a-z0-9-]*-[A-Za-z0-9]+$/;
/** Report strings: control characters (file names, frontmatter values) must not reach the terminal. */
const printable = (x: string): string => x.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
/** Receipt tags are the TAIL of the content hash (repair-written hashes end in `r<n>`, whose tag keeps the `r` and drops the digit suffix). */
const tagMatches = (hash: string, tags: string[]): boolean => tags.some((t) => hash.endsWith(t) || hash.replace(/r\d*$/, "").endsWith(t.replace(/r$/, "")));
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
  /** canonicalId is the entry id because Dewey's ledger said nothing. */
  fallback?: boolean;
}

export async function kbBackfill(opts: BackfillOptions): Promise<BackfillReport> {
  const tz = opts.tz ?? DEFAULT_BACKFILL_TZ;
  new Intl.DateTimeFormat("en-US", { timeZone: tz }); // throws RangeError on a bad zone
  const roots = hubRoots(opts.dataDir);
  const rep: BackfillReport = { dryRun: !!opts.dryRun, tz, items: 0, eventsBuilt: 0, eventsAppended: 0, alreadyPresent: 0, perWolf: {}, perDomain: {}, perOutcome: {}, missingEntries: 0, skipped: [], invalidItems: 0, canonicalFallback: 0, warnings: [], samples: [] };
  const skip = (key: string, reason: string) => rep.skipped.push({ key, reason });

  if (!opts.deweyLedger) {
    const msg = "no --dewey-ledger: canonical ids fall back to entry ids and ledger-only (kb-repair) items cannot be joined";
    if (!opts.dryRun) throw new Error(`kb-backfill needs --dewey-ledger for a real run (${msg})`);
    rep.warnings.push(msg);
  }
  // Dewey's ledger: aliased by hash (kb-repair join), entry_written by entry id / canonical id.
  const aliasByHash = new Map<string, { canonicalId: string; at: string; denTopicId: string; wolf: string }>();
  const canonOfEntry = new Map<string, string>();
  const writesOfCanon = new Map<string, Array<{ entryId: string; at: string; action: string }>>();
  if (opts.deweyLedger) {
    for (const line of readFileSync(opts.deweyLedger, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const e = parsed as Record<string, unknown>;
      const str = (k: string): string | undefined => (typeof e[k] === "string" ? (e[k] as string) : undefined);
      if (e.t === "aliased") {
        const hash = str("hash"), canonicalId = str("canonicalId"), at = str("at"), denTopicId = str("denTopicId"), wolf = str("wolf");
        if (hash && canonicalId && at && denTopicId && wolf) aliasByHash.set(bare(hash), { canonicalId, at, denTopicId, wolf });
      } else if (e.t === "entry_written") {
        const entryId = str("entryId"), canonicalId = str("canonicalId"), at = str("at"), action = str("action");
        if (entryId && canonicalId && at && action) {
          canonOfEntry.set(entryId, canonicalId);
          const l = writesOfCanon.get(canonicalId) ?? [];
          l.push({ entryId, at, action });
          writesOfCanon.set(canonicalId, l);
        }
      }
    }
  }

  const items: Item[] = [];
  const usedProcessed = new Set<string>();
  const procIndex = new Map<string, Array<{ f: string; fields: Record<string, string> }>>();
  const procOf = (wolf: string) => {
    let l = procIndex.get(wolf);
    if (!l) {
      l = mdFiles(join(opts.inbox, wolf, "_processed")).map((f) => ({ f, fields: parseSimple(readFileSync(join(opts.inbox, wolf, "_processed", f), "utf-8")).fields }));
      procIndex.set(wolf, l);
    }
    return l;
  };
  /** The _processed file of a receipt: same name; else (graduation / migration files, whose names carry no hash tag) same den topic and a content_hash that contains the receipt's tag. */
  const findProcessed = (wolf: string, f: string, topic: string): { f: string; fields: Record<string, string> } | undefined => {
    const list = procOf(wolf);
    const exact = list.find((x) => x.f === f);
    if (exact) return exact;
    const tag = /-([0-9a-z]{9,10})\.md$/.exec(f)?.[1];
    if (!tag) return undefined;
    const tags = [tag, tag.replace(/r$/, "")];
    const cands = list.filter((x) => !usedProcessed.has(`${wolf}/${x.f}`) && x.fields.den_topic_id === topic && x.fields.content_hash && tagMatches(bare(x.fields.content_hash!), tags));
    return cands.length === 1 ? cands[0] : undefined;
  };
  for (const wolf of dirs(opts.receipts)) {
    for (const f of mdFiles(join(opts.receipts, wolf))) {
      const key = `${wolf}/${f}`;
      const r = parseSimple(readFileSync(join(opts.receipts, wolf, f), "utf-8"));
      const outcome = r.fields.outcome;
      const processed = toIsoUtc(r.fields.processed, tz);
      if (outcome !== "create" && outcome !== "merge" && outcome !== "parked") { skip(key, `unknown outcome ${JSON.stringify(outcome)}`); continue; }
      if (!processed) { skip(key, "receipt has no parseable processed time"); continue; }
      const found = findProcessed(wolf, f, r.fields.den_topic_id ?? "");
      if (!found) { skip(key, "no matching _processed file (by name, or by den topic + hash tag; may be a duplicate receipt)"); continue; }
      usedProcessed.add(`${wolf}/${found.f}`);
      const p = found.fields;
      if (!p.content_hash) { skip(key, "_processed file has no content_hash"); continue; }
      const entryId = r.body.split(/\s+/)[0] ?? "";
      if (outcome !== "parked" && !ENTRY_ID_RE.test(entryId)) { skip(key, `${outcome} receipt body is not an entry id (kb-<domain>-<id>)`); continue; }
      const submitted = toIsoUtc(p.submitted, tz) ?? processed;
      items.push({
        key, at: processed, submitted, from: r.fields.from || wolf, denTopicId: r.fields.den_topic_id || p.den_topic_id || f.replace(/-[0-9a-f]{10}\.md$/, ""),
        hash: p.content_hash, prevHash: p.prev_hash && p.prev_hash !== "null" ? p.prev_hash : null, domainHint: p.domain_hint ?? "", outcome,
        ...(outcome !== "parked" ? { entryId, canonicalId: canonOfEntry.get(entryId) ?? entryId, ...(canonOfEntry.has(entryId) ? {} : { fallback: true }) } : {}),
      });
    }
  }
  // _processed files without a receipt: via Dewey's aliased events.
  for (const wolf of dirs(opts.inbox)) {
    for (const { f, fields: p } of procOf(wolf)) {
      const key = `${wolf}/${f}`;
      if (usedProcessed.has(key)) continue;
      if (!p.content_hash) { skip(key, "no receipt; _processed has no content_hash"); continue; }
      const a = aliasByHash.get(bare(p.content_hash));
      if (!a) {
        // No receipt and no aliased event: the file itself may carry the entry (graduation / repair files: entry_id + submitted).
        const at = toIsoUtc(p.submitted, tz);
        if (!p.entry_id || !ENTRY_ID_RE.test(p.entry_id) || !at) { skip(key, "no receipt, no aliased event with this hash, and no valid entry_id + submitted in the file"); continue; }
        items.push({ key, at, submitted: at, from: p.from || wolf, denTopicId: p.den_topic_id || f.replace(/\.md$/, ""), hash: p.content_hash, prevHash: p.prev_hash && p.prev_hash !== "null" ? p.prev_hash : null, domainHint: p.domain_hint ?? "", outcome: p.change === "create" ? "create" : "merge", entryId: p.entry_id, canonicalId: p.entry_id, fallback: true });
        continue;
      }
      const at = toIsoUtc(a.at, tz);
      if (!at) { skip(key, "aliased event has no parseable time"); continue; }
      const w = (writesOfCanon.get(a.canonicalId) ?? []).find((x) => x.at === a.at) ?? [...(writesOfCanon.get(a.canonicalId) ?? [])].reverse().find((x) => x.at <= a.at);
      const entryId = w?.entryId ?? a.canonicalId;
      items.push({
        key, at, submitted: toIsoUtc(p.submitted, tz) ?? at, from: p.from || wolf, denTopicId: p.den_topic_id || a.denTopicId || f.replace(/-[0-9a-f]{10}\.md$/, ""),
        hash: p.content_hash, prevHash: p.prev_hash && p.prev_hash !== "null" ? p.prev_hash : null, domainHint: p.domain_hint ?? "",
        outcome: w?.action === "create" ? "create" : "merge", entryId, canonicalId: a.canonicalId, ...(w ? {} : { fallback: true }),
      });
    }
  }
  items.sort((a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key));

  const domains = scanEntryDomains(roots.kbBase);
  const events: KbEvent[] = [];
  const kept: Item[] = [];
  for (const it of items) {
    const mine: KbEvent[] = [];
    mine.push({ id: evId("contribution", it.key), at: it.submitted, t: "contribution", from: it.from, denTopicId: it.denTopicId, hash: it.hash, prevHash: it.prevHash, domainHint: it.domainHint });
    if (it.outcome !== "parked" && it.entryId) {
      mine.push({ id: evId("entry_written", it.key), at: it.at, t: "entry_written", entryId: it.entryId, canonicalId: it.canonicalId ?? it.entryId, action: it.outcome });
    }
    mine.push({ id: evId("decision", it.key), at: it.at, t: "decision", from: it.from, denTopicId: it.denTopicId, hash: it.hash, outcome: it.outcome, ...(it.entryId ? { entryId: it.entryId } : {}) });
    const bad = mine.map((e) => KbEventSchema.safeParse(e)).find((r) => !r.success);
    if (bad && !bad.success) {
      rep.invalidItems++;
      skip(it.key, `invalid ${bad.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ").slice(0, 160)}`);
      continue;
    }
    kept.push(it);
    events.push(...mine);
    if (it.fallback) rep.canonicalFallback++;
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
  rep.items = kept.length;
  rep.eventsBuilt = events.length;
  rep.samples = events.slice(0, 3);

  const run = (): void => {
    const have = new Set<string>();
    let foreign = 0;
    const file = ledgerFile(roots);
    if (existsSync(file)) for (const line of readFileSync(file, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      const m = /^\{"id":"(bf-[0-9a-f]{16})"/.exec(line);
      if (m) have.add(m[1]!);
      else foreign++;
    }
    if (foreign > 0) {
      const msg = `the ledger already holds ${foreign} event(s) that are not backfill events; appended old-dated decisions would override newer ones in the activity reader`;
      if (!opts.dryRun && !opts.force) throw new Error(`kb-backfill refuses: ${msg} (pass --force to append anyway)`);
      rep.warnings.push(msg + (opts.dryRun ? " (a real run needs --force)" : " (--force given)"));
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
    `per wolf: ${printable(kv(r.perWolf))}`,
    `per domain: ${printable(kv(r.perDomain))}`,
    `per outcome: ${kv(r.perOutcome)}`,
    `range: ${r.earliest ?? "-"} .. ${r.latest ?? "-"}`,
    `entries not in the hub KB (emitted anyway): ${r.missingEntries}`,
    `canonical id fell back to the entry id (not in the Dewey ledger): ${r.canonicalFallback}`,
    `invalid (dropped) items: ${r.invalidItems}`,
    ...r.warnings.map((w) => `warning: ${printable(w)}`),
    `skipped: ${r.skipped.length}`,
    ...r.skipped.slice(0, 20).map((s) => `  ${printable(s.key)}: ${printable(s.reason)}`),
    ...(r.skipped.length > 20 ? [`  ... ${r.skipped.length - 20} more`] : []),
    ...r.samples.map((e) => `sample: ${printable(JSON.stringify(e))}`),
  ];
}
