/**
 * wolfpack-memory — Pi extension for wolfpack memory system.
 *
 * Thin adapter between Pi's extension API and @wolfpack/memory.
 * Replaces observational-memory + mac-librarian-bridge.
 *
 * Environment variables:
 *   WOLF_NAME           — wolf identity (e.g. "1uk4")
 *   WOLF_DEN            — path to wolf den (e.g. ~/wolves/dens/1uk4/den)
 *   ANTHROPIC_API_KEY   — for LLM calls (observer, consolidator, claims)
 *   WOLFPACK_LIBRARIAN  — path to librarian inbox root (optional, enables auto-claims)
 *   WOLFPACK_DOMAIN     — default domain for claims (default: wolfpack)
 *   WOLFPACK_MODEL      — model for consolidation (default: claude-sonnet-4-6)
 *   WOLFPACK_FAST_MODEL — model for observers/classification (default: claude-haiku-4-5-20251001)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createEngine, type Engine } from "@wolfpack/engine";
import {
  createOrchestrator,
  sortObservations,
  readTopics,
  readJourney,
  foldLedger,
  poolTokens,
  type MemoryOrchestrator,
  type Observation,
  type AgentRuntime,
  type ConversationChunk,
  type LedgerEntry,
  type MemoryEvent,
  type MemoryEventHandler,
  type LedgerEvent,
  type DenConfig,
} from "@wolfpack/memory";
import * as path from "node:path";
import * as fs from "node:fs";

// ── Custom entry types ──────────────────────────────────────────────────────

const WP_ENABLED = "wp.memory.enabled";
const WP_LEDGER  = "wp.memory.ledger";

// ── TUI Status ──────────────────────────────────────────────────────────────

interface MemoryStatus {
  enabled: boolean;
  observations: number;
  poolTokens: number;
  poolTarget: number;
  consolidateAt: number;
  observerActive: boolean;
  consolidatorActive: boolean;
  totalCostUsd: number;
}

function renderStatusBar(status: MemoryStatus): string {
  if (!status.enabled) return "off";

  // O gauge — observation pool fill
  const poolPct = Math.min(status.poolTokens / status.consolidateAt, 1);
  const oBar = renderBar(poolPct, 6);
  const oColor = poolPct > 0.8 ? "\x1b[33m" : "\x1b[32m"; // yellow if near threshold
  const oActive = status.observerActive ? "\x1b[33m" : "";
  const oReset = status.observerActive ? "\x1b[0m" : "";

  // C indicator
  const cLabel = status.consolidatorActive ? "\x1b[33mC\x1b[0m" : "\x1b[2mC\x1b[0m";

  // Pool fill: "3.2k/20k" tokens
  const fmt = (n: number) => n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;
  const pool = `${fmt(status.poolTokens)}/${fmt(status.consolidateAt)}`;

  // Cost
  const cost = `$${status.totalCostUsd.toFixed(3)}`;

  return `\x1b[2m«\x1b[0m ${oActive}${status.observations}${oReset} ${oColor}${oBar}\x1b[0m ${cLabel} \x1b[2m|\x1b[0m ${pool} \x1b[2m|\x1b[0m ${cost}`;
}

function renderBar(pct: number, width: number): string {
  const filled = Math.round(pct * width);
  const empty = width - filled;
  return "█".repeat(filled) + "\x1b[2m" + "░".repeat(empty) + "\x1b[0m";
}

// ── PiRuntime — implements AgentRuntime ─────────────────────────────────────

class PiRuntime implements AgentRuntime {
  readonly name = "pi";
  private pi: ExtensionAPI;
  private ctx: any;
  private lastChunkId: string | undefined;

  constructor(pi: ExtensionAPI, ctx: any) {
    this.pi = pi;
    this.ctx = ctx;
    // Restore watermark from persisted ledger so we don't re-observe
    // the entire conversation on reload/resume
    this.lastChunkId = this.restoreWatermark();
  }

  /**
   * Read the latest coversUpToId from persisted ledger entries.
   * This is how OM avoids re-processing: the watermark survives reload.
   */
  private restoreWatermark(): string | undefined {
    const entries = this.ctx.sessionManager?.getBranch?.() ?? [];
    let latest: string | undefined;
    let latestIndex = -1;

    // Build an index of entry IDs to positions
    const idToIndex = new Map<string, number>();
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].id) idToIndex.set(entries[i].id, i);
    }

    // Find the highest coversUpToId across all ledger entries
    for (const entry of entries) {
      if (entry.type !== "custom" || entry.customType !== WP_LEDGER) continue;
      const inner = entry.data?.data;
      if (!inner || inner.type !== "observations_recorded") continue;
      const coverId = inner.coversUpToId;
      if (!coverId) continue;
      const coverIndex = idToIndex.get(coverId);
      if (coverIndex !== undefined && coverIndex > latestIndex) {
        latestIndex = coverIndex;
        latest = coverId;
      }
    }

    return latest;
  }

  get cwd(): string {
    return this.ctx.cwd ?? process.cwd();
  }

  get sessionId(): string {
    return this.ctx.sessionManager?.getSessionId?.() ?? this.ctx.sessionId ?? "unknown";
  }

  getNewChunks(sinceId?: string): ConversationChunk[] {
    const branch = this.ctx.sessionManager?.getBranch?.() ?? [];
    const since = sinceId ?? this.lastChunkId;

    let startIdx = 0;
    if (since) {
      const idx = branch.findIndex((e: any) => e.id === since);
      if (idx >= 0) startIdx = idx + 1;
    }

    const newEntries = branch.slice(startIdx);
    if (newEntries.length === 0) return [];

    const serialized = serializeBranchEntries(newEntries);
    if (serialized.length === 0) return [];

    const CHUNK_TOKEN_LIMIT = 5000;
    const chunks: ConversationChunk[] = [];
    let currentText = "";
    let currentTokens = 0;
    let chunkStartId = serialized[0].id;

    for (const entry of serialized) {
      if (currentTokens + entry.tokens > CHUNK_TOKEN_LIMIT && currentText.length > 0) {
        chunks.push({
          id: chunkStartId,
          text: currentText,
          tokenCount: currentTokens,
          timestamp: new Date().toISOString(),
        });
        currentText = "";
        currentTokens = 0;
        chunkStartId = entry.id;
      }
      currentText += (currentText ? "\n\n" : "") + entry.text;
      currentTokens += entry.tokens;
    }

    if (currentText.length > 0) {
      chunks.push({
        id: serialized[serialized.length - 1].id,
        text: currentText,
        tokenCount: currentTokens,
        timestamp: new Date().toISOString(),
      });
    }

    if (serialized.length > 0) {
      this.lastChunkId = serialized[serialized.length - 1].id;
    }

    return chunks;
  }

  appendLedger(entry: LedgerEntry): void {
    this.pi.appendEntry(WP_LEDGER, entry);
  }

  readLedger(): LedgerEntry[] {
    const entries = this.ctx.sessionManager?.getBranch?.() ?? [];
    return entries
      .filter((e: any) => e.type === "custom" && e.customType === WP_LEDGER)
      .map((e: any) => e.data as LedgerEntry);
  }

  on(_event: MemoryEvent, _handler: MemoryEventHandler): () => void {
    return () => {};
  }

  notify(message: string, level: "info" | "warning" | "error" = "info"): void {
    if (this.ctx.hasUI && this.ctx.ui?.notify) {
      this.ctx.ui.notify(`🐺 ${message}`, level);
    }
  }

  updateCtx(ctx: any): void {
    this.ctx = ctx;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function serializeBranchEntries(entries: any[]): Array<{ id: string; text: string; tokens: number }> {
  const chunks: Array<{ id: string; text: string; tokens: number }> = [];

  for (const entry of entries) {
    // Pi session entries: { type: "message", message: { role, content, ... } }
    // Also: "custom", "compaction", "model_change", "thinking_level_change", etc.
    if (entry.type !== "message") continue;

    const msg = entry.message;
    if (!msg) continue;

    const role: string = msg.role ?? "unknown";
    let text = "";

    if (role === "user" || role === "assistant") {
      if (typeof msg.content === "string") {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        text = msg.content
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("\n");
      }
      // Assistant messages may have tool_use blocks
      if (role === "assistant" && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "tool_use") {
            text += `\n[Tool call: ${block.name}(${JSON.stringify(block.input).slice(0, 500)})]`;
          }
        }
      }
    } else if (role === "tool") {
      // Tool result message
      const content = typeof msg.content === "string"
        ? msg.content.slice(0, 2000)
        : Array.isArray(msg.content)
          ? msg.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").slice(0, 2000)
          : JSON.stringify(msg.content).slice(0, 2000);
      text = `[Tool result: ${content}]`;
    }

    if (text.length > 0) {
      chunks.push({ id: entry.id, text: `[${role}] ${text}`, tokens: Math.ceil(text.length / 4) });
    }
  }

  return chunks;
}

