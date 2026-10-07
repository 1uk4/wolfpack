/**
 * sweep-v2 — the KB v2 sweep: hierarchical section-tree placement.
 *
 * Selected when KB_V2=1 (see the dispatcher at the bottom of sweep.ts / the CLI).
 * The legacy `sweep` in sweep.ts is left UNTOUCHED for KB_V2 off.
 *
 * First-cut bring-up pipeline (entry-first, reachability never gated):
 *   intake → embed → routeByTree → (classifyToSection fallback) → produceEntry
 *          → commitEntryV2 → record events → renderDomainDigest → persist
 *
 * Tree REORGANIZATION (maybeSplit / crystallizeUnplaced / shouldMerge) runs as a
 * separate maintenance pass and inside the migration backfill, where per-section
 * member vectors are marshaled. It only reorganizes LIVE entries; it never gates
 * reachability. See docs/kb-v2-implementation.md §Phase 5.
 */
import { parseFrontmatter } from "@wolfpack/engine";
import { type KbEvent, ev, now } from "../shared/index.js";
import { readLedger, appendLedger, seenHashes } from "./ledger.js";
import { drainInbox } from "./intake.js";
import { createEmbedder, embedInput } from "./embed.js";
import { routeByTree } from "./route.js";
import { createOracles } from "./oracles.js";
import { produceEntry } from "./produce.js";
import {
  commitEntryV2,
  readEntryMarkdown,
  writeReceipt,
  markProcessed,
  gitCommit,
  quarantine,
} from "./commit.js";
import { renderDomainIndex, renderDomainDigest, readDeclaredDomains, isDeclared } from "./domains.js";
import { readSections, writeSections } from "./sections.js";
import {
  DomainId,
  SectionId,
  Slug,
  IsoDate,
  type Section,
  type Placement,
  type RelationResolver,
} from "../schema/knowledge.js";
import type { SweepContext, SweepResult } from "./sweep.js";

/** Generate a fresh SectionId: sec-<domain>-<6 alphanumerics>. */
function mkSectionId(domain: string): SectionId {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let tail = "";
  for (let i = 0; i < 6; i++) tail += chars[Math.floor(Math.random() * chars.length)];
  // Domain is sanitized to the brand's [a-z0-9-] alphabet by DomainId elsewhere.
  return SectionId.parse(`sec-${domain}-${tail}`);
}

/**
 * The v2 sweep. Same SweepContext as the legacy sweep so the CLI can dispatch
 * on KB_V2 without changing its call site.
 */
