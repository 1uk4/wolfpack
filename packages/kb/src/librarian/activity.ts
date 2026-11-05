/**
 * KB activity: the pure read model behind the hub's `GET /v1/kb/activity`.
 *
 *   buildActivityIndex(events, entryInfo)  one pass over the ledger: latest decision per (from, denTopicId, hash), changes per domain
 *   pageActivity(index, opts)              window / domain / cursor paging over that index
 *   foldKbActivity(events, opts)           both in one call
 *   readIncoming(inboxRoot)                the pending lane, by wolf (directory listings only)
 *
 * The result shape is `KbActivityResponse` (@wolfpack/protocol) minus the fields only the caller knows (generatedAt, source, sweep).
 * Types are declared structurally here: kb does not depend on protocol.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@wolfpack/engine";
import type { KbEvent } from "../shared/index.js";
import { oneLine } from "./redact.js";

export type ActivityOutcome = "create" | "merge" | "unchanged" | "reject" | "parked" | "unclassified";
export const ACTIVITY_OUTCOMES: ActivityOutcome[] = ["create", "merge", "unchanged", "reject", "parked", "unclassified"];
export const UNPLACED = "(unplaced)";
export const CHANGES_PER_DOMAIN = 10;
export const INCOMING_ITEMS_PER_WOLF = 20;
export const REASON_MAX = 240;

type Decision = Extract<KbEvent, { t: "decision" }>;

export interface ActivityDecision {
  id: string;
  at: string;
  from: string;
  denTopicId: string;
  hash: string;
  outcome: ActivityOutcome;
  entryId?: string;
  reason?: string;
  routing?: Decision["routing"];
  superseded?: number;
}
export interface ActivityChange {
  at: string;
  entryId: string;
  title?: string;
  action: "create" | "merge" | "supersede" | "retire";
  from?: string;
  denTopicId?: string;
}
export interface EntryInfo {
  domain?: string;
  title?: string;
}
export interface ActivityIndex {
  hasDecisions: boolean;
  /** Latest decision per key, newest first. */
  decisions: ActivityDecision[];
  /** Every entry_written / entry_retired, newest first (the page caps them per domain). */
  changes: Array<ActivityChange & { id: string }>;
  sectionDomain: Map<string, string>;
  placedSection: Map<string, string>;
}
export interface ActivityPage {
  hasDecisions: boolean;
  decisions: { items: ActivityDecision[]; nextCursor?: string; total: number; counts: Record<ActivityOutcome, number> };
  changes: { domains: Array<{ domain: string; items: ActivityChange[] }> };
}
export interface ActivityQuery {
  /** Lower bound (ms epoch) on a decision's `at`; undefined = all time. */
  sinceMs?: number;
  /** Cursor `${at}|${id}` from a previous page's nextCursor. */
  before?: string;
  limit?: number;
  domain?: string;
}

/**
 * Newest first, as a sort comparator (negative: `a` sorts before `b`). Compares the PARSED times, with the id as the tiebreak
 * (ids are time-ordered); unparseable timestamps fall back to string order. The window, the cursor and the sort all use it.
 */
const newer = (a: { at: string; id?: string }, b: { at: string; id?: string }): number => {
  const ta = Date.parse(a.at);
  const tb = Date.parse(b.at);
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return tb - ta;
  if (!(Number.isFinite(ta) && Number.isFinite(tb)) && a.at !== b.at) return b.at.localeCompare(a.at);
  return (b.id ?? "").localeCompare(a.id ?? "");
};

/** Resolves an entry id to its domain and title. The hub backs it with the entry files (domain: cached listing; title: read on demand). */
export interface EntryResolver {
  domain(id: string): string | undefined;
  title(id: string): string | undefined;
}
const NO_ENTRIES: EntryResolver = { domain: () => undefined, title: () => undefined };

const listDomains = (kbBase: string): string[] => {
  try {
    return readdirSync(join(kbBase, "domains"), { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith("_") && !d.name.startsWith(".")).map((d) => d.name);
  } catch {
    return [];
  }
};

/** entryId -> domain from `<kbBase>/domains/<domain>/entries/<id>.md`. Directory listings only: no entry file is opened. */
export function scanEntryDomains(kbBase: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const domain of listDomains(kbBase)) {
    try {
      for (const f of readdirSync(join(kbBase, "domains", domain, "entries"))) if (f.endsWith(".md")) out.set(f.slice(0, -3), domain);
    } catch {
      /* no entries dir */
    }
  }
  return out;
}

/** The frontmatter title of one entry file (redacted, one line), or undefined. */
export function readEntryTitle(kbBase: string, domain: string, id: string): string | undefined {
  try {
    const t = parseFrontmatter(readFileSync(join(kbBase, "domains", domain, "entries", `${id}.md`), "utf-8")).fields.title;
    return typeof t === "string" && t.trim() ? oneLine(t, 200) : undefined;
  } catch {
    return undefined;
  }
}

