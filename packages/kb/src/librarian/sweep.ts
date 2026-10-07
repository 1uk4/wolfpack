/**
 * sweep — Dewey's pipeline. Reads like consolidate.ts in the memory package:
 * a deterministic code pipeline with THREE guarded, mostly-conditional oracle
 * calls. Driven by a systemd timer → kb CLI (survives Dewey's pi lifecycle).
 *
 * Invariant: entries are committed the moment a contribution is accepted
 * (entry-first). Clustering/crystallization only REORGANIZES live entries —
 * it never gates reachability. High-quality knowledge is never left homeless.
 */
import type { Engine } from "@wolfpack/engine";
import { parseFrontmatter } from "@wolfpack/engine";
import {
  type KbRoots,
  type KbEvent,
  type FeedNotice,
  ev,
  now,
} from "../shared/index.js";
import {
  readLedger,
  appendLedger,
  seenHashes,
  foldRegistry,
  foldClusters,
} from "./ledger.js";
import {
  selectCrystallizationCandidates,
  DEFAULT_THRESHOLDS,
  type CrystallizationThresholds,
} from "./clusters.js";
import { drainInbox } from "./intake.js";
import { createEmbedder, embedInput } from "./embed.js";
import {
  routeContribution,
  DEFAULT_ROUTE_THRESHOLDS,
  type RouteThresholds,
  type EntryVector,
} from "./route.js";
import { createOracles } from "./oracles.js";
import { produce } from "./produce.js";
import {
  commitEntry,
  readEntryMarkdown,
  writeReceipt,
  archiveRejected,
  markProcessed,
  gitCommit,
} from "./commit.js";
import { renderRegistry } from "./registry.js";
import { emitFeed } from "./feed.js";
import { readDeclaredDomains, isDeclared, renderDomainIndex } from "./domains.js";
import { quarantine } from "./commit.js";

export interface SweepContext {
  engine: Engine;
  roots: KbRoots;
  thresholds?: CrystallizationThresholds;
  routeThresholds?: RouteThresholds;
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
  /** Contributions quarantined because they fit no declared domain. */
  unclassified: number;
  /** Distinct domain names the classifier suggested for quarantined items. */
  suggestedDomains: string[];
}

