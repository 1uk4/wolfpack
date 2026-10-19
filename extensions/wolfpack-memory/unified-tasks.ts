/**
 * Wolfpack Tasks Extension — Unified Implementation (Pi-Durable)
 * 
 * Work system tools for agent-managed task workflows.
 * Uses @wolfpack/kb/client for work operations.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
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
import { WorkClient } from "./work-client.js";

type WorkItemKind = "initiative" | "feature" | "task" | "issue" | "spike";
type WorkItemStage = typeof STAGE_ORDER[number];

// ─── Types ─────────────────────────────────────────────────────────────────

export interface TasksConfig {
  /** Auto-ship tasks without confirmation (default: true for agent-managed) */
  autoShip?: boolean;
}

interface ActiveBinding {
  taskId: string;
  domain: string;
  boundAt: string;
}

// ─── Binding State ─────────────────────────────────────────────────────────

function bindingPath(wolfDen: string): string {
  return join(wolfDen, "tasks", "active.json");
}

async function readBinding(wolfDen: string): Promise<ActiveBinding | null> {
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

async function writeBinding(wolfDen: string, taskId: string, domain: string): Promise<void> {
  const path = bindingPath(wolfDen);
  await mkdir(dirname(path), { recursive: true });
  const binding: ActiveBinding = {
    taskId,
    domain,
    boundAt: new Date().toISOString(),
  };
  await writeFile(path, JSON.stringify(binding, null, 2));
}

async function clearBinding(wolfDen: string): Promise<void> {
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
    if (task.partOf) {
      try {
        parent = await client.get(task.partOf as string);
        siblings = await client.query({ domain: task.domain as string, partOf: task.partOf as string });
      } catch { /* best effort */ }
    }
    await writeFile(cachePath(), JSON.stringify({ task, parent, siblings }));
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

  return defineExtension({
    name: "wolfpack-tasks",
    runtimes: ["pi-durable"],

    sections: [
      // Task tools instructions
      section("task_tools", () => {
        const domainList = domains.join(", ") || "(none configured)";
        return `## Task Tools

Available: task_query, task_bind, task_create, task_done, task_note, task_stage, task_features

Domains: ${domainList}`;
      }),

      // Active task section — shows current binding with feature context
      section("active_task", () => {
        try {
          const bp = bindingPath(wolfDen);
          if (!existsSync(bp)) {
            return `## Active Task\n\nNo task bound. Use \`task_query\` to see available work, then \`task_bind\` to start.`;
          }

          const binding = JSON.parse(require("fs").readFileSync(bp, "utf-8")) as ActiveBinding | null;
          if (!binding?.taskId) {
            return `## Active Task\n\nNo task bound. Use \`task_query\` to see available work, then \`task_bind\` to start.`;
          }

          const cached = readCache();
          if (!cached) {
            return `## Active Task\n\nBound to ${binding.taskId} (loading...). Use \`task_query\` to refresh.`;
          }

          const { task, parent, siblings } = cached;
          const lines: string[] = ["## Active Task", ""];

          if (parent && (parent.kind === "feature" || parent.kind === "initiative") && siblings) {
            lines.push(formatHierarchy(parent, siblings, task.id));
          } else {
            lines.push(`**Task:** [${task.id}] ${task.title}`);
            lines.push(`  Stage: ${task.stage}`);
          }

          if (task.successCriteria) {
            lines.push("");
            lines.push(`**Success Criteria:** ${task.successCriteria}`);
          }

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
        description: "Bind to a task to start working on it. The task will appear in your context.",
        parameters: Type.Object({
          id: Type.String({ description: "Work item ID to bind to" }),
        }),
        async execute(args: { id: string }, ctx: ToolContext): Promise<ToolResult> {
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

          await writeBinding(ctx.wolfDen, item.id, domain);
          await writeCache(item);

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
        description: "Create a new work item. Tasks/issues/spikes default to the bound task's feature if partOf is not specified.",
        parameters: Type.Object({
          kind: Type.String({ description: "Type: initiative, feature, task, issue, spike" }),
          domain: Type.String({ description: "Domain for the work item" }),
          title: Type.String({ description: "Short title" }),
          partOf: Type.Optional(Type.String({ description: "Parent work item ID" })),
          successCriteria: Type.Optional(Type.String({ description: "Done condition (required for tasks)" })),
        }),
        async execute(args: {
          kind: string;
          domain: string;
          title: string;
          partOf?: string;
          successCriteria?: string;
        }, ctx: ToolContext): Promise<ToolResult> {
          if (!domains.includes(args.domain)) {
            return {
              content: [{ type: "text", text: `Not subscribed to domain: ${args.domain}` }],
              isError: true,
            };
          }

          
          
          // Default partOf to bound task's workspace (its feature) for tasks/issues/spikes
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
          
          try {
            const input: CreateWorkInput = {
              kind: args.kind as WorkItemKind,
              domain: args.domain,
              title: args.title,
              partOf: partOf || undefined,
              successCriteria: args.successCriteria,
              assignee: ctx.wolfName,
            };
            
            const result = await client.create(input);

            return {
              content: [{
                type: "text",
                text: `Created: [${result.item.id}] ${result.item.title}\nKind: ${result.item.kind}\nStage: ${result.item.stage}`,
              }],
            };
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
        description: "Add a progress note to the active task.",
        parameters: Type.Object({
          text: Type.String({ description: "Progress note content" }),
        }),
        async execute(args: { text: string }, ctx: ToolContext): Promise<ToolResult> {
          const binding = await readBinding(ctx.wolfDen);
          if (!binding) {
            return {
              content: [{ type: "text", text: "No task bound. Use task_bind first." }],
              isError: true,
            };
          }

          
          
          try {
            await client.note(binding.taskId, args.text);
            return {
              content: [{ type: "text", text: `Note added to ${binding.taskId}.` }],
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
        description: "Update the active work item's working document (plan, notes, findings). Replaces the body of the .md file.",
        parameters: Type.Object({
          body: Type.String({ description: "The full updated markdown body (everything below frontmatter)" }),
        }),
        async execute(args: { body: string }, ctx: ToolContext): Promise<ToolResult> {
          const binding = await readBinding(ctx.wolfDen);
          if (!binding) {
            return {
              content: [{ type: "text", text: "No task bound. Use task_bind first." }],
              isError: true,
            };
          }

          const found = await findItem(binding.taskId);
          if (!found) {
            return {
              content: [{ type: "text", text: `Task ${binding.taskId} not found.` }],
              isError: true,
            };
          }

          
          
          try {
            await client.updateBody(found.item.id, args.body);
            await writeCache(found.item);
            return {
              content: [{ type: "text", text: `Updated working document for: ${found.item.title}` }],
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
        description: "Advance the active task to a new stage.",
        parameters: Type.Object({
          to: Type.String({ description: "Target stage: idea, plan, feasibility, approved, in_build, shipped, live, archived" }),
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
            await client.stage(binding.taskId, args.to);
            return {
              content: [{ type: "text", text: `${binding.taskId} → ${args.to}` }],
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
        description: "Ship the active task and optionally bind to the next unfinished sibling.",
        parameters: Type.Object({
          confirm: Type.Optional(Type.Boolean({ description: "Override auto-ship policy" })),
          bindNext: Type.Optional(Type.Boolean({ description: "Auto-bind to next unfinished sibling (default: true)" })),
        }),
        async execute(args: { confirm?: boolean; bindNext?: boolean }, ctx: ToolContext): Promise<ToolResult> {
          const binding = await readBinding(ctx.wolfDen);
          if (!binding) {
            return {
              content: [{ type: "text", text: "No task bound. Use task_bind first." }],
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
            await client.stage(binding.taskId, "shipped");
            
            const found = await findItem(binding.taskId);
            const result: string[] = [`Shipped: ${binding.taskId}`];
            
            // Find next sibling if requested
            const bindNext = args.bindNext ?? true;
            if (bindNext && found?.item.partOf) {
              const siblings = await getChildren(binding.domain, found.item.partOf);
              const next = siblings.find(s => 
                s.id !== binding.taskId && 
                !isComplete(s)
              );
              
              if (next) {
                await writeBinding(ctx.wolfDen, next.id, binding.domain);
                result.push(`Bound to next: [${next.id}] ${next.title}`);
              } else {
                await clearBinding(ctx.wolfDen);
                result.push("No more tasks in this feature. Unbound.");
              }
            } else {
              await clearBinding(ctx.wolfDen);
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