/** A resolver over the entry files, using a domain map the caller scanned (and may cache). Titles are read fresh. */
export function fsEntryResolver(kbBase: string, domains: Map<string, string>): EntryResolver {
  return { domain: (id) => domains.get(id), title: (id) => (domains.has(id) ? readEntryTitle(kbBase, domains.get(id)!, id) : undefined) };
}

/** entryId -> {domain,title} for every entry file (test / one-shot convenience). */
export function scanEntryInfo(kbBase: string): Map<string, EntryInfo> {
  const out = new Map<string, EntryInfo>();
  for (const [id, domain] of scanEntryDomains(kbBase)) {
    const title = readEntryTitle(kbBase, domain, id);
    out.set(id, { domain, ...(title ? { title } : {}) });
  }
  return out;
}

const asResolver = (x: Map<string, EntryInfo> | ((id: string) => EntryInfo | undefined) | EntryResolver | undefined): EntryResolver => {
  if (!x) return NO_ENTRIES;
  if (x instanceof Map) return { domain: (id) => x.get(id)?.domain, title: (id) => x.get(id)?.title };
  if (typeof x === "function") return { domain: (id) => x(id)?.domain, title: (id) => x(id)?.title };
  return x;
};

/** Free text from the engine (reasons, warnings): redacted, first line, capped. */
const clean = (s: string): string => oneLine(s, REASON_MAX);
/** Identifier-like strings (band, candidate ids, the subject match): redacted and capped short. */
const ID_MAX = 120;
const short = (s: string): string => oneLine(s, ID_MAX);
function cleanRouting(r: Decision["routing"]): Decision["routing"] {
  if (!r) return r;
  return {
    ...r,
    candidates: r.candidates.map((c) => ({ ...c, id: short(c.id) })),
    ...(r.band !== undefined ? { band: short(r.band) } : {}),
    ...(r.target !== undefined ? { target: short(r.target) } : {}),
    ...(r.warning !== undefined ? { warning: clean(r.warning) } : {}),
    ...(r.subject ? { subject: { ...r.subject, match: short(r.subject.match), ...(r.subject.reason !== undefined ? { reason: clean(r.subject.reason) } : {}) } } : {}),
    ...(r.confirm ? { confirm: { ...r.confirm, candidate: short(r.confirm.candidate), ...(r.confirm.reason !== undefined ? { reason: clean(r.confirm.reason) } : {}) } } : {}),
  } as Decision["routing"];
}

/** Which decision outcomes can have produced an entry_written of this action. */
const ACCEPTS: Record<"create" | "merge" | "supersede", ActivityOutcome[]> = { create: ["create"], merge: ["merge", "unchanged"], supersede: ["merge", "create"] };

/**
 * The ledger side of the model: everything that does not depend on the entry files. Rebuild it only when the ledger changes;
 * `pageActivity` resolves domains and titles per request.
 */
