/**
 * GET /v1/kb/activity: the hub's own ledger, contributions lane and curator state. No relay to a wolf.
 *
 * Query: `since` (7d|30d|all|ISO, default 30d), `before` (cursor), `limit` (1..200, default 50; larger values are clamped to 200),
 * `domain`. `domain` restricts `changes` and the decision feed to one domain (`(unplaced)` selects entries whose domain cannot be
 * resolved). A decision belongs to its entry's domain, else to its contribution's domain hint when that is a real
 * domain; with `domain` set, decisions with neither are excluded from the feed and its counts. `since` applies to decisions AND changes.
 *
 * Caches (two, independent):
 *  - ledger index (events -> ActivityIndex) keyed on the ledger file's (mtimeMs, size); rebuilt only when the ledger changes.
 *  - entry-id -> domain map (a directory listing, no file is opened) with a short TTL (ENTRY_SCAN_TTL_MS), so a sweep that appends
 *    to the ledger never triggers a full entry scan, and entries moved without a ledger append show up within the TTL.
 *    Titles are read per request, only for the (at most 10 per domain) change items returned, so a title edit shows immediately.
 * The lane is read fresh every time (bounded directory listings, see readIncoming). A missing ledger is the empty index.
 */
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { oneLine, buildActivityIndex, fsEntryResolver, listDomains, pageActivity, readIncoming, readLedger, scanEntryDomains, UNPLACED, type ActivityIndex } from "@wolfpack/kb/librarian";
import { ledgerFile, type KbRoots } from "@wolfpack/kb/shared";
import type { KbActivityResponse } from "@wolfpack/protocol";
import type { Curator } from "./curator.js";
import { HubError } from "./errors.js";
import { CONTRIBUTIONS_LANE } from "./layout.js";

/** A curator error for display: first line, absolute paths reduced to their basename (or <path>), secrets redacted, capped. */
export function safeError(e: string): string {
  const line = e.split("\n").find((l) => l.trim() !== "") ?? "";
  const paths = line.replace(/(?:[A-Za-z]:)?(?:[\\/][^\s'"`:,;()<>\\/]+){2,}[\\/]?/g, (m) => {
    const base = m.split(/[\\/]/).filter(Boolean).pop();
    return base && base.length <= 60 ? base : "<path>";
  });
  return oneLine(paths, 240);
}

export const ENTRY_SCAN_TTL_MS = 5_000;

export interface KbActivityQuery {
  since?: string | null;
  before?: string | null;
  limit?: string | null;
  domain?: string | null;
}

export interface KbActivity {
  read(query: KbActivityQuery): KbActivityResponse;
}

const DAY = 86_400_000;
const ISO_RE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;

export function createKbActivity(d: { roots: KbRoots; inboxRoot: string; receiptsRoot: string; curator?: Curator; now?: () => number }): KbActivity {
  const now = d.now ?? Date.now;
  let cached: { sig: string; index: ActivityIndex } | undefined;
  let domains: { at: number; map: Map<string, string> } | undefined;
  const lane: "hub" | "custom" = resolve(d.inboxRoot) === resolve(d.roots.opsRoot, CONTRIBUTIONS_LANE) ? "hub" : "custom";

  const index = (): ActivityIndex => {
    let sig = "none";
    try {
      const s = statSync(ledgerFile(d.roots));
      sig = `${s.mtimeMs}:${s.size}`;
    } catch {
      /* no ledger yet */
    }
    if (cached?.sig === sig) return cached.index;
    const built = buildActivityIndex(sig === "none" ? [] : readLedger(d.roots));
    cached = { sig, index: built };
    return built;
  };

  const entryDomains = (t: number): Map<string, string> => {
    if (!domains || t - domains.at >= ENTRY_SCAN_TTL_MS || t < domains.at) domains = { at: t, map: scanEntryDomains(d.roots.kbBase) };
    return domains.map;
  };

  return {
    read(q) {
      const t = now();
      let sinceMs: number | undefined;
      const since = q.since ?? "30d";
      if (since === "all") sinceMs = undefined;
      else if (since === "7d" || since === "30d") sinceMs = t - (since === "7d" ? 7 : 30) * DAY;
      else {
        const p = ISO_RE.test(since) ? Date.parse(since) : NaN;
        if (!Number.isFinite(p)) throw new HubError("invalid_request", "since must be 7d, 30d, all or an ISO timestamp");
        sinceMs = p;
      }
      let limit = 50;
      if (q.limit != null) {
        if (!/^\d{1,6}$/.test(q.limit) || Number(q.limit) < 1) throw new HubError("invalid_request", "limit must be an integer >= 1 (values above 200 are clamped to 200)");
        limit = Math.min(200, Number(q.limit));
      }
      if (q.before != null && !/^[^|]{1,64}\|[^|]{1,128}$/.test(q.before)) throw new HubError("invalid_request", "before is not a cursor from nextCursor");
      const domain = q.domain ? q.domain : undefined;
      if (domain !== undefined && domain !== UNPLACED && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(domain)) throw new HubError("invalid_request", "malformed domain");

      const idx = index();
      const page = pageActivity(idx, { sinceMs, ...(q.before != null ? { before: q.before } : {}), limit, ...(domain ? { domain } : {}) }, fsEntryResolver(d.roots.kbBase, entryDomains(t)));
      const emap = entryDomains(t);
      const knownDomains = new Set([...listDomains(d.roots.kbBase), ...emap.values()]);
      const { waitingByDomain, bad, ...lane_ } = readIncoming(d.inboxRoot, t, knownDomains);
      const incoming = { ...lane_, bad: bad.map((b) => ({ ...b, reason: safeError(b.reason) })) };
      const entryCount = new Map<string, number>();
      for (const dom of emap.values()) entryCount.set(dom, (entryCount.get(dom) ?? 0) + 1);
      const act = new Map(page.domains.map((x) => [x.domain, x]));
      const names = new Set([...listDomains(d.roots.kbBase), ...entryCount.keys()]);
      const domainSummaries = [...names].sort().map((name) => {
        const a = act.get(name);
        return { domain: name, entries: entryCount.get(name) ?? 0, waiting: waitingByDomain.get(name) ?? 0, ...(a?.lastChangeAt ? { lastChangeAt: a.lastChangeAt } : {}), contributors: a?.contributors ?? [], decided: a?.decided ?? 0, recent: a?.recent ?? [] };
      });
      const st = d.curator?.status();
      const on = st?.enabled === true;
      const badBy = new Map<string, number>();
      for (const w of incoming.wolves) if (w.bad) badBy.set(w.wolf, w.bad);
      const attWolves = new Set([...page.attention.map((a) => a.wolf), ...badBy.keys()]);
      const attention = [...attWolves].sort().map((wolf) => {
        const a = page.attention.find((x) => x.wolf === wolf);
        return { wolf, reject: a?.reject ?? 0, parked: a?.parked ?? 0, unclassified: a?.unclassified ?? 0, bad: badBy.get(wolf) ?? 0, items: a?.items ?? [] };
      });
      return {
        generatedAt: new Date(t).toISOString(),
        source: { lane, hasDecisions: page.hasDecisions, curator: on ? "on" : "off" },
        incoming,
        domains: domainSummaries,
        attention,
        decisions: page.decisions,
        changes: page.changes,
        ...(on && st ? { sweep: { running: st.running, ...(st.last ? { last: { ...st.last, ...(st.last.error ? { error: safeError(st.last.error) } : {}) } } : {}) } } : {}),
      } as KbActivityResponse;
    },
  };
}