export async function sweepV2(ctx: SweepContext): Promise<SweepResult> {
  const { engine, roots } = ctx;
  const embedder = createEmbedder(roots);
  const oracles = createOracles(engine);

  const log = readLedger(roots);
  const seen = seenHashes(log);
  const entryVectors = await ctx.loadEntryVectors();
  // Section tree, folded from the ledger / _sections.json.
  let sections: Section[] = readSections(roots);

  const batch: KbEvent[] = [];
  const result: SweepResult = {
    processed: 0,
    created: 0,
    merged: 0,
    rejected: 0,
    crystallized: 0,
    fed: 0,
    errors: 0,
    unclassified: 0,
    suggestedDomains: [],
  };

  const declared = readDeclaredDomains(roots);
  const touchedDomains = new Set<string>();

  // ── RELATION RESOLVER (first-cut) ──────────────────────────────────────────
  // Drops all proposed relation hints (returns null) → relations[] starts empty.
  // The soft overlay (embedding see_also + resolved LLM edges) is added in a
  // follow-up; dropping is safe (never invents an id). See §Phase 3b.
  const resolve: RelationResolver = () => null;

  const contributions = drainInbox(roots);

  for (const c of contributions) {
    if (seen.has(c.contentHash)) {
      markProcessed(c);
      continue;
    }
    result.processed++;

    try {
      const domain = c.domainHint || "wolfpack";

      // Declared-domain gate — never commit into an unmirrored, unreviewed domain.
      if (!isDeclared(declared, domain)) {
        quarantine(roots, c, domain);
        writeReceipt(roots, c.from, c, "unclassified", `pending domain: ${domain}`);
        markProcessed(c);
        result.unclassified++;
        continue;
      }

      // ── EMBED ───────────────────────────────────────────────────────────
      const vec = await embedder.embed(
        embedInput({ summary: c.summary, detail: c.body }),
        c.contentHash
      );

      // ── ROUTE (deterministic tree descent) ──────────────────────────────
      const decision = routeByTree(vec, domain, sections, entryVectors);
      let sectionId: SectionId;
      let placement: Placement;

      if (decision.section !== "_unplaced") {
        sectionId = decision.section;
        placement = { basis: "routed", fit: decision.fit };
      } else {
        // ── CLASSIFY FALLBACK (LLM section-pick, confined) ────────────────
        const candidates = sections
          .filter((s) => s.domain === domain)
          .map((s) => ({ sectionId: s.id, title: s.title, summary: s.summary }));
        const pick = await oracles.classifyToSection(c.body, candidates);

        if (pick.section !== "NEW") {
          sectionId = SectionId.parse(pick.section);
          placement = { basis: "routed", fit: decision.fit };
        } else {
          // NEW → create a singleton section under the domain (crystallize/merge
          // reorganizes later). Entry-first: the entry still gets a real home.
          sectionId = mkSectionId(domain);
          const nowIso = IsoDate.parse(now().slice(0, 10));
          const slug =
            (c.summary || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) ||
            "section";
          const newSection: Section = {
            id: sectionId,
            domain: DomainId.parse(domain),
            parent: null,
            depth: 0,
            label: Slug.parse(slug),
            title: c.summary.slice(0, 80) || "New section",
            centroid: vec,
            memberCount: 0,
            childIds: [],
            summary: c.summary || "(pending summary)",
            summaryHash: "",
            dirty: true,
            created: nowIso,
            updated: nowIso,
          };
          sections = [...sections, newSection];
          batch.push(
            ev.sectionCreated({
              sectionId,
              domain,
              parent: null,
              label: String(newSection.label),
            })
          );
          placement = { basis: "crystallized", fit: decision.fit };
        }
      }

      // ── PRODUCE (LLM → opinion only; code assembles) ────────────────────
      const existingMarkdown = decision.target
        ? readEntryMarkdown(roots, domain, decision.target) ?? undefined
        : undefined;

      const { entry, action } = await produceEntry(engine, {
        contribution: c,
        domain,
        section: sectionId,
        placement,
        entryId: decision.target,
        existingMarkdown,
        resolve,
      });

      // ── COMMIT (entry is live NOW) ──────────────────────────────────────
      commitEntryV2(roots, entry);

      batch.push(ev.contribution({
        from: c.from,
        denTopicId: c.denTopicId,
        hash: c.contentHash,
        prevHash: c.prevHash,
        domainHint: domain,
      }));
      batch.push(ev.entryWritten(entry.id, entry.id, action));
      batch.push(ev.entryPlaced({
        entryId: entry.id,
        sectionId,
        basis: placement.basis,
        fit: placement.fit,
      }));

      writeReceipt(roots, c.from, c, action, entry.id);
      markProcessed(c);
      touchedDomains.add(domain);
      if (action === "create") result.created++;
      else result.merged++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.notify?.(`kb-v2: skipped ${c.from}/${c.denTopicId} — ${msg}`);
      result.processed--;
      result.errors++;
    }
  }

  // ── INDEX + DIGEST per touched domain ─────────────────────────────────────
  if (sections.length > 0) writeSections(roots, sections);
  for (const domain of touchedDomains) {
    renderDomainIndex(roots, domain);
    renderDomainDigest(roots, domain);
  }

  // ── PERSIST ────────────────────────────────────────────────────────────────
  if (batch.length > 0) {
    appendLedger(roots, batch);
    gitCommit(roots, `sweep-v2: ${result.created}c ${result.merged}m ${result.rejected}r`);
  }

  ctx.notify?.(
    `kb-v2 sweep: ${result.processed} contributions → ${result.created}c ${result.merged}m`
  );
  return result;
}
