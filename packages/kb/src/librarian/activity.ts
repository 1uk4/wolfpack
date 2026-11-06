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
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
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
  /** Entry's domain, else the contribution's hinted domain when it is a real domain. */
  domain?: string;
  /** Title of the resulting entry (read on demand). */
  title?: string;
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
  /** domainHint of the contribution event, keyed JSON.stringify([from, denTopicId, hash]) (as the decisions are). */
  hints: Map<string, string>;
}
export interface DomainActivity {
  domain: string;
  /** Wolves with decisions in range for this domain. */
  contributors: Array<{ wolf: string; count: number }>;
  /** Latest entry change of the domain, any time. */
  lastChangeAt?: string;
  /** All decisions in range for this domain (any outcome). */
  decided: number;
  /** The newest `recentPerDomain` decisions in range for this domain (titles resolved). */
  recent: ActivityDecision[];
}
/** Per wolf: contributions that need a look, over the range (not just the loaded page), plus up to ATTENTION_ITEMS_PER_WOLF newest. */
export interface WolfAttention {
  wolf: string;
  reject: number;
  parked: number;
  unclassified: number;
  items: ActivityDecision[];
}
export const RECENT_PER_DOMAIN = 8;
export const ATTENTION_ITEMS_PER_WOLF = 20;
/** Outcomes that make a wolf a contributor of a domain (something was written or agreed with). */
const CONTRIBUTING: ReadonlySet<ActivityOutcome> = new Set(["create", "merge", "unchanged"]);
export interface ActivityPage {
  domains: DomainActivity[];
  attention: WolfAttention[];
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
  /** Decisions kept per domain summary (default RECENT_PER_DOMAIN). */
  recentPerDomain?: number;
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
  /** Real domains (a contribution's hint only counts when it is one of these). */
  known?(): ReadonlySet<string>;
}
const NO_ENTRIES: EntryResolver = { domain: () => undefined, title: () => undefined };