export function buildActivityIndex(events: KbEvent[]): ActivityIndex {
  const latest = new Map<string, { e: Decision; n: number }>();
  const decsOfEntry = new Map<string, Array<{ idx: number; e: Decision }>>();
  const marks = new Map<string, number[]>(); // entry_written / entry_retired positions per entry
  const sectionDomain = new Map<string, string>();
  const placedSection = new Map<string, string>();
  let hasDecisions = false;
  const contributions: Array<{ idx: number; from: string }> = [];
  const writeIdx: number[] = []; // every entry_written / entry_retired position, ledger order
  /** Writes folded into a later identical one of the same batch (W1 + W2 of one sweep write). */
  const dropped = new Set<number>();
  let boundaries = 0; // contribution / decision events seen: a batch edge
  const lastWrite = new Map<string, { idx: number; action: string; boundaries: number }>();
  events.forEach((e, idx) => {
    switch (e.t) {
      case "contribution":
        boundaries++;
        contributions.push({ idx, from: e.from });
        break;
      case "decision": {
        boundaries++;
        hasDecisions = true;
        const k = JSON.stringify([e.from, e.denTopicId, e.hash]);
        // "Latest" = last in ledger order; the ledger is append-only, so file order is time order.
        latest.set(k, { e, n: (latest.get(k)?.n ?? 0) + 1 });
        if (e.entryId) {
          const l = decsOfEntry.get(e.entryId) ?? [];
          l.push({ idx, e });
          decsOfEntry.set(e.entryId, l);
        }
        break;
      }
      case "entry_written":
      case "entry_retired": {
        const action = e.t === "entry_retired" ? "retire" : e.action;
        const prev = lastWrite.get(e.entryId);
        if (action !== "retire" && prev && prev.action === action && prev.boundaries === boundaries) dropped.add(prev.idx);
        lastWrite.set(e.entryId, { idx, action, boundaries });
        writeIdx.push(idx);
        const l = marks.get(e.entryId) ?? [];
        l.push(idx);
        marks.set(e.entryId, l);
        break;
      }
      case "section_created":
        sectionDomain.set(e.sectionId, e.domain);
        break;
      case "sections_replaced":
        for (const s of e.sections) if (typeof s.id === "string" && typeof s.domain === "string") sectionDomain.set(s.id, s.domain);
        break;
      case "entry_placed":
        placedSection.set(e.entryId, e.sectionId);
        break;
      default:
    }
  });

  const decisions = [...latest.values()].map(({ e, n }) => {
    const routing = cleanRouting(e.routing);
    return {
      id: e.id,
      at: e.at,
      from: e.from,
      denTopicId: e.denTopicId,
      hash: e.hash,
      outcome: e.outcome,
      ...(e.entryId ? { entryId: e.entryId } : {}),
      ...(e.reason ? { reason: oneLine(e.reason, REASON_MAX) } : {}),
      ...(routing ? { routing } : {}),
      ...(n > 1 ? { superseded: n - 1 } : {}),
    } as ActivityDecision;
  });
  decisions.sort(newer);

  /**
   * The decision behind an entry_written: the one of the SAME BATCH. sweep.ts logs the entry (commitKb) before it appends the batch
   * with the decision, so the batch's decision usually follows the write: take the first outcome-matching decision from this write up
   * to the entry's next write/retire; else the latest matching one before it; else the latest earlier decision of any outcome.
   * An entry_retired is not a contribution and carries no attribution.
   */
  const attribute = (entryId: string, idx: number, action: "create" | "merge" | "supersede"): Decision | undefined => {
    const decs = decsOfEntry.get(entryId) ?? [];
    const next = (marks.get(entryId) ?? []).find((m) => m > idx && !dropped.has(m)) ?? Infinity;
    const ok = (o: ActivityOutcome) => ACCEPTS[action].includes(o);
    const after = decs.find((x) => x.idx >= idx && x.idx < next && ok(x.e.outcome));
    if (after) return after.e;
    // Fallbacks (an earlier decision) may credit another wolf: only use one whose sender is the batch's own contribution event.
    const live = writeIdx.filter((m) => !dropped.has(m));
    const nextAny = live.find((m) => m > idx) ?? Infinity;
    const prevAny = [...live].reverse().find((m) => m < idx) ?? -1;
    const adj = contributions.find((c) => c.idx > idx && c.idx < nextAny) ?? [...contributions].reverse().find((c) => c.idx < idx && c.idx > prevAny);
    if (!adj) return undefined;
    const before = decs.filter((x) => x.idx < idx && x.e.from === adj.from);
    return [...before].reverse().find((x) => ok(x.e.outcome))?.e ?? before[before.length - 1]?.e;
  };
  const changes: Array<ActivityChange & { id: string }> = [];
  events.forEach((e, idx) => {
    if (e.t !== "entry_written" && e.t !== "entry_retired") return;
    if (dropped.has(idx)) return;
    const dec = e.t === "entry_written" ? attribute(e.entryId, idx, e.action) : undefined;
    changes.push({ id: e.id, at: e.at, entryId: e.entryId, action: e.t === "entry_retired" ? "retire" : e.action, ...(dec ? { from: dec.from, denTopicId: dec.denTopicId } : {}) });
  });
  changes.sort(newer);
  return { hasDecisions, decisions, changes, sectionDomain, placedSection };
}

export function pageActivity(index: ActivityIndex, q: ActivityQuery = {}, entries: EntryResolver = NO_ENTRIES): ActivityPage {
  const limit = q.limit ?? 50;
  const domainOf = (id: string): string => entries.domain(id) ?? index.sectionDomain.get(index.placedSection.get(id) ?? "") ?? UNPLACED;
  const counts = Object.fromEntries(ACTIVITY_OUTCOMES.map((o) => [o, 0])) as Record<ActivityOutcome, number>;
  const inWindow = index.decisions.filter((d) => {
    // A decision belongs to its entry's domain; one with no entry (reject, parked, unclassified) belongs to none and is dropped by a domain filter.
    if (q.domain !== undefined && (d.entryId === undefined || domainOf(d.entryId) !== q.domain)) return false;
    if (q.sinceMs !== undefined) {
      const t = Date.parse(d.at);
      if (!Number.isFinite(t) || t < q.sinceMs) return false;
    }
    return true;
  });
  for (const d of inWindow) counts[d.outcome]++;
  let rest = inWindow;
  if (q.before !== undefined) {
    const i = q.before.indexOf("|");
    const cur = { at: q.before.slice(0, i), id: q.before.slice(i + 1) };
    rest = inWindow.filter((d) => newer(cur, d) < 0); // strictly older than the cursor
  }
  const page = rest.slice(0, limit);
  const last = page[page.length - 1];

  const byDomain = new Map<string, ActivityChange[]>();
  for (const { id: _id, ...c } of index.changes) {
    const dom = domainOf(c.entryId);
    if (q.domain !== undefined && dom !== q.domain) continue;
    const list = byDomain.get(dom) ?? [];
    if (list.length >= CHANGES_PER_DOMAIN) continue;
    const title = entries.title(c.entryId);
    list.push({ ...c, ...(title ? { title } : {}) });
    byDomain.set(dom, list);
  }
  const domains = [...byDomain.keys()]
    .sort((a, b) => (a === UNPLACED ? 1 : b === UNPLACED ? -1 : a.localeCompare(b)))
    .map((domain) => ({ domain, items: byDomain.get(domain)! }));
  return {
    hasDecisions: index.hasDecisions,
    decisions: { items: page, ...(rest.length > limit && last ? { nextCursor: `${last.at}|${last.id}` } : {}), total: inWindow.length, counts },
    changes: { domains },
  };
}

