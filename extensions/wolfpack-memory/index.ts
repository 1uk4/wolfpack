/**
 * wolfpack-memory — Pi extension for wolfpack memory system.
 *
 * Thin adapter between Pi's extension API and @wolfpack/memory.
 * Replaces observational-memory + mac-librarian-bridge.
 *
 * Environment variables:
 *   WOLF_NAME           — wolf identity (e.g. "1uk4")
 *   WOLF_DEN            — path to wolf den (e.g. ~/wolves/local/1uk4/den)
 *   ANTHROPIC_API_KEY   — for LLM calls (observer, consolidator, claims)
 *   KB_OPS              — librarian-ops root (optional, enables KB delta emit)
 *   KB_BASE             — knowledge-base root (optional, enables entry resolve)
 *   WOLFPACK_DOMAIN     — default domain for claims (default: wolfpack)
 *   WOLFPACK_MODEL      — model for consolidation (default: claude-sonnet-4-6)
 *   WOLFPACK_FAST_MODEL — model for observers/classification (default: claude-haiku-4-5-20251001)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createEngine, DIGEST, type Engine } from "@wolfpack/engine";
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
import { emitDelta } from "@wolfpack/kb/client";
import type { KbRoots } from "@wolfpack/kb/shared";
import { readDeclaredDomains } from "@wolfpack/kb/librarian";
import { initWorkSystem, type WorkSystemConfig } from "./work-system.js";
import {
  getStageContext,
  summarizeTask,
  embedTaskInParent,
  areAllChildrenComplete,
  canGraduate,
  buildContribution,
  getWorkSession,
  getFileSession,
  summarizeFileChanges,
  type WorkSession,
} from "@wolfpack/memory";
import {
  planCrawl,
  runCrawl,
  emitCrawl,
  renderPlanSummary,
  readPlan,
  writePlan,
  readDenTopics,
  discoverSources,
  gatePlan,
  DEFAULT_CRAWL_CONCURRENCY,
  DEFAULT_SINK_BASE,
  type Strategy,
  type CrawlProgress,
  type CrawlBatchStage,
  type CrawlUsageStats,
  type EmitContribution,
} from "@wolfpack/memory";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, Key, matchesKey } from "@earendil-works/pi-tui";
import { wizardSingleChoice, type WizardOption } from "./crawl-wizard.ts";
import { statSync as fsStatSync } from "node:fs";
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
  promoterActive?: boolean;
  /** Seconds elapsed in the current long op (consolidate/promote). */
  activityElapsedS?: number;
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

  // Activity indicator \u2014 spinner + elapsed while consolidating (C) or promoting (P).
  let cLabel: string;
  if (status.consolidatorActive || status.promoterActive) {
    const frames = "\u280b\u2819\u2839\u2838\u283c\u2834\u2826\u2827\u2807\u280f";
    const e = status.activityElapsedS ?? 0;
    const spin = frames[e % frames.length];
    const label = status.promoterActive ? "P" : "C";
    cLabel = `\x1b[33m${spin} ${label} ${e}s\x1b[0m`;
  } else {
    cLabel = "\x1b[2mC\x1b[0m";
  }

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

// ── Crawl monitor TUI ───────────────────────────────────────────────────────
//
// A live panel for /wolf:crawl-run that reuses the subagents "monitor without
// panes" idea: the same in-process crawl engine the Linux wolves run headless,
// but driven by its onProgress callback so interactive wolves can watch batches
// move through extract \u2192 consolidate at up to N concurrent, then the global
// journey pass.

/** Collapse whitespace/newlines so a multi-line error or title can't spill
 *  across monitor rows (JSON blobs in extractor errors did exactly that). */
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Compact token counts: 1234 \u2192 1.2k, 1_200_000 \u2192 1.2M. */
function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

interface CrawlMonitorRow {
  topic: string;
  index: number;
  stage: CrawlBatchStage;
  files: number;
  scanned?: number;
  observations?: number;
  title?: string;
  error?: string;
}

interface CrawlMonitorState {
  planPath: string;
  concurrency: number;
  total: number;
  rows: Map<string, CrawlMonitorRow>;
  order: string[]; // first-seen order, for stable listing
  journey: "pending" | "running" | "done";
  journeyDated?: number;
  journeyUndated?: number;
  gateFailures?: string[];
  usage?: CrawlUsageStats;
  startedAt: number;
  finished: boolean;
  cancelling: boolean;
}

function newCrawlMonitorState(planPath: string, concurrency: number): CrawlMonitorState {
  return {
    planPath,
    concurrency,
    total: 0,
    rows: new Map(),
    order: [],
    journey: "pending",
    startedAt: Date.now(),
    finished: false,
    cancelling: false,
  };
}

function applyCrawlProgress(state: CrawlMonitorState, p: CrawlProgress): void {
  switch (p.phase) {
    case "gate":
      if (!p.ok) state.gateFailures = p.failures ?? [];
      return;
    case "batch": {
      const b = p.batch;
      state.total = b.total;
      if (!state.rows.has(b.topic)) state.order.push(b.topic);
      state.rows.set(b.topic, {
        topic: b.topic,
        index: b.index,
        stage: b.stage,
        files: b.files,
        scanned: b.scanned,
        observations: b.observations,
        title: b.title,
        error: b.error,
      });
      return;
    }
    case "stats":
      state.usage = p.usage;
      return;
    case "journey":
      state.journey = p.status === "done" ? "done" : "running";
      if (p.status === "done") {
        state.journeyDated = p.dated;
        state.journeyUndated = p.undated;
      }
      return;
    case "complete":
      state.finished = true;
      return;
  }
}

const CRAWL_SPINNER = ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"];

function crawlStageGlyph(stage: CrawlBatchStage, theme: any, frame: number): string {
  switch (stage) {
    case "extract":
    case "consolidate":
      return theme.fg("accent", CRAWL_SPINNER[frame % CRAWL_SPINNER.length]);
    case "done":
      return theme.fg("success", "\u2713");
    case "skipped":
      return theme.fg("dim", "\u2205");
    case "error":
      return theme.fg("error", "\u2717");
  }
}

function crawlStageRank(stage: CrawlBatchStage): number {
  // Active first, then errors, then finished.
  switch (stage) {
    case "extract":
    case "consolidate":
      return 0;
    case "error":
      return 1;
    case "done":
    case "skipped":
      return 2;
  }
}

/** Render the monitor as plain lines, each truncated to width (never wraps). */
function renderCrawlMonitor(
  state: CrawlMonitorState,
  theme: any,
  width: number,
  frame: number,
): string[] {
  const lines: string[] = [];
  const add = (s: string) => lines.push(truncateToWidth(s, width));

  const rows = [...state.rows.values()];
  const running = rows.filter(
    (r) => r.stage === "extract" || r.stage === "consolidate"
  ).length;
  const errors = rows.filter((r) => r.stage === "error").length;
  const settled = rows.filter(
    (r) => r.stage === "done" || r.stage === "skipped"
  ).length;
  const totalTopics = [...state.rows.values()].reduce(
    (s, r) => s + (r.observations ?? 0),
    0
  );
  const elapsed = Math.floor((Date.now() - state.startedAt) / 1000);
  const plan = state.planPath.split("/").pop() ?? state.planPath;

  const scanned = rows.reduce((s, r) => s + (r.scanned ?? 0), 0);
  const scanTotal = rows.reduce((s, r) => s + r.files, 0);

  add(theme.fg("accent", "\u2500".repeat(width)));
  add(
    ` ${theme.fg("toolTitle", theme.bold("\ud83d\udc3a crawl"))} ${theme.fg("muted", plan)}` +
      `  ${theme.fg("dim", `\u2264${state.concurrency} concurrent \u00b7 ${elapsed}s`)}`
  );

  // Live engine telemetry: tokens in/out, calls, est. cost, files scanned.
  if (state.usage || scanTotal) {
    const u = state.usage;
    const cost = u
      ? estimateCost({
          totalInputTokens: u.input,
          totalOutputTokens: u.output,
        })
      : 0;
    const parts: string[] = [];
    if (u)
      parts.push(
        theme.fg(
          "dim",
          `\u2191${fmtTokens(u.input)} \u2193${fmtTokens(u.output)} tok \u00b7 ${u.calls} calls \u00b7 ~$${cost.toFixed(2)}`
        )
      );
    if (scanTotal)
      parts.push(theme.fg("dim", `${scanned}/${scanTotal} files scanned`));
    add(` ${parts.join(theme.fg("dim", "  \u00b7  "))}`);
  }

  if (state.gateFailures && state.gateFailures.length) {
    add("");
    add(theme.fg("error", " gate failed \u2014 crawl refused:"));
    for (const f of state.gateFailures) add(theme.fg("error", `   \u2717 ${f}`));
    add(theme.fg("accent", "\u2500".repeat(width)));
    return lines;
  }

  const totalLabel = state.total || rows.length || "?";
  add(
    theme.fg("text", ` ${settled}/${totalLabel} batches`) +
      theme.fg("dim", "  \u00b7  ") +
      theme.fg(running ? "accent" : "dim", `${running} running`) +
      theme.fg("dim", "  \u00b7  ") +
      theme.fg(errors ? "error" : "dim", `${errors} error`) +
      theme.fg("dim", `  \u00b7  ${totalTopics} obs`)
  );
  add("");

  // Prioritise active work, cap the visible window so a huge plan can't blow up
  // the panel height; the counts line above still reflects the whole run.
  const MAX_ROWS = 14;
  const sorted = rows.sort((a, b) => {
    const r = crawlStageRank(a.stage) - crawlStageRank(b.stage);
    return r !== 0 ? r : a.index - b.index;
  });
  const shown = sorted.slice(0, MAX_ROWS);
  for (const r of shown) {
    const g = crawlStageGlyph(r.stage, theme, frame);
    const stageWord =
      r.stage === "extract"
        ? theme.fg(
            "accent",
            r.scanned != null && r.files
              ? `extracting ${r.scanned}/${r.files}`
              : "extracting"
          )
        : r.stage === "consolidate"
          ? theme.fg("accent", "consolidating")
          : r.stage === "done"
            ? theme.fg(
                "success",
                r.title ? `\u201c${oneLine(r.title)}\u201d` : "done"
              )
            : r.stage === "skipped"
              ? theme.fg("dim", "no observations")
              : theme.fg(
                  "error",
                  r.error ? oneLine(r.error) : "error"
                );
    const meta = theme.fg(
      "dim",
      ` ${r.files}f${r.observations ? ` \u00b7 ${r.observations}obs` : ""}`
    );
    add(` ${g} ${theme.fg("text", r.topic)}${meta}  ${stageWord}`);
  }
  if (sorted.length > shown.length)
    add(theme.fg("dim", `   \u2026 ${sorted.length - shown.length} more`));

  add("");
  if (state.journey === "pending")
    add(theme.fg("dim", " journey: waiting for batches"));
  else if (state.journey === "running")
    add(
      `${theme.fg("accent", CRAWL_SPINNER[frame % CRAWL_SPINNER.length])} ${theme.fg("accent", "journey: reconstructing the arc\u2026")}`
    );
  else
    add(
      `${theme.fg("success", "\u2713")} ${theme.fg("success", "journey done")}` +
        theme.fg(
          "dim",
          ` \u00b7 ${state.journeyDated ?? 0} dated, ${state.journeyUndated ?? 0} undated`
        )
    );

  add("");
  if (state.cancelling)
    add(theme.fg("warning", " cancelling \u2014 finishing in-flight batches\u2026"));
  else if (!state.finished)
    add(theme.fg("dim", " Esc to cancel (keeps finished batches; resumable)"));

  add(theme.fg("accent", "\u2500".repeat(width)));
  return lines;
}

