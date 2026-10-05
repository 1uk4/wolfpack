/**
 * @wolfpack/pi-adapter — Pi extension for wolfpack memory.
 *
 * This is the THIN adapter between Pi's extension API and the
 * agent-agnostic @wolfpack/memory system. It handles:
 *
 *   1. Session lifecycle (start, shutdown)
 *   2. Observer triggers (turn_end → processChunks)
 *   3. Compaction hook (session_before_compact → render memory summary)
 *   4. Commands (/wolf, /wolf:status, /wolf:consolidate)
 *   5. Wolf den promotion (session end → consolidateSession)
 *
 * The actual memory logic lives in @wolfpack/memory.
 * The LLM calls go through @wolfpack/engine.
 * This file only does the wiring.
 */
import { createEngine } from "@wolfpack/engine";
import {
  createOrchestrator,
  foldLedger,
  type MemoryOrchestrator,
  type LedgerEvent,
  type DenConfig,
} from "@wolfpack/memory";
import { createPiRuntime, PiRuntime } from "./pi-runtime.js";
import { renderCompactionSummary } from "./compaction.js";

// Pi types — using 'any' to avoid hard compile-time dependency
type ExtensionAPI = any;
type Entry = any;

/** Custom entry types in Pi's ledger */
const WP_ENABLED = "wp.memory.enabled";

interface WolfConfig {
  /** Wolf name (e.g. "1uk4") */
  wolfName: string;
  /** Path to wolf den */
  denRoot: string;
  /** Path to librarian inbox */
  librarianInbox?: string;
  /** Default domain for claims */
  defaultDomain?: string;
  /** Anthropic API key (reads from env if not set) */
  apiKey?: string;
  /** Default model */
  model?: string;
  /** Fast model (for classification, claim checks) */
  fastModel?: string;
  /** Observer token chunk size */
  chunkTokens?: number;
  /** Pool tokens before consolidation triggers */
  consolidateAtPoolTokens?: number;
  /** Target pool after consolidation */
  poolTargetTokens?: number;
  /** Max parallel observers */
  observerConcurrency?: number;
  /** Auto-start on session start */
  autoStart?: boolean;
}

const DEFAULT_WOLF_CONFIG: Partial<WolfConfig> = {
  model: "claude-sonnet-4-6",
  fastModel: "claude-haiku-4-5-20251001",
  chunkTokens: 5000,
  consolidateAtPoolTokens: 20000,
  poolTargetTokens: 10000,
  observerConcurrency: 4,
  autoStart: false,
};

/**
 * Load wolf config from environment and .wolf.json (if it exists).
 */
function loadWolfConfig(): WolfConfig | null {
  const wolfName = process.env.WOLF_NAME;
  const denRoot = process.env.WOLF_DEN;

  if (!wolfName || !denRoot) return null;

  return {
    wolfName,
    denRoot,
    librarianInbox: process.env.WOLFPACK_LIBRARIAN,
    defaultDomain: process.env.WOLFPACK_DOMAIN ?? "wolfpack",
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.WOLFPACK_MODEL ?? DEFAULT_WOLF_CONFIG.model,
    fastModel: process.env.WOLFPACK_FAST_MODEL ?? DEFAULT_WOLF_CONFIG.fastModel,
    chunkTokens: Number(process.env.WOLFPACK_CHUNK_TOKENS) || DEFAULT_WOLF_CONFIG.chunkTokens,
    consolidateAtPoolTokens: Number(process.env.WOLFPACK_CONSOLIDATE_AT) || DEFAULT_WOLF_CONFIG.consolidateAtPoolTokens,
    poolTargetTokens: Number(process.env.WOLFPACK_POOL_TARGET) || DEFAULT_WOLF_CONFIG.poolTargetTokens,
    observerConcurrency: Number(process.env.WOLFPACK_OBSERVER_CONCURRENCY) || DEFAULT_WOLF_CONFIG.observerConcurrency,
    autoStart: process.env.WOLFPACK_AUTO_START === "true" || DEFAULT_WOLF_CONFIG.autoStart,
  };
}

/**
 * Read the enabled gate from Pi's session ledger.
 */
function readGateFromLedger(branch: Entry[]): boolean {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === "custom" && entry.customType === WP_ENABLED) {
      return entry.data?.enabled ?? false;
    }
  }
  return false;
}

/**
 * Pi extension entry point.
 */