export async function sweep(ctx: SweepContext): Promise<SweepResult> {
  const { engine, roots } = ctx;
  const thresholds = ctx.thresholds ?? DEFAULT_THRESHOLDS;
  const routeThresholds = ctx.routeThresholds ?? DEFAULT_ROUTE_THRESHOLDS;
  const embedder = createEmbedder(roots);
  const oracles = createOracles(engine);

  const log = readLedger(roots); // [code]
  const reg = foldRegistry(log);
  const seen = seenHashes(log);
  const entryVectors = await ctx.loadEntryVectors();
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

  // Declared-domain gate + bookkeeping for INDEX regen and recommendations.
  const declared = readDeclaredDomains(roots);
  const touchedDomains = new Set<string>();
  const suggested = new Set<string>();

  // ── 1. INTAKE ───────────────────────────────────────────────────── [code]
  const contributions = drainInbox(roots);

  for (const c of contributions) {
    if (seen.has(c.contentHash)) {
      markProcessed(c); // already handled: drain it so the inbox stays clean
      continue;
    }
    result.processed++;

    try {
    // ── 2. EMBED ─────────────────────────────────────── [dedicated model]
    const vec = await embedder.embed(
      embedInput({ summary: c.summary, detail: c.body }),
      c.contentHash
    );

    // ── 3. ROUTE ───────────────────────────────────────────────── [code]
    const route = routeContribution(c, reg, vec, entryVectors, routeThresholds);

    // ── 4. ORACLES — only when code can't decide ── [LLM fast, conditional]
    let reject: string | null = null;
    if (route.kind === "maybe_conflict" && route.target) {
      const existing = readEntryMarkdown(
        roots,
        c.domainHint || "wolfpack",
        route.target
      );
      const existingDate = existing
        ? String(parseFrontmatter(existing).fields.updated ?? "")
        : "";

      // Archive-safety [code]: an archived contribution OLDER than a live entry
      // must never supersede it. Reject deterministically before the oracle —
      // back-filling history can never overwrite current truth.
      if (
        c.currency === "archived" &&
        c.sourceUpdated &&
        existingDate &&
        c.sourceUpdated < existingDate
      ) {
        reject = `archived-older-than-existing: ${c.sourceUpdated} < ${existingDate}`;
      } else {
        const verdict = await oracles.contradict(c.body, existing ?? "", {
          newDate: c.sourceUpdated,
          newCurrency: c.currency,
          existingDate,
          newOrigin: c.origin,
        });
        if (verdict.conflicts && verdict.winner === "existing") {
          reject = `superseded-by-existing: ${verdict.reason}`;
        }
        // else: fall through and merge/supersede in produce()
      }
    }

    let domain = c.domainHint || "wolfpack";
    let subcategory = "";
    if (route.kind === "unclassified" || !isDeclared(declared, domain)) {
      const klass = await oracles.classify(c.body);
      domain = klass.domain;
      subcategory = klass.subcategory;
    }

    // ── declared-domain gate — quarantine anything that fits no declared
    //    domain (never commit into an unmirrored, unreviewed domain) ── [code]
    if (!isDeclared(declared, domain)) {
      quarantine(roots, c, domain);
      writeReceipt(roots, c.from, c, "unclassified", `pending domain: ${domain}`);
      markProcessed(c);
      const ce = ev.contribution(toContribEvent(c));
      batch.push(ce);
      result.unclassified++;
      suggested.add(domain);
      continue;
    }

    // ── reject path — never silently dropped ────────────────────── [code]
    if (reject) {
      writeReceipt(roots, c.from, c, "reject", reject);
      archiveRejected(roots, c.from, c);
      markProcessed(c);
      batch.push(ev.contribution(toContribEvent(c)));
      const contribEvId = batch[batch.length - 1].id;
      batch.push(ev.rejected(contribEvId, reject));
      result.rejected++;
      continue;
    }

    // ── 5. PRODUCE — the one generative call ───────────────── [LLM smart]
    const existing = route.target
      ? { id: route.target, markdown: readEntryMarkdown(roots, domain, route.target) ?? "" }
      : undefined;
    const produced = await produce(engine, c, route, domain, subcategory, existing);

    // ── 6. COMMIT — entry is live NOW ───────────────────────────── [code]
    commitEntry(roots, produced.entry);

    const contribEv = ev.contribution(toContribEvent(c));
    batch.push(contribEv);
    batch.push(ev.routed(contribEv.id, route.kind, route.target ?? undefined));
    batch.push(
      ev.entryWritten(produced.entry.frontmatter.id, produced.canonicalId, produced.action)
    );
    batch.push(
      ev.aliased(c.from, c.denTopicId, produced.canonicalId, c.contentHash)
    );
    batch.push(ev.clustered(contribEv.id, produced.canonicalId, !existing));

    writeReceipt(roots, c.from, c, produced.action, produced.entry.frontmatter.id);
    markProcessed(c);
    if (produced.action === "create") result.created++;
    else result.merged++;

    // ── fan-out via the mirror: drop a notice INSIDE the domain folder so
    //    Syncthing delivers it to that domain's subscribers (no subscriber
    //    list needed; non-subscribers never receive it) ───────────── [code]
    touchedDomains.add(domain);
    emitFeed(roots, domain, {
      canonicalId: produced.canonicalId,
      entryId: produced.entry.frontmatter.id,
      yourAlias: null,
      change: produced.action === "create" ? "created" : "updated",
      by: c.from,
      summary: c.summary,
      updated: now(),
    });
    batch.push(ev.fed(c.from, produced.canonicalId, produced.entry.frontmatter.id));
    result.fed++;
    } catch (err) {
      // Isolate failures: one bad contribution must not crash the batch or lose
      // the ledger. Leave its file in the inbox so a later sweep retries it.
      const msg = err instanceof Error ? err.message : String(err);
      ctx.notify?.(`kb: skipped ${c.from}/${c.denTopicId} — ${msg}`);
      result.processed--;
      result.errors++;
    }
  }

  // ── 7. CRYSTALLIZE — reorganize LIVE entries ──── [code + optional tiny LLM]
  const clusters = foldClusters([...log, ...batch]);
  for (const cl of selectCrystallizationCandidates(clusters, thresholds)) {
    if (!cl.canonicalId) continue;
    const topic = foldRegistry([...log, ...batch]).get(cl.canonicalId);
    // Provisional slug from code; LLM label deferred to a later sweep.
    const subcategory = topic?.subcategory || "";
    batch.push(
      ev.crystallized({
        clusterId: cl.clusterId,
        canonicalId: cl.canonicalId,
        domain: topic?.domain || "wolfpack",
        subcategory,
      })
    );
    result.crystallized++;
  }

  // ── 8. INDEX — regenerate each touched domain's catalog (discovery) ─ [code]
  //    The per-domain INDEX.md mirrors with the domain, so subscribers can find
  //    entries in sections they never contributed to. (Fan-out already happened
  //    inline via the domain _feed above — mirror-delivered, access-scoped.)
  for (const domain of touchedDomains) renderDomainIndex(roots, domain);
  result.suggestedDomains = [...suggested];

  // ── 9. PERSIST ──────────────────────────────────────────────────── [code]
  // Only touch the ledger/registry/git when something actually changed — an
  // empty sweep must be a true no-op (no churn commits every timer tick).
  if (batch.length > 0) {
    appendLedger(roots, batch);
    renderRegistry(roots, foldRegistry([...log, ...batch]));
    gitCommit(
      roots,
      `sweep: ${result.created}c ${result.merged}m ${result.rejected}r ${result.crystallized}x`
    );
  }

  ctx.notify?.(
    `kb sweep: ${result.processed} contributions → ${result.created}c ${result.merged}m ${result.rejected}r`
  );
  return result;
}

function toContribEvent(c: {
  from: string;
  denTopicId: string;
  contentHash: string;
  prevHash: string | null;
  domainHint: string;
}) {
  return {
    from: c.from,
    denTopicId: c.denTopicId,
    hash: c.contentHash,
    prevHash: c.prevHash,
    domainHint: c.domainHint,
  };
}