/** Plain-text completion summary shown after a run (and each rerun). */
function crawlRunSummary(state: CrawlMonitorState, dir: string): string {
  const rows = [...state.rows.values()];
  const done = rows.filter((r) => r.stage === "done").length;
  const skipped = rows.filter((r) => r.stage === "skipped").length;
  const errored = rows.filter((r) => r.stage === "error");
  const obs = rows.reduce((s, r) => s + (r.observations ?? 0), 0);
  const files = rows.reduce((s, r) => s + r.files, 0);
  const elapsed = Math.floor((Date.now() - state.startedAt) / 1000);
  const u = state.usage;
  const cost = u
    ? estimateCost({ totalInputTokens: u.input, totalOutputTokens: u.output })
    : 0;
  const lines = [
    `\ud83d\udc3a crawl summary \u2014 ${done} ok \u00b7 ${skipped} empty \u00b7 ${errored.length} failed`,
    `   ${files} files \u00b7 ${obs} observations \u00b7 ${elapsed}s` +
      (u
        ? ` \u00b7 \u2191${fmtTokens(u.input)}/\u2193${fmtTokens(u.output)} tok \u00b7 ~$${cost.toFixed(2)}`
        : ""),
  ];
  if (errored.length)
    lines.push(`   failed: ${errored.map((r) => r.topic).join(", ")}`);
  lines.push(`   out: ${dir}`);
  return lines.join("\n");
}