export const listDomains = (kbBase: string): string[] => {
  try {
    return readdirSync(join(kbBase, "domains"), { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith("_") && !d.name.startsWith(".") && DOMAIN_RE.test(d.name)).map((d) => d.name);
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
  const known = new Set([...listDomains(kbBase), ...domains.values()]);
  return { domain: (id) => domains.get(id), title: (id) => (domains.has(id) ? readEntryTitle(kbBase, domains.get(id)!, id) : undefined), known: () => known };
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
  const hints = new Map<string, string>();
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
        if (e.domainHint) hints.set(JSON.stringify([e.from, e.denTopicId, e.hash]), e.domainHint);
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
  return { hasDecisions, decisions, changes, sectionDomain, placedSection, hints };
}

export function pageActivity(index: ActivityIndex, q: ActivityQuery = {}, entries: EntryResolver = NO_ENTRIES): ActivityPage {
  const limit = q.limit ?? 50;
  const known = entries.known?.() ?? new Set<string>();
  const domainOf = (id: string): string => entries.domain(id) ?? index.sectionDomain.get(index.placedSection.get(id) ?? "") ?? UNPLACED;
  /** The entry's domain; else (no entry, or unplaced) the contribution's hint when it is a real domain; else none. */
  const decisionDomain = (d: ActivityDecision): string | undefined => {
    if (d.entryId) {
      const dom = domainOf(d.entryId);
      if (dom !== UNPLACED) return dom;
    }
    const hint = index.hints.get(JSON.stringify([d.from, d.denTopicId, d.hash]));
    if (hint && known.has(hint)) return hint;
    return d.entryId ? UNPLACED : undefined;
  };
  const sinceOk = (at: string): boolean => {
    if (q.sinceMs === undefined) return true;
    const t = Date.parse(at);
    return Number.isFinite(t) && t >= q.sinceMs;
  };
  const counts = Object.fromEntries(ACTIVITY_OUTCOMES.map((o) => [o, 0])) as Record<ActivityOutcome, number>;
  const inRange = index.decisions.filter((d) => sinceOk(d.at)).map((d) => ({ d, dom: decisionDomain(d) }));
  const contrib = new Map<string, Map<string, number>>();
  const recentN = q.recentPerDomain ?? RECENT_PER_DOMAIN;
  const recent = new Map<string, ActivityDecision[]>();
  const decidedBy = new Map<string, number>();
  const attn = new Map<string, WolfAttention>();
  for (const { d, dom } of inRange) {
    if (d.outcome === "reject" || d.outcome === "parked" || d.outcome === "unclassified") {
      const a = attn.get(d.from) ?? { wolf: d.from, reject: 0, parked: 0, unclassified: 0, items: [] };
      a[d.outcome]++;
      if (a.items.length < ATTENTION_ITEMS_PER_WOLF) a.items.push({ ...d, ...(dom && dom !== UNPLACED ? { domain: dom } : {}) });
      attn.set(d.from, a);
    }
    if (!dom || dom === UNPLACED) continue;
    decidedBy.set(dom, (decidedBy.get(dom) ?? 0) + 1);
    const r = recent.get(dom) ?? [];
    if (r.length < recentN) {
      const title = d.entryId ? entries.title(d.entryId) : undefined;
      r.push({ ...d, domain: dom, ...(title ? { title } : {}) });
      recent.set(dom, r);
    }
    if (!CONTRIBUTING.has(d.outcome)) continue;
    const m = contrib.get(dom) ?? new Map<string, number>();
    m.set(d.from, (m.get(d.from) ?? 0) + 1);
    contrib.set(dom, m);
  }
  const lastChange = new Map<string, string>();
  for (const c of index.changes) {
    const dom = domainOf(c.entryId);
    if (!lastChange.has(dom)) lastChange.set(dom, c.at); // changes are newest first
  }
  const inWindow = inRange.filter(({ dom }) => q.domain === undefined || dom === q.domain).map(({ d, dom }) => ({ d, dom }));
  for (const { d } of inWindow) counts[d.outcome]++;
  let rest = inWindow;
  if (q.before !== undefined) {
    const i = q.before.indexOf("|");
    const cur = { at: q.before.slice(0, i), id: q.before.slice(i + 1) };
    rest = inWindow.filter(({ d }) => newer(cur, d) < 0); // strictly older than the cursor
  }
  const page = rest.slice(0, limit);
  const last = page[page.length - 1]?.d;
  const items = page.map(({ d, dom }) => {
    const title = d.entryId ? entries.title(d.entryId) : undefined;
    return { ...d, ...(dom && dom !== UNPLACED ? { domain: dom } : {}), ...(title ? { title } : {}) };
  });

  const perDomain = q.domain !== undefined ? Math.max(CHANGES_PER_DOMAIN, limit) : CHANGES_PER_DOMAIN;
  const byDomain = new Map<string, ActivityChange[]>();
  for (const { id: _id, ...c } of index.changes) {
    if (!sinceOk(c.at)) continue;
    const dom = domainOf(c.entryId);
    if (q.domain !== undefined && dom !== q.domain) continue;
    const list = byDomain.get(dom) ?? [];
    if (list.length >= perDomain) continue;
    const title = entries.title(c.entryId);
    list.push({ ...c, ...(title ? { title } : {}) });
    byDomain.set(dom, list);
  }
  const domains = [...byDomain.keys()]
    .sort((a, b) => (a === UNPLACED ? 1 : b === UNPLACED ? -1 : a.localeCompare(b)))
    .map((domain) => ({ domain, items: byDomain.get(domain)! }));
  const names = new Set([...contrib.keys(), ...decidedBy.keys(), ...lastChange.keys()]);
  const summaries: DomainActivity[] = [...names]
    .filter((n) => n !== UNPLACED)
    .sort()
    .map((domain) => ({
      domain,
      contributors: [...(contrib.get(domain) ?? [])].map(([wolf, count]) => ({ wolf, count })).sort((a, b) => b.count - a.count || a.wolf.localeCompare(b.wolf)),
      ...(lastChange.has(domain) ? { lastChangeAt: lastChange.get(domain)! } : {}),
      decided: decidedBy.get(domain) ?? 0,
      recent: recent.get(domain) ?? [],
    }));
  return {
    hasDecisions: index.hasDecisions,
    domains: summaries,
    attention: [...attn.values()].sort((a, b) => a.wolf.localeCompare(b.wolf)),
    decisions: { items, ...(rest.length > limit && last ? { nextCursor: `${last.at}|${last.id}` } : {}), total: inWindow.length, counts },
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
  items: Array<{ denTopicId: string; hash?: string; ageMs: number; domain?: string }>;
}
export interface BadContribution {
  /** The quarantined file's full name (stable key; `x.md` and `x.raw` stay distinct). */
  id: string;
  wolf: string;
  denTopicId?: string;
  domainHint?: string;
  /** First line of the reason sidecar, capped; callers sanitise further. */
  reason: string;
  /** The body file's mtime, i.e. when it was submitted / quarantined (not when the sidecar was written). */
  at: string;
}
export const BAD_MAX = 50;
export const BAD_REASON_MAX = 300;
const HEAD_BYTES = 4096;
/** The hub's domain-name shape: a hint or directory that fails it is never a domain. */
export const DOMAIN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * The first `bytes` of a REGULAR file, or undefined. The inbox is wolf-writable, so a symlink (could point at any hub-readable file),
 * a FIFO or a device (could block the event loop) is refused: lstat first, then open with O_NOFOLLOW | O_NONBLOCK and fstat the descriptor.
 */
function readHeadSafe(file: string, bytes: number): string | undefined {
  try {
    const l = lstatSync(file);
    if (!l.isFile() || l.isSymbolicLink()) return undefined;
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!fstatSync(fd).isFile()) return undefined;
      const buf = Buffer.alloc(bytes);
      const n = readSync(fd, buf, 0, bytes, 0);
      return buf.subarray(0, n).toString("utf-8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}
/** The item the sweep is working on right now (`<denLocal>/sweep-current.json`), read as a regular non-symlink file; absent on any problem. */
export interface SweepCurrent { from: string; denTopicId: string; startedAt: number; route?: string }
export function readSweepCurrent(denLocal: string): SweepCurrent | undefined {
  const raw = readHeadSafe(join(denLocal, "sweep-current.json"), 4096);
  if (raw === undefined) return undefined;
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    if (typeof j.from !== "string" || !j.from || typeof j.denTopicId !== "string" || !j.denTopicId) return undefined;
    if (typeof j.startedAt !== "number" || !Number.isFinite(j.startedAt)) return undefined;
    const out: SweepCurrent = { from: oneLine(j.from, 80), denTopicId: oneLine(j.denTopicId, 200), startedAt: j.startedAt };
    if (typeof j.route === "string" && j.route) out.route = oneLine(j.route, 200);
    return out;
  } catch {
    return undefined;
  }
}
/** True for a real directory (not a symlink to one). The inbox is wolf-writable: never list through a symlinked directory. */
function realDir(path: string): boolean {
  try {
    const l = lstatSync(path);
    return l.isDirectory() && !l.isSymbolicLink();
  } catch {
    return false;
  }
}
/** lstat of a regular, non-symlink file, or undefined. */
function regularStat(file: string): { mtimeMs: number } | undefined {
  try {
    const l = lstatSync(file);
    return l.isFile() && !l.isSymbolicLink() ? { mtimeMs: l.mtimeMs } : undefined;
  } catch {
    return undefined;
  }
}
const unquote = (v: string): string => {
  const t = v.trim();
  return t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0] ? t.slice(1, -1) : t;
};
/** `domain_hint:` from the FRONTMATTER block of a file head (never the body). Empty when absent. */
function frontmatterHint(head: string): string {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head)?.[1];
  if (fm === undefined) return "";
  const raw = /^domain_hint:[ \t]*(.*)$/m.exec(fm)?.[1];
  return raw === undefined ? "" : unquote(raw);
}

/** Per-path caches keyed by mtime; entries of a scanned directory that are no longer listed are pruned (no whole-cache wipe). */
const hintCache = new Map<string, { mtime: number; hint: string }>();
const badCache = new Map<string, { mtime: number; sidecarMtime: number; info: Omit<BadContribution, "wolf" | "at" | "id"> }>();
function prune(cache: Map<string, unknown>, dir: string, keep: Set<string>): void {
  const prefix = dir + "/";
  for (const k of cache.keys()) if (k.startsWith(prefix) && !keep.has(k)) cache.delete(k);
}

function inboxHint(file: string, mtime: number): string {
  const hit = hintCache.get(file);
  if (hit && hit.mtime === mtime) return hit.hint;
  const head = readHeadSafe(file, HEAD_BYTES);
  const hint = head === undefined ? "" : frontmatterHint(head);
  hintCache.set(file, { mtime, hint });
  return hint;
}

function readBadInfo(file: string, name: string, mtime: number): Omit<BadContribution, "wolf" | "at" | "id"> {
  const sidecarMtime = regularStat(`${file}.reason.txt`)?.mtimeMs ?? 0; // 0: no sidecar (yet); a later one changes the key
  const hit = badCache.get(file);
  let info = hit && hit.mtime === mtime && hit.sidecarMtime === sidecarMtime ? hit.info : undefined;
  if (!info) {
    let denTopicId: string | undefined;
    let domainHint: string | undefined;
    const head = readHeadSafe(file, HEAD_BYTES);
    if (head !== undefined) {
      if (name.endsWith(".md")) {
        const m = FILE_RE.exec(name);
        denTopicId = m ? m[1] : name.slice(0, -3);
        domainHint = frontmatterHint(head) || undefined;
      } else {
        let j: Record<string, unknown> | undefined;
        try {
          j = JSON.parse(head) as Record<string, unknown>;
        } catch {
          /* truncated body: pick the fields by pattern */
        }
        const pick = (k: string): string | undefined => (typeof j?.[k] === "string" ? (j[k] as string) : new RegExp(`"${k}"\\s*:\\s*"([^"\\n]{0,200})"`).exec(head)?.[1]);
        denTopicId = pick("denTopicId");
        domainHint = pick("domainHint");
      }
    }
    const sidecar = readHeadSafe(`${file}.reason.txt`, 1024) ?? "";
    const reason = oneLine(sidecar.split("\n").find((l) => l.trim() !== "") ?? "", BAD_REASON_MAX) || "quarantined";
    info = { ...(denTopicId ? { denTopicId: oneLine(denTopicId, ID_MAX) } : {}), ...(domainHint ? { domainHint: oneLine(domainHint, 64) } : {}), reason };
    badCache.set(file, { mtime, sidecarMtime, info });
  }
  return info;
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

export interface Incoming {
  total: number;
  wolves: IncomingWolf[];
  bad: BadContribution[];
  /** Waiting contributions per KNOWN domain (a Map: hints are wolf-written). SAMPLED: only the first INCOMING_STAT_CAP files per wolf are read. */
  waitingByDomain: Map<string, number>;
}

/**
 * The pending lane `<inboxRoot>/<wolf>/<denTopicId>-<hash10>.md`. Top-level `.md` files only: `_processed/`, `_bad/` and dotfiles
 * (`.sweep-lease*`, `.*.tmp`) are never pending. `pending` is counted from the directory listing alone. `hash` is the 10-hex tag
 * of the file name (a prefix of the ledger hash). `known`: the real domains; a hint outside it is ignored (no item domain, not counted
 * in `waitingByDomain`); without it any well-formed domain name counts.
 *
 * Files are only ever read as regular, non-symlink files, head only (see readHeadSafe). `bad`: the quarantined files of all wolves, newest
 * first across ALL of them, capped at BAD_MAX; only those are read.
 *
 * APPROXIMATION: ages come from mtimes, and only the first INCOMING_STAT_CAP (2000) files (by name) of a wolf are stat'ed; above that `pending` is still the exact listing count. `items` (at most 20,
 * oldest first), `oldestAgeMs` and `waitingByDomain` are taken from that sample. Up to 2000 pending files per wolf the answer is exact.
 */
export function readIncoming(inboxRoot: string, now: number = Date.now(), known?: ReadonlySet<string>): Incoming {
  const wolves: IncomingWolf[] = [];
  const waitingByDomain = new Map<string, number>();
  const badCandidates: Array<{ wolf: string; dir: string; name: string; mtime: number }> = [];
  let total = 0;
  const keptHint = new Set<string>();
  const keptBad = new Set<string>();
  const names = safeDir(() => readdirSync(inboxRoot, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith("_") && !d.name.startsWith(".")).map((d) => d.name).sort(), [] as string[]);
  const okHint = (h: string): boolean => h !== "" && DOMAIN_RE.test(h) && (known ? known.has(h) : true);
  for (const wolf of names) {
    const dir = join(inboxRoot, wolf);
    if (!realDir(dir)) continue;
    const listed = safeDir(() => readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && !e.name.startsWith(".") && e.name.endsWith(".md")).map((e) => e.name).sort(), [] as string[]);
    const sampled: Array<{ f: string; mtime: number }> = [];
    for (const f of listed.slice(0, INCOMING_STAT_CAP)) {
      const st = regularStat(join(dir, f));
      if (st) sampled.push({ f, mtime: st.mtimeMs });
    }
    sampled.sort((a, b) => a.mtime - b.mtime || a.f.localeCompare(b.f));
    const badDir = join(dir, "_bad");
    const badFiles = !realDir(badDir) ? undefined : safeDir(() => readdirSync(badDir).filter((f) => !f.startsWith(".") && !f.endsWith(".reason.txt")).sort(), undefined as string[] | undefined);
    if (badFiles) {
      for (const name of badFiles.slice(0, INCOMING_STAT_CAP)) {
        const st = regularStat(join(badDir, name));
        if (st) badCandidates.push({ wolf, dir: badDir, name, mtime: st.mtimeMs });
      }
    }
    const badCount = badFiles?.length;
    for (const f of badFiles ?? []) keptBad.add(join(badDir, f));
    for (const f of listed) keptHint.add(join(dir, f));
    if (listed.length === 0 && !badCount) continue;
    total += listed.length;
    // Hints only for the 20 shown items are NOT enough for the per-domain count, so read every sampled file (head only, cached by mtime).
    const hintOf = new Map<string, string>();
    for (const { f, mtime } of sampled) {
      const h = inboxHint(join(dir, f), mtime);
      if (okHint(h)) {
        hintOf.set(f, h);
        waitingByDomain.set(h, (waitingByDomain.get(h) ?? 0) + 1);
      }
    }
    wolves.push({
      wolf,
      pending: listed.length,
      ...(sampled.length ? { oldestAgeMs: Math.max(0, Math.round(now - sampled[0].mtime)) } : {}),
      ...(badCount !== undefined ? { bad: badCount } : {}),
      items: sampled.slice(0, INCOMING_ITEMS_PER_WOLF).map(({ f, mtime }) => {
        const m = FILE_RE.exec(f);
        const domain = hintOf.get(f);
        return { denTopicId: m ? m[1] : f.slice(0, -3), ...(m ? { hash: m[2] } : {}), ageMs: Math.max(0, Math.round(now - mtime)), ...(domain ? { domain: short(domain) } : {}) };
      }),
    });
  }
  // Drop cache entries of files that are gone, including those of drained or vanished wolves.
  prune(hintCache, inboxRoot, keptHint);
  prune(badCache, inboxRoot, keptBad);
  badCandidates.sort((a, b) => b.mtime - a.mtime || a.wolf.localeCompare(b.wolf) || a.name.localeCompare(b.name));
  const bad = badCandidates.slice(0, BAD_MAX).map((c) => {
    const id = oneLine(c.name, 120);
    return { id, wolf: c.wolf, ...readBadInfo(join(c.dir, c.name), c.name, c.mtime), at: new Date(c.mtime).toISOString() } as BadContribution;
  });
  return { total, wolves, bad, waitingByDomain };
}
