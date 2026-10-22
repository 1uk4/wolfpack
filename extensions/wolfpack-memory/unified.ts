/**
 * Wolfpack Memory Extension — Unified Implementation
 * 
 * Supports both pi and pi-durable runtimes through the unified extension API.
 * Core logic lives in @wolfpack/memory package.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
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
} from "@wolfpack/harness/extension";
import {
  observe,
  renderDenContext,
  renderKbAccess,
  reconcileDen,
  type RawObservation,
} from "@wolfpack/memory";
import { consolidatePool } from "@wolfpack/harness/memory";
import { readBoundTask } from "./unified-tasks.js";
import { drainInbox, listParked, type ParsedContribution, type KbRoots, type ParkedItem } from "@wolfpack/kb/librarian";
import { createEngine, engineSteps, loadModelTable, type Engine, type EngineConfig, type ModelTable } from "@wolfpack/engine";

// ─── Config ────────────────────────────────────────────────────────────────

export interface MemoryConfig {
  enabled?: boolean;
  /** Minimum text length to trigger observation (default: 100) */
  minTextLength?: number;
  /** Consolidation settings */
  consolidation?: {
    trigger?: "threshold" | "timer" | "hybrid" | "manual";
    threshold?: number;
    interval?: string;
  };
  /** Librarian mode - enables KB inbox tools (read-only for now) */
  librarian?: boolean;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function formatMessage(message: AssistantMessage): string {
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      parts.push(`[assistant] ${block.text}`);
    } else if (block.type === "toolCall") {
      parts.push(`[tool_call] ${block.name}(${JSON.stringify(block.arguments).slice(0, 200)})`);
    } else if (block.type === "thinking") {
      parts.push(`[thinking] ${block.thinking.slice(0, 500)}`);
    }
  }
  return parts.join("\n");
}

/**
 * Append observations to the pool. While a task is bound they are stamped
 * `work: <task id>`: they feed that item's Record, not the den.
 */
async function writeToPool(
  wolfDen: string,
  observations: RawObservation[],
  bound: { taskId: string; featureId?: string } | null = null,
): Promise<void> {
  if (observations.length === 0) return;
  const poolDir = join(wolfDen, ".memory", "pool");
  await mkdir(poolDir, { recursive: true });
  const poolFile = join(poolDir, "observations.jsonl");
  const timestamp = new Date().toISOString();
  const lines = observations.map(obs =>
    JSON.stringify({
      ...obs,
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

  const consolidationThreshold = consolidation?.threshold ?? 15000;
  const consolidationTrigger = consolidation?.trigger ?? "threshold";

  // Models come from the wolf's resolved table (the harness points
  // WOLFPACK_MODELS_FILE at the shipped models.json before loading us).
  // Loaded lazily so a broken table surfaces as a tool error, not a crash.
  let table: ModelTable | null = null;
  function getTable(): ModelTable {
    if (!table) table = loadModelTable().table;
    return table;
  }
  function apiKeyFor(t: ModelTable): string | undefined {
    return t.tiers.smart.provider === "anthropic" ? process.env.ANTHROPIC_API_KEY : undefined;
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
    if (!engine) engine = makeEngine();
    return engine;
  }

  // KB roots from env
  const kbBase = process.env.KB_BASE;
  const kbOps = process.env.KB_OPS;
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

  return defineExtension({
    name: "wolfpack-memory",
    runtimes: ["pi", "pi-durable"],

    tools: [
      defineTool({
        name: "memory_consolidate",
        description: "Consolidate observation pool into persistent memory topics. Use when you have important context to preserve, or when the pool is getting large.",
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

            const result = await consolidatePool({
              wolfDen: ctx.wolfDen,
              wolfName: ctx.wolfName,
              table: getTable(),
              apiKey: apiKeyFor(getTable()),
              kbRoots: kbRoots ?? undefined,
              defaultDomain: domains[0] ?? "wolfpack",
              domains,
              onProgress: (msg) => console.log(`[memory] ${msg}`),
            });

            return {
              content: [{
                type: "text",
                text: `Consolidated ${result.observationsProcessed} observations: ${result.topicsCreated} created, ${result.topicsMerged} updated, ${result.claimsSubmitted} emitted to KB.`,
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
      afterResponse: (message: AssistantMessage, ctx: HookContext) => {
        // Only observe root conversation — subagents are ephemeral
        if (ctx.conversationId !== 1) return;

        // Fire-and-forget: don't await
        (async () => {
          try {
            const text = formatMessage(message);
            if (text.length < minTextLength) return;

            const eng = getEngine();
            const result = await observe({
              engine: eng,
              chunkText: text,
              mode: "conversation",
            });

            if (result.observations.length > 0) {
              await writeToPool(ctx.wolfDen, result.observations, readBoundTask(ctx.wolfDen));

              // Auto-consolidation if threshold trigger
              if (consolidationTrigger === "threshold" || consolidationTrigger === "hybrid") {
                const stats = await getPoolStats(ctx.wolfDen);
                if (stats.tokens >= consolidationThreshold) {
                  console.log(`[memory] Threshold reached (${stats.tokens} >= ${consolidationThreshold}), consolidating...`);
                  try {
                    const consResult = await consolidatePool({
                      wolfDen: ctx.wolfDen,
                      wolfName: ctx.wolfName,
                      table: getTable(),
                      apiKey: apiKeyFor(getTable()),
                      kbRoots: kbRoots ?? undefined,
                      defaultDomain: domains[0] ?? "wolfpack",
              domains,
                      onProgress: (msg) => console.log(`[memory] ${msg}`),
                    });
                    console.log(`[memory] Auto-consolidated: ${consResult.topicsCreated} created, ${consResult.topicsMerged} updated, ${consResult.claimsSubmitted} emitted`);
                  } catch (consErr) {
                    console.error("[memory] Auto-consolidation failed:", consErr instanceof Error ? consErr.message : consErr);
                  }
                }
              }
            }
          } catch (err) {
            console.error("[memory] observation error:", err instanceof Error ? err.message : err);
          }
        })();
      },
    },
  });
}
