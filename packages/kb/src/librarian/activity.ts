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
  /** Latest decision per key, newest first. Each carries its domain (undefined: unresolved) for the filter. */
  decisions: Array<{ d: ActivityDecision; domain?: string }>;
  /** Per domain, newest first, uncapped (the page applies the cap). */
  changes: Map<string, ActivityChange[]>;
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

/** Newest first: by `at`, then id. */
const newer = (a: { at: string; id?: string }, b: { at: string; id?: string }) => (a.at === b.at ? (b.id ?? "").localeCompare(a.id ?? "") : b.at.localeCompare(a.at));

/** entryId -> {domain,title} from `<kbBase>/domains/<domain>/entries/<id>.md` (frontmatter title). One directory walk. */
export function scanEntryInfo(kbBase: string): Map<string, EntryInfo> {
  const out = new Map<string, EntryInfo>();
  let domains: string[] = [];
  try {
    domains = readdirSync(join(kbBase, "domains"), { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith("_") && !d.name.startsWith(".")).map((d) => d.name);
  } catch {
    return out;
  }
  for (const domain of domains) {
    let files: string[] = [];
    try {
      files = readdirSync(join(kbBase, "domains", domain, "entries")).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    for (const f of files) {
      const id = f.slice(0, -3);
      let title: string | undefined;
      try {
        const t = parseFrontmatter(readFileSync(join(kbBase, "domains", domain, "entries", f), "utf-8")).fields.title;
        if (typeof t === "string" && t.trim()) title = oneLine(t, 200);
      } catch {
        /* unreadable entry: no title */
      }
      out.set(id, { domain, ...(title ? { title } : {}) });
    }
  }
  return out;
}

export function buildActivityIndex(events: KbEvent[], entryInfo: Map<string, EntryInfo> | ((id: string) => EntryInfo | undefined) = new Map()): ActivityIndex {
  const info = typeof entryInfo === "function" ? entryInfo : (id: string) => entryInfo.get(id);
  const latest = new Map<string, { e: Decision; n: number }>();
  const decisionOfEntry = new Map<string, Decision>();
  const sectionDomain = new Map<string, string>();
  const placedSection = new Map<string, string>();
  let hasDecisions = false;
  for (const e of events) {
    switch (e.t) {
      case "decision": {
        hasDecisions = true;
        const k = JSON.stringify([e.from, e.denTopicId, e.hash]);
        const prev = latest.get(k);
        // "Latest" = last in ledger order; the ledger is append-only, so file order is time order.
        latest.set(k, { e, n: (prev?.n ?? 0) + 1 });
        if (e.entryId) decisionOfEntry.set(e.entryId, e);
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
  }
  const domainOf = (entryId: string): string | undefined => info(entryId)?.domain ?? sectionDomain.get(placedSection.get(entryId) ?? "");

  const decisions = [...latest.values()].map(({ e, n }) => {
    const d: ActivityDecision = {
      id: e.id,
      at: e.at,
      from: e.from,
      denTopicId: e.denTopicId,
      hash: e.hash,
      outcome: e.outcome,
      ...(e.entryId ? { entryId: e.entryId } : {}),
      ...(e.reason ? { reason: oneLine(e.reason, REASON_MAX) } : {}),
      ...(e.routing ? { routing: e.routing } : {}),
      ...(n > 1 ? { superseded: n - 1 } : {}),
    };
    return { d, ...(e.entryId && domainOf(e.entryId) ? { domain: domainOf(e.entryId) } : {}) };
  });
  decisions.sort((a, b) => newer(a.d, b.d));

  const changes = new Map<string, ActivityChange[]>();
  for (const e of events) {
    if (e.t !== "entry_written" && e.t !== "entry_retired") continue;
    const dec = decisionOfEntry.get(e.entryId);
    const title = info(e.entryId)?.title;
    const c: ActivityChange = {
      at: e.at,
      entryId: e.entryId,
      ...(title ? { title } : {}),
      action: e.t === "entry_retired" ? "retire" : e.action,
      ...(dec ? { from: dec.from, denTopicId: dec.denTopicId } : {}),
    };
    const dom = domainOf(e.entryId) ?? UNPLACED;
    const list = changes.get(dom) ?? [];
    list.push(c);
    changes.set(dom, list);
  }
  for (const [dom, list] of changes) {
    list.reverse(); // ledger order is time order: newest first
    list.sort((a, b) => (a.at === b.at ? 0 : b.at.localeCompare(a.at))); // stable: ties keep the reversed ledger order
    changes.set(dom, list);
  }
  return { hasDecisions, decisions, changes };
}

export function pageActivity(index: ActivityIndex, q: ActivityQuery = {}): ActivityPage {
  const limit = q.limit ?? 50;
  const counts = Object.fromEntries(ACTIVITY_OUTCOMES.map((o) => [o, 0])) as Record<ActivityOutcome, number>;
  const inWindow = index.decisions.filter(({ d, domain }) => {
    if (q.domain !== undefined && domain !== q.domain) return false;
    if (q.sinceMs !== undefined) {
      const t = Date.parse(d.at);
      if (!Number.isFinite(t) || t < q.sinceMs) return false;
    }
    return true;
  });
  for (const { d } of inWindow) counts[d.outcome]++;
  let rest = inWindow;
  if (q.before !== undefined) {
    const i = q.before.indexOf("|");
    const cur = { at: q.before.slice(0, i), id: q.before.slice(i + 1) };
    rest = inWindow.filter(({ d }) => newer(cur, d) < 0); // strictly older than the cursor
  }
  const page = rest.slice(0, limit).map((x) => x.d);
  const last = page[page.length - 1];
  const domains = [...index.changes.keys()]
    .filter((d) => q.domain === undefined || d === q.domain)
    .sort((a, b) => (a === UNPLACED ? 1 : b === UNPLACED ? -1 : a.localeCompare(b)))
    .map((domain) => ({ domain, items: index.changes.get(domain)!.slice(0, CHANGES_PER_DOMAIN) }));
  return {
    hasDecisions: index.hasDecisions,
    decisions: { items: page, ...(rest.length > limit && last ? { nextCursor: `${last.at}|${last.id}` } : {}), total: inWindow.length, counts },
    changes: { domains },
  };
}

export function foldKbActivity(events: KbEvent[], opts: ActivityQuery & { entryInfo?: Map<string, EntryInfo> | ((id: string) => EntryInfo | undefined) } = {}): ActivityPage {
  return pageActivity(buildActivityIndex(events, opts.entryInfo), opts);
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

/**
 * The pending lane `<inboxRoot>/<wolf>/<denTopicId>-<hash10>.md`. Top-level `.md` files only: `_processed/`, `_bad/` and dotfiles
 * (`.sweep-lease*`, `.*.tmp`) are never pending. `hash` is the 10-hex tag of the file name (a prefix of the ledger hash).
 * Items are oldest first, at most 20 per wolf.
 */
export function readIncoming(inboxRoot: string, now: number = Date.now()): { total: number; wolves: IncomingWolf[] } {
  const wolves: IncomingWolf[] = [];
  let total = 0;
  const names = safeDir(() => readdirSync(inboxRoot, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith("_") && !d.name.startsWith(".")).map((d) => d.name).sort(), [] as string[]);
  for (const wolf of names) {
    const dir = join(inboxRoot, wolf);
    const files: Array<{ f: string; mtime: number }> = [];
    for (const f of safeDir(() => readdirSync(dir), [] as string[])) {
      if (f.startsWith(".") || !f.endsWith(".md")) continue;
      const mtime = safeDir(() => {
        const s = statSync(join(dir, f));
        return s.isFile() ? s.mtimeMs : undefined;
      }, undefined);
      if (mtime !== undefined) files.push({ f, mtime });
    }
    files.sort((a, b) => a.mtime - b.mtime || a.f.localeCompare(b.f));
    const badDir = join(dir, "_bad");
    const bad = existsSync(badDir) ? safeDir(() => readdirSync(badDir).filter((f) => !f.startsWith(".") && !f.endsWith(".reason.txt")).length, 0) : undefined;
    if (files.length === 0 && !bad) continue;
    total += files.length;
    wolves.push({
      wolf,
      pending: files.length,
      ...(files.length ? { oldestAgeMs: Math.max(0, Math.round(now - files[0].mtime)) } : {}),
      ...(bad !== undefined ? { bad } : {}),
      items: files.slice(0, INCOMING_ITEMS_PER_WOLF).map(({ f, mtime }) => {
        const m = FILE_RE.exec(f);
        return { denTopicId: m ? m[1] : f.slice(0, -3), ...(m ? { hash: m[2] } : {}), ageMs: Math.max(0, Math.round(now - mtime)) };
      }),
    });
  }
  return { total, wolves };
}
