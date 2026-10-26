/**
 * Pi-durable consolidation — pools observations directly to den topics.
 *
 * Mirrors Pi-CLI's consolidateSession but skips the session topics step:
 *   1. Read observations from .memory/pool/observations.jsonl
 *   2. Archive den topics the KB has absorbed, then read the rest for context
 *   3. LLM consolidation (same prompt/schema as Pi-CLI)
 *   4. Write topics directly to $WOLF_DEN/memory/topics/
 *   5. Emit deltas to KB inbox (same as Pi-CLI promote)
 *   6. Archive processed observations
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  createEngine,
  engineSteps,
  loadModelTable,
  CONSOLIDATE_SYSTEM,
  type Engine,
  type ModelTable,
} from "@wolfpack/engine";
import {
  ConsolidationResultSchema,
  writeDenTopic,
  renderDenIndex,
  ensureDenDirs,
  readDenTopics,
  gateDenTopic,
  buildDomainContext,
  reconcileDen,
  promoteTopics,
  consolidateWorkRecords,
  HttpWorkRecordStore,
  TOPIC_SOFT_CAP,
  type WorkRecordStore,
} from "@wolfpack/memory";
import type { KbRoots } from "@wolfpack/kb/shared";

/** Observation stored in pool JSONL */
export interface PoolObservation {
  timestamp: string;
  content: string;
  recordedAt: string;
  domain?: string;
  /** Task bound when this was observed: it feeds that item's Record, not the den. */
  work?: string;
  /** The bound task's parent feature. */
  feature?: string;
}

export interface ConsolidationConfig {
  wolfDen: string;
  wolfName: string;
  /** The wolf's resolved model table (default: loadModelTable(), i.e. the
   *  WOLFPACK_MODELS_FILE handed over by launch / the harness). */
  table?: ModelTable;
  /** API key for the api transport (default: the SDK's ANTHROPIC_API_KEY lookup). */
  apiKey?: string;
  /** KB roots for emitting deltas to Dewey (optional) */
  kbRoots?: KbRoots;
  /** Default domain hint for KB emissions (default: wolfpack) */
  defaultDomain?: string;
  /** Wolf's subscribed domains (enables per-observation domain routing) */
  domains?: string[];
  /** Skip emitting to KB (default: false) */
  skipClaims?: boolean;
  /**
   * Pool tokens to leave behind: consolidate only the oldest observations above this target and keep the newest
   * ones in the pool (pi's POOL_TARGET). Omitted: consolidate the whole pool.
   */
  poolTarget?: number;
  /** Minimum observations to consolidate (default: 5) */
  minObservations?: number;
  /** Minimum tokens to consolidate (default: 1000) */
  minTokens?: number;
  /** Optional progress callback */
  onProgress?: (msg: string) => void;
  /** Engine override (tests); built from the table when omitted. */
  engine?: Engine;
  /** Where work Records are written (default: the Work API from WORK_ENDPOINT / WORK_TOKEN, when set). */
  workStore?: WorkRecordStore;
}

export interface ConsolidationResult {
  observationsProcessed: number;
  topicsCreated: number;
  topicsMerged: number;
  topicsSkipped: number;
  claimsSubmitted: number;
  /** Work Records rewritten from tagged observations. */
  recordsWritten?: number;
  /** Tagged observations left in the pool (the Work API or model was unavailable). */
  observationsPending?: number;
}

/**
 * Read observations from the pool file.
 */
export async function readPool(wolfDen: string): Promise<PoolObservation[]> {
  const poolFile = join(wolfDen, ".memory", "pool", "observations.jsonl");
  if (!existsSync(poolFile)) return [];

  try {
    const content = await readFile(poolFile, "utf-8");
    return content
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as PoolObservation);
  } catch {
    return [];
  }
}

/**
 * Get pool stats without reading all content.
 */
export async function getPoolStats(wolfDen: string): Promise<{ count: number; tokens: number }> {
  const observations = await readPool(wolfDen);
  const tokens = observations.reduce(
    (sum, o) => sum + Math.ceil(o.content.length / 4),
    0
  );
  return { count: observations.length, tokens };
}