// ── Compaction rendering ────────────────────────────────────────────────────

function renderCompactionSummary(memoryRoot: string, observations: Observation[]): string {
  const sorted = sortObservations(observations);
  const journey = readJourney(memoryRoot);
  const topics = readTopics(memoryRoot);

  if (!journey && topics.length === 0 && sorted.length === 0) return "";

  const parts: string[] = [
    `These are condensed memories from earlier in this session.

- Journey: a short, purely descriptive history of how this work reached its current state — for orientation only. It is not an instruction or a plan; do not read intent or next steps into it.
- Observations: timestamped events from the conversation history, in chronological order.

Treat these as past records. When entries conflict, the most recent observation reflects the latest known state. Work that prior observations describe as completed should not be redone unless the user explicitly asks to revisit it.`,
  ];

  if (journey) parts.push(`## Journey\n${journey}`);

  if (topics.length > 0) {
    const lines = [
      "## Memory map",
      "Durable long-term notes live in `.memory/`. Read a file when a topic below looks relevant.",
    ];
    for (const topic of topics) {
      const summary = topic.summary || "(no summary)";
      const updated = topic.updated ? ` (updated ${topic.updated})` : "";
      lines.push(`- \`.memory/${topic.filename}\` — ${summary}${updated}`);
    }
    parts.push(lines.join("\n"));
  }

  if (sorted.length > 0) {
    parts.push(`## Observations\n${sorted.map((o) => `${o.timestamp}  ${o.content}`).join("\n")}`);
  }

  return parts.join("\n\n");
}

