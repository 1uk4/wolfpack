/**
 * sweep-v2 — the KB v2 sweep: hierarchical section-tree placement.
 *
 * The one and only KB sweep (v1 retired).
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
import { parseFrontmatter, SWEEP } from "@wolfpack/engine";
import { type KbEvent, ev, now } from "../shared/index.js";
import { readLedger, appendLedger, seenHashes, foldRegistry } from "./ledger.js";
import { drainInbox } from "./intake.js";
import { createEmbedder, embedInput, cosine } from "./embed.js";
import { renderRegistry } from "./registry.js";
import { emitFeed } from "./feed.js";
import { routeByTree, type EntryVector } from "./route.js";
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
import type { Engine } from "@wolfpack/engine";
import type { KbRoots } from "../shared/index.js";

export interface SweepContext {
  engine: Engine;
  roots: KbRoots;
  /** Load current entry vectors (from cache). Injected for testability. */
  loadEntryVectors: () => Promise<EntryVector[]>;
  notify?: (msg: string) => void;
}

export interface SweepResult {
  processed: number;
  created: number;
  merged: number;
  rejected: number;
  crystallized: number;
  fed: number;
  errors: number;
  unclassified: number;
  suggestedDomains: string[];
  /** Contributions left in the inbox after this batched run (await next tick). */
  remaining: number;
}

/** Generate a fresh SectionId: sec-<domain>-<6 alphanumerics>. */
function mkSectionId(domain: string): SectionId {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let tail = "";
  for (let i = 0; i < 6; i++) tail += chars[Math.floor(Math.random() * chars.length)];
  // Domain is sanitized to the brand's [a-z0-9-] alphabet by DomainId elsewhere.
  return SectionId.parse(`sec-${domain}-${tail}`);
}

/**
 * The KB sweep: hierarchical section-tree placement.
 */
export async function sweepV2(ctx: SweepContext): Promise<SweepResult> {
  const { engine, roots } = ctx;
  const embedder = createEmbedder(roots);
  const oracles = createOracles(engine);

  const log = readLedger(roots);
  let reg = foldRegistry(log); // deterministic identity: (wolf, den topic) -> entry
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
    remaining: 0,
  };

  const declared = readDeclaredDomains(roots);
  const touchedDomains = new Set<string>();

  // ── RELATION RESOLVER (first-cut) ──────────────────────────────────────────
  // Drops all proposed relation hints (returns null) → relations[] starts empty.
  // The soft overlay (embedding see_also + resolved LLM edges) is added in a
  // follow-up; dropping is safe (never invents an id). See §Phase 3b.
  const resolve: RelationResolver = () => null;

  // Batch: process at most `batchSize` contributions per run (oldest first), so
  // a large multi-wolf inbox never makes one run exhaust the server. The rest
  // wait for the next timer tick. Oldest-first keeps it fair by arrival time.
  const batchSize = Number(process.env.KB_SWEEP_BATCH) || SWEEP.batchSize;
  const pending = drainInbox(roots).sort((a, b) =>
    (a.submitted || "").localeCompare(b.submitted || "")
  );
  const contributions = pending.slice(0, batchSize);
  result.remaining = Math.max(0, pending.length - contributions.length);

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

      // ── IDENTITY (deterministic registry) ───────────────────────────────
      // A re-promote of a known den topic UPDATES its entry (never duplicates).
      // 1) exact alias match (wolf, den topic) from the registry; 2) otherwise
      // content-similarity to the nearest entry (seeds the alias on commit).
      let targetId: string | undefined;
      for (const topic of reg.values()) {
        const alias = topic.aliases.find(
          (a) => a.wolf === c.from && a.denTopicId === c.denTopicId
        );
        if (alias) {
          targetId = topic.entries[0];
          break;
        }
      }
      if (!targetId) {
        let near: { id: string; score: number } | null = null;
        for (const e of entryVectors) {
          if (e.domain !== domain) continue;
          const s = cosine(vec, e.vector);
          if (!near || s > near.score) near = { id: e.entryId, score: s };
        }
        if (near && near.score >= SWEEP.mergeSim) targetId = near.id;
      }

      let sectionId: SectionId | undefined;
      let placement: Placement | undefined;

      // Updating a known entry → keep its existing section (identity stable).
      if (targetId) {
        const md = readEntryMarkdown(roots, domain, targetId);
        const sec = md ? String(parseFrontmatter(md).fields.section ?? "") : "";
        try {
          sectionId = SectionId.parse(sec);
          placement = { basis: "routed", fit: 1 };
        } catch {
          targetId = undefined; // couldn't resolve its section → place fresh
        }
      }

      // Otherwise place a NEW entry by deterministic tree descent.
      if (!sectionId) {
        const decision = routeByTree(vec, domain, sections, entryVectors);
        if (decision.section !== "_unplaced") {
          sectionId = decision.section;
          placement = { basis: "routed", fit: decision.fit };
        } else {
          // ── CLASSIFY FALLBACK (LLM section-pick, confined) ──────────────
          const candidates = sections
            .filter((s) => s.domain === domain)
            .map((s) => ({ sectionId: s.id, title: s.title, summary: s.summary }));
          const pick = await oracles.classifyToSection(c.body, candidates);
          if (pick.section !== "NEW" && sections.some((s) => s.id === pick.section)) {
            sectionId = SectionId.parse(pick.section);
            placement = { basis: "routed", fit: decision.fit };
          } else {
            // NEW → singleton section under the domain (reorganized later).
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
              ev.sectionCreated({ sectionId, domain, parent: null, label: String(newSection.label) })
            );
            placement = { basis: "crystallized", fit: decision.fit };
          }
        }
      }

      if (!sectionId || !placement) throw new Error("unrouted contribution");

      // ── PRODUCE (LLM → opinion only; code assembles) ────────────────────
      const existingMarkdown = targetId
        ? readEntryMarkdown(roots, domain, targetId) ?? undefined
        : undefined;

      const { entry, action } = await produceEntry(engine, {
        contribution: c,
        domain,
        section: sectionId,
        placement,
        entryId: targetId,
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
      // Registry: record (wolf, den topic) -> entry so later re-promotes resolve
      // by alias and update in place. Re-fold so later items in THIS batch see it.
      batch.push(ev.aliased(c.from, c.denTopicId, entry.id, c.contentHash));
      reg = foldRegistry([...log, ...batch]);
      // Publish the canonical id back to the wolf's flow via the domain feed.
      emitFeed(roots, domain, {
        canonicalId: entry.id,
        entryId: entry.id,
        yourAlias: c.denTopicId,
        change: action === "create" ? "created" : "updated",
        by: c.from,
        summary: c.summary,
        updated: now(),
      });
      batch.push(ev.fed(c.from, entry.id, entry.id));
      result.fed++;

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
    renderRegistry(roots, foldRegistry([...log, ...batch]));
    gitCommit(roots, `sweep-v2: ${result.created}c ${result.merged}m ${result.rejected}r`);
  }

  ctx.notify?.(
    `kb-v2 sweep: ${result.processed} contributions → ${result.created}c ${result.merged}m` +
      (result.remaining > 0 ? ` · ${result.remaining} queued for next tick` : "")
  );
  return result;
}
