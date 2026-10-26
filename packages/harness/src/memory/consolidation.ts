/**
 * Pi-durable consolidation. Two modes:
 *
 * Session mode (`sessionTopics` set; what the memory extension uses, pi parity):
 *   1. Read observations from .memory/pool/observations.jsonl
 *   2. Work-tagged observations feed their item's Record (those that fall back, or are untagged, continue)
 *   3. LLM consolidation (pi's session prompt) into session topics under .memory/sessions/<id>/
 *   4. Archive the processed observations. No den write and no claims: promoteSessionTopics later moves session
 *      topics to the den and emits distilled contributions to the KB inbox.
 *
 * Legacy mode (no `sessionTopics`): pool straight to the den, then deltas to the KB inbox:
 *   1. Read the pool; 2. archive absorbed den topics (reconcileDen) and read the rest for context;
 *   3. LLM consolidation; 4. write $WOLF_DEN/memory/topics/; 5. emit deltas to the KB inbox; 6. archive observations.
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
  consolidateSession,
  readTopics,
  readJourney,
  writeTopic,
  renderIndex,
  SESSION_CONSOLIDATION_USER_PROMPT,
  fillPromptTemplate,
  type ConsolidateResult,
  reconcileDen,
  promoteTopics,
  consolidateWorkRecords,
  HttpWorkRecordStore,
  TOPIC_SOFT_CAP,
  type WorkRecordStore,
} from "@wolfpack/memory";
import { isSafeSegment, type KbRoots } from "@wolfpack/kb/shared";

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

/**
 * Where a durable wolf keeps its session topics: pi's layout (`<root>/<sessionId>/<topic>.md` + INDEX.md), under the
 * wolf's den. One session per wolf, not per run or per conversation: the observation pool is per wolf and survives
 * restarts, so the topics folded out of it must too (a per-run id would strand unpromoted topics at every restart,
 * and promote is an idempotent upsert, so a long-lived session is exactly what pi's own long sessions are).
 */
export interface SessionTopicsLocation {
  /** The directory holding session dirs (consolidateSession's `memoryRoot`). */
  memoryRoot: string;
  sessionId: string;
}

export const DURABLE_SESSION_ID = "durable";

export function durableSessionTopics(wolfDen: string): SessionTopicsLocation {
  return { memoryRoot: join(wolfDen, ".memory", "sessions"), sessionId: DURABLE_SESSION_ID };
}

/** Event callbacks are observers: they never break consolidation. */
function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    /* ignore */
  }
}

export interface ConsolidatedTopic {
  id: string;
  domain?: string;
  change: "create" | "merge";
  scope: "session" | "den";
  /** Observations in the batch this topic was folded from. */
  observationCount: number;
}