/** Compact "Nm/Nh/Nd ago" from an epoch-ms timestamp. */
function agoLabel(ms: number): string {
  const mins = Math.floor((Date.now() - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/** Does `file` name a contribution for exactly `denTopicId` (id-<hex>.md)? */
function laneFileMatches(file: string, denTopicId: string): boolean {
  if (!file.endsWith(".md")) return false;
  const base = file.slice(0, -3);
  if (!base.startsWith(denTopicId + "-")) return false;
  return /^[0-9a-f]+$/.test(base.slice(denTopicId.length + 1));
}

/** Which of `denTopicIds` currently have a file in this ops lane dir. */
function idsInLane(laneDir: string, denTopicIds: string[]): Set<string> {
  const out = new Set<string>();
  let files: string[];
  try {
    files = fs.readdirSync(laneDir);
  } catch {
    return out;
  }
  for (const f of files)
    for (const id of denTopicIds)
      if (laneFileMatches(f, id)) {
        out.add(id);
        break;
      }
  return out;
}

/** den topic ids a run would emit: one per batch + the history entry. */
function denTopicIdsForPlan(plan: any): string[] {
  const ids = (plan.batches ?? []).map(
    (b: any) => `crawl-${plan.domain}-${b.topic}`
  );
  ids.push(`crawl-${plan.domain}-history`);
  return ids;
}

export interface CrawlReleaseState {
  /** emitted.json timestamp (we handed it to the inbox), if any. */
  releasedAt?: number;
  /** den topic ids Dewey has written a receipt for (curated into the KB). */
  curated: Set<string>;
  /** den topic ids still sitting in the inbox (awaiting Dewey). */
  inbox: Set<string>;
}

/** Detect, from disk + ops lanes, whether a run was emitted / curated. */
function readReleaseState(
  runDir: string,
  opsRoot: string | undefined,
  wolf: string | undefined,
  denTopicIds: string[]
): CrawlReleaseState {
  let releasedAt: number | undefined;
  try {
    releasedAt = JSON.parse(
      fs.readFileSync(path.join(runDir, "emitted.json"), "utf-8")
    ).at;
  } catch {
    /* never released via the extension */
  }
  const curated =
    opsRoot && wolf
      ? idsInLane(path.join(opsRoot, "receipts", wolf), denTopicIds)
      : new Set<string>();
  const inbox =
    opsRoot && wolf
      ? idsInLane(path.join(opsRoot, "inbox", wolf), denTopicIds)
      : new Set<string>();
  return { releasedAt, curated, inbox };
}

interface EmitReviewState {
  domain: string;
  runDir: string;
  contributions: EmitContribution[];
  kbEnabled: boolean;
  journeyMissing: boolean;
  cursor: number;
  /** list = the contribution index; detail = reading one topic's full doc. */
  mode: "list" | "detail";
  detail?: { title: string; raw: string; scroll: number };
  /** Release lifecycle detected from emitted.json + Dewey's ops lanes. */
  release: CrawlReleaseState;
}

/** Hard-wrap one line to width (word boundaries where possible). */
function wrapHard(text: string, width: number): string[] {
  if (!text) return [""];
  const out: string[] = [];
  let rest = text;
  while (rest.length > width) {
    let cut = rest.lastIndexOf(" ", width);
    if (cut < width * 0.5) cut = width;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  out.push(rest);
  return out;
}

/** Detail view: the full generated doc for the selected contribution. */
function renderEmitDetail(
  st: EmitReviewState,
  theme: any,
  width: number
): string[] {
  const d = st.detail!;
  const out: string[] = [];
  const add = (s: string) => out.push(truncateToWidth(s, width));
  add(theme.fg("accent", "\u2500".repeat(width)));
  add(
    ` ${theme.fg("toolTitle", theme.bold("\ud83d\udc3a " + oneLine(d.title)))}` +
      ` ${theme.fg("dim", "(staged for inbox)")}`
  );
  add("");
  const body: string[] = [];
  for (const raw of d.raw.split("\n")) {
    if (raw.length <= width - 1) body.push(raw);
    else for (const w of wrapHard(raw, width - 1)) body.push(w);
  }
  const VIEW = 22;
  const maxScroll = Math.max(0, body.length - VIEW);
  const scroll = Math.min(Math.max(0, d.scroll), maxScroll);
  d.scroll = scroll;
  for (const ln of body.slice(scroll, scroll + VIEW)) add(` ${theme.fg("text", ln)}`);
  add("");
  const end = Math.min(scroll + VIEW, body.length);
  add(
    theme.fg(
      "dim",
      ` \u2191\u2193 scroll \u00b7 Space page \u00b7 ${end}/${body.length} \u00b7 Esc back`
    )
  );
  add(theme.fg("accent", "\u2500".repeat(width)));
  return out;
}

/** Render the pre-release review: the topics + history about to hit the inbox. */
function renderEmitReview(
  st: EmitReviewState,
  theme: any,
  width: number
): string[] {
  if (st.mode === "detail" && st.detail)
    return renderEmitDetail(st, theme, width);
  const lines: string[] = [];
  const add = (s: string) => lines.push(truncateToWidth(s, width));
  const c = st.contributions;
  const rel = st.release;
  const toEmit = c.filter((x) => x.status === "emit").length;
  const unchanged = c.length - toEmit;
  const curatedN = c.filter((x) => rel.curated.has(x.denTopicId)).length;
  const inboxN = c.filter(
    (x) => !rel.curated.has(x.denTopicId) && rel.inbox.has(x.denTopicId)
  ).length;
  const pendingN = c.length - curatedN - inboxN;

  add(theme.fg("accent", "\u2500".repeat(width)));
  add(
    ` ${theme.fg("toolTitle", theme.bold("\ud83d\udc3a release review"))} ` +
      `${theme.fg("muted", st.domain)}  ` +
      theme.fg(
        "dim",
        `${toEmit} new \u00b7 ${unchanged} unchanged \u00b7 ${c.length} total`
      )
  );
  add(
    ` ${theme.fg("dim", st.kbEnabled ? "\u2192 inbox \u2192 Dewey" : "KB_OPS not set \u2014 preview only")}`
  );
  if (rel.releasedAt || curatedN || inboxN)
    add(
      ` ${theme.fg("success", curatedN + " curated")}` +
        theme.fg("dim", " \u00b7 ") +
        theme.fg("accent", inboxN + " in inbox") +
        theme.fg("dim", " \u00b7 ") +
        theme.fg("dim", pendingN + " not released") +
        (rel.releasedAt
          ? theme.fg("dim", ` \u00b7 released ${agoLabel(rel.releasedAt)}`)
          : "")
    );
  if (st.journeyMissing)
    add(
      ` ${theme.fg("warning", "journey not written \u2014 run /wolf:crawl-run to resume before releasing")}`
    );
  add("");

  // Scroll window around the cursor so long plans stay inside the panel.
  const MAX = 16;
  const start = Math.max(
    0,
    Math.min(st.cursor - Math.floor(MAX / 2), Math.max(0, c.length - MAX))
  );
  const shown = c.slice(start, start + MAX);
  shown.forEach((x, i) => {
    const idx = start + i;
    const focused = idx === st.cursor;
    const prefix = focused ? theme.fg("accent", "> ") : "  ";
    const mark =
      x.status === "emit"
        ? theme.fg("success", "+")
        : theme.fg("dim", "=");
    const kind = x.kind === "history" ? theme.fg("muted", " [history]") : "";
    const rtag = rel.curated.has(x.denTopicId)
      ? theme.fg("success", " \u2713 curated")
      : rel.inbox.has(x.denTopicId)
        ? theme.fg("accent", " \u2192 in inbox")
        : rel.releasedAt
          ? theme.fg("dim", " \u00b7 released")
          : "";
    const title = focused
      ? theme.fg("accent", oneLine(x.title))
      : theme.fg("text", oneLine(x.title));
    const meta = theme.fg(
      "dim",
      ` \u00b7 ${x.currency} \u00b7 ${(x.bodyChars / 1000).toFixed(1)}k`
    );
    add(`${prefix}${mark} ${title}${kind}${rtag}${meta}`);
    if (focused && x.summary)
      for (const ln of wrapOneLine(x.summary, width - 6))
        add(theme.fg("muted", `      ${ln}`));
  });
  if (c.length > shown.length)
    add(theme.fg("dim", `   \u2026 ${st.cursor + 1}/${c.length}`));

  add("");
  const release =
    st.kbEnabled && !st.journeyMissing
      ? " \u00b7 r release to Dewey"
      : "";
  add(
    theme.fg(
      "dim",
      ` \u2191\u2193 move \u00b7 Enter view topic${release} \u00b7 Esc close`
    )
  );
  add(theme.fg("accent", "\u2500".repeat(width)));
  return lines;
}

/** Soft-wrap a single-lined string to width, returning at most 2 lines. */
function wrapOneLine(s: string, width: number): string[] {
  const t = oneLine(s);
  if (t.length <= width) return [t];
  const out: string[] = [];
  let rest = t;
  while (rest.length > width && out.length < 2) {
    let cut = rest.lastIndexOf(" ", width);
    if (cut < width * 0.6) cut = width;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).trim();
  }
  if (out.length < 2 && rest) out.push(rest.slice(0, width));
  return out;
}


/** A crawl run/plan on disk, with lifecycle derived from which files exist. */
export interface CrawlEntity {
  dir: string;
  domain: string;
  source: string;
  topics: number;
  files: number;
  createdAt: number;
  /** plan → incomplete (extracting/interrupted) → complete → released. */
  status: "plan" | "incomplete" | "complete" | "released" | "curated";
  ready: boolean;
}

/** List every crawl dir (has a plan.yaml) across the given base dirs, dedup'd. */
function scanCrawlDirs(bases: string[]): string[] {
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const base of bases) {
    let entries: string[];
    try {
      entries = fs.readdirSync(base);
    } catch {
      continue;
    }
    for (const e of entries) {
      const dir = path.join(base, e);
      if (seen.has(dir)) continue;
      try {
        if (!fsStatSync(path.join(dir, "plan.yaml")).isFile()) continue;
      } catch {
        continue;
      }
      seen.add(dir);
      dirs.push(dir);
    }
  }
  return dirs;
}

function hasFile(dir: string, f: string): boolean {
  try {
    return fsStatSync(path.join(dir, f)).isFile();
  } catch {
    return false;
  }
}

/** Read one crawl dir into a CrawlEntity, deriving its lifecycle from files
 *  and (when ops lanes are given) whether Dewey has curated it. */
function readCrawlEntity(
  dir: string,
  lane?: { opsRoot?: string; wolf?: string }
): CrawlEntity | null {
  let plan: any;
  try {
    plan = readPlan(path.join(dir, "plan.yaml"));
  } catch {
    return null;
  }
  let status: CrawlEntity["status"];
  if (hasFile(dir, "emitted.json")) status = "released";
  else if (hasFile(dir, "history.json")) status = "complete";
  else if (hasFile(dir, "observations.jsonl")) status = "incomplete";
  else status = "plan";
  // Upgrade released -> curated once Dewey has receipts for every contribution.
  if (
    (status === "released" || status === "complete") &&
    lane?.opsRoot &&
    lane?.wolf
  ) {
    const ids = denTopicIdsForPlan(plan);
    const curated = idsInLane(path.join(lane.opsRoot, "receipts", lane.wolf), ids);
    if (curated.size > 0) status = curated.size >= ids.length ? "curated" : "released";
  }
  let topics = 0;
  try {
    topics = (
      JSON.parse(fs.readFileSync(path.join(dir, "topics.json"), "utf-8")) as unknown[]
    ).length;
  } catch {
    /* none yet */
  }
  const files: number = (plan.batches ?? []).reduce(
    (n: number, b: any) => n + (b.files?.length ?? 0),
    0
  );
  let createdAt = 0;
  try {
    createdAt = fsStatSync(path.join(dir, "plan.yaml")).mtimeMs;
  } catch {
    /* 0 */
  }
  return {
    dir,
    domain: plan.domain,
    source: plan.source,
    topics,
    files,
    createdAt,
    status,
    ready: plan.status === "ready",
  };
}

/** All crawl entities across bases, newest first. */
function listCrawls(
  bases: string[],
  lane?: { opsRoot?: string; wolf?: string }
): CrawlEntity[] {
  return scanCrawlDirs(bases)
    .map((d) => readCrawlEntity(d, lane))
    .filter((e): e is CrawlEntity => !!e)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Most recent crawl plan across bases. Prefers plans stamped `status: ready`,
 * then newest. Fallback for `/wolf:crawl-run` after a relaunch loses state.
 */
function findLatestPlan(bases: string[]): string | null {
  const all = listCrawls(bases);
  if (all.length === 0) return null;
  all.sort(
    (a, b) => Number(b.ready) - Number(a.ready) || b.createdAt - a.createdAt
  );
  return path.join(all[0].dir, "plan.yaml");
}

export interface IncompleteRun {
  runDir: string;
  /** Batch topics not yet in topics.json (empty = extraction done, journey not). */
  missing: string[];
  done: number;
  total: number;
  domain: string;
}

/**
 * Find an interrupted run (crash / relaunch / cancel mid-crawl) for the given
 * plan. Resumable = has observations.jsonl (extraction began) but no
 * history.json (journey never finished), and matches this plan's source+domain.
 */
function findIncompleteRun(
  resolved: { source: string; domain: string },
  bases: string[]
): IncompleteRun | null {
  const found: (IncompleteRun & { mtime: number })[] = [];
  for (const dir of scanCrawlDirs(bases)) {
    if (hasFile(dir, "history.json")) continue; // finished
    if (!hasFile(dir, "observations.jsonl")) continue; // never ran (plan dir)
    let plan: any;
    try {
      plan = readPlan(path.join(dir, "plan.yaml"));
    } catch {
      continue;
    }
    if (plan.source !== resolved.source || plan.domain !== resolved.domain)
      continue;
    let doneTopics = new Set<string>();
    try {
      const arr = JSON.parse(
        fs.readFileSync(path.join(dir, "topics.json"), "utf-8")
      ) as [string, unknown][];
      doneTopics = new Set(arr.map(([k]) => k));
    } catch {
      /* nothing completed yet */
    }
    const topics: string[] = plan.batches.map((b: any) => b.topic);
    const missing = topics.filter((t) => !doneTopics.has(t));
    let mtime = 0;
    try {
      mtime = fsStatSync(path.join(dir, "plan.yaml")).mtimeMs;
    } catch {
      /* 0 */
    }
    found.push({
      runDir: dir,
      missing,
      done: doneTopics.size,
      total: topics.length,
      domain: plan.domain,
      mtime,
    });
  }
  if (found.length === 0) return null;
  found.sort((a, b) => b.mtime - a.mtime);
  const f = found[0];
  return {
    runDir: f.runDir,
    missing: f.missing,
    done: f.done,
    total: f.total,
    domain: f.domain,
  };
}

// ── Extension entry ─────────────────────────────────────────────────────────

export default function wolfpackMemory(pi: ExtensionAPI): void {
  const wolfName = process.env.WOLF_NAME;
  const wolfDen  = process.env.WOLF_DEN;
  const apiKey   = process.env.ANTHROPIC_API_KEY;

  // Soft fail if not configured — extension is invisible
  if (!wolfName || !wolfDen) return;

  // Transport for memory LLM calls. Default to the Claude Agent SDK bridge so
  // consolidation/promote run on the user's Claude subscription (MAX/Pro OAuth)
  // instead of a raw ANTHROPIC_API_KEY — no per-token billing and no key to
  // expire. Set WOLFPACK_MEMORY_PROVIDER=anthropic to force the API path.
  const memProvider = (process.env.WOLFPACK_MEMORY_PROVIDER ?? "claude-agent-sdk").toLowerCase();
  const useBridge = memProvider === "claude-agent-sdk" || memProvider === "claude-bridge";
  // The bridge speaks Claude Code model aliases (undated); the API path wants
  // dated ids. Pick defaults to match whichever transport is active.
  const model     = process.env.WOLFPACK_MODEL      ?? (useBridge ? "claude-sonnet-4-5" : "claude-sonnet-4-6");
  const fastModel = process.env.WOLFPACK_FAST_MODEL  ?? (useBridge ? "claude-haiku-4-5" : "claude-haiku-4-5-20251001");
  // Credentials are satisfied either by the bridge (no key) or an API key.
  const credsOk = useBridge || !!apiKey;
  // KB roots come from the environment — set explicitly in each wolf's .env by
  // the CLI (KB_BASE/KB_OPS). No path math: the old `../../` derivation silently
  // broke whenever the den layout changed (old ~/wolves/dens vs new host-first
  // ~/wolves/<host>/<wolf>), writing/reading KB in divergent places. If unset,
  // KB features are inert but memory still works.
  const kbRoots: KbRoots = {
    kbBase: process.env.KB_BASE ?? "",
    opsRoot: process.env.KB_OPS ?? "",
    denLocal: path.join(wolfDen, "kb"),
  };
  // KB is only active when both roots are configured. Otherwise emit/resolve are
  // inert (no writes to stray relative paths), but session+den memory run fully.
  const kbEnabled = !!(kbRoots.kbBase && kbRoots.opsRoot);
  const defaultDomain  = process.env.WOLFPACK_DOMAIN ?? "wolfpack";

  // Durable home for crawl entities (plan \u2192 run \u2192 review \u2192 emit all live in one
  // dir). Defaults under the den so runs survive relaunches/reboots; /tmp is
  // still scanned as a legacy location so older runs remain selectable.
  const crawlHome =
    process.env.WOLFPACK_CRAWL_HOME || path.join(wolfDen, "crawls");
  try {
    fs.mkdirSync(crawlHome, { recursive: true });
  } catch {
    /* best effort */
  }
  const crawlBases =
    crawlHome === DEFAULT_SINK_BASE ? [crawlHome] : [crawlHome, DEFAULT_SINK_BASE];

  /** One-line label for a crawl entity in a picker. */
  function crawlEntityLabel(e: CrawlEntity): string {
    const age = (() => {
      const mins = Math.floor((Date.now() - e.createdAt) / 60000);
      if (mins < 60) return `${mins}m ago`;
      const hrs = Math.floor(mins / 60);
      if (hrs < 24) return `${hrs}h ago`;
      return `${Math.floor(hrs / 24)}d ago`;
    })();
    const legacy = e.dir.startsWith(DEFAULT_SINK_BASE) ? " (tmp)" : "";
    return (
      `${e.domain} \u00b7 ${e.topics || e.files} ${e.topics ? "topics" : "files"} \u00b7 ` +
      `${e.status} \u00b7 ${age}${legacy}`
    );
  }

  /**
   * Pick a crawl entity from disk (any session). Returns its dir, or null if
   * cancelled / none match. `statuses` filters the lifecycle states shown.
   */
  async function pickCrawl(
    ctx: any,
    title: string,
    statuses: CrawlEntity["status"][]
  ): Promise<string | null> {
    const all = listCrawls(crawlBases, { opsRoot: kbRoots.opsRoot, wolf: wolfName }).filter(
      (e) => statuses.includes(e.status)
    );
    if (all.length === 0) return null;
    if (all.length === 1) return all[0].dir;
    if (!ctx.hasUI || !ctx.ui?.custom) return all[0].dir;
    const choice = await wizardSingleChoice(
      ctx,
      title,
      "Pick a crawl \u2014 any session, newest first.",
      all.map((e) => ({ label: crawlEntityLabel(e), value: e.dir })),
      false
    );
    return choice;
  }

  /** Mark a run released so pickers can show it and avoid confusion. */
  function markEmitted(runDir: string, emitted: number, dest: string): void {
    try {
      fs.writeFileSync(
        path.join(runDir, "emitted.json"),
        JSON.stringify({ at: Date.now(), emitted, dest }, null, 2)
      );
    } catch {
      /* non-fatal */
    }
  }

  const CONSOLIDATE_AT = 20000;
  const POOL_TARGET = 10000;
  // Memory is ON by default; set WOLFPACK_MEMORY_DEFAULT=off to start disabled.
  // An explicit /wolf:memory off (persisted in the session) always wins.
  const DEFAULT_ENABLED =
    (process.env.WOLFPACK_MEMORY_DEFAULT ?? "on").toLowerCase() !== "off";

  let runtime: PiRuntime | null = null;
  let orchestrator: MemoryOrchestrator | null = null;
  let engine: Engine | null = null;
  let enabled = false;
  let observerPending = false;
  let consolidatorPending = false;
  let promoterPending = false;
  // Crawl plan mode: while active, the live observer is PAUSED so that reading
  // source files during planning never pollutes this wolf's den (spec §3).
  let crawlPlanMode = false;
  let lastPlanPath: string | null = null;
  let activityStartMs = 0;
  let activityTimer: ReturnType<typeof setInterval> | null = null;

  // 1s heartbeat so the status bar shows live progress (spinner + elapsed) for
  // long memory ops \u2014 consolidate (C) and promote (P) \u2014 so it's clear work is in
  // flight and you shouldn't quit.
  function beginActivity(ctx: any, kind: "consolidate" | "promote"): void {
    if (kind === "promote") promoterPending = true;
    else consolidatorPending = true;
    activityStartMs = Date.now();
    if (ctx.hasUI && !activityTimer) {
      activityTimer = setInterval(() => refreshStatus(ctx), 1000);
    }
    refreshStatus(ctx);
  }
  function endActivity(ctx: any, kind: "consolidate" | "promote"): void {
    if (kind === "promote") promoterPending = false;
    else consolidatorPending = false;
    if (!consolidatorPending && !promoterPending) {
      activityStartMs = 0;
      if (activityTimer) {
        clearInterval(activityTimer);
        activityTimer = null;
      }
    }
    refreshStatus(ctx);
  }
  let totalCostUsd = 0;

  function readGate(branch: any[]): boolean {
    for (let i = branch.length - 1; i >= 0; i--) {
      if (branch[i].type === "custom" && branch[i].customType === WP_ENABLED) {
        return branch[i].data?.enabled ?? false;
      }
    }
    // No explicit toggle in this session → fall back to the default.
    return DEFAULT_ENABLED;
  }

  function initOrchestrator(ctx: any): void {
    if (!runtime || !credsOk) return;

    engine = createEngine({
      provider: useBridge ? "claude-agent-sdk" : "anthropic",
      ...(useBridge ? {} : { apiKey }),
      defaultModel: model,
      steps: {
        classify:    { model: fastModel },
        // Large pools produce large action lists; give the output real headroom
        // so the JSON isn't truncated (the default 4096 is far too small).
        consolidate: { model, maxTokens: 16000 },
      },
    });

    orchestrator = createOrchestrator(engine, runtime, {
      chunkTokens: 5000,
      consolidateAtPoolTokens: CONSOLIDATE_AT,
      poolTargetTokens: POOL_TARGET,
      observerConcurrency: 4,
      kbRoots: kbEnabled ? kbRoots : undefined,
      defaultDomain,
    });
  }

  /**
   * Persist a compact status snapshot to `<den>/status.json` so wolfpack's
   * LocalBackend / agent can report wolf health without entering PI. Runs in
   * every mode (headless RPC included), unlike the TUI status bar.
   */
  function writeStatusFile(status: MemoryStatus): void {
    try {
      const snapshot = {
        enabled: status.enabled,
        observations: status.observations,
        poolTokens: status.poolTokens,
        consolidateAt: status.consolidateAt,
        totalCostUsd: status.totalCostUsd,
        updatedAt: Date.now(),
      };
      fs.writeFileSync(
        path.join(wolfDen, "status.json"),
        JSON.stringify(snapshot),
      );
    } catch {
      // best-effort; never break a turn over status
    }
  }

  function refreshStatus(ctx: any): void {
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
      promoterActive: promoterPending,
      activityElapsedS: activityStartMs
        ? Math.round((Date.now() - activityStartMs) / 1000)
        : 0,
      totalCostUsd,
    };

    // Always persist the sidechannel (works headless)
    writeStatusFile(status);

    // TUI status bar only when there's a UI. A captured ctx can go stale after
    // session shutdown/replacement — notably in `pi -p` subagent children, where
    // a background observer's finally{} calls refreshStatus AFTER the process has
    // begun tearing down. Reading ctx.hasUI then throws "stale ctx"; left
    // unhandled it rejects the observer task and crashes the child (which the
    // subagent tool surfaces as "(no output)"). The headless sidechannel was
    // already written above, so never let the UI refresh crash the process.
    try {
      if (!ctx.hasUI) return;
      if (!enabled) {
        ctx.ui.setStatus("wolfpack-memory", "\x1b[2m🐺 mem off\x1b[0m");
        return;
      }
      ctx.ui.setStatus("wolfpack-memory", renderStatusBar(status));
    } catch {
      // stale ctx (post-shutdown/replacement) — safe to ignore
    }
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


  // Lightweight discovery header: list the KB domains this wolf can see (its
  // mirrored domain folders) with each domain's entry count and top-level
  // section titles from Dewey's _digest.json, and point at INDEX.md. Enough to
  // tell WHEN a domain is relevant, without dumping the KB into context.
  // Access-scoped by what's on disk.
  function domainOutline(dir: string): string {
    let entries = 0;
    try {
      entries = fs.readdirSync(path.join(dir, "entries")).filter((f) => f.endsWith(".md")).length;
    } catch { /* no entries dir */ }
    let titles: string[] = [];
    try {
      const digest = JSON.parse(fs.readFileSync(path.join(dir, "_digest.json"), "utf-8"));
      titles = (digest.sections ?? [])
        .map((s: { title?: string }) => (s.title ?? "").replace(/^#+\s*/, "").trim())
        .filter(Boolean);
    } catch { /* no digest yet: count only */ }
    const shown = titles
      .slice(0, DIGEST.maxPointerSections)
      .map((t) => (t.length > 60 ? t.slice(0, 59) + "…" : t));
    const more = titles.length > shown.length ? `; +${titles.length - shown.length} more` : "";
    return `(${entries} entries)${shown.length ? ": " + shown.join("; ") + more : ""}`;
  }

  function renderKbAccess(): string | null {
    if (!kbEnabled) return null;
    try {
      const domainsRoot = path.join(kbRoots.kbBase, "domains");
      const names = fs
        .readdirSync(domainsRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith("."))
        .map((d) => d.name)
        .sort();
      if (!names.length) return null;
      return [
        `You have access to ${names.length} shared knowledge domain(s):`,
        ...names.map((n) => `- ${n} ${domainOutline(path.join(domainsRoot, n))}`),
        `Each lives at ${domainsRoot}/<domain>/. When a question touches one of these`,
        `topics, read <domain>/INDEX.md, then entries/<id>.md on demand.`,
        `Trust entries (authority: curated).`,
      ].join("\n");
    } catch {
      return null;
    }
  }

  pi.on("before_agent_start", (event: any, _ctx: any) => {
    const parts: string[] = [];

    const denContext = renderDenContext();
    if (denContext) parts.push("<wolf_memory>", denContext, "</wolf_memory>");

    const kbAccess = renderKbAccess();
    if (kbAccess) parts.push("<kb_access>", kbAccess, "</kb_access>");


    if (parts.length === 0) return;

    const injection = "\n" + parts.join("\n") + "\n";
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
    // Den-corruption guard: never observe while building a crawl plan.
    if (crawlPlanMode) return;
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

    // Supply tokensBefore so the compaction summary renders correctly on resume.
    // Pi's compaction renderer calls tokensBefore.toLocaleString() unconditionally;
    // omitting it leaves the stored entry with an undefined field that crashes
    // "Failed to resume session" on reload.
    const tokensBefore =
      _event?.preparation?.tokensBefore ??
      _event?.preparation?.contextTokens ??
      ctx?.getContextUsage?.()?.contextTokens ??
      0;

    return { compaction: { summary, tokensBefore } };
  });

  // ── Work System (Factory merged into Memory) ─────────────────────────────

  const workConfig: WorkSystemConfig = {
    // Inject stage-specific prompts when bound to a task
    getStageContext: (item) => getStageContext(item),

    // Handle task completion: summarize and embed in parent
    onTaskComplete: async (taskId, item) => {
      if (!engine) {
        console.log(`[work] Task completed (no engine): ${item.title}`);
        return;
      }

      try {
        // Get task body for summarization context
        const { resolveWorkItem, commitWorkItem, loadWorkState, queryWork } = await import("@wolfpack/kb/client");
        const resolved = resolveWorkItem(kbRoots, item.domain as string, taskId);
        const taskBody = resolved?.body ?? "";

        // Get work session (observations, notes, files during this task)
        const workSession = getWorkSession(taskId as any);
        const fileSession = getFileSession(taskId);
        
        // Add file changes to task body context if available
        let fullTaskBody = taskBody;
        if (fileSession && fileSession.files.length > 0) {
          fullTaskBody += "\n\n## Files Changed\n" + summarizeFileChanges(fileSession);
        }

        // Summarize the task
        const summary = await summarizeTask(engine, {
          task: item,
          taskBody: fullTaskBody,
          session: workSession || null,
        });

        // Embed in parent feature if exists
        if (item.partOf) {
          const state = loadWorkState(kbRoots);
          const parent = state.get(item.partOf as any);
          if (parent) {
            const parentResolved = resolveWorkItem(kbRoots, parent.domain as string, parent.id as string);
            const parentBody = parentResolved?.body ?? "";
            const updatedBody = embedTaskInParent(
              parentBody,
              item.title,
              summary,
              new Date().toISOString().split("T")[0]
            );
            commitWorkItem(kbRoots, parent, updatedBody);

            // Shipping the parent once its last task ships is task_done's job
            // (work-system.ts): it awaits this summary before graduating.
          }
        }
      } catch (e: any) {
        console.error(`[work] Failed to summarize task: ${e.message}`);
      }
    },

    // Handle feature/initiative ready to graduate
    onReadyToGraduate: async (item) => {
      if (!kbEnabled) {
        return;
      }

      if (!canGraduate(item)) {
        return;
      }

      try {
        const { resolveWorkItem, commitWorkItem, loadWorkState, queryWork, stageWork, linkWork } = await import("@wolfpack/kb/client");
        const resolved = resolveWorkItem(kbRoots, item.domain as string, item.id as string);
        const body = resolved?.body ?? "";
        const inboxDir = path.join(kbRoots.opsRoot, "inbox", wolfName);
        fs.mkdirSync(inboxDir, { recursive: true });

        if (item.kind === "feature") {
          // Feature: create standalone KB entry
          const contribution = buildContribution(item, body);
          const featureEntryId = `kb-${contribution.domain}-${item.id.split("-").pop()}`;

          const contentHash = require("crypto").createHash("sha256").update(contribution.body).digest("hex").slice(0, 16);
          const mdContent = `---\nfrom: ${wolfName}\nden_topic_id: ${item.id}\nchange: create\ncontent_hash: ${contentHash}\nprev_hash: null\ndomain_hint: ${contribution.domain}\norigin: wolf\ncurrency: live\nsubmitted: ${new Date().toISOString()}\n---\n\n${contribution.body}`;

          const filename = `work-${item.id}-${Date.now()}.md`;
          fs.writeFileSync(path.join(inboxDir, filename), mdContent);
          linkWork(kbRoots, item.id as any, "graduated_to", featureEntryId);

          // Update parent initiative with link to this feature
          if (item.partOf) {
            const state = loadWorkState(kbRoots);
            const parent = state.get(item.partOf as any);
            if (parent && parent.kind === "initiative") {
              const parentResolved = resolveWorkItem(kbRoots, parent.domain as string, parent.id as string);
              let parentBody = parentResolved?.body ?? "";
              
              // Add feature link to initiative's Features section
              const featureLink = `- [[${featureEntryId}]] ${item.title}`;
              if (parentBody.includes("## Features")) {
                parentBody = parentBody.replace("## Features", `## Features\n${featureLink}`);
              } else {
                parentBody += `\n\n## Features\n${featureLink}`;
              }
              commitWorkItem(kbRoots, parent, parentBody);

              // Check if all features graduated → ship + graduate initiative
              const siblings = queryWork(kbRoots, { partOf: item.partOf as string }) ?? [];
              const allGraduated = siblings.every(s => s.graduatedTo && s.graduatedTo.length > 0);
              if (allGraduated && siblings.length > 0) {
                const { item: shippedInit } = stageWork(kbRoots, parent.id as any, "shipped");
                await workConfig.onReadyToGraduate?.(shippedInit);
              }
            }
          }
        } else if (item.kind === "initiative") {
          // Initiative: create KB entry with summary + links to features
          const contribution = buildContribution(item, body);

          const contentHash = require("crypto").createHash("sha256").update(contribution.body).digest("hex").slice(0, 16);
          const mdContent = `---\nfrom: ${wolfName}\nden_topic_id: ${item.id}\nchange: create\ncontent_hash: ${contentHash}\nprev_hash: null\ndomain_hint: ${contribution.domain}\norigin: wolf\ncurrency: live\nsubmitted: ${new Date().toISOString()}\n---\n\n${contribution.body}`;

          const filename = `work-${item.id}-${Date.now()}.md`;
          fs.writeFileSync(path.join(inboxDir, filename), mdContent);

          const entryId = `kb-${contribution.domain}-${item.id.split("-").pop()}`;
          linkWork(kbRoots, item.id as any, "graduated_to", entryId);
        }
        
      } catch (e: any) {
        console.error(`[work] Failed to graduate: ${e.message}`);
      }
    },
  };

  initWorkSystem(pi, workConfig);

  // ── Commands ────────────────────────────────────────────────────────────

  pi.registerCommand("wolf:memory", {
    description: "Toggle wolfpack memory (/wolf:memory on, /wolf:memory off)",
    handler: async (args: string, ctx: any) => {
      if (!credsOk) {
        if (ctx.hasUI) ctx.ui.notify("🐺 ANTHROPIC_API_KEY not set — cannot enable memory", "error");
        return;
      }

      const arg = (args ?? "").trim().toLowerCase();
      const next = arg === "on" ? true : arg === "off" ? false : !enabled;

      if (next === enabled) {
        if (ctx.hasUI) ctx.ui.notify(`🐺 memory already ${next ? "on" : "off"}`, "info");
        return;
      }

      // Turning OFF: don't strand un-consolidated observations. Fold them into
      // session topics first so no context is lost. Ask in the TUI; auto-save
      // when headless (can't prompt). If the save fails, leave memory ON.
      if (!next && orchestrator) {
        const pending = orchestrator.getActiveObservations();
        if (pending.length > 0) {
          let save = true;
          if (ctx.mode === "tui" && ctx.hasUI) {
            save = await ctx.ui.confirm(
              "Turn memory off?",
              `${pending.length} observation(s) aren't saved yet. Consolidate + promote them to the den first so nothing is lost?`,
            );
          }
          if (save) {
            beginActivity(ctx, "consolidate");
            try {
              await orchestrator.consolidateNow();
              await orchestrator.promoteToWolfMemory({ denRoot: wolfDen, wolfName });
              if (ctx.hasUI)
                ctx.ui.notify("🐺 consolidated + promoted to den before turning off", "info");
            } catch (e) {
              if (ctx.hasUI)
                ctx.ui.notify(`🐺 save failed — memory left ON: ${String(e)}`, "error");
              return; // abort the toggle; nothing lost
            } finally {
              endActivity(ctx, "consolidate");
            }
          }
        }
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
        `Transport: ${useBridge ? "claude-bridge (subscription)" : "anthropic api"}`,
        `Model: ${model}`,
        `API key: ${useBridge ? "n/a (bridge)" : apiKey ? "set" : "MISSING"}`,
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

  pi.registerCommand("kb", {
    description:
      "Open the KB knowledge-graph in your browser (/kb [kb-root])",
    handler: async (args: string, ctx: any) => {
      const { execFile } = require("node:child_process");
      const home = process.env.HOME ?? "";
      const script = path.join(home, ".local", "share", "wolfpack", "kb-graph", "build_graph.py");
      if (!fs.existsSync(script)) {
        if (ctx.hasUI)
          ctx.ui.notify(
            `🐺 kb-graph skill not found at ${script}\n   install it or run the generator manually`,
            "error",
          );
        return;
      }

      // Prefer an explicit arg, then the wolf's KB_BASE; otherwise let the
      // generator fall back to its own default (~/wolves/knowledge/base).
      const scriptArgs = ["-I", script, "--no-open"];
      const kbRoot = (args ?? "").trim() || kbRoots.kbBase;
      if (kbRoot) scriptArgs.push("--kb-root", kbRoot);

      if (ctx.hasUI) ctx.ui.notify("🐺 building KB graph…", "info");
      try {
        const out: string = await new Promise((resolve, reject) => {
          execFile(
            "python3",
            scriptArgs,
            { timeout: 60_000 },
            (err: any, stdout: string, stderr: string) => {
              if (err) reject(new Error(stderr || err.message));
              else resolve(stdout);
            },
          );
        });
        const m = out.match(/Wrote (.+)/);
        const outPath = m ? m[1].trim() : path.join(home, ".cache", "kb-graph", "kb-graph.html");

        // On an interactive wolf (laptop), launch the browser — pi's notify
        // renders plain text, so a file:// line isn't clickable. On headless
        // wolves (e.g. Dewey) there's no browser: just print the path.
        const opener =
          process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
        let opened = false;
        if (ctx.mode === "tui" && ctx.hasUI) {
          try {
            await new Promise<void>((resolve) => {
              execFile(opener, [outPath], { timeout: 10_000 }, () => resolve());
            });
            opened = true;
          } catch {
            opened = false;
          }
        }
        if (ctx.hasUI)
          ctx.ui.notify(
            opened
              ? `🐺 KB graph opened in your browser\n   ${outPath}`
              : `🐺 KB graph ready — open it:\n   file://${outPath}`,
            "info",
          );
      } catch (e) {
        if (ctx.hasUI) ctx.ui.notify(`🐺 KB graph build failed: ${String(e)}`, "error");
      }
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
      beginActivity(ctx, "consolidate");

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
        endActivity(ctx, "consolidate");
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
        beginActivity(ctx, "consolidate");
        try {
          await orchestrator.consolidateNow();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (ctx.hasUI) ctx.ui.notify(`🐺 consolidation failed: ${msg}`, "error");
          endActivity(ctx, "consolidate");
          return;
        }
        endActivity(ctx, "consolidate");
      }

      // Step 2: Promote session topics to wolf den
      if (ctx.hasUI) ctx.ui.notify("🐺 promoting session to den...", "info");

      beginActivity(ctx, "promote");
      try {
        const denConfig: DenConfig = { denRoot: wolfDen, wolfName: wolfName };
        const result = await orchestrator.promoteToWolfMemory(denConfig);
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

        if (ctx.hasUI) {
          const { topicsProcessed, topicsCreated, topicsMerged, topicsSkipped, claimsSubmitted, details } = result;
          if (topicsProcessed === 0) {
            ctx.ui.notify(`🐺 nothing new to promote (den has ${denTopicCount} topic(s))`, "info");
          } else {
            const lines = [
              `🐺 promoted to den — ${topicsCreated} created, ${topicsMerged} updated` +
                (topicsSkipped ? `, ${topicsSkipped} skipped` : ``),
              ...details.map((d) => `   ${d.change === "merge" ? "⤵ updated" : "✦ created"}: ${d.title}`),
              `   KB deltas emitted: ${claimsSubmitted} (sweep merges → registry)`,
              `   Den: ${wolfDen}/memory/ (${denTopicCount} topic(s) total)`,
            ];
            ctx.ui.notify(lines.join("\n"), "info");
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (ctx.hasUI) ctx.ui.notify(`🐺 promote failed: ${msg}`, "error");
      } finally {
        endActivity(ctx, "promote");
      }
    },
  });

  // ── Crawl: deterministic corpus ingestion (plan → run → emit) ────────────
  // The wolf PLANS (here, in this session); the scribe EXECUTES (ingests under
  // the `scribe` identity — this wolf's den is never written). Observation is
  // paused while planning so reading source files cannot pollute the den.

  const SCRIBE = "scribe";
  const requireScribe =
    ["1", "true", "yes"].includes(
      (process.env.WOLFPACK_CRAWL_REQUIRE_SCRIBE ?? "").toLowerCase()
    );
  // "scribe" is a ROLE, not a wolf: any wolf can crawl knowledge in its location.
  // Contributions emit under THIS wolf's own (already-synced) inbox lane, tagged
  // origin=crawl so Dewey knows the wolf acted as a scribe.
  const scribeNudge =
    `\n\n🐺 Crawl ingests under THIS wolf (${wolfName}), tagged as a crawl — ` +
    "your den is NOT written and observation is paused while planning.";

  function declaredDomains(): Set<string> | null {
    if (!kbEnabled) return null;
    try {
      return readDeclaredDomains(kbRoots);
    } catch {
      return null;
    }
  }

  // Plan tools — thin, read-only wrappers over the deterministic front-end, so
  // the agent + user can iterate on batching during the plan conversation.
  pi.registerTool(
    defineTool({
      name: "crawl_plan",
      label: "Crawl: draft plan",
      description:
        "Draft a crawl plan from a source directory (deterministic; no LLM). " +
        "Groups files into topic batches and resolves dates. Writes crawl-plan.yaml.",
      parameters: Type.Object({
        path: Type.String({ description: "Absolute source directory to crawl" }),
        domain: Type.Optional(Type.String({ description: "Target KB domain" })),
        strategy: Type.Optional(
          Type.String({ description: "by-folder | by-pattern" })
        ),
        depth: Type.Optional(
          Type.Number({ description: "by-folder: cap grouping to N path segments" })
        ),
      }),
      async execute(_id, params) {
        const { plan, sink } = planCrawl({
          source: params.path,
          domain: params.domain ?? defaultDomain,
          strategy: (params.strategy as Strategy) ?? "by-folder",
          folderDepth: params.depth,
          sinkBase: crawlHome,
        });
        lastPlanPath = path.join(sink.dir, "plan.yaml");
        crawlPlanMode = true;
        const files = discoverSources(params.path, {
          include: plan.include,
          exclude: plan.exclude,
        });
        const summary = renderPlanSummary(plan, files);
        return {
          content: [
            {
              type: "text",
              text: `Plan written: ${lastPlanPath} (status: draft)\n\n${summary}`,
            },
          ],
          details: { planPath: lastPlanPath, batches: plan.batches.length },
        };
      },
    })
  );

  pi.registerTool(
    defineTool({
      name: "crawl_preview",
      label: "Crawl: preview plan",
      description: "Summarize a crawl plan (batch count, files, per-batch detail).",
      parameters: Type.Object({
        planPath: Type.Optional(Type.String({ description: "Plan path (defaults to last)" })),
      }),
      async execute(_id, params) {
        const p = params.planPath ?? lastPlanPath;
        if (!p) throw new Error("no plan path (run crawl_plan first)");
        const plan = readPlan(p);
        const files = discoverSources(plan.source, {
          include: plan.include,
          exclude: plan.exclude,
        });
        return {
          content: [{ type: "text", text: renderPlanSummary(plan, files) }],
          details: { planPath: p },
        };
      },
    })
  );

  pi.registerTool(
    defineTool({
      name: "crawl_validate",
      label: "Crawl: validate plan (run gate)",
      description:
        "Run the crawl gate against a plan: status ready, domain declared, every " +
        "batch resolves, no file in two batches. Returns pass or the failures.",
      parameters: Type.Object({
        planPath: Type.Optional(Type.String({ description: "Plan path (defaults to last)" })),
      }),
      async execute(_id, params) {
        const p = params.planPath ?? lastPlanPath;
        if (!p) throw new Error("no plan path (run crawl_plan first)");
        const plan = readPlan(p);
        let sourceExists = false;
        try {
          sourceExists = fsStatSync(plan.source).isDirectory();
        } catch {
          /* false */
        }
        const files = discoverSources(plan.source, {
          include: plan.include,
          exclude: plan.exclude,
        });
        const failures = gatePlan(plan, {
          files,
          declared: declaredDomains(),
          sourceExists,
        });
        return {
          content: [
            {
              type: "text",
              text: failures.length
                ? `GATE FAILS:\n  ${failures.join("\n  ")}`
                : "GATE PASSES — plan is ready to run.",
            },
          ],
          details: { ok: failures.length === 0, failures },
        };
      },
    })
  );

  // Finalize: the user approved the batch summary. Runs every gate check except
  // the status check (the plan is still a draft here), then stamps the plan
  // 'status: ready' and writes it back so /wolf:crawl-run can execute it.
  pi.registerTool(
    defineTool({
      name: "crawl_finalize",
      label: "Crawl: finalize plan (status: ready)",
      description:
        "Mark a reviewed plan as ready: run every gate check except status, then " +
        "write 'status: ready' to the plan document. Call ONLY after the user " +
        "approved the batch summary. Returns the failures if the plan is not sound.",
      parameters: Type.Object({
        planPath: Type.Optional(Type.String({ description: "Plan path (defaults to last)" })),
      }),
      async execute(_id, params) {
        const p = params.planPath ?? lastPlanPath;
        if (!p) throw new Error("no plan path (run crawl_plan first)");
        const plan = readPlan(p);
        let sourceExists = false;
        try {
          sourceExists = fsStatSync(plan.source).isDirectory();
        } catch {
          /* false */
        }
        const files = discoverSources(plan.source, {
          include: plan.include,
          exclude: plan.exclude,
        });
        // Gate a status:ready copy so only real problems (not the draft status)
        // surface. If anything fails, refuse to finalize.
        const ready = { ...plan, status: "ready" as const };
        const failures = gatePlan(ready, {
          files,
          declared: declaredDomains(),
          sourceExists,
        });
        if (failures.length) {
          return {
            content: [
              {
                type: "text",
                text: `CANNOT FINALIZE — fix these first:\n  ${failures.join("\n  ")}`,
              },
            ],
            details: { ok: false, failures },
          };
        }
        writePlan(p, ready);
        return {
          content: [
            {
              type: "text",
              text:
                `Plan finalized → status: ready (${ready.batches.length} batch(es)).\n` +
                `   plan: ${p}\n\nRun it with:  /wolf:crawl-run`,
            },
          ],
          details: { ok: true, planPath: p, batches: ready.batches.length },
        };
      },
    })
  );

  // Draft a plan deterministically (no questionnaire). Shared by the --draft
  // escape hatch and the headless/busy fallback.
  function draftCrawlPlan(ctx: any, parts: string[]): void {
    try {
      const { plan, sink } = planCrawl({
        source: parts[0],
        domain: parts[1] ?? defaultDomain,
        strategy: (parts[2] as Strategy) ?? "by-folder",
        folderDepth: parts[3] ? Number(parts[3]) : undefined,
        sinkBase: crawlHome,
      });
      lastPlanPath = path.join(sink.dir, "plan.yaml");
      crawlPlanMode = true;
      refreshStatus(ctx);
      if (ctx.hasUI)
        ctx.ui.notify(
          `🐺 crawl plan drafted — ${plan.batches.length} batch(es)\n` +
            `   plan: ${lastPlanPath}\n\n` +
            `Plan mode ON (observation paused). Refine batches with the crawl_* tools, ` +
            `review the plan, set 'status: ready', then:\n` +
            `   /wolf:crawl-run\n` +
            `(cancel with /wolf:crawl-cancel)${scribeNudge}`,
          "info"
        );
    } catch (e) {
      if (ctx.hasUI) ctx.ui.notify(`🐺 crawl plan failed: ${String(e)}`, "error");
    }
  }

  pi.registerCommand("wolf:crawl", {
    description:
      "Start a crawl plan via questionnaire: /wolf:crawl <path> [domain] [strategy] [depth] [--draft]",
    handler: async (args: string, ctx: any) => {
      let parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const draftOnly = parts.includes("--draft");
      parts = parts.filter((p) => p !== "--draft");
      const src = parts[0];

      // A questionnaire can ask for the source directory itself, so a bare
      // `/wolf:crawl` is fine when we can interview. Only the deterministic
      // draft path (explicit --draft, or headless/busy) needs a path up front.
      const canInterview =
        !draftOnly && ctx.hasUI && (ctx.isIdle ? ctx.isIdle() : true);
      if (!src && !canInterview) {
        if (ctx.hasUI)
          ctx.ui.notify(
            "🐺 usage: /wolf:crawl <path> [domain] [strategy] [depth] [--draft]",
            "error"
          );
        return;
      }
      if (requireScribe && wolfName !== SCRIBE) {
        if (ctx.hasUI)
          ctx.ui.notify(
            `🐺 crawl is restricted to the scribe wolf (WOLFPACK_CRAWL_REQUIRE_SCRIBE set); this is ${wolfName}.`,
            "error"
          );
        return;
      }

      // Pause observation up front: the interview turn and any plan tool calls
      // must never leak into the den.
      crawlPlanMode = true;
      refreshStatus(ctx);

      // Deterministic draft: explicit --draft, or no interactive/idle agent to
      // run the questionnaire.
      if (!canInterview) {
        draftCrawlPlan(ctx, parts);
        return;
      }

      // Questionnaire: hand the agent a directive so it interviews the user with
      // the ask_user_question tool, then drafts the plan from their answers.
      const declared = declaredDomains();
      const domainList =
        declared && declared.size
          ? [...declared].join(", ")
          : `(none declared; default "${defaultDomain}")`;
      const hints: string[] = [];
      if (parts[1]) hints.push(`domain=${parts[1]}`);
      if (parts[2]) hints.push(`strategy=${parts[2]}`);
      if (parts[3]) hints.push(`depth=${parts[3]}`);
      const hintLine = hints.length
        ? `\nThe user pre-filled some defaults (treat as suggested answers, still confirm): ${hints.join(", ")}.`
        : "";

      const cwd = process.cwd();
      const srcLine = src
        ? `The source directory is \`${src}\`.`
        : `The user did not specify a source directory. Make question 0 ` +
          `"Which directory should I crawl?" a single-select whose first option is ` +
          `the current working directory, labelled "${cwd} (Recommended)"; the user ` +
          `can pick "Other" to type a different path. Confirm the chosen path exists ` +
          `before continuing.`;
      const planPathNote = src ? `path=\`${src}\`` : `path set to the directory from question 0`;

      const directive =
        `Run a short crawl-planning questionnaire. ${srcLine}\n\n` +
        `Use the ask_user_question tool to gather the plan parameters. Ask exactly ONE ` +
        `question per tool call, in this order, skipping any the user already pinned:\n` +
        `1. Target KB domain. Offer options: ${domainList}.\n` +
        `2. Grouping strategy — options: "by-folder" (Recommended), "by-pattern".\n` +
        `3. If by-folder: folder depth (how many path segments to group on) — ` +
        `offer 1, 2, 3; let them pick "Other" for a custom number.\n` +
        `4. Scope confirmation: anything to include/exclude, or crawl the whole tree.\n\n` +
        `Then call crawl_plan with ${planPathNote} plus the chosen domain/strategy/depth, ` +
        `and call crawl_preview. Show the user a clear summary of the resulting batches — ` +
        `one line per batch with its topic and file count, plus the totals (batch count, ` +
        `files matched/skipped).\n\n` +
        `Finally, use ask_user_question to ask "Does this plan look good?" with options ` +
        `"Looks good — add to plan" (Recommended) and "Edit it".\n` +
        `  • If they approve: call crawl_finalize to stamp the plan 'status: ready', then ` +
        `tell them to run /wolf:crawl-run.\n` +
        `  • If they want to edit: ask what to change, adjust (re-ask a question or change ` +
        `domain/strategy/depth/scope), re-run crawl_plan + crawl_preview, and ask for ` +
        `approval again. Do NOT run the crawl yourself.${hintLine}`;

      if (ctx.hasUI)
        ctx.ui.notify(
          `🐺 crawl questionnaire starting${src ? ` for ${src}` : ""} — observation paused.${scribeNudge}`,
          "info"
        );
      try {
        pi.sendUserMessage(directive);
      } catch (e) {
        // sendUserMessage throws if streaming / no agent: fall back to a draft.
        if (ctx.hasUI)
          ctx.ui.notify(
            `🐺 could not start questionnaire (${String(e)}); drafting a plan directly.`,
            "warning"
          );
        draftCrawlPlan(ctx, parts);
      }
    },
  });

  // Concurrency resolution for crawl-run:
  //   per-invocation --concurrency/-c  >  WOLFPACK_CRAWL_CONCURRENCY env  >  default 5
  // Clamped to [1, CRAWL_CONCURRENCY_MAX] so a typo can't fork thousands.
  const CRAWL_CONCURRENCY_MAX = 32;
  function envCrawlConcurrency(): number {
    const raw = Number(process.env.WOLFPACK_CRAWL_CONCURRENCY);
    if (!Number.isFinite(raw) || raw < 1) return DEFAULT_CRAWL_CONCURRENCY;
    return Math.min(Math.floor(raw), CRAWL_CONCURRENCY_MAX);
  }

  // Review the exact contributions a run would hand to Dewey, then release them
  // (real emit) from inside the TUI \u2014 one command, no separate emit.
  async function reviewAndRelease(ctx: any, runDir: string): Promise<void> {
    let domain = defaultDomain;
    try {
      domain = readPlan(path.join(runDir, "plan.yaml")).domain;
    } catch {
      /* keep default */
    }
    let journeyMissing = false;
    try {
      journeyMissing = !fsStatSync(path.join(runDir, "history.json")).isFile();
    } catch {
      journeyMissing = true;
    }

    let contributions: EmitContribution[] = [];
    try {
      // Dry-run renders the exact files into the run sink and returns details.
      contributions = emitCrawl(runDir, {
        dryRun: true,
        wolf: wolfName,
        sinkBase: crawlHome,
        quiet: true,
      }).contributions;
    } catch (e) {
      if (ctx.hasUI)
        ctx.ui.notify(`\ud83d\udc3a could not build release preview: ${String(e)}`, "error");
      return;
    }
    if (contributions.length === 0) {
      if (ctx.hasUI)
        ctx.ui.notify(`\ud83d\udc3a nothing to release from ${runDir}`, "warning");
      return;
    }

    // Headless (no TUI to review/confirm in): emit directly and report.
    if (!ctx.hasUI || !ctx.ui?.custom) {
      try {
        const r = emitCrawl(runDir, { dryRun: false, wolf: wolfName, sinkBase: crawlHome, quiet: true });
        markEmitted(runDir, r.emitted, r.dest);
        ctx.ui?.notify?.(`🐺 released ${r.emitted} contribution(s) -> ${r.dest}`, "info");
      } catch (e) {
        ctx.ui?.notify?.(`🐺 release failed: ${String(e)}`, "error");
      }
      return;
    }

    // Full doc for a contribution = the generated topic md the inbox gets.
    const loadDoc = (cb: EmitContribution): string => {
      const file =
        cb.kind === "history"
          ? path.join("topics", "_history.md")
          : path.join("topics", `${cb.topic}.md`);
      try {
        return fs.readFileSync(path.join(runDir, file), "utf-8");
      } catch (e) {
        return `(could not read ${file}: ${String(e)})`;
      }
    };

    const release = readReleaseState(
      runDir,
      kbRoots.opsRoot,
      wolfName,
      contributions.map((c) => c.denTopicId)
    );
    const st: EmitReviewState = {
      domain,
      runDir,
      contributions,
      kbEnabled,
      journeyMissing,
      cursor: 0,
      mode: "list",
      release,
    };
    const canRelease = kbEnabled && !journeyMissing;
    while (true) {
    const decision = await ctx.ui.custom<"release" | "close">(
      (tui: any, theme: any, _kb: any, done: (r: "release" | "close") => void) => ({
        render: (width: number) => renderEmitReview(st, theme, width),
        invalidate: () => {},
        handleInput: (data: string) => {
          // Detail view: scroll the topic doc; Esc returns to the list.
          if (st.mode === "detail" && st.detail) {
            if (matchesKey(data, Key.up) || data === "k") {
              st.detail.scroll -= 1;
              tui.requestRender();
            } else if (matchesKey(data, Key.down) || data === "j") {
              st.detail.scroll += 1;
              tui.requestRender();
            } else if (matchesKey(data, Key.space)) {
              st.detail.scroll += 20;
              tui.requestRender();
            } else if (matchesKey(data, Key.escape)) {
              st.mode = "list";
              st.detail = undefined;
              tui.requestRender();
            }
            return;
          }
          // List view.
          if (matchesKey(data, Key.up) || data === "k") {
            st.cursor = Math.max(0, st.cursor - 1);
            tui.requestRender();
          } else if (matchesKey(data, Key.down) || data === "j") {
            st.cursor = Math.min(contributions.length - 1, st.cursor + 1);
            tui.requestRender();
          } else if (matchesKey(data, Key.enter)) {
            const cb = contributions[st.cursor];
            st.detail = { title: cb.title, raw: loadDoc(cb), scroll: 0 };
            st.mode = "detail";
            tui.requestRender();
          } else if (data === "r" || data === "R") {
            if (canRelease) done("release");
          } else if (matchesKey(data, Key.escape)) {
            done("close");
          }
        },
      })
    );

      if (decision === "close") {
        ctx.ui.notify(
          `🐺 not released. Review/release later with:\n   /wolf:crawl-release ${runDir}`,
          "info"
        );
        return;
      }

      // decision === "release": explicit, numbers-forward confirmation before
      // anything shared leaves this wolf.
      const toEmit = contributions.filter((x) => x.status === "emit").length;
      const unchanged = contributions.length - toEmit;
      const curatedNow = contributions.filter((x) =>
        release.curated.has(x.denTopicId)
      ).length;
      const already =
        release.releasedAt || curatedNow
          ? `Already released ${release.releasedAt ? agoLabel(release.releasedAt) : ""}` +
            (curatedNow ? ` · ${curatedNow} already curated by Dewey` : "") +
            `. Re-releasing is idempotent (unchanged are skipped).\n\n`
          : "";
      const ok = await ctx.ui.confirm(
        "🐺 Release to the librarian?",
        already +
          `${toEmit} contribution(s) in "${domain}" → inbox lane "${wolfName}" → Dewey.` +
          (unchanged ? ` ${unchanged} unchanged will be skipped.` : "") +
          `\n\nThis is a SHARED, one-way handoff: Dewey's sweep will route, guard, ` +
          `and curate them into the KB. Proceed?`
      );
      if (!ok) continue; // back to the review

      try {
        const r = emitCrawl(runDir, {
          dryRun: false,
          wolf: wolfName,
          sinkBase: crawlHome,
          quiet: true,
        });
        markEmitted(runDir, r.emitted, r.dest);
        ctx.ui.notify(
          `🐺 released ${r.emitted} contribution(s)` +
            (r.skipped ? ` (${r.skipped} unchanged)` : "") +
            ` → ${r.dest}\nDewey's sweep will route + curate them.`,
          "info"
        );
      } catch (e) {
        ctx.ui.notify(`🐺 release failed: ${String(e)}`, "error");
      }
      return;
    }
  }

  pi.registerCommand("wolf:crawl-run", {
    description:
      "Run a reviewed crawl plan (gate enforced): /wolf:crawl-run [plan.yaml] [--concurrency N]",
    handler: async (args: string, ctx: any) => {
      // Parse flags out of the arg string: --concurrency N | -c N.
      let rest = (args ?? "").trim();
      let concurrency = envCrawlConcurrency();
      let concProvided = false;
      const concMatch = rest.match(/(?:--concurrency|-c)\s+(\d+)/i);
      if (concMatch) {
        concProvided = true;
        const n = Math.max(1, parseInt(concMatch[1], 10));
        concurrency = Math.min(n, CRAWL_CONCURRENCY_MAX);
        if (n > CRAWL_CONCURRENCY_MAX && ctx.hasUI)
          ctx.ui.notify(
            `🐺 capping concurrency at ${CRAWL_CONCURRENCY_MAX} (requested ${n})`,
            "warning"
          );
        rest = rest.replace(concMatch[0], "").trim();
      }

      // Resolve the plan: explicit arg → in-memory last plan → newest ready
      // plan on disk (survives a relaunch, when lastPlanPath is gone).
      const explicit = rest;
      let planPath = explicit || lastPlanPath || null;
      let discovered = false;
      if (!planPath) {
        planPath = findLatestPlan(crawlBases);
        discovered = !!planPath;
      }
      if (!planPath) {
        if (ctx.hasUI)
          ctx.ui.notify(
            "🐺 no plan — run /wolf:crawl first or pass a plan path",
            "error"
          );
        return;
      }
      lastPlanPath = planPath;
      const planFile: string = planPath;
      if (discovered && ctx.hasUI)
        ctx.ui.notify(`🐺 resuming latest plan on disk:\n   ${planFile}`, "info");

      // Headless path (Linux wolves / no TUI): run the exact same engine with no
      // monitor. This is the path the CLI uses too.
      if (!ctx.hasUI || !ctx.ui?.custom) {
        try {
          const res = await runCrawl(planPath, {
            declared: declaredDomains(),
            concurrency,
            sinkBase: crawlHome,
          });
          if (res.ok) {
            crawlPlanMode = false;
            refreshStatus(ctx);
          }
          if (ctx.hasUI)
            ctx.ui.notify(
              res.ok
                ? `🐺 crawl complete \u2192 ${res.dir}`
                : `🐺 crawl refused (gate):\n  ${(res.failures ?? []).join("\n  ")}`,
              res.ok ? "info" : "error"
            );
        } catch (e) {
          if (ctx.hasUI) ctx.ui.notify(`🐺 crawl failed: ${String(e)}`, "error");
        }
        return;
      }

      // Interactive path: a short wizard (single-choice UI borrowed from the
      // ask-user-question extension) configures the run, then we drive the live
      // monitor and offer reruns.
      let runPlanFile = planFile;
      let seedRunDir: string | undefined;
      let seedOnly: string[] | undefined;

      // Resume step: if an interrupted run exists for this plan, offer to finish it.
      try {
        const resolved = readPlan(planFile);
        const incomplete = findIncompleteRun(
          { source: resolved.source, domain: resolved.domain },
          crawlBases
        );
        if (incomplete) {
          const remaining = incomplete.missing.length;
          const choice = await wizardSingleChoice(
            ctx,
            "🐺 Resume the interrupted crawl?",
            `Found an unfinished run in ${incomplete.runDir}\n` +
              `${incomplete.done}/${incomplete.total} batches done` +
              (remaining
                ? `, ${remaining} remaining`
                : `, journey not written`) +
              ` \u00b7 domain ${incomplete.domain}.`,
            [
              {
                label: remaining
                  ? `Resume \u2014 finish the ${remaining} remaining batch(es)`
                  : "Resume \u2014 finish the journey",
                value: "resume",
              },
              {
                label: "Start fresh \u2014 new run from the full plan",
                value: "fresh",
              },
              { label: "Cancel", value: "cancel" },
            ]
          );
          if (choice === null || choice === "cancel") return;
          if (choice === "resume") {
            seedRunDir = incomplete.runDir;
            seedOnly = incomplete.missing; // [] => journey-only
            runPlanFile = path.join(incomplete.runDir, "plan.yaml");
          }
        }
      } catch {
        /* plan unreadable => skip resume detection, run normally */
      }

      // Concurrency step.
      if (!concProvided) {
        const choice = await wizardSingleChoice(
          ctx,
          "🐺 How many batches to run at once?",
          `More = faster, but bounded by your Anthropic rate limit (max ${CRAWL_CONCURRENCY_MAX}).`,
          [5, 8, 12, 16, 24, 32].map((n) => ({
            label: n === concurrency ? `${n} (default)` : `${n}`,
            value: String(n),
          })) as WizardOption[],
          true // allow "Other" custom value
        );
        if (choice === null) return; // cancelled
        const n = parseInt(choice, 10);
        if (Number.isFinite(n) && n >= 1)
          concurrency = Math.min(n, CRAWL_CONCURRENCY_MAX);
      }
      ctx.ui.notify(
        `🐺 running up to ${concurrency} batches at once` +
          (seedRunDir ? " (resuming)" : ""),
        "info"
      );

      type RunOutcome =
        | { kind: "ok"; dir: string }
        | { kind: "cancelled"; dir: string }
        | { kind: "gate"; failures: string[] }
        | { kind: "error"; error: string };

      // One monitored run. `only`+`runDir` drive rerun / resume into a dir.
      // Esc aborts cooperatively (finishes in-flight batches, skips journey).
      const runWithMonitor = (
        only?: string[],
        runDir?: string
      ): Promise<{ outcome: RunOutcome; state: CrawlMonitorState }> => {
        const state = newCrawlMonitorState(runPlanFile, concurrency);
        const controller = new AbortController();
        return ctx.ui
          .custom<RunOutcome>(
            (tui: any, theme: any, _kb: any, done: (r: RunOutcome) => void) => {
              let frame = 0;
              const timer = setInterval(() => {
                frame++;
                tui.requestRender();
              }, 150);
              const finish = (r: RunOutcome) => {
                clearInterval(timer);
                done(r);
              };
              runCrawl(runPlanFile, {
                declared: declaredDomains(),
                concurrency,
                only,
                runDir,
                sinkBase: crawlHome,
                signal: controller.signal,
                onProgress: (p) => {
                  applyCrawlProgress(state, p);
                  tui.requestRender();
                },
              })
                .then((res) =>
                  res.cancelled
                    ? finish({ kind: "cancelled", dir: res.dir })
                    : res.ok
                      ? finish({ kind: "ok", dir: res.dir })
                      : finish({ kind: "gate", failures: res.failures ?? [] })
                )
                .catch((e) => finish({ kind: "error", error: String(e) }));
              return {
                render: (width: number) =>
                  renderCrawlMonitor(state, theme, width, frame),
                invalidate: () => {},
                handleInput: (data: string) => {
                  // Esc requests cancellation; the run resolves once in-flight
                  // batches settle. Don't close the panel yet.
                  if (matchesKey(data, Key.escape) && !state.cancelling) {
                    state.cancelling = true;
                    controller.abort();
                    tui.requestRender();
                  }
                },
              };
            }
          )
          .then((outcome: RunOutcome) => ({ outcome, state }));
      };

      let runDir: string | undefined = seedRunDir;
      let rerunOnly: string[] | undefined = seedOnly;
      while (true) {
        const { outcome, state } = await runWithMonitor(rerunOnly, runDir);

        if (outcome.kind === "gate") {
          ctx.ui.notify(
            `🐺 crawl refused (gate):\n  ${outcome.failures.join("\n  ")}`,
            "error"
          );
          return;
        }
        if (outcome.kind === "error") {
          ctx.ui.notify(`🐺 crawl failed: ${outcome.error}`, "error");
          return;
        }
        if (outcome.kind === "cancelled") {
          crawlPlanMode = false;
          refreshStatus(ctx);
          ctx.ui.notify(
            `🐺 crawl cancelled → ${outcome.dir}\n` +
              `   finished batches were kept; resume with /wolf:crawl-run.`,
            "warning"
          );
          return;
        }

        runDir = outcome.dir;
        const errored = [...state.rows.values()].filter(
          (r) => r.stage === "error"
        );
        ctx.ui.notify(
          crawlRunSummary(state, outcome.dir),
          errored.length ? "warning" : "info"
        );
        if (errored.length === 0) break;

        const again = await ctx.ui.confirm(
          "🐺 Rerun failed batches?",
          `${errored.length} batch(es) failed: ${errored
            .map((r) => r.topic)
            .join(", ")}`
        );
        if (!again) break;
        rerunOnly = errored.map((r) => r.topic);
      }

      crawlPlanMode = false;
      refreshStatus(ctx);
      ctx.ui.notify(`🐺 crawl complete → ${runDir}`, "info");
      // Continue straight into the release review inside the TUI.
      if (runDir) await reviewAndRelease(ctx, runDir);
    },
  });

  pi.registerCommand("wolf:crawl-release", {
    description:
      "Review a run's topics + what hits the inbox, then release to Dewey (review + confirm + emit in one): /wolf:crawl-release [run-dir]",
    handler: async (args: string, ctx: any) => {
      const explicit = (args ?? "").trim();
      let runDir: string | null = explicit || null;
      if (!runDir) {
        runDir = await pickCrawl(ctx, "🐺 Release which crawl?", [
          "complete",
          "released",
          "curated",
        ]);
      }
      if (!runDir) {
        if (ctx.hasUI)
          ctx.ui.notify(
            "🐺 no completed crawl to release; run /wolf:crawl-run first",
            "error"
          );
        return;
      }
      await reviewAndRelease(ctx, runDir);
    },
  });

  pi.registerCommand("wolf:crawls", {
    description: "List crawl runs on disk (any session) with their status",
    handler: async (_args: string, ctx: any) => {
      const all = listCrawls(crawlBases, { opsRoot: kbRoots.opsRoot, wolf: wolfName });
      if (all.length === 0) {
        if (ctx.hasUI) ctx.ui.notify(`🐺 no crawls under ${crawlHome}`, "info");
        return;
      }
      const lines = all.map((e) => {
        const when = new Date(e.createdAt).toLocaleString();
        const where = e.dir.startsWith(DEFAULT_SINK_BASE) ? " (tmp)" : "";
        return `  • [${e.status}] ${e.domain} · ${e.topics || e.files} ${e.topics ? "topics" : "files"} · ${when}${where}\n      ${e.dir}`;
      });
      if (ctx.hasUI)
        ctx.ui.notify(`🐺 ${all.length} crawl(s):\n${lines.join("\n")}`, "info");
    },
  });

  // Full re-send: the wolf is the durable source of truth, so a complete KB
  // rebuild = wipe Dewey, then every wolf re-emits its entire contribution set.
  // Rare + expensive by design, hence an explicit confirmation. Single-wolf
  // scope for now (re-emits THIS wolf only).
  pi.registerCommand("wolf:resend-all", {
    description:
      "Re-emit THIS wolf's ENTIRE contribution set (all den topics + completed crawls) to the Librarian. Rare + expensive — for rebuilding Dewey from scratch.",
    handler: async (args: string, ctx: any) => {
      if (!kbEnabled) {
        if (ctx.hasUI)
          ctx.ui.notify(
            "\ud83d\udc3a KB_OPS not set \u2014 no Librarian inbox to emit to.",
            "error"
          );
        return;
      }

      // 1) Every den memory topic (the wolf's accumulated knowledge).
      let denTopics: { id: string; summary: string; body: string }[] = [];
      try {
        denTopics = readDenTopics(wolfDen);
      } catch {
        denTopics = [];
      }

      // 2) Every COMPLETED crawl run (has history.json → re-emittable), deduped
      //    by (domain, source) keeping the newest — a crawl run twice re-sends
      //    once, not duplicated.
      const finished = listCrawls(crawlBases).filter((e) =>
        ["complete", "released", "curated"].includes(e.status)
      );
      const newestBySource = new Map<string, (typeof finished)[number]>();
      for (const e of finished) {
        const key = `${e.domain}\u0000${e.source}`;
        const prev = newestBySource.get(key);
        if (!prev || e.createdAt > prev.createdAt) newestBySource.set(key, e);
      }
      const crawlRuns = [...newestBySource.values()];
      const crawlTopicTotal = crawlRuns.reduce((n, e) => n + (e.topics || 0), 0);

      if (denTopics.length === 0 && crawlRuns.length === 0) {
        if (ctx.hasUI)
          ctx.ui.notify(
            "\ud83d\udc3a nothing to re-send \u2014 no den topics or completed crawls found",
            "info"
          );
        return;
      }

      // Confirm — rare, expensive, outward-facing (re-floods Dewey's inbox).
      const force = /\s(--force|--yes)\b/.test(` ${args ?? ""}`);
      const detail =
        `Re-emit ${wolfName}'s ENTIRE contribution set to the Librarian inbox:\n` +
        `  \u2022 ${denTopics.length} den topic(s) \u2192 domain "${defaultDomain}"\n` +
        `  \u2022 ${crawlRuns.length} completed crawl(s), ${crawlTopicTotal} topics:\n` +
        crawlRuns
          .map((e) => `      - ${e.domain} \u00b7 ${e.topics} topics \u00b7 ${e.source}`)
          .join("\n") +
        `\n\nDewey reprocesses everything from scratch \u2014 this is for a full KB ` +
        `rebuild (expensive, rarely needed). Proceed?`;

      if (!force) {
        if (!ctx.hasUI || !ctx.ui.confirm) {
          ctx.ui?.notify?.(
            "\ud83d\udc3a resend-all needs interactive confirmation (or pass --force).",
            "error"
          );
          return;
        }
        const ok = await ctx.ui.confirm(
          "\ud83d\udc3a Re-send ALL contributions to Dewey?",
          detail
        );
        if (!ok) {
          ctx.ui.notify("\ud83d\udc3a resend-all cancelled \u2014 nothing emitted", "info");
          return;
        }
      }

      // Emit den topics.
      let denEmitted = 0;
      for (const t of denTopics) {
        try {
          const d = emitDelta({
            roots: kbRoots,
            wolf: wolfName,
            denTopicId: t.id,
            change: "create",
            domainHint: defaultDomain,
            summary: t.summary,
            body: t.body,
          });
          if (d) denEmitted++;
        } catch (e) {
          ctx.ui?.notify?.(`\ud83d\udc3a den topic ${t.id} failed: ${String(e)}`, "warning");
        }
      }

      // Emit crawl runs.
      let crawlEmitted = 0;
      let crawlRunsOk = 0;
      for (const e of crawlRuns) {
        try {
          const r = emitCrawl(e.dir, {
            dryRun: false,
            wolf: wolfName,
            sinkBase: crawlHome,
            quiet: true,
          });
          crawlEmitted += r.emitted;
          crawlRunsOk++;
        } catch (err) {
          ctx.ui?.notify?.(`\ud83d\udc3a crawl ${e.dir} failed: ${String(err)}`, "warning");
        }
      }

      refreshStatus(ctx);
      if (ctx.hasUI)
        ctx.ui.notify(
          `\ud83d\udc3a re-sent \u2192 ${kbRoots.opsRoot}/inbox/${wolfName}:\n` +
            `   ${denEmitted}/${denTopics.length} den topic(s)\n` +
            `   ${crawlEmitted} crawl contribution(s) from ${crawlRunsOk}/${crawlRuns.length} run(s)\n` +
            `Dewey's sweep will rebuild the KB from these.`,
          crawlRunsOk < crawlRuns.length ? "warning" : "info"
        );
    },
  });

  pi.registerCommand("wolf:crawl-cancel", {
    description: "Exit crawl plan mode without running",
    handler: async (_args: string, ctx: any) => {
      crawlPlanMode = false;
      refreshStatus(ctx);
      if (ctx.hasUI) ctx.ui.notify("🐺 crawl plan mode off (observation resumed)", "info");
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
          beginActivity(ctx, "consolidate");
          try {
            await orchestrator.consolidateNow();
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (ctx.hasUI) ctx.ui.notify(`🐺 consolidation failed: ${msg}`, "warning");
          } finally {
            endActivity(ctx, "consolidate");
          }
        }

        if (ctx.hasUI) ctx.ui.notify("🐺 promoting to den...", "info");
        beginActivity(ctx, "promote");
        try {
          const denConfig: DenConfig = { denRoot: wolfDen, wolfName: wolfName };
          await orchestrator.promoteToWolfMemory(denConfig);
          if (ctx.hasUI) ctx.ui.notify("🐺 session promoted to den", "info");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (ctx.hasUI) ctx.ui.notify(`🐺 promote failed: ${msg}`, "warning");
        } finally {
          endActivity(ctx, "promote");
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
