/**
 * Wolfpack Memory Extension — Unified Implementation
 * 
 * Supports both pi and pi-durable runtimes through the unified extension API.
 * Core logic lives in @wolfpack/memory package.
 */
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

import { join } from "node:path";
import {
  defineExtension,
  defineTool,
  section,
  Type,
  type ExtensionContext,
  type ToolContext,
  type ToolResult,
  type HookContext,
  type AssistantMessage,
  type ConversationMessage,
} from "@wolfpack/harness/extension";
import {
  observe,
  renderDenContext,
  renderKbAccess,
  reconcileDen,
  serializeBranchEntries,
  chunkSerialized,
  buildDomainContext,
  type RawObservation,
} from "@wolfpack/memory";
import { consolidatePool, durableSessionTopics, promoteSessionTopics, type ConsolidationResult } from "@wolfpack/harness/memory";
import { registerMemoryActions, unregisterMemoryActions, type MemoryActions, type PromoteOutcome } from "./memory-actions.js";
import { HttpWorkRecordStore } from "@wolfpack/memory";
import { readBoundTask } from "./unified-tasks.js";
import { drainInbox, listParked, type ParsedContribution, type KbRoots, type ParkedItem } from "@wolfpack/kb/librarian";
import { assertSandboxed, resolveDefaultDomain, createEngine, engineSteps, loadModelTable, type Engine, type EngineConfig, type ModelTable } from "@wolfpack/engine";

// ─── Config ────────────────────────────────────────────────────────────────

export interface MemoryConfig {
  /** Explicit off switch. Memory is also off unless `sandbox` or `live` is set (see {@link memoryGate}). */
  enabled?: boolean;
  /** `memory.live: true` in wolf.yaml: durable memory may write the LIVE den / KB_OPS / Work API. */
  live?: boolean;
  /** @internal test seam: timer period in ms, instead of `consolidation.interval`. */
  intervalMs?: number;
  /** @internal test seam: replaces the lazily-built model engine (the established `engine.call` stub). */
  engine?: Engine;
  /** Minimum text length to trigger observation (default: 100) */
  minTextLength?: number;
  /** Consolidation settings */
  consolidation?: {
    trigger?: "threshold" | "timer" | "hybrid" | "manual";
    /** Pool tokens at which consolidation runs (default 20000, pi's value). */
    threshold?: number;
    /** Pool tokens left in the pool by a consolidation (default 10000, pi's value). */
    poolTarget?: number;
    interval?: string;
  };
  /** `memory.defaultDomain` in wolf.yaml: domain for observations the observer leaves untagged (default: first of `domains`). */
  defaultDomain?: string;
  /** Librarian mode - enables KB inbox tools (read-only for now) */
  librarian?: boolean;
}

// ─── Gate ──────────────────────────────────────────────────────────────────

export interface MemoryGate {
  enabled: boolean;
  /** One line saying why memory is off (or in which mode it runs). */
  reason: string;
}

/**
 * Fail-closed gate for durable memory. It starts only when the wolf is sandboxed (`sandbox:` in wolf.yaml,
 * normalized to `{root}`) or has `memory.live: true`; nothing sets `live` until cutover. In a sandbox it also
 * proves the den and env (incl. a loopback WORK_ENDPOINT) really point into the dev root, and throws if not (a
 * misconfigured sandbox must not boot). `context.env` wins over process.env everywhere in this extension.
 */