export interface ConsolidationConfig {
  /**
   * Fold the pool into session topics (pi's /wolf:consolidate) instead of straight into the den; a later
   * promoteSessionTopics moves them to the den and the KB inbox. Omitted: the legacy pool → den path.
   */
  sessionTopics?: SessionTopicsLocation;
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
  /** Called per topic written (session topics or, on the legacy path, den topics). Metadata only. */
  onTopic?: (t: ConsolidatedTopic) => void;
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
  /** Ids of the topics created or merged by this run (distinct, in write order). */
  topicIds?: string[];
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
export async function consolidatePool(config: ConsolidationConfig): Promise<ConsolidationResult> {
  const ids = new Set<string>();
  const result = await consolidatePoolInner({
    ...config,
    onTopic: (t) => {
      ids.add(t.id);
      config.onTopic?.(t);
    },
  });
  return { ...result, topicIds: [...ids] };
}

async function consolidatePoolInner(
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

  if (config.sessionTopics) {
    const folded = await consolidateToSessionTopics({ ...config, sessionTopics: config.sessionTopics }, engine, denObs, domainCtx);
    await settlePool(wolfDen, [...handled, ...denObs]);
    return {
      observationsProcessed: handled.length + denObs.length,
      topicsCreated: folded.created,
      topicsMerged: folded.merged,
      topicsSkipped: folded.skipped,
      claimsSubmitted: 0,
      recordsWritten,
      observationsPending: pending,
    };
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

    const res = action.result;
    safely(() => config.onTopic?.({ id: res.id, domain: domainOf(res.domain), change, scope: "den", observationCount: denObs.length }));
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

/** Pi's session consolidation (orchestrator.consolidatePool) over durable pool observations. */
async function consolidateToSessionTopics(
  config: ConsolidationConfig & { sessionTopics: SessionTopicsLocation },
  engine: Engine,
  observations: PoolObservation[],
  domainCtx: string,
): Promise<{ created: number; merged: number; skipped: number }> {
  const { onProgress } = config;
  const root = join(config.sessionTopics.memoryRoot, config.sessionTopics.sessionId);
  const obsLines = observations
    .map((o) => `${o.timestamp}${o.domain ? ` [${o.domain}]` : ""}  ${o.content}`)
    .join("\n");
  const existing = readTopics(root);
  const journey = readJourney(root);
  const existingSection =
    existing.length > 0
      ? existing.map((t) => `### ${t.id} — ${t.title}\nSummary: ${t.summary}\n\n${t.body}`).join("\n\n---\n\n")
      : "(empty — no session memory yet)";
  const prompt = fillPromptTemplate(SESSION_CONSOLIDATION_USER_PROMPT, {
    obsLines,
    existingSection,
    journeyBlock: journey ? `===== CURRENT JOURNEY =====\n${journey}\n===== END JOURNEY =====\n` : "",
  });
  let system = CONSOLIDATE_SYSTEM;
  if (domainCtx) {
    system += `\n\nObservations carry domain tags [domain]. When creating or merging topics, set the domain field to match the dominant domain of the observations in that group. NEVER merge observations from different domains into the same topic.\n\n${domainCtx}`;
  }

  onProgress?.("Running LLM consolidation into session topics...");
  const result = await engine.call("consolidate", ConsolidationResultSchema, { system, prompt });

  const now = new Date().toISOString().replace("T", " ").slice(0, 16);
  // As pi: a dropped topic domain falls back to the batch's domain when the batch has exactly one.
  const batchDomains = new Set(observations.map((o) => o.domain).filter(Boolean));
  const soleDomain = batchDomains.size === 1 ? [...batchDomains][0] : undefined;

  let created = 0;
  let merged = 0;
  let skipped = 0;
  for (const action of result.actions) {
    if (action.action === "skip" || !action.result) {
      skipped++;
      continue;
    }
    const r = action.result;
    if (!isSafeSegment(r.id)) {
      skipped++;
      onProgress?.(`  skipped topic with unsafe id ${JSON.stringify(r.id)}`);
      continue;
    }
    const isUpdate = existing.some((t) => t.id === r.id);
    writeTopic(root, { id: r.id, title: r.title, summary: r.summary, updated: now, body: r.body, domain: r.domain || soleDomain });
    safely(() => config.onTopic?.({ id: r.id, domain: r.domain || soleDomain, change: isUpdate ? "merge" : "create", scope: "session", observationCount: observations.length }));
    onProgress?.(`  ${isUpdate ? "updated" : "created"} session topic: ${r.title}`);
    if (isUpdate) merged++;
    else created++;
  }
  renderIndex(root);
  onProgress?.(`Done: ${created} session topic(s) created, ${merged} updated, ${skipped} skipped`);
  return { created, merged, skipped };
}

export interface PromoteSessionConfig {
  wolfDen: string;
  wolfName: string;
  engine: Engine;
  kbRoots?: KbRoots;
  defaultDomain?: string;
  onProgress?: (msg: string) => void;
  /** Called per contribution written to the KB inbox (metadata only). */
  onEmit?: (c: { id: string; denTopicId: string; domain: string }) => void;
}

/**
 * Pi's promote: session topics → den topics → distilled contributions in the KB inbox. consolidateSession runs
 * reconcileDen first (when kbRoots is set), so absorbed topics leave the den before the promote reads it.
 */
export function promoteSessionTopics(config: PromoteSessionConfig): Promise<ConsolidateResult> {
  const loc = durableSessionTopics(config.wolfDen);
  return consolidateSession({
    engine: config.engine,
    den: { denRoot: config.wolfDen, wolfName: config.wolfName },
    memoryRoot: loc.memoryRoot,
    sessionId: loc.sessionId,
    kbRoots: config.kbRoots,
    defaultDomain: config.defaultDomain,
    skipClaims: false,
    onProgress: config.onProgress,
    onEmit: config.onEmit,
  });
}