export default function wolfpackMemory(pi: ExtensionAPI): void {
  let runtime: PiRuntime | null = null;
  let orchestrator: MemoryOrchestrator | null = null;
  let enabled = false;
  let config: WolfConfig | null = null;
  let observerPending = false;

  // ── Session lifecycle ─────────────────────────────────────────────

  pi.on("session_start", (_event: unknown, ctx: any) => {
    config = loadWolfConfig();
    if (!config) return;

    runtime = createPiRuntime(pi, ctx);
    enabled = config.autoStart || readGateFromLedger(ctx.sessionManager.getBranch());

    if (enabled) {
      initOrchestrator(ctx);
    }
  });

  pi.on("session_shutdown", () => {
    enabled = false;
    orchestrator = null;
    runtime = null;
  });

  function initOrchestrator(ctx: any) {
    if (!runtime || !config?.apiKey) return;

    const engine = createEngine({
      provider: "anthropic",
      apiKey: config.apiKey,
      defaultModel: config.model!,
      steps: {
        classify: { model: config.fastModel! },
        claimCheck: { model: config.fastModel! },
        consolidate: { model: config.model! },
      },
    });

    orchestrator = createOrchestrator(engine, runtime, {
      chunkTokens: config.chunkTokens,
      consolidateAtPoolTokens: config.consolidateAtPoolTokens,
      poolTargetTokens: config.poolTargetTokens,
      observerConcurrency: config.observerConcurrency,
    });
  }

  // ── Observer trigger — fire on turn_end ─────────────────────────

  pi.on("turn_end", async (_event: unknown, ctx: any) => {
    if (!enabled || !orchestrator || !runtime || observerPending) return;

    runtime.updateCtx(ctx);
    const chunks = runtime.getNewChunks();
    if (chunks.length === 0) return;

    observerPending = true;
    try {
      await orchestrator.processChunks(chunks);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      runtime.notify(`observer error: ${msg}`, "error");
    } finally {
      observerPending = false;
    }
  });

  // ── Compaction hook — inject memory into summary ─────────────────

  pi.on("session_before_compact", async (_event: any, ctx: any) => {
    if (!enabled || !orchestrator || !runtime) return undefined;

    runtime.updateCtx(ctx);

    // Get active observations for the summary
    const observations = orchestrator.getActiveObservations();
    const memoryRoot = orchestrator.getMemoryRoot();
    const summary = renderCompactionSummary(memoryRoot, observations);

    if (!summary) return undefined;

    return {
      compaction: {
        summary,
      },
    };
  });

  // ── Commands ─────────────────────────────────────────────────────

  pi.registerCommand("wolf", {
    description: "Toggle wolfpack memory (/wolf on, /wolf off)",
    handler: async (args: string, ctx: any) => {
      if (!config) {
        if (ctx.hasUI) ctx.ui.notify("wolf: WOLF_NAME and WOLF_DEN env vars required", "error");
        return;
      }

      const arg = (args ?? "").trim().toLowerCase();
      const next = arg === "on" ? true : arg === "off" ? false : !enabled;

      if (next === enabled) {
        if (ctx.hasUI) ctx.ui.notify(`wolf: already ${next ? "on" : "off"}`, "info");
        return;
      }

      enabled = next;
      pi.appendEntry(WP_ENABLED, { enabled: next });

      if (next) {
        if (!runtime) runtime = createPiRuntime(pi, ctx);
        else runtime.updateCtx(ctx);
        initOrchestrator(ctx);
        if (ctx.hasUI) ctx.ui.notify("wolf: memory enabled", "info");
      } else {
        orchestrator = null;
        if (ctx.hasUI) ctx.ui.notify("wolf: memory disabled", "info");
      }
    },
  });

  pi.registerCommand("wolf:status", {
    description: "Show wolfpack memory status",
    handler: async (_args: string, ctx: any) => {
      const lines: string[] = [];
      lines.push(`Wolf: ${config?.wolfName ?? "(not configured)"}`);
      lines.push(`Memory: ${enabled ? "ON" : "OFF"}`);

      if (enabled && orchestrator) {
        const obs = orchestrator.getActiveObservations();
        const totalTokens = obs.reduce((s, o) => s + o.tokenCount, 0);
        lines.push(`Observations: ${obs.length} (~${totalTokens.toLocaleString()} tokens)`);
        lines.push(`Memory root: ${orchestrator.getMemoryRoot()}`);
      }

      lines.push(`Den: ${config?.denRoot ?? "(not set)"}`);
      lines.push(`API key: ${config?.apiKey ? "set" : "MISSING"}`);

      if (ctx.hasUI) {
        ctx.ui.notify(lines.join("\n"), "info");
      }
    },
  });

  pi.registerCommand("wolf:promote", {
    description: "Promote session memory to wolf den now",
    handler: async (_args: string, ctx: any) => {
      if (!enabled || !orchestrator || !config) {
        if (ctx.hasUI) ctx.ui.notify("wolf: not enabled or not configured", "error");
        return;
      }

      if (ctx.hasUI) ctx.ui.notify("wolf: promoting session to den...", "info");

      try {
        const denConfig: DenConfig = {
          denRoot: config.denRoot,
          wolfName: config.wolfName,
        };
        await orchestrator.promoteToWolfMemory(denConfig);
        if (ctx.hasUI) ctx.ui.notify("wolf: session promoted to den", "info");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (ctx.hasUI) ctx.ui.notify(`wolf: promote failed: ${msg}`, "error");
      }
    },
  });
}