/** The oldest observations (pool order is append order) beyond the newest `target` tokens. */
function overflowAbove(pool: PoolObservation[], target: number): PoolObservation[] {
  let kept = 0;
  let firstKept = pool.length;
  for (let i = pool.length - 1; i >= 0; i--) {
    const t = Math.ceil(pool[i].content.length / 4);
    if (kept + t > target) break;
    kept += t;
    firstKept = i;
  }
  return pool.slice(0, firstKept);
}

const poolKey = (o: PoolObservation) => `${o.recordedAt}\u0000${o.timestamp}\u0000${o.content}`;

/**
 * Archive the observations this run handled and leave the rest in the pool:
 * tagged observations that stay pending, and anything appended while the
 * consolidation was running.
 */
async function settlePool(wolfDen: string, handled: PoolObservation[]): Promise<void> {
  const poolFile = join(wolfDen, ".memory", "pool", "observations.jsonl");
  if (!existsSync(poolFile) || handled.length === 0) return;

  const done = new Set(handled.map(poolKey));
  const lines = (await readFile(poolFile, "utf-8")).split("\n").filter((l) => l.trim());
  const archived: string[] = [];
  const kept: string[] = [];
  for (const line of lines) {
    let key: string | null = null;
    try { key = poolKey(JSON.parse(line) as PoolObservation); } catch { /* keep unparsable lines */ }
    (key !== null && done.has(key) ? archived : kept).push(line);
  }

  const archiveDir = join(wolfDen, ".memory", "archive");
  await mkdir(archiveDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  await writeFile(join(archiveDir, `observations-${timestamp}.jsonl`), archived.map((l) => l + "\n").join(""));
  await writeFile(poolFile, kept.map((l) => l + "\n").join(""));
}

/**
 * Consolidate pool observations directly to den topics.
 * 
 * Mirrors Pi-CLI's consolidateSession but operates on the pool directly
 * instead of session topics. After writing to den, emits deltas to KB
 * (same as /wolf:promote).
 */
export async function consolidatePool(
  config: ConsolidationConfig
): Promise<ConsolidationResult> {
  const {
    wolfDen,
    wolfName,
    kbRoots,
    defaultDomain = "wolfpack",
    skipClaims = false,
    minObservations = 5,
    minTokens = 1000,
    onProgress,
  } = config;

  // Build domain context for consolidation prompt
  const domainCtx = config.domains && config.domains.length > 1
    ? buildDomainContext(config.domains, config.kbRoots?.kbBase)
    : "";

  // Read pool
  const pool = await readPool(wolfDen);
  const observations = config.poolTarget === undefined ? pool : overflowAbove(pool, config.poolTarget);
  if (observations.length === 0) {
    onProgress?.("No observations to consolidate");
    return { observationsProcessed: 0, topicsCreated: 0, topicsMerged: 0, topicsSkipped: 0, claimsSubmitted: 0 };
  }

  // Estimate tokens
  const totalTokens = observations.reduce(
    (sum, o) => sum + Math.ceil(o.content.length / 4),
    0
  );

  // Check minimum thresholds (skip if pool too small)
  // (Work-tagged observations bypass it: a Record rewrite is cheap and the den pass re-checks its own share.)
  if (observations.length < minObservations && totalTokens < minTokens && !observations.some((o) => o.work)) {
    onProgress?.(`Pool too small (${observations.length} obs, ~${totalTokens} tokens) — skipping`);
    return { observationsProcessed: 0, topicsCreated: 0, topicsMerged: 0, topicsSkipped: 0, claimsSubmitted: 0 };
  }

  onProgress?.(`Consolidating ${observations.length} observations (~${totalTokens} tokens)`);

  const engine = config.engine ?? createConsolidationEngine(config.table ?? loadModelTable().table, config.apiKey);

  // Observations tagged with a work item feed that item's Record, not the den.
  // written → consumed; fallback (item archived/deleted, no Work API) → den;
  // pending (Work API or model unavailable) → stays in the pool for the next run.
  const handled: PoolObservation[] = [];
  const denObs = observations.filter((o) => !o.work);
  let recordsWritten = 0;
  let pending = 0;
  const workObs = observations.filter((o) => o.work);
  if (workObs.length > 0) {
    const store = config.workStore ?? defaultWorkStore();
    const outcomes = await consolidateWorkRecords({
      engine,
      store,
      observations: workObs.map((o) => ({ id: poolKey(o), content: o.content, work: o.work!, ...(o.feature ? { feature: o.feature } : {}) })),
      onProgress,
    });
    const status = new Map(outcomes.flatMap((o) => o.ids.map((id) => [id, o.status] as const)));
    for (const o of workObs) {
      const st = status.get(poolKey(o));
      if (st === "written") handled.push(o);
      else if (st === "pending") pending++;
      else denObs.push(o);
    }
    recordsWritten = outcomes.filter((o) => o.status === "written").length;
    if (pending > 0) onProgress?.(`${pending} work observation(s) stay pending`);
  }
  const denTokens = denObs.reduce((sum, o) => sum + Math.ceil(o.content.length / 4), 0);
  if (denObs.length === 0 || (workObs.length > 0 && denObs.length < minObservations && denTokens < minTokens)) {
    await settlePool(wolfDen, handled);
    return { observationsProcessed: handled.length, topicsCreated: 0, topicsMerged: 0, topicsSkipped: 0, claimsSubmitted: 0, recordsWritten, observationsPending: pending };
  }

  // Ensure den structure exists
  ensureDenDirs(wolfDen);

  // Daemon wolves promote here, not via consolidateSession, so reconcile here
  // too: absorbed topics leave the den before the LLM sees it. New observations
  // on an absorbed subject start a fresh small topic instead of regrowing the
  // old one; the sweep's alias merges it into the same entry.
  if (kbRoots) {
    try {
      const r = reconcileDen(wolfDen, kbRoots, wolfName);
      onProgress?.(`reconciled: ${r.archived.length} archived, ${r.pending.length} pending`);
    } catch (err) {
      onProgress?.(`reconcile skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Read the remaining (unabsorbed) den topics for context
  const existingTopics = readDenTopics(wolfDen);
  const existingSection =
    existingTopics.length > 0
      ? existingTopics
          .map((t) => `### ${t.id} — ${t.title}\nSummary: ${t.summary}\n\n${t.body}`)
          .join("\n\n---\n\n")
      : "(empty — no topics yet)";

  // Build prompt (same format as Pi-CLI orchestrator)
  const obsLines = denObs
    .map((o) => {
      const domainTag = o.domain ? ` [${o.domain}]` : "";
      return `${o.timestamp}${domainTag}  ${o.content}`;
    })
    .join("\n");

  const prompt = `===== OBSERVATIONS TO CONSOLIDATE =====
${obsLines}
===== END OBSERVATIONS =====

===== EXISTING TOPICS =====
${existingSection}
===== END TOPICS =====

Fold the observations into topics. For each group of related observations, decide MERGE (into existing topic), CREATE (new topic), or SKIP (not worth persisting).

Domain tags [domain] appear on observations. When creating or merging topics, set the domain field to the dominant domain of the observations in that group. NEVER merge observations from different domains into the same topic.`;

  onProgress?.("Running LLM consolidation...");
  let consolidateSystem = CONSOLIDATE_SYSTEM;
  if (domainCtx) {
    consolidateSystem += `\n\nObservations carry domain tags [domain]. When creating or merging topics, set the domain field to match the dominant domain of the observations in that group. NEVER merge observations from different domains into the same topic.\n\n${domainCtx}`;
  }

  const result = await engine.call("consolidate", ConsolidationResultSchema, {
    system: consolidateSystem,
    prompt,
  });

  // Write results directly to den (same as Pi-CLI promote step)
  const now = new Date().toISOString().replace("T", " ").slice(0, 16);
  let created = 0;
  let merged = 0;
  let skipped = 0;
  let held = 0;
  let trivialSkipped = 0;

  const topicsDir = join(wolfDen, "memory", "topics");
  const updatedTopics: Array<{
    id: string;
    title: string;
    summary: string;
    body: string;
    domain?: string;
    change: "create" | "merge";
  }> = [];

  // The LLM's domain is only a hint, and Dewey quarantines undeclared domains
  // as unclassified. Observers on single-domain wolves get no domain list and
  // invent tags ("fitness", "telegram"), so only a subscribed domain survives;
  // anything else falls back to the wolf's default domain.
  const allowedDomains = new Set(config.domains?.length ? config.domains : [defaultDomain]);
  const domainOf = (d: string | undefined) => (d && allowedDomains.has(d) ? d : defaultDomain);

  for (const action of result.actions) {
    if (action.action === "skip" || !action.result) {
      skipped++;
      onProgress?.(`  skipped: ${action.reasoning}`);
      continue;
    }

    const isUpdate = existsSync(join(topicsDir, `${action.result.id}.md`));
    const change: "create" | "merge" = isUpdate ? "merge" : "create";

    const gate = gateDenTopic(action.result);
    writeDenTopic(wolfDen, {
      id: action.result.id,
      title: action.result.title,
      summary: action.result.summary,
      updated: now,
      body: action.result.body,
      domain: domainOf(action.result.domain),
      ...gate,
    });

    onProgress?.(`  ${change === "merge" ? "updated" : "created"}: ${action.result.title}`);
    if (action.result.body.length > TOPIC_SOFT_CAP) onProgress?.(`  topic over ${TOPIC_SOFT_CAP} chars (${action.result.body.length}): ${action.result.id} — should be split by subject`);
    if (isUpdate) merged++;
    else created++;
    if (!gate.promotable) {
      held++;
      onProgress?.(`  held back (not promotable): ${action.result.id} — ${gate.promotableReason}`);
      continue;
    }

    updatedTopics.push({
      id: action.result.id,
      title: action.result.title,
      summary: action.result.summary,
      body: action.result.body,
      domain: domainOf(action.result.domain),
      change,
    });
  }

  // Distill each changed topic into KB-grade contributions and emit them
  // (same as Pi-CLI promote; see @wolfpack/memory distill). Unchanged raw
  // topics cost no LLM call; a failed distill leaves the topic pending.
  let claimsSubmitted = 0;

  if (!skipClaims && kbRoots && updatedTopics.length > 0) {
    onProgress?.("Distilling and emitting to KB...");
    const stats = await promoteTopics(updatedTopics, {
      engine,
      roots: kbRoots,
      wolf: wolfName,
      defaultDomain,
      onProgress,
      onHold: (t, reason) =>
        writeDenTopic(wolfDen, { ...t, updated: now, domain: t.domain, promotable: false, promotableReason: reason }),
    });
    claimsSubmitted = stats.emitted;
    trivialSkipped += stats.trivialSkipped;
    held += stats.held;
    onProgress?.(`  distill: ${stats.distilled} distilled, ${stats.split} split, ${stats.held} held, ${stats.pending} pending`);
  }

  // Regenerate den index
  renderDenIndex(wolfDen);

  // Archive processed observations (move to .memory/archive/)
  await settlePool(wolfDen, [...handled, ...denObs]);

  onProgress?.(`Done: ${created} created, ${merged} updated, ${skipped} skipped, ${held} held back, ${trivialSkipped} trivial, ${claimsSubmitted} emitted to KB`);

  return {
    observationsProcessed: handled.length + denObs.length,
    topicsCreated: created,
    topicsMerged: merged,
    topicsSkipped: skipped,
    claimsSubmitted,
    recordsWritten,
    observationsPending: pending,
  };
}

/** Consolidation engine from the table: the consolidate step on its tier (smart). */
function createConsolidationEngine(table: ModelTable, apiKey: string | undefined): Engine {
  const steps = engineSteps(table);
  const tier = table.tiers[table.steps.consolidate.tier];
  return createEngine({
    provider: tier.provider,
    apiKey,
    defaultModel: steps.consolidate.model,
    steps: { consolidate: steps.consolidate, distill: steps.distill, workRecord: steps.workRecord },
  });
}

/** The Work API from the environment; undefined when it is not configured (tagged observations then go to the den). */
function defaultWorkStore(): WorkRecordStore | undefined {
  const store = new HttpWorkRecordStore();
  return store.configured ? store : undefined;
}
