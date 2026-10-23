/**
 * Wolfpack Tasks Extension — Unified Implementation (Pi-Durable)
 * 
 * Work system tools for agent-managed task workflows.
 * Uses @wolfpack/kb/client for work operations.
 */
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { createEngine, engineSteps, loadModelTable, type Engine } from "@wolfpack/engine";
import type { KbRoots } from "@wolfpack/kb/shared";
import { join, dirname } from "node:path";
import {
  defineExtension,
  defineTool,
  section,
  Type,
  type ExtensionContext,
  type ToolContext,
  type ToolResult,
} from "@wolfpack/harness/extension";
import {
  type WorkItem,
  type CreateWorkInput,
  STAGE_ORDER,
  isComplete,
} from "@wolfpack/kb/client";
import { listSubscribedDomains, formatDomainChoices } from "@wolfpack/kb";
import {
  renderWorkingDocument,
  extractRecord,
  replaceRecordSection,
  syncFeatureStage,
  readyToGraduate,
  readyBoundContext,
  readyBoundReply,
  previewGraduation,
  confirmGraduation,
  renderGraduationPreview,
  initiativeOf,
  type GraduationPreview,
  rollupToParent,
  recordFeatureId,
  renderFeatureRecord,
  shouldBindOnCreate,
  createSerial,
  notBoundReason,
  withHeadsUp,
  UNBOUND_CONTEXT,
  BINDING_RULES,
} from "@wolfpack/memory";
import { WorkClient, shipAndRollup } from "./work-client.js";

type WorkItemKind = "initiative" | "feature" | "task" | "issue" | "spike";
type WorkItemStage = typeof STAGE_ORDER[number];

// ─── Types ─────────────────────────────────────────────────────────────────

export interface TasksConfig {
  /** Auto-ship tasks without confirmation (default: true for agent-managed) */
  autoShip?: boolean;
  /** Engine for graduation's distill (default: the wolf's model table). Test seam. */
  engine?: () => Engine;
  /** KB roots for graduation (default: KB_BASE / KB_OPS, den-local state under <den>/kb). Test seam. */
  kbRoots?: KbRoots;
}

/** A graduation preview waits this long for the owner's answer. */
const PREVIEW_TTL_MS = 6 * 60 * 60 * 1000;

interface ActiveBinding {
  taskId: string;
  domain: string;
  boundAt: string;
  /** The task's parent feature at bind time. */
  featureId?: string;
}

// ─── Binding State ─────────────────────────────────────────────────────────

/**
 * A subagent child (PI_SUBAGENT_AGENT) never binds: the binding file lives in
 * the orchestrator's den and is theirs. No binding context or rules, no
 * auto-bind, no heads-up; task_bind / task_unbind refuse. Other tools keep working.
 */
const isSubagent = () => !!process.env.PI_SUBAGENT_AGENT;
const bindSerial = createSerial();
const SUBAGENT_NO_BIND = "Subagents don't bind: the orchestrator owns the binding.";
const heads = (reply: string, working: { id: string; title?: string }, bound: { id: string; title?: string } | null) =>
  isSubagent() ? reply : withHeadsUp(reply, working, bound);

function bindingPath(wolfDen: string): string {
  return join(wolfDen, "tasks", "active.json");
}

async function readBinding(wolfDen: string): Promise<ActiveBinding | null> {
  if (isSubagent()) return null;
  const path = bindingPath(wolfDen);
  if (!existsSync(path)) return null;
  try {
    const content = await readFile(path, "utf-8");
    const parsed = JSON.parse(content);
    if (!parsed || !parsed.taskId) return null;
    return parsed as ActiveBinding;
  } catch {
    return null;
  }
}

/**
 * The task this wolf is bound to, read synchronously (memory tags observations
 * with it). Null when nothing is bound.
 */
export function readBoundTask(wolfDen: string): { taskId: string; featureId?: string } | null {
  try {
    const parsed = JSON.parse(readFileSync(bindingPath(wolfDen), "utf-8")) as ActiveBinding | null;
    return parsed?.taskId ? { taskId: parsed.taskId, ...(parsed.featureId ? { featureId: parsed.featureId } : {}) } : null;
  } catch {
    return null;
  }
}

async function writeBinding(wolfDen: string, taskId: string, domain: string, featureId?: string): Promise<void> {
  if (isSubagent()) return;
  const path = bindingPath(wolfDen);
  await mkdir(dirname(path), { recursive: true });
  const binding: ActiveBinding = {
    taskId,
    domain,
    boundAt: new Date().toISOString(),
    ...(featureId ? { featureId } : {}),
  };
  await writeFile(path, JSON.stringify(binding, null, 2));
}

