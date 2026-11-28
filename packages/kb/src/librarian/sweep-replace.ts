/**
 * sweep-replace — oversize-section handling and re-placement, split out of sweep.ts:
 *  - the "a rebuild is due" notice (plus the optional host hook `onSplitDue`, R6), and
 *  - replaceMisfits (R7): re-home entries whose own section no longer fits them. Dry run by default at the sweep.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { HIERARCHY } from "@wolfpack/engine";
import { ev, entriesDir, type KbEvent, type KbRoots } from "../shared/index.js";
import type { Section } from "../schema/knowledge.js";
import { DEFAULT_RULES } from "./tree-rules.js";
import { cosine } from "./embed.js";
import { readEntryCached } from "./entry-cache.js";
import { routeByTree, type EntryVector } from "./route.js";

/** At most this many entries are re-homed per sweep. */
export const MAX_REPLACEMENTS_PER_SWEEP = 10;
/** At most this many candidates (worst fit first) are routed per sweep: bounds the work on a big domain. */
export const MAX_CANDIDATES_EXAMINED = 50;
/** A domain rebuilt less than this long ago is left alone (the rebuild just placed everything). */
export const REPLACE_AFTER_REBUILD_MS = 24 * 60 * 60 * 1000;

/** One parent section over the split threshold (`threshold` is the domain-scaled value it was measured against, when known). */
export interface OversizeSection { id: string; domain: string; count: number; threshold?: number }

/** Host hook: a domain has sections whose direct entries outgrew the split threshold. Fire and forget (never fails the sweep). */
export type SplitDueHook = (domain: string, sections: { id: string; count: number }[]) => void | Promise<void>;

/** Whether a parent's direct-entry count outgrew the split threshold (default: the current fixed one; callers may pass a domain-scaled value). */
export function exceedsSplitAbove(directEntries: number, threshold: number = DEFAULT_RULES.splitAbove): boolean {
  return directEntries > threshold;
}

/**
 * Tell the host once per sweep that parent sections outgrew the split threshold. Logs one line; with `hook`, also calls it once per
 * domain without blocking. Returns the hook calls' promises (settled, never rejecting) so a caller or test can await them.
 */
export function notifySplitDue(
  notify: ((msg: string) => void) | undefined,
  big: OversizeSection[],
  hook?: SplitDueHook,
  threshold: number = DEFAULT_RULES.splitAbove,
): Promise<void>[] {
  if (!big.length) return [];
  const thresholds = [...new Set(big.map((b) => b.threshold ?? threshold))].sort((a, b) => a - b);
  notify?.(`sweep: ${big.length} parent section(s) hold more than ${thresholds.join("/")} direct entries (${big.map((b) => `${b.id} (${b.count})`).join(", ")}); a rebuild is due`);
  if (!hook) return [];
  const byDomain = new Map<string, { id: string; count: number }[]>();
  for (const b of big) {
    if (!byDomain.has(b.domain)) byDomain.set(b.domain, []);
    byDomain.get(b.domain)!.push({ id: b.id, count: b.count });
  }
  return [...byDomain].map(([domain, list]) =>
    Promise.resolve()
      .then(() => hook(domain, list))
      .catch((e) => notify?.(`sweep: onSplitDue hook failed for ${domain}: ${e instanceof Error ? e.message : String(e)}`)),
  );
}

/** Dry-run findings already logged in this process (entry|target), so a repeated sweep stays quiet. */
const loggedWouldReplace = new Set<string>();

export interface ReplaceContext {
  roots: KbRoots;
  sections: Section[];
  /** Domains to look at (the sweep passes the ones it touched). */
  domains: string[];
  loadEntryVectors: () => Promise<EntryVector[]>;
  writer: {
    patchEntry(roots: KbRoots, domain: string, id: string, content: string): void | Promise<void>;
    appendLedger(roots: KbRoots, events: KbEvent[]): void | Promise<void>;
  };
  notify?: (msg: string) => void;
  /** Plan only: log the moves, write nothing. */
  dryRun?: boolean;
  /** The ledger so far: a domain whose last `sections_replaced` (a rebuild apply) is under 24h old is skipped. */
  ledger?: KbEvent[];
  now?: () => number;
  /** Override the placement thresholds (default: HIERARCHY.fitThreshold / DEFAULT_RULES.misplacedMargin). */
  fitThreshold?: number;
  margin?: number;
  maxMoves?: number;
  maxExamined?: number;
}