// ── Extension entry ─────────────────────────────────────────────────────────

export default function wolfpackMemory(pi: ExtensionAPI): void {
  const wolfName = process.env.WOLF_NAME;
  const wolfDen  = process.env.WOLF_DEN;
  const apiKey   = process.env.ANTHROPIC_API_KEY;

  // Soft fail if not configured — extension is invisible
  if (!wolfName || !wolfDen) return;

  const model     = process.env.WOLFPACK_MODEL      ?? "claude-sonnet-4-6";
  const fastModel = process.env.WOLFPACK_FAST_MODEL  ?? "claude-haiku-4-5-20251001";
  const librarianInbox = process.env.WOLFPACK_LIBRARIAN
    ?? path.join(path.dirname(wolfDen), "..", "..", "librarian", "inbox");
  const defaultDomain  = process.env.WOLFPACK_DOMAIN ?? "wolfpack";

  const CONSOLIDATE_AT = 20000;
  const POOL_TARGET = 10000;

  let runtime: PiRuntime | null = null;
  let orchestrator: MemoryOrchestrator | null = null;
  let engine: Engine | null = null;
  let enabled = false;
  let observerPending = false;
  let consolidatorPending = false;
  let totalCostUsd = 0;

  function readGate(branch: any[]): boolean {
    for (let i = branch.length - 1; i >= 0; i--) {
      if (branch[i].type === "custom" && branch[i].customType === WP_ENABLED) {
        return branch[i].data?.enabled ?? false;
      }
    }
    return false;
  }

  function initOrchestrator(ctx: any): void {
    if (!runtime || !apiKey) return;

    engine = createEngine({
      provider: "anthropic",
      apiKey,
      defaultModel: model,
      steps: {
        classify:    { model: fastModel },
        claimCheck:  { model: fastModel },
        consolidate: { model },
      },
    });

    orchestrator = createOrchestrator(engine, runtime, {
      chunkTokens: 5000,
      consolidateAtPoolTokens: CONSOLIDATE_AT,
      poolTargetTokens: POOL_TARGET,
      observerConcurrency: 4,
    });
  }

  function refreshStatus(ctx: any): void {
    if (!ctx.hasUI) return;

    if (!enabled) {
      ctx.ui.setStatus("wolfpack-memory", "\x1b[2m🐺 mem off\x1b[0m");
      return;
    }

    const observations = orchestrator?.getActiveObservations() ?? [];
    const tokens = observations.reduce((s: number, o: Observation) => s + o.tokenCount, 0);

    const status: MemoryStatus = {
      enabled,
      observations: observations.length,
      poolTokens: tokens,
      poolTarget: POOL_TARGET,
      consolidateAt: CONSOLIDATE_AT,
      observerActive: observerPending,
      consolidatorActive: consolidatorPending,
      totalCostUsd,
    };

    ctx.ui.setStatus("wolfpack-memory", renderStatusBar(status));
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  pi.on("session_start", (_event: unknown, ctx: any) => {
    runtime = new PiRuntime(pi, ctx);
    enabled = readGate(ctx.sessionManager.getBranch());
    if (enabled) initOrchestrator(ctx);
    refreshStatus(ctx);
  });

  pi.on("session_shutdown", () => {
    enabled = false;
    orchestrator = null;
    runtime = null;
  });

  // ── Den context injection ──────────────────────────────────────────────

  function renderDenContext(): string | null {
    try {
      const topicsDir = path.join(wolfDen, "memory", "topics");
      if (!fs.existsSync(topicsDir)) return null;

      const files: string[] = (fs.readdirSync(topicsDir) as string[]).filter((f: string) => f.endsWith(".md"));
      if (files.length === 0) return null;

      const topics: Array<{ id: string; summary: string; filePath: string }> = [];
      for (const file of files) {
        const raw = fs.readFileSync(path.join(topicsDir, file), "utf-8");
        const idMatch = raw.match(/^id:\s*(.+)$/m);
        const summaryMatch = raw.match(/^summary:\s*(.+)$/m);
        topics.push({
          id: idMatch?.[1]?.trim() ?? file.replace(/\.md$/, ""),
          summary: summaryMatch?.[1]?.trim() ?? "(no summary)",
          filePath: path.join(topicsDir, file),
        });
      }

      const lines = [
        `Wolf ${wolfName} has persistent memory from previous sessions (${topics.length} topic${topics.length !== 1 ? "s" : ""}).`,
        "Read a topic file when you need full details.",
        "",
        ...topics.map(t => `- \`${t.filePath}\` -- ${t.summary}`),
      ];
      return lines.join("\n");
    } catch {
      return null;
    }
  }

  pi.on("before_agent_start", (event: any, _ctx: any) => {
    const denContext = renderDenContext();
    if (!denContext) return;

    const injection = [
      "",
      "<wolf_memory>",
      denContext,
      "</wolf_memory>",
      "",
    ].join("\n");

    return {
      systemPrompt: event.systemPrompt + injection,
    };
  });

  // ── Observer trigger (fire-and-forget, like OM) ─────────────────────────
  // Observers run in the background. Multiple can be in-flight at once.
  // The observerPending flag is NOT a gate — we use it only for TUI display.
  // Each observer gets its own chunk (watermarked) so no double-processing.

  const observerTasks = new Set<Promise<void>>();

  pi.on("turn_end", (_event: unknown, ctx: any) => {
    if (!enabled || !orchestrator || !runtime) return;

    runtime.updateCtx(ctx);
    const chunks = runtime.getNewChunks();
    if (chunks.length === 0) return;

    // Fire observer in background — don't block turn_end
    const task = (async () => {
      observerPending = true;
      refreshStatus(ctx);
      try {
        await orchestrator!.processChunks(chunks);
        if (engine) {
          const usage = engine.usage.summarize();
          totalCostUsd = estimateCost(usage);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        runtime?.notify(`observer error: ${msg}`, "error");
      } finally {
        observerTasks.delete(task);
        observerPending = observerTasks.size > 0;
        refreshStatus(ctx);
      }
    })();

    observerTasks.add(task);
  });

  // ── Compaction hook ─────────────────────────────────────────────────────

  pi.on("session_before_compact", async (_event: any, ctx: any) => {
    if (!enabled || !orchestrator || !runtime) return undefined;

    runtime.updateCtx(ctx);

    const observations = orchestrator.getActiveObservations();
    const memoryRoot = orchestrator.getMemoryRoot();
    let summary = renderCompactionSummary(memoryRoot, observations);

    // Include den knowledge in compaction summary
    const denContext = renderDenContext();
    if (denContext) {
      const denSection = `## Wolf memory (persistent across sessions)\n${denContext}`;
      summary = summary ? `${summary}\n\n${denSection}` : denSection;
    }

    if (!summary) return undefined;

    return { compaction: { summary } };
  });

  // ── Commands ────────────────────────────────────────────────────────────

  pi.registerCommand("wolf:memory", {
    description: "Toggle wolfpack memory (/wolf:memory on, /wolf:memory off)",
    handler: async (args: string, ctx: any) => {
      if (!apiKey) {
        if (ctx.hasUI) ctx.ui.notify("🐺 ANTHROPIC_API_KEY not set — cannot enable memory", "error");
        return;
      }

      const arg = (args ?? "").trim().toLowerCase();
      const next = arg === "on" ? true : arg === "off" ? false : !enabled;

      if (next === enabled) {
        if (ctx.hasUI) ctx.ui.notify(`🐺 memory already ${next ? "on" : "off"}`, "info");
        return;
      }

      enabled = next;
      pi.appendEntry(WP_ENABLED, { enabled: next });

      if (next) {
        if (!runtime) runtime = new PiRuntime(pi, ctx);
        else runtime.updateCtx(ctx);
        initOrchestrator(ctx);
        if (ctx.hasUI) ctx.ui.notify("🐺 memory enabled", "info");
      } else {
        orchestrator = null;
        if (ctx.hasUI) ctx.ui.notify("🐺 memory disabled", "info");
      }
      refreshStatus(ctx);
    },
  });

  pi.registerCommand("wolf:status", {
    description: "Show wolfpack memory status",
    handler: async (_args: string, ctx: any) => {
      const lines: string[] = [
        `Wolf: ${wolfName}`,
        `Memory: ${enabled ? "ON" : "OFF"}`,
        `Den: ${wolfDen}`,
        `API key: ${apiKey ? "set" : "MISSING"}`,
      ];

      if (enabled && orchestrator) {
        const obs = orchestrator.getActiveObservations();
        const tokens = obs.reduce((s, o) => s + o.tokenCount, 0);
        lines.push(`Observations: ${obs.length} (~${tokens.toLocaleString()} tokens)`);
        lines.push(`Pool: ${tokens.toLocaleString()} / ${CONSOLIDATE_AT.toLocaleString()} tokens`);
        lines.push(`Memory root: ${orchestrator.getMemoryRoot()}`);
        lines.push(`Cost: $${totalCostUsd.toFixed(4)}`);
      }

      if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("wolf:consolidate", {
    description: "Force consolidation now (fold observations into session topic files)",
    handler: async (_args: string, ctx: any) => {
      if (!enabled || !orchestrator) {
        if (ctx.hasUI) ctx.ui.notify("🐺 memory not enabled", "error");
        return;
      }

      const obs = orchestrator.getActiveObservations();
      if (obs.length === 0) {
        if (ctx.hasUI) ctx.ui.notify("🐺 no observations to consolidate", "info");
        return;
      }

      const memRoot = orchestrator.getMemoryRoot();
      if (ctx.hasUI) ctx.ui.notify(
        `🐺 consolidating ${obs.length} observations...\n` +
        `   memory root: ${memRoot}`,
        "info"
      );
      consolidatorPending = true;
      refreshStatus(ctx);

      try {
        await orchestrator.consolidateNow();
        if (engine) {
          const usage = engine.usage.summarize();
          totalCostUsd = estimateCost(usage);
        }
        const remaining = orchestrator.getActiveObservations();
        const memRoot = orchestrator.getMemoryRoot();
        const topics = readTopics(memRoot);
        if (ctx.hasUI) ctx.ui.notify(
          `🐺 consolidated → ${topics.length} topic(s) in .memory/\n` +
          `   ${remaining.length} observations remaining in pool`,
          "info"
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (ctx.hasUI) ctx.ui.notify(`🐺 consolidation failed: ${msg}`, "error");
      } finally {
        consolidatorPending = false;
        refreshStatus(ctx);
      }
    },
  });

  pi.registerCommand("wolf:promote", {
    description: "Consolidate + promote session memory to wolf den",
    handler: async (_args: string, ctx: any) => {
      if (!enabled || !orchestrator) {
        if (ctx.hasUI) ctx.ui.notify("🐺 memory not enabled", "error");
        return;
      }

      // Step 1: Consolidate observations into session topics first
      const obs = orchestrator.getActiveObservations();
      if (obs.length > 0) {
        if (ctx.hasUI) ctx.ui.notify(`🐺 consolidating ${obs.length} observations first...`, "info");
        consolidatorPending = true;
        refreshStatus(ctx);
        try {
          await orchestrator.consolidateNow();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (ctx.hasUI) ctx.ui.notify(`🐺 consolidation failed: ${msg}`, "error");
          consolidatorPending = false;
          refreshStatus(ctx);
          return;
        }
        consolidatorPending = false;
      }

      // Step 2: Promote session topics to wolf den
      if (ctx.hasUI) ctx.ui.notify("🐺 promoting session to den...", "info");

      try {
        const denConfig: DenConfig = { denRoot: wolfDen, wolfName: wolfName };
        await orchestrator.promoteToWolfMemory(denConfig);
        if (engine) {
          const usage = engine.usage.summarize();
          totalCostUsd = estimateCost(usage);
        }

        // Report what was written
        const denTopicsDir = wolfDen + "/memory/topics";
        let denTopicCount = 0;
        try {
          const { readdirSync } = require("node:fs");
          denTopicCount = readdirSync(denTopicsDir).filter((f: string) => f.endsWith(".md")).length;
        } catch {}

        if (ctx.hasUI) ctx.ui.notify(
          `🐺 promoted to den\n` +
          `   Den: ${wolfDen}/memory/\n` +
          `   Topics: ${denTopicCount}`,
          "info"
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (ctx.hasUI) ctx.ui.notify(`🐺 promote failed: ${msg}`, "error");
      } finally {
        refreshStatus(ctx);
      }
    },
  });

  pi.registerCommand("end", {
    description: "Promote session memory to den, compact, then exit",
    handler: async (_args: string, ctx: any) => {
      // Step 1: Promote (consolidate + fold to den) if memory is on
      if (enabled && orchestrator) {
        const obs = orchestrator.getActiveObservations();
        if (obs.length > 0) {
          if (ctx.hasUI) ctx.ui.notify(`🐺 consolidating ${obs.length} observations...`, "info");
          try {
            await orchestrator.consolidateNow();
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (ctx.hasUI) ctx.ui.notify(`🐺 consolidation failed: ${msg}`, "warning");
          }
        }

        if (ctx.hasUI) ctx.ui.notify("🐺 promoting to den...", "info");
        try {
          const denConfig: DenConfig = { denRoot: wolfDen, wolfName: wolfName };
          await orchestrator.promoteToWolfMemory(denConfig);
          if (ctx.hasUI) ctx.ui.notify("🐺 session promoted to den", "info");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (ctx.hasUI) ctx.ui.notify(`🐺 promote failed: ${msg}`, "warning");
        }
      }

      // Step 2: Compact + exit
      if (ctx.hasUI) ctx.ui.notify("🐺 compacting before exit...", "info");
      ctx.compact({
        customInstructions: "Summarise this session. Focus on decisions made, files changed, and anything a future session should know.",
        onComplete: () => {
          if (ctx.hasUI) ctx.ui.notify("Done. Goodbye 🐺", "info");
          setTimeout(() => process.exit(0), 800);
        },
        onError: (err: any) => {
          if (ctx.hasUI) ctx.ui.notify(`Compaction failed: ${err?.message ?? err}`, "error");
          setTimeout(() => process.exit(1), 800);
        },
      });
    },
  });
}

// ── Cost estimation ─────────────────────────────────────────────────────────

function estimateCost(usage: { totalInputTokens: number; totalOutputTokens: number }): number {
  // Rough estimate using haiku pricing (most calls go to haiku)
  const M = 1_000_000;
  return (usage.totalInputTokens / M) * 0.80 + (usage.totalOutputTokens / M) * 4.00;
}