export function foldKbActivity(events: KbEvent[], opts: ActivityQuery & { entryInfo?: Map<string, EntryInfo> | ((id: string) => EntryInfo | undefined) | EntryResolver } = {}): ActivityPage {
  return pageActivity(buildActivityIndex(events), opts, asResolver(opts.entryInfo));
}

export interface IncomingWolf {
  wolf: string;
  pending: number;
  oldestAgeMs?: number;
  bad?: number;
  items: Array<{ denTopicId: string; hash?: string; ageMs: number }>;
}

const FILE_RE = /^(.+)-([0-9a-f]{10})\.md$/;
const safeDir = <T>(fn: () => T, fallback: T): T => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};
/** File names carry no time, so ages need a stat. At most this many files per wolf are stat'ed (the rest are only counted). */
export const INCOMING_STAT_CAP = 2000;

/**
 * The pending lane `<inboxRoot>/<wolf>/<denTopicId>-<hash10>.md`. Top-level `.md` files only: `_processed/`, `_bad/` and dotfiles
 * (`.sweep-lease*`, `.*.tmp`) are never pending. `pending` is counted from the directory listing alone. `hash` is the 10-hex tag
 * of the file name (a prefix of the ledger hash).
 *
 * APPROXIMATION: ages come from mtimes, and only the first INCOMING_STAT_CAP (2000) files (by name) of a wolf are stat'ed; above that `pending` is still the exact listing count. `items` (at most 20,
 * oldest first) and `oldestAgeMs` are taken from that sample, so with more than 2000 pending files `oldestAgeMs` and `items` describe a sample, not
 * necessarily the true 20 oldest. Up to 2000 pending files per wolf the answer is exact.
 */
export function readIncoming(inboxRoot: string, now: number = Date.now()): { total: number; wolves: IncomingWolf[] } {
  const wolves: IncomingWolf[] = [];
  let total = 0;
  const names = safeDir(() => readdirSync(inboxRoot, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith("_") && !d.name.startsWith(".")).map((d) => d.name).sort(), [] as string[]);
  for (const wolf of names) {
    const dir = join(inboxRoot, wolf);
    const listed = safeDir(() => readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && !e.name.startsWith(".") && e.name.endsWith(".md")).map((e) => e.name).sort(), [] as string[]);
    const sampled: Array<{ f: string; mtime: number }> = [];
    for (const f of listed.slice(0, INCOMING_STAT_CAP)) {
      const mtime = safeDir(() => statSync(join(dir, f)).mtimeMs, undefined);
      if (mtime !== undefined) sampled.push({ f, mtime });
    }
    sampled.sort((a, b) => a.mtime - b.mtime || a.f.localeCompare(b.f));
    const badDir = join(dir, "_bad");
    const bad = existsSync(badDir) ? safeDir(() => readdirSync(badDir).filter((f) => !f.startsWith(".") && !f.endsWith(".reason.txt")).length, 0) : undefined;
    if (listed.length === 0 && !bad) continue;
    total += listed.length;
    wolves.push({
      wolf,
      pending: listed.length,
      ...(sampled.length ? { oldestAgeMs: Math.max(0, Math.round(now - sampled[0].mtime)) } : {}),
      ...(bad !== undefined ? { bad } : {}),
      items: sampled.slice(0, INCOMING_ITEMS_PER_WOLF).map(({ f, mtime }) => {
        const m = FILE_RE.exec(f);
        return { denTopicId: m ? m[1] : f.slice(0, -3), ...(m ? { hash: m[2] } : {}), ageMs: Math.max(0, Math.round(now - mtime)) };
      }),
    });
  }
  return { total, wolves };
}