export interface Replacement { entryId: string; domain: string; from: string; to: string; fromFit: number; toFit: number }

/**
 * Re-home misfit entries. Candidates: fit to their own section's centroid below the placement threshold, worst first (at most
 * MAX_CANDIDATES_EXAMINED); anchors and grouped entries are skipped. A candidate moves only when the tree routes it elsewhere, the
 * target fits at least the threshold and beats the current fit by the misplacement margin. At most MAX_REPLACEMENTS_PER_SWEEP moves.
 * Returns the moves made (or planned, in dry run).
 */
export async function replaceMisfits(ctx: ReplaceContext): Promise<Replacement[]> {
  const threshold = ctx.fitThreshold ?? HIERARCHY.fitThreshold;
  const margin = ctx.margin ?? DEFAULT_RULES.misplacedMargin;
  const cap = ctx.maxMoves ?? MAX_REPLACEMENTS_PER_SWEEP;
  const examine = ctx.maxExamined ?? MAX_CANDIDATES_EXAMINED;
  const now = (ctx.now ?? Date.now)();
  const vectors = await ctx.loadEntryVectors();
  const centroid = new Map(ctx.sections.map((s) => [String(s.id), s.centroid] as const));
  const out: Replacement[] = [];
  for (const domain of ctx.domains) {
    // A rebuild's apply is the ledger's `sections_replaced` for the domain; the rebuild just placed every entry.
    const rebuilt = (ctx.ledger ?? []).filter((e) => e.t === "sections_replaced" && (e as { domain?: string }).domain === domain).map((e) => Date.parse(e.at));
    if (rebuilt.length && now - Math.max(...rebuilt) < REPLACE_AFTER_REBUILD_MS) continue;
    const dir = entriesDir(ctx.roots, domain);
    if (!existsSync(dir)) continue;
    const inDomain = vectors.filter((v) => v.domain === domain);
    const domainSections = ctx.sections.filter((s) => String(s.domain) === domain);
    const cands: { id: string; from: string; fit: number; vec: EntryVector; raw: string }[] = [];
    for (const v of inDomain) {
      try {
        const e = readEntryCached(join(dir, `${v.entryId}.md`));
        const from = String(e?.fields.section ?? "");
        const c = centroid.get(from);
        if (!e || !from || !c || e.anchor() || e.group()) continue;
        const fit = cosine(v.vector, c);
        if (fit < threshold) cands.push({ id: v.entryId, from, fit, vec: v, raw: e.raw });
      } catch { continue; }
    }
    cands.sort((a, b) => a.fit - b.fit || (a.id < b.id ? -1 : 1));
    for (const c of cands.slice(0, examine)) {
      if (out.length >= cap) break;
      const d = routeByTree(c.vec.vector, domain, domainSections, inDomain);
      if (d.section === "_unplaced" || String(d.section) === c.from) continue;
      if (d.fit < threshold || d.fit < c.fit + margin) continue;
      if (!/^section: .+$/m.test(c.raw)) continue;
      const m: Replacement = { entryId: c.id, domain, from: c.from, to: String(d.section), fromFit: c.fit, toFit: d.fit };
      const memo = `${ctx.roots.kbBase}|${domain}|${c.id}|${m.to}`;
      const quiet = ctx.dryRun && loggedWouldReplace.has(memo);
      if (ctx.dryRun) loggedWouldReplace.add(memo);
      if (!quiet) ctx.notify?.(`sweep: ${ctx.dryRun ? "would re-place" : "re-placing"} ${c.id}: ${c.from} (${c.fit.toFixed(2)}) -> ${m.to} (${d.fit.toFixed(2)}) [replace-misfit]`);
      if (!ctx.dryRun) {
        await ctx.writer.patchEntry(ctx.roots, domain, c.id, c.raw.replace(/^section: .+$/m, `section: ${m.to}`));
        // entry_placed has no reason field and a closed basis enum: "routed" is the closest; the reason is only in the notify log.
        await ctx.writer.appendLedger(ctx.roots, [ev.entryPlaced({ entryId: c.id, sectionId: m.to, basis: "routed", fit: d.fit })]);
      }
      out.push(m);
    }
  }
  return out;
}
