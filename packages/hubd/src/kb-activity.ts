/**
 * GET /v1/kb/activity: the hub's own ledger, contributions lane and curator state. No relay to a wolf.
 *
 * Cache: the parsed ledger (events -> ActivityIndex, plus the entry-file scan that resolves domains and titles) is kept per
 * ledger file signature (mtimeMs, size). An append changes the size, so the next read re-parses; reads in between cost two stat
 * calls and the paging pass. The lane is read fresh every time (directory listings). A missing ledger is the empty index.
 */
import { statSync } from "node:fs";
import { buildActivityIndex, pageActivity, readIncoming, readLedger, scanEntryInfo, type ActivityIndex } from "@wolfpack/kb/librarian";
import { ledgerFile, type KbRoots } from "@wolfpack/kb/shared";
import type { KbActivityResponse } from "@wolfpack/protocol";
import type { Curator } from "./curator.js";
import { HubError } from "./errors.js";
import { contributionsRoot } from "./layout.js";

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
  const lane: "hub" | "custom" = d.inboxRoot === contributionsRoot(d.roots.denLocal) || d.inboxRoot === `${d.roots.opsRoot}/contributions` ? "hub" : "custom";

  const index = (): ActivityIndex => {
    let sig = "none";
    try {
      const s = statSync(ledgerFile(d.roots));
      sig = `${s.mtimeMs}:${s.size}`;
    } catch {
      /* no ledger yet */
    }
    if (cached?.sig === sig) return cached.index;
    const built = buildActivityIndex(sig === "none" ? [] : readLedger(d.roots), scanEntryInfo(d.roots.kbBase));
    cached = { sig, index: built };
    return built;
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
        if (!/^\d{1,6}$/.test(q.limit) || Number(q.limit) < 1) throw new HubError("invalid_request", "limit must be an integer from 1 to 200");
        limit = Math.min(200, Number(q.limit));
      }
      if (q.before != null && !/^[^|]{1,64}\|[^|]{1,128}$/.test(q.before)) throw new HubError("invalid_request", "before is not a cursor from nextCursor");
      const domain = q.domain ? q.domain : undefined;
      if (domain !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(domain)) throw new HubError("invalid_request", "malformed domain");

      const idx = index();
      const page = pageActivity(idx, { sinceMs, ...(q.before != null ? { before: q.before } : {}), limit, ...(domain ? { domain } : {}) });
      const incoming = readIncoming(d.inboxRoot, t);
      const st = d.curator?.status();
      const on = st?.enabled === true;
      return {
        generatedAt: new Date(t).toISOString(),
        source: { lane, hasDecisions: page.hasDecisions, curator: on ? "on" : "off" },
        incoming,
        decisions: page.decisions,
        changes: page.changes,
        ...(on && st ? { sweep: { running: st.running, ...(st.last ? { last: st.last } : {}) } } : {}),
      } as KbActivityResponse;
    },
  };
}
