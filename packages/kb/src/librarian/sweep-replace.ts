/**
 * sweep-replace — oversize-section handling and re-placement, split out of sweep.ts:
 *  - the "a rebuild is due" notice (plus the optional host hook `onSplitDue`, R6), and
 *  - replaceMisfits (R7): re-home entries whose own section no longer fits them.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { HIERARCHY } from "@wolfpack/engine";
import { ev, entriesDir, type KbEvent, type KbRoots } from "../shared/index.js";
import type { Section } from "../schema/knowledge.js";
import { DEFAULT_RULES } from "./tree-rules.js";
import { cosine } from "./embed.js";
import { listEntryFiles, readEntryCached } from "./entry-cache.js";
import { routeByTree, type EntryVector } from "./route.js";

/** At most this many entries are re-homed per sweep. */
export const MAX_REPLACEMENTS_PER_SWEEP = 10;

/** Host hook: a domain has sections whose direct entries outgrew the split threshold. Fire and forget (never fails the sweep). */
export type SplitDueHook = (domain: string, sections: { id: string; count: number }[]) => void | Promise<void>;

/** Whether a parent's direct-entry count outgrew the split threshold (default: the current fixed one; callers may pass a domain-scaled value). */
export function exceedsSplitAbove(directEntries: number, threshold: number = DEFAULT_RULES.splitAbove): boolean {
  return directEntries > threshold;
}

/**
 * Tell the host once per sweep that parent sections outgrew the split threshold; `big` is "id (n)" per parent.
 * With `hook` and `sections` (to find each parent's domain) the hook is also called once per domain, without blocking.
 */
export function notifySplitDue(
  notify: ((msg: string) => void) | undefined,
  big: string[],
  hook?: SplitDueHook,
  sections: Section[] = [],
): void {
  if (!big.length) return;
  notify?.(`sweep: ${big.length} parent section(s) hold more than ${DEFAULT_RULES.splitAbove} direct entries (${big.join(", ")}); a rebuild is due`);
  if (!hook) return;
  const byDomain = new Map<string, { id: string; count: number }[]>();
  for (const b of big) {
    const m = /^(.*) \((\d+)\)$/.exec(b);
    if (!m) continue;
    const domain = String(sections.find((s) => String(s.id) === m[1])?.domain ?? "");
    if (!domain) continue;
    if (!byDomain.has(domain)) byDomain.set(domain, []);
    byDomain.get(domain)!.push({ id: m[1], count: Number(m[2]) });
  }
  for (const [domain, list] of byDomain) {
    void Promise.resolve()
      .then(() => hook(domain, list))
      .catch((e) => notify?.(`sweep: onSplitDue hook failed for ${domain}: ${e instanceof Error ? e.message : String(e)}`));
  }
}

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
  /** Override the placement thresholds (default: HIERARCHY.fitThreshold / DEFAULT_RULES.misplacedMargin). */
  fitThreshold?: number;
  margin?: number;
  maxMoves?: number;
}

export interface Replacement { entryId: string; domain: string; from: string; to: string; fromFit: number; toFit: number }

/**
 * Re-home misfit entries. Candidates: fit to their own section's centroid below the placement threshold, worst first; anchors and
 * grouped entries are skipped. A candidate moves only when the tree routes it elsewhere, the target fits at least the threshold and
 * beats the current fit by the misplacement margin. Bounded by MAX_REPLACEMENTS_PER_SWEEP. Returns the moves made (or planned).
 */
export async function replaceMisfits(ctx: ReplaceContext): Promise<Replacement[]> {
  const threshold = ctx.fitThreshold ?? HIERARCHY.fitThreshold;
  const margin = ctx.margin ?? DEFAULT_RULES.misplacedMargin;
  const cap = ctx.maxMoves ?? MAX_REPLACEMENTS_PER_SWEEP;
  const vectors = await ctx.loadEntryVectors();
  const centroid = new Map(ctx.sections.map((s) => [String(s.id), s.centroid] as const));
  const out: Replacement[] = [];
  for (const domain of ctx.domains) {
    const dir = entriesDir(ctx.roots, domain);
    if (!existsSync(dir)) continue;
    const inDomain = vectors.filter((v) => v.domain === domain);
    const domainSections = ctx.sections.filter((s) => String(s.domain) === domain);
    const cands: { id: string; from: string; fit: number; vec: EntryVector }[] = [];
    for (const v of inDomain) {
      let e;
      try { e = readEntryCached(join(dir, `${v.entryId}.md`)); } catch { continue; }
      const from = String(e?.fields.section ?? "");
      const c = centroid.get(from);
      if (!e || !from || !c || e.anchor() || e.group()) continue;
      const fit = cosine(v.vector, c);
      if (fit < threshold) cands.push({ id: v.entryId, from, fit, vec: v });
    }
    cands.sort((a, b) => a.fit - b.fit || (a.id < b.id ? -1 : 1));
    for (const c of cands) {
      if (out.length >= cap) break;
      const d = routeByTree(c.vec.vector, domain, domainSections, inDomain);
      if (d.section === "_unplaced" || String(d.section) === c.from) continue;
      if (d.fit < threshold || d.fit < c.fit + margin) continue;
      const m: Replacement = { entryId: c.id, domain, from: c.from, to: String(d.section), fromFit: c.fit, toFit: d.fit };
      ctx.notify?.(`sweep: ${ctx.dryRun ? "would re-place" : "re-placing"} ${c.id}: ${c.from} (${c.fit.toFixed(2)}) -> ${m.to} (${d.fit.toFixed(2)}) [replace-misfit]`);
      if (!ctx.dryRun) {
        const raw = readEntryCached(join(dir, `${c.id}.md`))?.raw ?? "";
        if (!/^section: .+$/m.test(raw)) continue;
        await ctx.writer.patchEntry(ctx.roots, domain, c.id, raw.replace(/^section: .+$/m, `section: ${m.to}`));
        // entry_placed has no reason field and a closed basis enum: "routed" is the closest; the move is found by its fit and a prior placement.
        await ctx.writer.appendLedger(ctx.roots, [ev.entryPlaced({ entryId: c.id, sectionId: m.to, basis: "routed", fit: d.fit })]);
      }
      out.push(m);
    }
  }
  return out;
}