async function clearBinding(wolfDen: string): Promise<void> {
  if (isSubagent()) return;
  const path = bindingPath(wolfDen);
  if (existsSync(path)) {
    await writeFile(path, "null");
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function stageIcon(item: WorkItem): string {
  if (isComplete(item)) return "☑️";
  if (item.stage === "in_build") return "→";
  return "○";
}

function formatWorkItem(item: WorkItem, isActive: boolean = false): string {
  const icon = stageIcon(item);
  const active = isActive ? " ← active" : "";
  return `${icon} [${item.id}] ${item.title} (${item.stage})${active}`;
}

function formatHierarchy(
  feature: WorkItem,
  children: WorkItem[],
  activeId: string | null
): string {
  const lines: string[] = [];
  const completed = children.filter(c => isComplete(c)).length;
  lines.push(`**Feature:** [${feature.id}] ${feature.title}`);
  lines.push(`  Stage: ${feature.stage} | ${completed}/${children.length} tasks shipped`);
  lines.push("");
  
  if (children.length > 0) {
    lines.push("**Tasks:**");
    for (const child of children) {
      const isActiveTask = child.id === activeId;
      lines.push(`  ${formatWorkItem(child, isActiveTask)}`);
    }
  }
  
  return lines.join("\n");
}

function makeClient(): WorkClient {
  return new WorkClient();
}

// ─── Extension Factory ─────────────────────────────────────────────────────

export default function createTasksExtension(
  config: TasksConfig,
  context: ExtensionContext
): ReturnType<typeof defineExtension> {
  const { wolfDen, wolfName, domains } = context;
  const autoShip = config.autoShip ?? true;

  const client = makeClient();

  // ── Cache: sections read sync, tools write async ────────────────────────
  interface TaskCache {
    task: WorkItem;
    parent?: WorkItem;
    siblings?: WorkItem[];
    /** The working document (plan + Record), as of the last refresh. */
    body?: string;
    /** The feature's Record (shared by its tasks), rendered for the context. */
    featureRecord?: string;
    /** The bound item is done and waits for a manual graduation (a finished feature or loose task). */
    ready?: boolean;
    fetchedAt?: number;
  }

  function cachePath(): string {
    return join(wolfDen, "factory", "task-cache.json");
  }

  function readCache(): TaskCache | null {
    try {
      return JSON.parse(require("fs").readFileSync(cachePath(), "utf-8"));
    } catch {
      return null;
    }
  }

  async function writeCache(task: WorkItem): Promise<void> {
    const dir = dirname(cachePath());
    await mkdir(dir, { recursive: true });
    let parent: WorkItem | undefined;
    let siblings: WorkItem[] | undefined;
    let body: string | undefined;
    let featureRecord: string | undefined;
    try {
      body = (await client.getWithBody(task.id as string)).body ?? "";
    } catch { /* best effort: the section just omits the document */ }
    if (task.partOf) {
      try {
        parent = await client.get(task.partOf as string);
        siblings = await client.query({ domain: task.domain as string, partOf: task.partOf as string });
        if (parent.kind === "feature" && !parent.container) {
          const f = await client.getWithBody(parent.id as string);
          featureRecord = renderFeatureRecord(parent.title, f.body ?? "") || undefined;
        }
      } catch { /* best effort */ }
    }
    let ready = false;
    try {
      const all = task.kind === "feature" ? [task, ...(await client.query({ domain: task.domain as string, partOf: task.id as string }))] : [task, ...(parent ? [parent] : [])];
      ready = readyToGraduate(task, all);
    } catch { /* advisory */ }
    await writeFile(cachePath(), JSON.stringify({ task, parent, siblings, body, featureRecord, ready, fetchedAt: Date.now() } satisfies TaskCache));
  }

  /** Sections render synchronously from the cache. The Record changes behind
   *  our back (memory rewrites it), so each render schedules a refresh: the
   *  agent sees it one turn later at the latest. */
  let refreshing = false;
  function refreshCacheSoon(cached: TaskCache): void {
    if (refreshing || Date.now() - (cached.fetchedAt ?? 0) < 10_000) return;
    refreshing = true;
    client.get(cached.task.id as string)
      .then((task) => writeCache(task))
      .catch(() => {})
      .finally(() => { refreshing = false; });
  }

  function clearCache(): void {
    try { require("fs").unlinkSync(cachePath()); } catch { /* ok */ }
  }

  // ── API helpers ─────────────────────────────────────────────────────────
  async function getItems(domain: string): Promise<WorkItem[]> {
    return client.query({ domain });
  }

  async function findItem(id: string): Promise<{ item: WorkItem; domain: string } | null> {
    try {
      const item = await client.get(id);
      return { item, domain: item.domain as string };
    } catch {
      return null;
    }
  }

  async function getChildren(domain: string, parentId: string): Promise<WorkItem[]> {
    return client.query({ domain, partOf: parentId });
  }

  async function getParent(domain: string, item: WorkItem): Promise<WorkItem | null> {
    if (!item.partOf) return null;
    try {
      return await client.get(item.partOf as string);
    } catch {
      return null;
    }
  }

  /** The bound item as the heads-up line names it. */
  function boundRef(binding: ActiveBinding | null): { id: string; title?: string } | null {
    if (!binding) return null;
    const cached = readCache();
    return { id: binding.taskId, title: cached?.task.id === binding.taskId ? cached.task.title : undefined };
  }

  // ── Graduation: preview first, send only on the owner's yes ─────────────
  const previewDir = () => join(wolfDen, "tasks", "graduation");
  const previewFile = (token: string) => join(previewDir(), `${token.replace(/[^a-f0-9]/g, "")}.json`);
  function graduationRoots(): KbRoots | null {
    if (config.kbRoots) return config.kbRoots;
    const kbBase = process.env.KB_BASE;
    const kbOps = process.env.KB_OPS;
    return kbBase && kbOps ? { kbBase, opsRoot: kbOps, denLocal: join(wolfDen, "kb") } : null;
  }
  function graduationEngine(): Engine {
    if (config.engine) return config.engine();
    const t = loadModelTable().table;
    const apiKey = t.tiers.smart.provider === "anthropic" ? process.env.ANTHROPIC_API_KEY : undefined;
    return createEngine({
      provider: t.tiers.smart.provider,
      ...(apiKey ? { apiKey } : {}),
      defaultModel: t.tiers.smart.model,
      steps: engineSteps(t),
    });
  }

  /** Ship an item and fold it into its feature's ## Outcomes (a failed rollup never blocks the ship). */
  const ship = (id: string) => shipAndRollup(client, id, rollupToParent);

  const ID_NOTE = " Optional id: act on that item instead of the bound one (the reply then warns that it is not the bound item).";

  return defineExtension({
    name: "wolfpack-tasks",
    runtimes: ["pi-durable"],

    sections: [
      // Task tools instructions
      section("task_tools", () => {
        const domainList = domains.join(", ") || "(none configured)";
        return `## Task Tools

Available: task_query, task_bind, task_unbind, task_current, task_create, task_done, task_note, task_stage, task_graduate, task_features

Domains: ${domainList}${isSubagent() ? "" : `\n\n${BINDING_RULES}`}`;
      }),

      // Active task section — shows current binding with feature context
      section("active_task", () => {
        if (isSubagent()) return "";
        try {
          const bp = bindingPath(wolfDen);
          if (!existsSync(bp)) {
            return `## Active Task\n\n${UNBOUND_CONTEXT}\nUse \`task_query\` to see available work.`;
          }

          const binding = JSON.parse(require("fs").readFileSync(bp, "utf-8")) as ActiveBinding | null;
          if (!binding?.taskId) {
            return `## Active Task\n\n${UNBOUND_CONTEXT}\nUse \`task_query\` to see available work.`;
          }

          const cached = readCache();
          if (!cached) {
            return `## Active Task\n\nBound to ${binding.taskId} (loading...). Use \`task_query\` to refresh.`;
          }

          const { task, parent, siblings } = cached;
          const lines: string[] = ["## Active Task", ""];
          if (cached.ready) lines.push(readyBoundContext(task), "");

          if (task.kind === "feature") {
            lines.push(`**Feature:** [${task.id}] ${task.title}`);
            lines.push(`  Stage: ${task.stage}`);
          } else if (parent && (parent.kind === "feature" || parent.kind === "initiative") && siblings) {
            lines.push(formatHierarchy(parent, siblings, task.id));
          } else {
            lines.push(`**Task:** [${task.id}] ${task.title}`);
            lines.push(`  Stage: ${task.stage}`);
          }

          if (task.successCriteria) {
            lines.push("");
            lines.push(`**Success Criteria:** ${task.successCriteria}`);
          }

          const doc = cached.body ? renderWorkingDocument(cached.body) : "";
          if (doc) {
            lines.push("");
            lines.push("## Working Document (plan + Record)");
            lines.push(doc);
            lines.push("The Record is kept up to date by memory from this session's observations; task_update never replaces it. If the document above ends in […] it is clipped: do not write it back with task_update.");
          }
          if (cached.featureRecord && task.kind !== "feature") {
            lines.push("");
            lines.push(cached.featureRecord);
          }
          refreshCacheSoon(cached);

          return lines.join("\n");
        } catch (err) {
          return `## Active Task\n\nError: ${err instanceof Error ? err.message : err}`;
        }
      }),
    ],

    tools: [
      // ─── task_bind ───────────────────────────────────────────────────────
      defineTool({
        name: "task_bind",
        description:
          "Bind to the task/issue/spike you are working on. Do it BEFORE you start: the bound item decides where what you learn is kept (its feature's Record, not den topics). " +
          "One bound item per session; call it again to switch.",
        parameters: Type.Object({
          id: Type.String({ description: "Work item ID to bind to" }),
        }),
        async execute(args: { id: string }, ctx: ToolContext): Promise<ToolResult> {
          if (isSubagent()) return { content: [{ type: "text", text: SUBAGENT_NO_BIND }], isError: true };
          const found = await findItem(args.id);
          if (!found) {
            return {
              content: [{ type: "text", text: `Task ${args.id} not found in subscribed domains.` }],
              isError: true,
            };
          }

          const { item, domain } = found;
          
          // Only bind to actionable items
          if (!["task", "issue", "spike"].includes(item.kind)) {
            return {
              content: [{ type: "text", text: `Cannot bind to ${item.kind}. Use task_bind on tasks, issues, or spikes.` }],
              isError: true,
            };
          }

          await writeBinding(ctx.wolfDen, item.id, domain, await recordFeatureId(client, item));
          await writeCache(item);
          // A feature follows its tasks into build
          await syncFeatureStage(client, item).catch(() => {});

          return {
            content: [{
              type: "text",
              text: `Bound to: [${item.id}] ${item.title}\nStage: ${item.stage}\n${item.successCriteria ? `Success: ${item.successCriteria}` : ""}`,
            }],
          };
        },
      }),

      // ─── task_unbind ─────────────────────────────────────────────────────
      defineTool({
        name: "task_unbind",
        description: "Unbind from the current task without shipping it.",
        parameters: Type.Object({}),
        async execute(_args: unknown, ctx: ToolContext): Promise<ToolResult> {
          if (isSubagent()) return { content: [{ type: "text", text: SUBAGENT_NO_BIND }], isError: true };
          const binding = await readBinding(ctx.wolfDen);
          if (!binding) {
            return {
              content: [{ type: "text", text: "No task currently bound." }],
            };
          }

          await clearBinding(ctx.wolfDen);
          clearCache();
          return {
            content: [{ type: "text", text: `Unbound from ${binding.taskId}.` }],
          };
        },
      }),

      // ─── task_current ────────────────────────────────────────────────────
      defineTool({
        name: "task_current",
        description: "Get details about the currently bound task.",
        parameters: Type.Object({}),
        async execute(_args: unknown, ctx: ToolContext): Promise<ToolResult> {
          const binding = await readBinding(ctx.wolfDen);
          if (!binding) {
            return {
              content: [{ type: "text", text: "No task currently bound." }],
            };
          }

          const found = await findItem(binding.taskId);
          if (!found) {
            return {
              content: [{ type: "text", text: `Bound task ${binding.taskId} not found.` }],
              isError: true,
            };
          }

          const { item } = found;
          return {
            content: [{
              type: "text",
              text: `ID: ${item.id}\nTitle: ${item.title}\nKind: ${item.kind}\nStage: ${item.stage}\nDomain: ${binding.domain}\n${item.successCriteria ? `Success: ${item.successCriteria}` : ""}`,
            }],
          };
        },
      }),

      // ─── task_query ──────────────────────────────────────────────────────
      defineTool({
        name: "task_query",
        description: "Query work items across subscribed domains. Returns hierarchical view with parents and children.",
        parameters: Type.Object({
          domain: Type.Optional(Type.String({ description: "Filter to specific domain" })),
          kind: Type.Optional(Type.String({ description: "Filter by kind: initiative, feature, task, issue, spike" })),
          stage: Type.Optional(Type.String({ description: "Filter by stage" })),
          id: Type.Optional(Type.String({ description: "Get specific item with its context" })),
          depth: Type.Optional(Type.Number({ description: "Include children to this depth (default: 1)" })),
        }),
        async execute(args: {
          domain?: string;
          kind?: string;
          stage?: string;
          id?: string;
          depth?: number;
        }, ctx: ToolContext): Promise<ToolResult> {
          const targetDomains = args.domain ? [args.domain] : domains;
          const depth = args.depth ?? 1;
          const results: string[] = [];
          const binding = await readBinding(ctx.wolfDen);

          for (const domain of targetDomains) {
            if (!domains.includes(domain)) continue;
            
            try {
              
              
              // Specific item lookup
              if (args.id) {
                const found = await findItem(args.id);
                if (!found || found.domain !== domain) continue;
                
                const item = found.item;
                const lines: string[] = [`## ${domain}`, ""];
                
                // Get parent context
                if (item.partOf) {
                  const parent = await getParent(domain, item);
                  if (parent) {
                    lines.push(`Parent: ${formatWorkItem(parent)}`);
                    lines.push("");
                  }
                }
                
                lines.push(`${formatWorkItem(item, item.id === binding?.taskId)}`);
                
                // Get children
                if (depth > 0) {
                  const children = await getChildren(domain, item.id);
                  if (children.length > 0) {
                    lines.push("");
                    lines.push("Children:");
                    for (const child of children) {
                      lines.push(`  ${formatWorkItem(child, child.id === binding?.taskId)}`);
                    }
                  }
                }
                
                results.push(lines.join("\n"));
                continue;
              }

              const items = await client.query({
                domain,
                ...(args.kind ? { kind: args.kind } : {}),
                ...(args.stage ? { stage: args.stage } : {}),
              });

              if (items.length === 0) continue;

              const lines: string[] = [`## ${domain}`, ""];
              
              // Group by parent (features/initiatives)
              const topLevel = items.filter(i => !i.partOf || !items.find(p => p.id === i.partOf));
              
              for (const item of topLevel) {
                lines.push(formatWorkItem(item, item.id === binding?.taskId));
                
                // Show children if depth > 0
                if (depth > 0) {
                  const children = items.filter(i => i.partOf === item.id);
                  for (const child of children) {
                    lines.push(`  ${formatWorkItem(child, child.id === binding?.taskId)}`);
                  }
                }
              }

              results.push(lines.join("\n"));
            } catch (err) {
              results.push(`## ${domain}\nError: ${err instanceof Error ? err.message : err}`);
            }
          }

          if (results.length === 0) {
            return {
              content: [{ type: "text", text: "No work items found matching query." }],
            };
          }

          return {
            content: [{ type: "text", text: results.join("\n\n") }],
          };
        },
      }),

      // ─── task_create ─────────────────────────────────────────────────────
      defineTool({
        name: "task_create",
        description:
          "Create a new work item. Tasks/issues/spikes default to the bound task's feature if partOf is not specified. " +
          "PARENT MUST BE IN THE SAME DOMAIN as the new item — a task in one domain cannot sit under a feature in another. " +
          "If no fitting feature exists in that domain, OMIT partOf and the item lands in the domain's Inbox. " +
          "Pick domain by SUBJECT: a code change to a skill belongs to the domain that owns the code, even if the skill is about something else.",
        parameters: Type.Object({
          kind: Type.String({ description: "Type: initiative, feature, task, issue, spike" }),
          domain: Type.String({ description: `Domain: ${formatDomainChoices(listSubscribedDomains())}` }),
          title: Type.String({ description: "Short title" }),
          partOf: Type.Optional(Type.String({ description: "Parent work item ID" })),
          successCriteria: Type.Optional(Type.String({ description: "Done condition (required for tasks)" })),
          standing: Type.Optional(Type.Boolean({ description: "Initiatives only: never completes; it keeps gaining features (e.g. a new week each week)" })),
          bind: Type.Optional(Type.Boolean({ description: "Bind the new item (task/issue/spike) so what you learn goes to its Record. Default: true when nothing is bound and the item is assigned to you, else false." })),
        }),
        async execute(args: {
          kind: string;
          domain: string;
          title: string;
          partOf?: string;
          successCriteria?: string;
          standing?: boolean;
          bind?: boolean;
        }, ctx: ToolContext): Promise<ToolResult> {
          if (!domains.includes(args.domain)) {
            return {
              content: [{ type: "text", text: `Not subscribed to domain: ${args.domain}` }],
              isError: true,
            };
          }

          // Default partOf to bound task's workspace (its feature) for tasks/issues/spikes.
          let partOf = args.partOf;
          if (!partOf && ["task", "issue", "spike"].includes(args.kind)) {
            const binding = await readBinding(ctx.wolfDen);
            if (binding) {
              const boundTask = await findItem(binding.taskId);
              if (boundTask?.item.partOf) {
                partOf = boundTask.item.partOf;
              }
            }
          }

          // Cross-domain guard: parent must be in the same domain as the new
          // item. The server enforces this (placementError), but failing fast
          // here gives a clearer error AND prevents the bound-feature default
          // from silently misparenting a task under a feature in another domain.
          if (partOf) {
            const parent = await findItem(partOf);
            if (parent && parent.item.domain !== args.domain) {
              return {
                content: [{
                  type: "text",
                  text:
                    `Parent ${partOf} is in domain '${parent.item.domain}', not '${args.domain}'. ` +
                    `A task must sit under a feature in the SAME domain. ` +
                    `Either change the new item's domain to '${parent.item.domain}', pick a feature in '${args.domain}', or omit partOf to land in the '${args.domain}' Inbox.`,
                }],
                isError: true,
              };
            }
          }
          
          try {
            const input: CreateWorkInput = {
              kind: args.kind as WorkItemKind,
              domain: args.domain,
              title: args.title,
              partOf: partOf || undefined,
              successCriteria: args.successCriteria,
              standing: args.standing,
              assignee: ctx.wolfName,
            };
            
            const result = await client.create(input);

            let reply = `Created: [${result.item.id}] ${result.item.title}\nKind: ${result.item.kind}\nStage: ${result.item.stage}`;
            // One at a time, reading the binding file inside: parallel creates see each other's binding.
            reply += await bindSerial(async () => {
              const bindInput = { kind: args.kind, assignee: input.assignee, wolf: ctx.wolfName, bound: !!(await readBinding(ctx.wolfDen)), bind: args.bind };
              if (isSubagent()) return ""; // a subagent never binds
              if (!shouldBindOnCreate(bindInput)) return `\nNot bound: ${notBoundReason(bindInput)}.`;
              await writeBinding(ctx.wolfDen, result.item.id, args.domain, await recordFeatureId(client, result.item));
              await writeCache(result.item);
              await syncFeatureStage(client, result.item).catch(() => {});
              return "\nBound to it.";
            });
            return { content: [{ type: "text", text: reply }] };
          } catch (err) {
            return {
              content: [{ type: "text", text: `Failed to create: ${err instanceof Error ? err.message : err}` }],
              isError: true,
            };
          }
        },
      }),

      // ─── task_note ───────────────────────────────────────────────────────
      defineTool({
        name: "task_note",
        description: "Add a progress note to the active task." + ID_NOTE,
        parameters: Type.Object({
          text: Type.String({ description: "Progress note content" }),
          id: Type.Optional(Type.String({ description: "Work item to note (default: the bound one)" })),
        }),
        async execute(args: { text: string; id?: string }, ctx: ToolContext): Promise<ToolResult> {
          const binding = await readBinding(ctx.wolfDen);
          const target = args.id ?? binding?.taskId;
          if (!target) {
            return {
              content: [{ type: "text", text: "No task bound. Use task_bind first." }],
              isError: true,
            };
          }

          try {
            const noted = await client.note(target, args.text);
            await syncFeatureStage(client, noted).catch(() => {});
            return {
              content: [{ type: "text", text: heads(`Note added to ${target}.`, { id: target, title: noted.title }, boundRef(binding)) }],
            };
          } catch (err) {
            return {
              content: [{ type: "text", text: `Failed: ${err instanceof Error ? err.message : err}` }],
              isError: true,
            };
          }
        },
      }),

      // ─── task_update ─────────────────────────────────────────────────────
      defineTool({
        name: "task_update",
        description: "Update the active work item's working document (plan, notes, findings). Replaces the body of the .md file." + ID_NOTE,
        parameters: Type.Object({
          body: Type.String({ description: "The full updated markdown body (everything below frontmatter)" }),
          id: Type.Optional(Type.String({ description: "Work item to update (default: the bound one)" })),
        }),
        async execute(args: { body: string; id?: string }, ctx: ToolContext): Promise<ToolResult> {
          const binding = await readBinding(ctx.wolfDen);
          const target = args.id ?? binding?.taskId;
          if (!target) {
            return {
              content: [{ type: "text", text: "No task bound. Use task_bind first." }],
              isError: true,
            };
          }

          const found = await findItem(target);
          if (!found) {
            return {
              content: [{ type: "text", text: `Task ${target} not found.` }],
              isError: true,
            };
          }

          try {
            // The Record belongs to memory: whatever the agent writes, the
            // item's current Record section stays as it is.
            const { body: current } = await client.getWithBody(found.item.id);
            const record = extractRecord(current ?? "");
            await client.updateBody(found.item.id, record ? replaceRecordSection(args.body, record) : args.body);
            if (found.item.id === binding?.taskId) await writeCache(found.item);
            return {
              content: [{ type: "text", text: heads(`Updated working document for: ${found.item.title}`, { id: found.item.id, title: found.item.title }, boundRef(binding)) }],
            };
          } catch (err) {
            return {
              content: [{ type: "text", text: `Failed: ${err instanceof Error ? err.message : err}` }],
              isError: true,
            };
          }
        },
      }),

      // ─── task_stage ──────────────────────────────────────────────────────
      defineTool({
        name: "task_stage",
        description:
          "Advance the active task to a new stage. Moving an item to in_build binds it when nothing is bound." + ID_NOTE,
        parameters: Type.Object({
          to: Type.String({ description: "Target stage: idea, plan, feasibility, approved, in_build, shipped, live, archived" }),
          id: Type.Optional(Type.String({ description: "Work item to move (default: the bound one)" })),
        }),
        async execute(args: { to: string; id?: string }, ctx: ToolContext): Promise<ToolResult> {
          let binding = await readBinding(ctx.wolfDen);
          const target = args.id ?? binding?.taskId;
          if (!target) {
            return {
              content: [{ type: "text", text: "No task bound. Use task_bind first." }],
              isError: true,
            };
          }

          try {
            const moved = args.to === "shipped" ? await ship(target) : await client.stage(target, args.to);
            if (moved.stage === "in_build") await syncFeatureStage(client, moved).catch(() => {});
            let reply = `${target} → ${args.to}`;
            if (moved.stage === "in_build" && !binding && !isSubagent() && ["task", "issue", "spike"].includes(moved.kind)) {
              await writeBinding(ctx.wolfDen, moved.id, moved.domain as string, await recordFeatureId(client, moved));
              await writeCache(moved);
              binding = await readBinding(ctx.wolfDen);
              reply += "\nNothing was bound, so it is bound now: what you learn goes to its Record.";
            }
            return {
              content: [{ type: "text", text: heads(reply, { id: target, title: moved.title }, boundRef(binding)) }],
            };
          } catch (err) {
            return {
              content: [{ type: "text", text: `Failed: ${err instanceof Error ? err.message : err}` }],
              isError: true,
            };
          }
        },
      }),

      // ─── task_done ───────────────────────────────────────────────────────
      defineTool({
        name: "task_done",
        description: "Ship the active task and optionally bind to the next unfinished sibling." + ID_NOTE + " Shipping another item leaves your binding as it is.",
        parameters: Type.Object({
          confirm: Type.Optional(Type.Boolean({ description: "Override auto-ship policy" })),
          bindNext: Type.Optional(Type.Boolean({ description: "Auto-bind to next unfinished sibling (default: true)" })),
          id: Type.Optional(Type.String({ description: "Work item to ship (default: the bound one)" })),
        }),
        async execute(args: { confirm?: boolean; bindNext?: boolean; id?: string }, ctx: ToolContext): Promise<ToolResult> {
          const binding = await readBinding(ctx.wolfDen);
          if (args.id && args.id !== binding?.taskId) {
            if (args.confirm ?? !autoShip) {
              return { content: [{ type: "text", text: `Confirmation required to ship ${args.id}. Call task_done again with confirm: false to ship.` }] };
            }
            try {
              const shippedOther = await ship(args.id);
              return {
                content: [{ type: "text", text: heads(`Shipped: ${args.id}`, { id: args.id, title: shippedOther.title }, boundRef(binding)) }],
              };
            } catch (err) {
              return { content: [{ type: "text", text: `Failed: ${err instanceof Error ? err.message : err}` }], isError: true };
            }
          }
          if (!binding) {
            return {
              content: [{ type: "text", text: "No task bound. Use task_bind first." }],
              isError: true,
            };
          }

          // Bound to a finished feature: nothing to ship, it waits for graduation.
          if (binding.featureId === binding.taskId) {
            return {
              content: [{ type: "text", text: `Bound to the feature ${binding.taskId}, not to a task. It is ready to graduate when all its tasks are done: use task_graduate.` }],
              isError: true,
            };
          }

          const shouldConfirm = args.confirm ?? !autoShip;
          
          // If confirmation needed, return message
          if (shouldConfirm) {
            return {
              content: [{
                type: "text",
                text: `Confirmation required to ship ${binding.taskId}. Call task_done again with confirm: false to ship.`,
              }],
            };
          }

          
          
          try {
            // Ship the task
            await ship(binding.taskId);
            
            const found = await findItem(binding.taskId);
            const result: string[] = [`Shipped: ${binding.taskId}`];

            // Find next sibling if requested; with none left, stay on the finished
            // feature (or on the finished loose task) until it is graduated.
            const bindNext = args.bindNext ?? true;
            const all = await client.query({ domain: binding.domain });
            const parentItem = found?.item.partOf ? all.find((i) => i.id === found.item.partOf) : undefined;
            const realFeature = parentItem && parentItem.kind === "feature" && !parentItem.container ? parentItem : undefined;
            const shippedItem = await client.get(binding.taskId);
            if (!realFeature) {
              if (readyToGraduate(shippedItem, all)) {
                await writeCache(shippedItem);
                result.push(`🎓 "${shippedItem.title}" is done and ready to graduate on its own (task_graduate previews it; the user decides). Tell the user.`);
                result.push(readyBoundReply(shippedItem));
              } else {
                await clearBinding(ctx.wolfDen);
                clearCache();
              }
            } else {
              const siblings = bindNext ? await getChildren(binding.domain, realFeature.id as string) : [];
              const next = siblings.find(s => s.id !== binding.taskId && !isComplete(s));
              if (next) {
                await writeBinding(ctx.wolfDen, next.id, binding.domain, await recordFeatureId(client, next));
                await writeCache(next);
                await syncFeatureStage(client, next).catch(() => {});
                result.push(`Bound to next: [${next.id}] ${next.title}`);
              } else if (readyToGraduate(realFeature, all)) {
                await writeBinding(ctx.wolfDen, realFeature.id as string, binding.domain, realFeature.id as string);
                await writeCache(realFeature);
                result.push(`🎓 All tasks under "${realFeature.title}" are done: it is ready to graduate (task_graduate previews it; the user decides). Tell the user.`);
                result.push(readyBoundReply(realFeature));
              } else {
                await clearBinding(ctx.wolfDen);
                clearCache();
                result.push("No more tasks in this feature. Unbound.");
              }
            }

            return {
              content: [{ type: "text", text: result.join("\n") }],
            };
          } catch (err) {
            return {
              content: [{ type: "text", text: `Failed: ${err instanceof Error ? err.message : err}` }],
              isError: true,
            };
          }
        },
      }),

      // ─── task_schedule ───────────────────────────────────────────────────
      defineTool({
        name: "task_schedule",
        description:
          "Pin a task to a calendar slot. scheduledFor is 'YYYY-MM-DD HH:MM' " +
          "(local time). durationMinutes defaults to 60 when omitted. Pass " +
          "scheduledFor='' or clear=true to unschedule. Uses the active task " +
          "if no id provided.",
        parameters: Type.Object({
          scheduledFor: Type.Optional(
            Type.String({ description: "YYYY-MM-DD HH:MM local time. Empty string unschedules." })
          ),
          durationMinutes: Type.Optional(
            Type.Number({ description: "Block length in minutes (default 60)" })
          ),
          clear: Type.Optional(
            Type.Boolean({ description: "Unschedule the task (clears both fields)" })
          ),
          id: Type.Optional(
            Type.String({ description: "Work item ID (defaults to active task)" })
          ),
        }),
        async execute(
          args: { scheduledFor?: string; durationMinutes?: number; clear?: boolean; id?: string },
          ctx: ToolContext
        ): Promise<ToolResult> {
          let targetId = args.id;
          if (!targetId) {
            const binding = await readBinding(ctx.wolfDen);
            if (!binding) {
              return {
                content: [{ type: "text", text: "No active task and no id provided." }],
                isError: true,
              };
            }
            targetId = binding.taskId;
          }

          const unscheduling = args.clear === true || args.scheduledFor === "";
          const sched = unscheduling ? null : (args.scheduledFor ?? null);
          if (!unscheduling && !sched) {
            return {
              content: [{ type: "text", text: "Provide scheduledFor='YYYY-MM-DD HH:MM' or clear=true." }],
              isError: true,
            };
          }
          if (sched && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(sched)) {
            return {
              content: [{ type: "text", text: `scheduledFor must be 'YYYY-MM-DD HH:MM', got '${sched}'.` }],
              isError: true,
            };
          }

          try {
            const item = await client.schedule(targetId, sched, args.durationMinutes ?? null);
            if (unscheduling) {
              return { content: [{ type: "text", text: `${targetId} unscheduled.` }] };
            }
            const mins = (item as any).durationMinutes ?? args.durationMinutes ?? 60;
            return {
              content: [{
                type: "text",
                text: `${targetId} scheduled for ${sched} (${mins} min)`,
              }],
            };
          } catch (err) {
            return {
              content: [{ type: "text", text: `Failed: ${err instanceof Error ? err.message : err}` }],
              isError: true,
            };
          }
        },
      }),

      // ─── task_link ───────────────────────────────────────────────────────
      defineTool({
        name: "task_link",
        description: "Add a dependency link between work items. Uses the active task if no id provided.",
        parameters: Type.Object({
          rel: Type.String({ description: "Relation: depends_on or blocks" }),
          target: Type.String({ description: "Target work item ID" }),
          id: Type.Optional(Type.String({ description: "Source work item ID (defaults to active task)" })),
        }),
        async execute(args: { rel: string; target: string; id?: string }, ctx: ToolContext): Promise<ToolResult> {
          let sourceId = args.id;
          let domain: string | undefined;

          if (!sourceId) {
            const binding = await readBinding(ctx.wolfDen);
            if (!binding) {
              return {
                content: [{ type: "text", text: "No active task and no id provided." }],
                isError: true,
              };
            }
            sourceId = binding.taskId;
            domain = binding.domain;
          }

          if (!domain) {
            const match = sourceId.match(/^work-(\w+)-/);
            domain = match?.[1];
          }
          if (!domain) {
            return { content: [{ type: "text", text: "Cannot determine domain from item ID." }], isError: true };
          }

          
          
          try {
            await client.link(sourceId, args.rel, args.target);
            return {
              content: [{ type: "text", text: `${sourceId} ${args.rel} ${args.target}` }],
            };
          } catch (err) {
            return {
              content: [{ type: "text", text: `Failed: ${err instanceof Error ? err.message : err}` }],
              isError: true,
            };
          }
        },
      }),

      // ─── task_unlink ─────────────────────────────────────────────────────
      defineTool({
        name: "task_unlink",
        description: "Remove a dependency link between work items. Uses the active task if no id provided.",
        parameters: Type.Object({
          rel: Type.String({ description: "Relation: depends_on or blocks" }),
          target: Type.String({ description: "Target work item ID" }),
          id: Type.Optional(Type.String({ description: "Source work item ID (defaults to active task)" })),
        }),
        async execute(args: { rel: string; target: string; id?: string }, ctx: ToolContext): Promise<ToolResult> {
          let sourceId = args.id;
          let domain: string | undefined;

          if (!sourceId) {
            const binding = await readBinding(ctx.wolfDen);
            if (!binding) {
              return {
                content: [{ type: "text", text: "No active task and no id provided." }],
                isError: true,
              };
            }
            sourceId = binding.taskId;
            domain = binding.domain;
          }

          if (!domain) {
            const match = sourceId.match(/^work-(\w+)-/);
            domain = match?.[1];
          }
          if (!domain) {
            return { content: [{ type: "text", text: "Cannot determine domain from item ID." }], isError: true };
          }

          
          
          try {
            await client.unlink(sourceId, args.rel, args.target);
            return {
              content: [{ type: "text", text: `Removed: ${sourceId} ${args.rel} ${args.target}` }],
            };
          } catch (err) {
            return {
              content: [{ type: "text", text: `Failed: ${err instanceof Error ? err.message : err}` }],
              isError: true,
            };
          }
        },
      }),

      // ─── task_move ───────────────────────────────────────────────────────
      defineTool({
        name: "task_move",
        description: "Move the active task under a different parent.",
        parameters: Type.Object({
          to: Type.String({ description: "New parent ID, 'inbox', or 'none'" }),
        }),
        async execute(args: { to: string }, ctx: ToolContext): Promise<ToolResult> {
          const binding = await readBinding(ctx.wolfDen);
          if (!binding) {
            return {
              content: [{ type: "text", text: "No task bound. Use task_bind first." }],
              isError: true,
            };
          }

          
          
          try {
            const newParent = args.to === "none" ? null : args.to;
            await client.move(binding.taskId, newParent);
            return {
              content: [{ type: "text", text: `Moved ${binding.taskId} to ${args.to}` }],
            };
          } catch (err) {
            return {
              content: [{ type: "text", text: `Failed: ${err instanceof Error ? err.message : err}` }],
              isError: true,
            };
          }
        },
      }),

      // ─── task_graduate ───────────────────────────────────────────────────
      defineTool({
        name: "task_graduate",
        description:
          "Graduate a finished work item into the knowledge base, in two steps. " +
          "Step 1: task_graduate(id) distills the item and returns a PREVIEW (what would be sent to the KB) and a confirmation token. Nothing is sent. " +
          "Show the preview to the owner and ask whether to send it. " +
          "Step 2, ONLY after the owner has said yes in this conversation: task_graduate(id, confirm=<token>). " +
          "Never confirm on your own. Eligible: a feature whose tasks are all done, a loose Inbox task, an initiative whose features have all graduated.",
        parameters: Type.Object({
          id: Type.String({ description: "Work item to graduate" }),
          confirm: Type.Optional(Type.String({ description: "The token from the preview, once the owner approved it" })),
        }),
        async execute(args: { id: string; confirm?: string }, ctx: ToolContext): Promise<ToolResult> {
          const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });
          const roots = graduationRoots();
          if (!roots) return fail("The knowledge base is not configured for this wolf (KB_BASE / KB_OPS).");
          try {
            if (!args.confirm) {
              const preview = await previewGraduation({ client, engine: graduationEngine(), id: args.id, roots });
              await mkdir(previewDir(), { recursive: true });
              await writeFile(previewFile(preview.token), JSON.stringify(preview));
              const text = renderGraduationPreview(preview);
              return {
                content: [{
                  type: "text",
                  text: preview.blocked
                    ? `${text}\n\nNothing can be sent from this preview. Tell the owner and try again later.`
                    : `${text}\n\nNOTHING HAS BEEN SENT. Ask the owner whether to send this. If they say yes, call task_graduate with id ${args.id} and confirm "${preview.token}".`,
                }],
              };
            }

            const file = previewFile(args.confirm);
            if (!existsSync(file)) return fail("No such preview (or it was already used). Call task_graduate(id) again to get a fresh preview.");
            const preview = JSON.parse(await readFile(file, "utf-8")) as GraduationPreview;
            if (preview.itemId !== args.id) return fail(`That token is for ${preview.itemId}, not ${args.id}.`);
            if (Date.now() - Date.parse(preview.createdAt) > PREVIEW_TTL_MS) {
              return fail("That preview is too old. Call task_graduate(id) again for a fresh one and ask the owner again.");
            }
            const done = await confirmGraduation({ client, roots, wolf: wolfName, preview, ship });
            await unlink(file).catch(() => { /* used once */ });

            const binding = await readBinding(ctx.wolfDen);
            if (binding && done.archived.includes(binding.taskId)) {
              await clearBinding(ctx.wolfDen);
              clearCache();
            }
            const result = [`Graduated "${preview.title}": ${done.sent.length} contribution(s) sent to Dewey; ${done.archived.length} item(s) archived.`];
            try {
              const all = await client.query({ domain: preview.domain });
              const item = all.find((i) => i.id === args.id);
              const parent = item ? initiativeOf(item, all) : undefined;
              if (readyToGraduate(parent, all)) result.push(`🎓 All features of "${parent.title}" have graduated: it can be completed too. Tell the user.`);
            } catch { /* advisory */ }
            return { content: [{ type: "text", text: result.join("\n") }] };
          } catch (err) {
            return fail(`Graduation failed: ${err instanceof Error ? err.message : err}`);
          }
        },
      }),

      // ─── task_features ───────────────────────────────────────────────────
      defineTool({
        name: "task_features",
        description: "List open features in a domain. Useful for showing parent options when creating tasks.",
        parameters: Type.Object({
          domain: Type.String({ description: "Domain to list features from" }),
        }),
        async execute(args: { domain: string }): Promise<ToolResult> {
          if (!domains.includes(args.domain)) {
            return {
              content: [{ type: "text", text: `Not subscribed to domain: ${args.domain}` }],
              isError: true,
            };
          }

          const items = await getItems(args.domain);
          const features = items.filter(i => 
            i.kind === "feature" && 
            !isComplete(i)
          );

          if (features.length === 0) {
            return {
              content: [{ type: "text", text: "No open features. Tasks will go to Inbox." }],
            };
          }

          const lines = features.map(f => `${f.id} | ${f.title}`);
          return {
            content: [{ type: "text", text: `Open features:\n${lines.join("\n")}` }],
          };
        },
      }),
    ],
  });
}
