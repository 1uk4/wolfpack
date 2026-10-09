/**
 * sweep — the KB sweep: hierarchical section-tree placement.
 *
 * The one and only KB sweep (v1 retired).
 *
 * First-cut bring-up pipeline (entry-first, reachability never gated):
 *   intake → embed → routeByTree → (classifyToSection fallback) → produceEntry
 *          → commitEntry → record events → renderDomainDigest → persist
 *
 * Tree REORGANIZATION (maybeSplit / crystallizeUnplaced / shouldMerge) runs as a
 * separate maintenance pass and inside the migration backfill, where per-section
 * member vectors are marshaled. It only reorganizes LIVE entries; it never gates
 * reachability. See docs/kb-implementation.md §Phase 5.
 */
import { parseFrontmatter, SWEEP } from "@wolfpack/engine";
import { type KbEvent, ev, now } from "../shared/index.js";
import { readLedger, appendLedger, seenHashes, foldRegistry } from "./ledger.js";
import { drainInbox } from "./intake.js";
import { createEmbedder, embedInput, cosine } from "./embed.js";
import { renderRegistry } from "./registry.js";
import { routeByTree, type EntryVector } from "./route.js";
import { createOracles } from "./oracles.js";
import { produceEntry } from "./produce.js";
import {
  commitEntry,
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

/** One contribution the sweep could not commit, with a human-readable reason. */
export interface SweepFailure {
  from: string;
  denTopicId: string;
  reason: string;
}

export interface SweepResult {
  processed: number;
  created: number;
  merged: number;
  rejected: number;
  crystallized: number;
  errors: number;
  unclassified: number;
  suggestedDomains: string[];
  /** Per-contribution failures (concise reasons), so callers can surface them
   *  instead of leaving them buried in notify() log lines. */
  failures: SweepFailure[];
  /** Contributions left in the inbox after this batched run (await next tick). */
  remaining: number;
}

/** Turn a thrown error — especially a ZodError — into a short, readable reason.
 *  Raw ZodError messages are multi-line JSON blobs; collapse them to a compact
 *  `path: message` list so a skip is legible at a glance. */
export function cleanError(err: unknown): string {
  const issuesOf = (v: unknown): string | null => {
    const arr = (v as { issues?: unknown })?.issues ?? v;
    if (!Array.isArray(arr)) return null;
    return arr
      .map((i: { path?: unknown[]; message?: string }) =>
        `${(i.path ?? []).join(".") || "(root)"}: ${i.message ?? "invalid"}`
      )
      .join("; ");
  };
  // ZodError instance, or an Error whose .message is a JSON issues array.
  const direct = issuesOf(err);
  if (direct) return direct.slice(0, 240);
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.trim().startsWith("[")) {
    try {
      const parsed = issuesOf(JSON.parse(msg));
      if (parsed) return parsed.slice(0, 240);
    } catch {
      /* not JSON — fall through */
    }
  }
  return msg.split("\n")[0].slice(0, 240);
}

/** Generate a fresh SectionId: sec-<domain>-<6 alphanumerics>. */
function mkSectionId(domain: string): SectionId {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let tail = "";
  for (let i = 0; i < 6; i++) tail += chars[Math.floor(Math.random() * chars.length)];
  // Domain is sanitized to the brand's [a-z0-9-] alphabet by DomainId elsewhere.
  return SectionId.parse(`sec-${domain}-${tail}`);
}

/** Clamp a routing score into the Placement.fit [0,1] range. Guards against a
 *  cosine FP overshoot (>1) or a reused _unplaced score (<0) hard-failing the
 *  whole contribution at schema-parse time. */
function clampFit(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * The KB sweep: hierarchical section-tree placement.
 */
export async function sweep(ctx: SweepContext): Promise<SweepResult> {
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
    errors: 0,
    unclassified: 0,
    suggestedDomains: [],
    failures: [],
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

      // ── ARCHIVE-SAFETY ──────────────────────────────────────────────────
      // An ARCHIVED contribution (e.g. a historical crawl) must never supersede
      // a NEWER LIVE entry: back-filled history cannot overwrite current truth.
      // Skip it (receipt + processed), leaving the live entry intact.
      if (targetId && c.currency === "archived" && c.sourceUpdated) {
        const md = readEntryMarkdown(roots, domain, targetId);
        const ef = md ? parseFrontmatter(md).fields : null;
        const existingLive = ef ? String(ef.currency ?? "live") !== "archived" : false;
        const existingUpdated = ef ? String(ef.updated ?? "") : "";
        if (existingLive && existingUpdated && c.sourceUpdated < existingUpdated) {
          writeReceipt(
            roots, c.from, c, "reject",
            `archived-older-than-live: ${c.sourceUpdated} < ${existingUpdated}`
          );
          markProcessed(c);
          result.rejected++;
          continue;
        }
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
          placement = { basis: "routed", fit: clampFit(decision.fit) };
        } else {
          // ── CLASSIFY FALLBACK (LLM section-pick, confined) ──────────────
          const candidates = sections
            .filter((s) => s.domain === domain)
            .map((s) => ({ sectionId: s.id, title: s.title, summary: s.summary }));
          const pick = await oracles.classifyToSection(c.body, candidates);
          if (pick.section !== "NEW" && sections.some((s) => s.id === pick.section)) {
            sectionId = SectionId.parse(pick.section);
            placement = { basis: "routed", fit: clampFit(decision.fit) };
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
            placement = { basis: "crystallized", fit: clampFit(decision.fit) };
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
      commitEntry(roots, entry);

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

      writeReceipt(roots, c.from, c, action, entry.id);
      markProcessed(c);
      touchedDomains.add(domain);
      if (action === "create") result.created++;
      else result.merged++;
    } catch (err) {
      const reason = cleanError(err);
      ctx.notify?.(`sweep: skipped ${c.from}/${c.denTopicId} — ${reason}`);
      result.failures.push({ from: c.from, denTopicId: c.denTopicId, reason });
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
    gitCommit(roots, `sweep: ${result.created}c ${result.merged}m ${result.rejected}r`);
  }

  ctx.notify?.(
    `sweep: ${result.processed} contributions → ${result.created}c ${result.merged}m` +
      (result.remaining > 0 ? ` · ${result.remaining} queued for next tick` : "")
  );
  return result;
}