export function memoryGate(config: MemoryConfig, context: ExtensionContext): MemoryGate {
  const env = context.env ?? process.env;
  const sandbox = (context.wolfConfig as { sandbox?: unknown }).sandbox;
  if (sandbox) {
    const root = typeof sandbox === "object" ? (sandbox as { root?: unknown }).root : undefined;
    if (typeof root !== "string") throw new Error("sandbox: wolf.yaml sandbox has no resolved dev root; refusing to start memory");
    assertSandboxed(root, {
      den: context.wolfDen,
      kbOps: env.KB_OPS,
      kbDenLocal: env.KB_DEN_LOCAL ?? join(context.wolfDen, "kb"),
      workEndpoint: env.WORK_ENDPOINT,
    });
    // KB_BASE stays readable (context, classification) but nothing mutating may receive it: the librarian tools
    // (reorg, retire, split-fat) are the only writers and are refused above, so they are never registered.
    if (config.librarian) throw new Error("sandbox: librarian mode mutates KB_BASE and is refused in a sandbox; remove memory.librarian");
    return { enabled: config.enabled !== false, reason: config.enabled === false ? "disabled by memory.enabled: false" : `sandbox (${root})` };
  }
  if (config.enabled === false) return { enabled: false, reason: "disabled by memory.enabled: false" };
  if (config.live === true) return { enabled: true, reason: "live (memory.live: true)" };
  return { enabled: false, reason: "durable memory is off: set `sandbox: true` or `memory.live: true` in wolf.yaml to start it" };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Waits between polls for the reported response to be committed (then the hook's copy is used): ~1s in all. */
const COMMIT_WAITS_MS = [10, 20, 40, 80, 160, 160, 160, 160, 160];

/** Pi's defaults (extensions/wolfpack-memory/index.ts CONSOLIDATE_AT / POOL_TARGET). */
export const DEFAULT_CONSOLIDATE_AT = 20000;
export const DEFAULT_POOL_TARGET = 10000;

/** "30s" | "15m" | "4h" | "1d" -> ms; anything else falls back to 4h. */
function parseInterval(interval: string): number {
  const m = interval.match(/^(\d+)(s|m|h|d)$/);
  if (!m) return 4 * 3600_000;
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
}

// ─── Watermarks ────────────────────────────────────────────────────────────

/**
 * Per-conversation observer position, `<den>/.memory/watermarks/<conversationId>.json`.
 *
 * `lastEntryId` is the newest committed entry already observed, advanced after each pooled chunk. afterResponse fires
 * before the response it reports is committed, so the observer may read that response from the hook itself; `tail`
 * fingerprints it and `tailAfter` is the entry position it was observed at. Its committed twin is the first entry after
 * `tailAfter`; when it shows up it is skipped instead of observed twice.
 */
export interface Watermark {
  lastEntryId: number;
  tail?: string;
  tailAfter?: number;
}

const watermarkFile = (den: string, conversationId: number) => join(den, ".memory", "watermarks", `${conversationId}.json`);

/** `undefined` when this conversation has never been observed (no file). */
export async function readWatermark(den: string, conversationId: number): Promise<Watermark | undefined> {
  try {
    const w = JSON.parse(await readFile(watermarkFile(den, conversationId), "utf-8")) as Watermark;
    if (typeof w.lastEntryId === "number") return w;
  } catch { /* none yet */ }
  return undefined;
}

/**
 * Start from now: with no watermark, everything before the current turn's first user message is skipped (no backfill
 * of history from before the observer ran). A brand-new conversation's only user message is its first, so it is
 * captured whole; a fork's own entries start at the fork point.
 */
export function seedWatermark(committed: ConversationMessage[]): Watermark {
  for (let i = committed.length - 1; i >= 0; i--) {
    if (committed[i].message.role === "user") return { lastEntryId: committed[i].entryId - 1 };
  }
  // No user message among the conversation's own entries (a fork continuing mid-turn): they are all new.
  return { lastEntryId: 0 };
}

/** Chunk id -> the entry watermark it covers. A `:current` chunk (the hook's uncommitted copy) covers its prefix. */
export const chunkEntryId = (id: string): number => Number(id.split(":")[0]);

async function writeWatermark(den: string, conversationId: number, w: Watermark): Promise<void> {
  const file = watermarkFile(den, conversationId);
  await mkdir(join(den, ".memory", "watermarks"), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(w));
  await rename(`${file}.tmp`, file);
}

type Block = { type?: string; text?: string; name?: string; arguments?: unknown };

/** Identity of an assistant response across its two forms (hook message, committed entry). Thinking is ignored. */
function fingerprint(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return (content as Block[])
    .map((b) => (b.type === "text" ? `t:${b.text}` : b.type === "toolCall" ? `c:${b.name}:${JSON.stringify(b.arguments ?? {})}` : ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * The text the observer reads for one afterResponse: the conversation's own messages past the watermark, via pi's
 * chunk serializer (user / assistant / tool results, tools opted in).
 *
 * afterResponse fires before the response it reports is committed, so right then `committed` may not hold it yet.
 * Returns undefined while it is missing and `settled` is false (the caller retries). Once settled, a response that
 * still isn't committed is observed from the hook's own copy and fingerprinted in `tail`/`tailAfter`, so that when it
 * is committed later it is skipped instead of observed twice. Only the entry directly after `tailAfter` can be that
 * twin: a user message in between means the observed response never committed (aborted), and a later identical reply
 * is new.
 */
export function newObserverChunks(
  committed: ConversationMessage[],
  current: AssistantMessage,
  watermark: Watermark,
  settled: boolean,
): { chunks: Array<{ id: string; text: string; tokenCount: number }>; next: Watermark } | undefined {
  let rest = committed;
  if (watermark.tail && watermark.tailAfter !== undefined) {
    const first = rest[0];
    if (first && first.entryId > watermark.tailAfter && first.message.role === "assistant" && fingerprint(first.message.content) === watermark.tail) {
      rest = rest.slice(1);
    }
  }
  const lastEntryId = committed.length ? committed[committed.length - 1].entryId : watermark.lastEntryId;
  const entries: Array<{ type: string; id: string; message: ConversationMessage["message"] }> = rest.map((m) => ({ type: "message", id: String(m.entryId), message: m.message }));
  const chunk = () => chunkSerialized(serializeBranchEntries(entries, { tools: true }));

  const fp = fingerprint(current.content);
  // Any unobserved assistant entry may be the reported response: when the observer lags (a tool round runs on while
  // it polls) the reported call is no longer the latest assistant entry. A false match is harmless: nothing is
  // dropped, the watermark only ever advances to committed entries and the real response is read once it commits.
  const isCommitted = fp === "" || rest.some((m) => m.message.role === "assistant" && fingerprint(m.message.content) === fp);
  if (isCommitted) return { chunks: chunk(), next: { lastEntryId } };
  if (!settled) return undefined;
  entries.push({ type: "message", id: `${lastEntryId}:current`, message: { role: "assistant", content: current.content } });
  return { chunks: chunk(), next: { lastEntryId, tail: fp, tailAfter: lastEntryId } };
}

/**
 * Append observations to the pool. While a task is bound they are stamped
 * `work: <task id>`: they feed that item's Record, not the den.
 */
async function writeToPool(
  wolfDen: string,
  observations: RawObservation[],
  bound: { taskId: string; featureId?: string } | null = null,
  defaultDomain?: string,
): Promise<void> {
  if (observations.length === 0) return;
  const poolDir = join(wolfDen, ".memory", "pool");
  await mkdir(poolDir, { recursive: true });
  const poolFile = join(poolDir, "observations.jsonl");
  const timestamp = new Date().toISOString();
  const lines = observations.map(obs =>
    JSON.stringify({
      ...obs,
      // Stamped at observe time (as pi's orchestrator does), so consolidation never has to guess a domain.
      ...(defaultDomain ? { domain: obs.domain || defaultDomain } : {}),
      recordedAt: timestamp,
      ...(bound ? { work: bound.taskId, ...(bound.featureId ? { feature: bound.featureId } : {}) } : {}),
    }) + "\n"
  );
  await appendFile(poolFile, lines.join(""));
}

function renderSplitResult(
  r: { entryId: string; parentSize: number; shards: Array<{ entryId: string; title: string; size: number }>; retired: boolean },
  dryRun: boolean
): string {
  const lines = [`### ${r.entryId} (${r.parentSize} chars)`];
  if (r.shards.length === 0) {
    lines.push("  (below threshold — skipped)");
    return lines.join("\n");
  }
  const status = dryRun ? "would write" : r.retired ? "wrote + retired" : "wrote (retire failed)";
  lines.push(`  ${status}: ${r.shards.length} shards`);
  for (const s of r.shards) {
    lines.push(`    - ${s.entryId} (${s.size} chars) — ${s.title}`);
  }
  return lines.join("\n");
}

async function getPoolStats(wolfDen: string): Promise<{ count: number; tokens: number }> {
  const poolFile = join(wolfDen, ".memory", "pool", "observations.jsonl");
  if (!existsSync(poolFile)) return { count: 0, tokens: 0 };
  try {
    const content = await readFile(poolFile, "utf-8");
    const lines = content.split("\n").filter(l => l.trim());
    const tokens = Math.ceil(content.length / 4);
    return { count: lines.length, tokens };
  } catch {
    return { count: 0, tokens: 0 };
  }
}

// ─── Extension Factory ─────────────────────────────────────────────────────

export default function createMemoryExtension(
  config: MemoryConfig,
  context: ExtensionContext
): ReturnType<typeof defineExtension> {
  const { wolfDen, wolfName, domains } = context;
  const {
    minTextLength = 100,
    consolidation,
  } = config;

  // Fail closed before anything touches the den (reconcileDen below writes to it).
  const gate = memoryGate(config, context);
  console.log(`[memory] ${gate.enabled ? "starting: " : "inert: "}${gate.reason}`);
  if (!gate.enabled) return defineExtension({ name: "wolfpack-memory", runtimes: ["pi", "pi-durable"] });

  const defaultDomain = resolveDefaultDomain(config.defaultDomain, domains);
  // Per-observation classification, as pi: built once, only when there is a choice to make.
  const domainKbBase = (context.env ?? process.env).KB_BASE;
  const domainContext = domains.length > 1 ? buildDomainContext(domains, domainKbBase) : "";
  if (domains.length > 1) {
    console.log(
      domainKbBase
        ? `[memory] domain context built for ${domains.length} domains (KB_BASE ${domainKbBase})`
        : `[memory] warning: ${domains.length} domains but no KB_BASE; the observer classifies without domain descriptions`,
    );
  }

  const consolidationThreshold = consolidation?.threshold ?? DEFAULT_CONSOLIDATE_AT;
  const poolTarget = consolidation?.poolTarget ?? DEFAULT_POOL_TARGET;
  const consolidationTrigger = consolidation?.trigger ?? "hybrid";

  // Models come from the wolf's resolved table (the harness points
  // WOLFPACK_MODELS_FILE at the shipped models.json before loading us).
  // Loaded lazily so a broken table surfaces as a tool error, not a crash.
  let table: ModelTable | null = null;
  function getTable(): ModelTable {
    if (!table) table = loadModelTable().table;
    return table;
  }
  function apiKeyFor(t: ModelTable): string | undefined {
    return t.tiers.smart.provider === "anthropic" ? (context.env ?? process.env).ANTHROPIC_API_KEY : undefined;
  }
  /** Engine on the table's models/transport. */
  function makeEngine(): Engine {
    const t = getTable();
    const steps: NonNullable<EngineConfig["steps"]> = engineSteps(t);
    const apiKey = apiKeyFor(t);
    return createEngine({
      provider: t.tiers.smart.provider,
      ...(apiKey ? { apiKey } : {}),
      defaultModel: t.tiers.smart.model,
      steps,
    });
  }

  // Lazy-init engine
  let engine: Engine | null = null;
  function getEngine(): Engine {
    if (!engine) engine = config.engine ?? makeEngine();
    return engine;
  }

  // Record store from context.env when given (sandbox): never falls back to process.env.WORK_ENDPOINT.
  function recordStore(): HttpWorkRecordStore | undefined {
    if (!context.env) return undefined; // consolidatePool then reads the process env, as before
    return new HttpWorkRecordStore(context.env.WORK_ENDPOINT ?? "", context.env.WORK_TOKEN ?? "");
  }

  // KB roots from env
  const kbBase = (context.env ?? process.env).KB_BASE;
  const kbOps = (context.env ?? process.env).KB_OPS;
  const kbRoots: KbRoots | null = kbBase && kbOps ? {
    kbBase,
    opsRoot: kbOps,
    denLocal: join(wolfDen, "kb"),
  } : null;
  
  // Librarian mode
  const isLibrarian = config.librarian === true;
  
  // Archive den topics Dewey has absorbed (receipt-driven, silent). Daemon
  // wolves only do this at startup; between restarts renderDenContext still
  // hides absorbed topics, so wolf_memory stays lean either way.
  try {
    reconcileDen(wolfDen, kbRoots ?? undefined, wolfName);
  } catch { /* never block startup */ }

  // ─── Observer ──────────────────────────────────────────────────────────────
  const observing = new Map<number, Promise<void>>();
  let warnedNoReads = false;
  let consolidating: Promise<void> | null = null;
  let closeHooked = false;

  /**
   * Observe what a conversation said since its watermark. Any conversation that is not task-owned captures (root or
   * fork); task-owned conversations (subagents) capture nothing. Unbound talk lands in the pool and consolidates to
   * den topics. The binding is the conversation's lineage binding, re-read each chunk.
   */
  async function observeConversation(message: AssistantMessage, ctx: HookContext, opts: { flush?: boolean } = {}): Promise<void> {
    const reads = ctx.conversation;
    if (!reads) {
      if (!warnedNoReads) {
        warnedNoReads = true;
        console.warn("[memory] observer inactive: hook has no conversation reader (host did not attachConversationReader)");
      }
      return;
    }
    const cls = await reads.classify();
    if (!cls || cls.kind === "task") return;

    let watermark = await readWatermark(ctx.wolfDen, ctx.conversationId);
    if (!watermark) {
      watermark = seedWatermark(await reads.messagesSince(0));
      await writeWatermark(ctx.wolfDen, ctx.conversationId, watermark);
    }
    let planned: ReturnType<typeof newObserverChunks>;
    for (let attempt = 0; !planned; attempt++) {
      if (attempt === 0) await new Promise((r) => setImmediate(r));
      const committed = await reads.messagesSince(watermark.lastEntryId);
      planned = newObserverChunks(committed, message, watermark, attempt >= COMMIT_WAITS_MS.length);
      if (!planned) await new Promise((r) => setTimeout(r, COMMIT_WAITS_MS[attempt]));
    }
    const { chunks, next } = planned;
    if (!opts.flush && chunks.reduce((n, c) => n + c.text.length, 0) < minTextLength) return; // keep accumulating

    const eng = getEngine();
    let at = watermark.lastEntryId;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const result = await observe({ engine: eng, chunkText: chunk.text, mode: "conversation", domainContext: domainContext || undefined });
      if (result.observations.length > 0) await writeToPool(ctx.wolfDen, result.observations, await readBoundTask(ctx), defaultDomain); // re-read every chunk, never cached
      // Persist per chunk: a failure in a later chunk retries from here, not from the start.
      const last = i === chunks.length - 1;
      at = last ? next.lastEntryId : chunkEntryId(chunk.id);
      await writeWatermark(ctx.wolfDen, ctx.conversationId, last ? next : { lastEntryId: at });
    }

    if (!closeHooked) {
      closeHooked = true;
      ctx.conversation?.onEngineClose?.(() => unregisterMemoryActions(wolfDen, actions));
    }
    startTimer(ctx);
    if (consolidationTrigger === "threshold" || consolidationTrigger === "hybrid") void maybeConsolidate(ctx);
  }

  /**
   * Before a durable conversation compacts: observe everything since its watermark, whatever its size, so nothing the
   * summary replaces goes uncaptured. Runs on the conversation's observer queue (after any in-flight observation).
   * Nothing is committed beyond the entries already there, so the usual watermark keeps it from double counting.
   */
  function flushBeforeCompact(ctx: HookContext): Promise<void> {
    const prev = observing.get(ctx.conversationId) ?? Promise.resolve();
    const run = prev.then(() => observeConversation({ content: [] } as unknown as AssistantMessage, ctx, { flush: true })).catch((err) => {
      console.error("[memory] pre-compaction capture error:", err instanceof Error ? err.message : err);
    });
    observing.set(ctx.conversationId, run);
    void run.finally(() => {
      if (observing.get(ctx.conversationId) === run) observing.delete(ctx.conversationId);
    });
    return run;
  }

  // ─── Interval timer (trigger: timer | hybrid) ─────────────────────────────
  let timer: ReturnType<typeof setInterval> | undefined;
  const stopTimer = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
  /** Started on the first observation (durable has no extension start hook); cleared when the engine closes. */
  function startTimer(ctx: HookContext): void {
    if (timer || ctx.conversation?.hostConsolidationTimer || (consolidationTrigger !== "timer" && consolidationTrigger !== "hybrid")) return;
    const ms = config.intervalMs ?? parseInterval(consolidation?.interval ?? "4h");
    timer = setInterval(() => {
      void (async () => {
        try {
          if (consolidating || (await getPoolStats(wolfDen)).count === 0) return;
          if (!actions.promoteEnabled) {
            console.log("[memory] Timer-triggered consolidation (session topics only)");
            await actions.consolidate();
            return;
          }
          console.log("[memory] Timer-triggered consolidate + promote");
          const job = actions.promote();
          if (job.status === "started") await job.done;
        } catch (err) {
          console.error("[memory] timer error:", err instanceof Error ? err.message : err);
        }
      })();
    }, ms);
    timer.unref?.();
    ctx.conversation?.onEngineClose?.(stopTimer);
  }

  function maybeConsolidate(ctx: HookContext): Promise<void> {
    if (consolidating) return consolidating;
    return getPoolStats(ctx.wolfDen).then((stats) => {
      if (stats.tokens < consolidationThreshold) return;
      console.log(`[memory] Threshold reached (${stats.tokens} >= ${consolidationThreshold}), consolidating...`);
      return runConsolidation();
    });
  }

  // Consolidation and promote mutate the same session topics, so they run one at a time (pi's orchestrator does the same).
  let opTail: Promise<unknown> = Promise.resolve();
  function serialized<T>(op: () => Promise<T>): Promise<T> {
    const run = opTail.then(op, op);
    opTail = run.catch(() => {});
    return run;
  }

  /** Pool → session topics (pi's consolidation), unserialized: callers hold the queue. poolTarget undefined: the whole pool. */
  function consolidateInner(opts: { poolTarget?: number; minObservations: number }): Promise<ConsolidationResult> {
    return consolidatePool({
      wolfDen,
      wolfName,
      table: getTable(),
      apiKey: apiKeyFor(getTable()),
      kbRoots: kbRoots ?? undefined,
      workStore: recordStore(),
      ...(config.engine ? { engine: config.engine } : {}),
      defaultDomain,
      domains,
      sessionTopics: durableSessionTopics(wolfDen),
      ...(opts.poolTarget !== undefined ? { poolTarget: opts.poolTarget } : {}),
      minObservations: opts.minObservations,
      onProgress: (msg) => console.log(`[memory] ${msg}`),
    });
  }
  const consolidateToSessions = (opts: { poolTarget?: number; minObservations: number }) => serialized(() => consolidateInner(opts));

  /** Consolidate the pool down to poolTarget (drain: the whole pool, as the timer does). Never overlaps itself. */
  function runConsolidation(opts: { drain?: boolean } = {}): Promise<void> {
    if (consolidating) return consolidating;
    consolidating = (async () => {
      try {
        // minObservations 1: the trigger already decided; the manual-use size floor doesn't apply
        const consResult = await consolidateToSessions({ ...(opts.drain ? {} : { poolTarget }), minObservations: 1 });
        console.log(`[memory] Auto-consolidated into session topics: ${consResult.topicsCreated} created, ${consResult.topicsMerged} updated`);
      } catch (consErr) {
        console.error("[memory] Auto-consolidation failed:", consErr instanceof Error ? consErr.message : consErr);
      } finally {
        consolidating = null;
      }
    })();
    return consolidating;
  }

  // ─── Actions (consolidate / promote) ──────────────────────────────────────
  let promoting: string | null = null;
  let jobSeq = 0;
  if (!kbRoots) console.log("[memory] promote disabled: no KB roots (KB_BASE/KB_OPS); interval ticks only consolidate into session topics");
  const actions: MemoryActions = {
    promoteEnabled: kbRoots !== null,
    consolidate: () => consolidateToSessions({ minObservations: 1 }),
    promote() {
      if (promoting) return { status: "already_running", jobId: promoting };
      const jobId = `promote-${Date.now().toString(36)}-${++jobSeq}`;
      promoting = jobId;
      const done = (async (): Promise<PromoteOutcome> => {
        try {
          if (!kbRoots) throw new Error("promote needs KB_BASE and KB_OPS (no KB roots configured); nothing was changed");
          // One queue slot: nothing interleaves between consolidate and promote. reconcileDen runs at promote start
          // inside promoteSessionTopics, as in pi.
          const { consolidated, promoted } = await serialized(async () => {
            const c = (await consolidateInner({ minObservations: 1 })).observationsProcessed;
            const p = await promoteSessionTopics({
              wolfDen,
              wolfName,
              engine: getEngine(),
              kbRoots,
              defaultDomain,
              onProgress: (msg) => console.log(`[memory] ${msg}`),
            });
            return { consolidated: c, promoted: p };
          });
          return { consolidated, promoted };
        } finally {
          promoting = null;
        }
      })();
      done.catch(() => {}); // the caller owns the rejection; never an unhandled one
      return { status: "started", jobId, done };
    },
  };
  registerMemoryActions(wolfDen, actions);

  return defineExtension({
    name: "wolfpack-memory",
    runtimes: ["pi", "pi-durable"],

    lifecycle: { stop: () => { stopTimer(); unregisterMemoryActions(wolfDen, actions); } },

    tools: [
      defineTool({
        name: "memory_consolidate",
        description: "Consolidate the observation pool into session topics (promote publishes them to the den and KB). Use when you have important context to preserve, or when the pool is getting large.",
        parameters: Type.Object({
          reason: Type.Optional(Type.String({ description: "Why you're consolidating (for logging)" })),
        }),
        async execute(args: { reason?: string }, ctx: ToolContext): Promise<ToolResult> {
          try {
            const stats = await getPoolStats(ctx.wolfDen);
            if (stats.count === 0) {
              return {
                content: [{ type: "text", text: "Nothing to consolidate — pool is empty." }],
              };
            }

            const result = await actions.consolidate();

            return {
              content: [{
                type: "text",
                text: `Consolidated ${result.observationsProcessed} observations into session topics: ${result.topicsCreated} created, ${result.topicsMerged} updated.`,
              }],
            };
          } catch (err) {
            return {
              content: [{
                type: "text",
                text: `Consolidation failed: ${err instanceof Error ? err.message : String(err)}`,
              }],
              isError: true,
            };
          }
        },
      }),
      
      // Librarian tools (read-only for now)
      ...(isLibrarian && kbRoots ? [
        defineTool({
          name: "kb_inbox",
          description: "List pending contributions in the KB inbox. Shows what wolves have submitted for integration.",
          parameters: Type.Object({
            limit: Type.Optional(Type.Number({ description: "Max items to show (default: 20)" })),
          }),
          async execute(args: { limit?: number }, ctx: ToolContext): Promise<ToolResult> {
            const contributions = drainInbox(kbRoots);
            const limit = args.limit ?? 20;
            
            if (contributions.length === 0) {
              return {
                content: [{ type: "text", text: "KB inbox is empty." }],
              };
            }
            
            // Group by wolf
            const byWolf = new Map<string, ParsedContribution[]>();
            for (const c of contributions) {
              const list = byWolf.get(c.from) ?? [];
              list.push(c);
              byWolf.set(c.from, list);
            }
            
            const lines: string[] = [`## KB Inbox (${contributions.length} pending)`, ""];
            let shown = 0;
            
            for (const [wolf, items] of byWolf.entries()) {
              lines.push(`### ${wolf} (${items.length})`);
              for (const c of items.slice(0, limit - shown)) {
                const domain = c.domainHint || "?";
                const grad = c.graduation ? ` [${c.graduation}]` : "";
                lines.push(`- ${c.denTopicId} → ${domain}${grad}`);
                shown++;
                if (shown >= limit) break;
              }
              if (shown >= limit && contributions.length > limit) {
                lines.push(`... +${contributions.length - shown} more`);
                break;
              }
              lines.push("");
            }
            
            return { content: [{ type: "text", text: lines.join("\n") }] };
          },
        }),
        
        defineTool({
          name: "kb_contribution",
          description: "View a specific contribution's details by topic ID.",
          parameters: Type.Object({
            topicId: Type.String({ description: "The den_topic_id to look up" }),
          }),
          async execute(args: { topicId: string }, ctx: ToolContext): Promise<ToolResult> {
            const contributions = drainInbox(kbRoots);
            const match = contributions.find(c => c.denTopicId === args.topicId);
            
            if (!match) {
              return {
                content: [{ type: "text", text: `Not found: ${args.topicId}` }],
                isError: true,
              };
            }
            
            const lines = [
              `## ${match.denTopicId}`,
              `From: ${match.from}`,
              `Domain: ${match.domainHint || "(none)"}`,
              `Change: ${match.change}`,
              `Hash: ${match.contentHash.slice(0, 12)}`,
            ];
            
            if (match.graduation) lines.push(`Graduation: ${match.graduation}`);
            if (match.entryId) lines.push(`Entry: ${match.entryId}`);
            if (match.partOf) lines.push(`Part of: ${match.partOf}`);
            
            return { content: [{ type: "text", text: lines.join("\n") }] };
          },
        }),
        
        defineTool({
          name: "kb_parked",
          description: "List parked (stuck) contributions that failed processing. These need manual intervention.",
          parameters: Type.Object({}),
          async execute(_args: unknown, ctx: ToolContext): Promise<ToolResult> {
            const parked = listParked(kbRoots);
            
            if (parked.length === 0) {
              return {
                content: [{ type: "text", text: "No parked items." }],
              };
            }
            
            const lines: string[] = [`## Parked Items (${parked.length})`, ""];
            for (const p of parked) {
              lines.push(`### ${p.contribution.denTopicId}`);
              lines.push(`  From: ${p.contribution.from}`);
              lines.push(`  Domain: ${p.contribution.domainHint || "(none)"}`);
              lines.push(`  Reason: ${p.reason}`);
              lines.push(`  Parked: ${p.parkedAt}`);
              lines.push("");
            }
            
            return { content: [{ type: "text", text: lines.join("\n") }] };
          },
        }),
        
        defineTool({
          name: "kb_status",
          description: "Get KB status overview: inbox count, parked count, and domain health.",
          parameters: Type.Object({}),
          async execute(_args: unknown, ctx: ToolContext): Promise<ToolResult> {
            const inbox = drainInbox(kbRoots);
            const parked = listParked(kbRoots);
            
            // Group inbox by domain
            const byDomain = new Map<string, number>();
            for (const c of inbox) {
              const d = c.domainHint || "unknown";
              byDomain.set(d, (byDomain.get(d) ?? 0) + 1);
            }
            
            const lines: string[] = [
              `## KB Status`,
              "",
              `**Inbox:** ${inbox.length} pending`,
              `**Parked:** ${parked.length} stuck`,
              "",
            ];
            
            if (byDomain.size > 0) {
              lines.push("**By Domain:**");
              for (const [d, count] of byDomain.entries()) {
                lines.push(`  - ${d}: ${count}`);
              }
            }
            
            return { content: [{ type: "text", text: lines.join("\n") }] };
          },
        }),
        
        defineTool({
          name: "kb_sweep_start",
          description: "Start a KB sweep in the background to process pending contributions. Returns immediately - use kb_sweep_status to monitor progress.",
          parameters: Type.Object({}),
          async execute(_args: unknown, ctx: ToolContext): Promise<ToolResult> {
            // Check if sweep manager is available
            if (!context.sweep) {
              return {
                content: [{ type: "text", text: "Sweep manager not initialized. Check librarian configuration." }],
                isError: true,
              };
            }
            
            // Check inbox first
            const inbox = drainInbox(kbRoots);
            if (inbox.length === 0) {
              return {
                content: [{ type: "text", text: "Nothing to sweep — inbox is empty." }],
              };
            }
            
            // Start sweep in background
            const result = await context.sweep.start();
            
            if (!result.started) {
              return {
                content: [{ type: "text", text: result.reason ?? "Sweep could not start." }],
              };
            }
            
            return {
              content: [{
                type: "text",
                text: `Sweep started in background (${inbox.length} items in inbox).\nUse kb_sweep_status to monitor progress.`,
              }],
            };
          },
        }),
        
        defineTool({
          name: "kb_sweep_status",
          description: "Check the status of the KB sweep. Shows progress if running, or last result if completed.",
          parameters: Type.Object({}),
          async execute(_args: unknown, ctx: ToolContext): Promise<ToolResult> {
            if (!context.sweep) {
              return {
                content: [{ type: "text", text: "Sweep manager not initialized." }],
                isError: true,
              };
            }
            
            const status = context.sweep.getStatus();
            const lines: string[] = [`## Sweep Status: ${status.state}`];
            
            if (status.startedAt) {
              lines.push(`Started: ${status.startedAt}`);
            }
            
            if (status.state === "running" && status.progress) {
              lines.push(`Progress: ${status.progress}`);
            }
            
            if (status.completedAt) {
              lines.push(`Completed: ${status.completedAt}`);
            }
            
            if (status.result) {
              const r = status.result;
              lines.push("");
              lines.push("**Results:**");
              lines.push(`- Processed: ${r.processed}`);
              lines.push(`- Created: ${r.created}`);
              lines.push(`- Merged: ${r.merged}`);
              lines.push(`- Rejected: ${r.rejected}`);
              lines.push(`- Parked: ${r.parked}`);
              lines.push(`- Remaining: ${r.remaining}`);
              lines.push(`- Duration: ${Math.round(r.duration / 1000)}s`);
            }
            
            if (status.error) {
              lines.push(`\n**Error:** ${status.error}`);
            }
            
            return { content: [{ type: "text", text: lines.join("\n") }] };
          },
        }),
        
        defineTool({
          name: "kb_reorg",
          description: "Reorganize KB sections. Use rebuild=true for full bottom-up reconstruction of the section tree (agglomerative clustering). Without rebuild, does incremental maintenance (split/merge/prune).",
          parameters: Type.Object({
            domain: Type.Optional(Type.String({ description: "Only reorg this domain (default: all)" })),
            rebuild: Type.Optional(Type.Boolean({ description: "Full bottom-up rebuild of section tree (default: false)" })),
          }),
          async execute(args: { domain?: string; rebuild?: boolean }, ctx: ToolContext): Promise<ToolResult> {
            try {
              const { reorg } = await import("@wolfpack/kb/librarian");
              // Every step on its tier (section summaries/labels on fast).
              const engine = makeEngine();
              
              const roots = {
                kbBase: kbRoots.kbBase,
                opsRoot: kbRoots.opsRoot,
                denLocal: join(wolfDen, "kb"),
              };
              
              const result = await reorg({
                engine,
                roots,
                domains: args.domain ? [args.domain] : undefined,
                rebuild: args.rebuild,
                notify: (msg: string) => console.log(`[librarian] ${msg}`),
              });
              
              const lines = [
                `## Reorg Complete${result.rebuilt ? " (Full Rebuild)" : ""}`,
                "",
                `- Splits: ${result.splits}`,
                `- Merges: ${result.merges}`,
                `- Crystallized: ${result.crystallized}`,
                `- Entries moved: ${result.placements}`,
                `- Labels updated: ${result.labelsUpdated}`,
                `- Domains: ${result.domains.join(", ")}`,
              ];
              
              return { content: [{ type: "text", text: lines.join("\n") }] };
            } catch (err) {
              return {
                content: [{ type: "text", text: `Reorg failed: ${err instanceof Error ? err.message : String(err)}` }],
                isError: true,
              };
            }
          },
        }),
        
        defineTool({
          name: "kb_retire",
          description: "Remove KB entries by ID. Deletes the entry file, updates registry, digest, and index.",
          parameters: Type.Object({
            entryIds: Type.Array(Type.String({ description: "Entry IDs to retire (e.g., kb-wolfpack-abc1234)" })),
            reason: Type.Optional(Type.String({ description: "Reason for retirement" })),
          }),
          async execute(args: { entryIds: string[]; reason?: string }, ctx: ToolContext): Promise<ToolResult> {
            try {
              const { retireEntries } = await import("@wolfpack/kb/librarian");
              
              const roots = {
                kbBase: kbRoots.kbBase,
                opsRoot: kbRoots.opsRoot,
                denLocal: join(wolfDen, "kb"),
              };
              
              const result = retireEntries(roots, args.entryIds, { reason: args.reason });
              
              const lines = [`## Retired ${result.retired.length} entries`];
              for (const e of result.retired) {
                lines.push(`- ${e.entryId}`);
              }
              if (result.notFound.length > 0) {
                lines.push("", `Not found: ${result.notFound.join(", ")}`);
              }
              
              return { content: [{ type: "text", text: lines.join("\n") }] };
            } catch (err) {
              return {
                content: [{ type: "text", text: `Retire failed: ${err instanceof Error ? err.message : String(err)}` }],
                isError: true,
              };
            }
          },
        }),

        defineTool({
          name: "kb_split_fat",
          description:
            "Scan and split oversized KB entries into cohesive shards. " +
            "With no action args, reports what would be split (dry report). " +
            "With entryId, splits that one entry. With auto=true, splits up to " +
            "`max` oversized entries in order of size. Runs the LLM to propose " +
            "shards along ## boundaries. Follow with kb_reorg to re-cluster.",
          parameters: Type.Object({
            domain: Type.Optional(Type.String({ description: "Scope to one domain (default: all)" })),
            entryId: Type.Optional(Type.String({ description: "Split exactly this entry" })),
            auto: Type.Optional(Type.Boolean({ description: "Process every oversized entry in scope" })),
            max: Type.Optional(Type.Number({ description: "Cap on entries processed when auto=true (default: 20)" })),
            threshold: Type.Optional(Type.Number({ description: `Oversized threshold in chars (default: 10000)` })),
            dryRun: Type.Optional(Type.Boolean({ description: "Propose shards without writing or retiring" })),
          }),
          async execute(
            args: {
              domain?: string;
              entryId?: string;
              auto?: boolean;
              max?: number;
              threshold?: number;
              dryRun?: boolean;
            },
            ctx: ToolContext
          ): Promise<ToolResult> {
            try {
              const { scanFat, splitFatEntry, splitFatAuto, SPLIT_FAT } = await import(
                "@wolfpack/kb/librarian"
              );

              const roots = {
                kbBase: kbRoots.kbBase,
                opsRoot: kbRoots.opsRoot,
                denLocal: join(wolfDen, "kb"),
              };

              // Scan-only (no action args)
              if (!args.entryId && !args.auto) {
                const candidates = scanFat(roots, {
                  domain: args.domain,
                  threshold: args.threshold,
                });
                if (candidates.length === 0) {
                  return {
                    content: [{
                      type: "text",
                      text: `No oversized entries${args.domain ? ` in ${args.domain}` : ""} (threshold ${args.threshold ?? SPLIT_FAT.oversizedThreshold} chars).`,
                    }],
                  };
                }
                const lines: string[] = [
                  `## Oversized Entries (${candidates.length})`,
                  "",
                  `Threshold: ${args.threshold ?? SPLIT_FAT.oversizedThreshold} chars · target shard max: ${SPLIT_FAT.targetShardMax}`,
                  "",
                ];
                for (const c of candidates) {
                  lines.push(
                    `- **${c.entryId}** (${c.domain}, ${c.size} chars, ${c.nH2Sections} H2 sections) → ${c.suggestedShards} shards`,
                  );
                  lines.push(`  ${c.title}`);
                }
                return { content: [{ type: "text", text: lines.join("\n") }] };
              }

              // Lazy engine
              const splitEngine = makeEngine();
              const notify = (m: string) => console.log(`[librarian] ${m}`);

              // Single-entry split
              if (args.entryId) {
                const r = await splitFatEntry({
                  engine: splitEngine,
                  roots,
                  entryId: args.entryId,
                  threshold: args.threshold,
                  notify,
                  dryRun: args.dryRun,
                });
                return { content: [{ type: "text", text: renderSplitResult(r, !!args.dryRun) }] };
              }

              // Auto-split
              const { scanned, processed } = await splitFatAuto({
                engine: splitEngine,
                roots,
                domain: args.domain,
                threshold: args.threshold,
                max: args.max ?? 20,
                notify,
                dryRun: args.dryRun,
              });

              const lines: string[] = [
                `## Split Fat ${args.dryRun ? "(DRY RUN) " : ""}— ${processed.length} / ${scanned.length} oversized`,
                "",
              ];
              for (const r of processed) {
                lines.push(renderSplitResult(r, !!args.dryRun));
                lines.push("");
              }
              if (!args.dryRun && processed.length > 0) {
                lines.push("Follow up with `kb_reorg` to re-cluster the new shards into the section tree.");
              }
              return { content: [{ type: "text", text: lines.join("\n") }] };
            } catch (err) {
              return {
                content: [{ type: "text", text: `Split failed: ${err instanceof Error ? err.message : String(err)}` }],
                isError: true,
              };
            }
          },
        }),
      ] : []),
    ],

    sections: [
      section("wolf_memory", (ctx) => {
        const content = renderDenContext(ctx.wolfDen, ctx.wolfName, kbRoots ?? undefined);
        return content ?? undefined;
      }),
      section("kb_access", (ctx) => {
        const content = renderKbAccess(kbBase, domains);
        return content ?? undefined;
      }),
    ],

    hooks: {
      beforeCompact: (_compaction, ctx) => flushBeforeCompact(ctx),
      afterResponse: (message: AssistantMessage, ctx: HookContext) => {
        // Fire-and-forget; one observation at a time per conversation (afterResponse fires per model response, so a
        // tool round fires twice and the second must see the first's watermark).
        const prev = observing.get(ctx.conversationId) ?? Promise.resolve();
        const run = prev.then(() => observeConversation(message, ctx)).catch((err) => {
          console.error("[memory] observation error:", err instanceof Error ? err.message : err);
        });
        observing.set(ctx.conversationId, run);
        void run.finally(() => {
          if (observing.get(ctx.conversationId) === run) observing.delete(ctx.conversationId);
        });
      },
    },
  });
}
