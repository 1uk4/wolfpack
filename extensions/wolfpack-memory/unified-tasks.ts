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
  createWork,
  stageWork,
  noteWork,
  linkWork,
  unlinkWork,
  moveWork,
  listWorkItems,
  resolveWorkItem,
  commitWorkItem,
  type WorkItem,
  type CreateWorkInput,
  STAGE_ORDER,
  isComplete,
} from "@wolfpack/kb/client";
import type { KbRoots } from "@wolfpack/kb/shared";

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

function buildKbRoots(domain: string): KbRoots {
  const kbBase = process.env.KB_BASE;
  const kbOps = process.env.KB_OPS;
  const wolfDen = process.env.WOLF_DEN;
  
  if (!kbOps) throw new Error("KB_OPS not set");
  
  return {
    kbBase: kbBase ?? "",
    opsRoot: kbOps,
    denLocal: wolfDen ? join(wolfDen, "kb") : "",
  };
}

// ─── Extension Factory ─────────────────────────────────────────────────────

export default function createTasksExtension(
  config: TasksConfig,
  context: ExtensionContext
): ReturnType<typeof defineExtension> {
  const { wolfDen, wolfName, domains } = context;
  const autoShip = config.autoShip ?? true;

  // Helper to get all items for a domain (reads from KB markdown files)
  function getItems(domain: string): WorkItem[] {
    const roots = buildKbRoots(domain);
    const ids = listWorkItems(roots, domain);
    const items: WorkItem[] = [];
    for (const id of ids) {
      const resolved = resolveWorkItem(roots, domain, id);
      if (resolved?.item) items.push(resolved.item);
    }
    return items;
  }

  // Helper to find item across subscribed domains
  function findItem(id: string): { item: WorkItem; domain: string } | null {
    for (const domain of domains) {
      try {
        const items = getItems(domain);
        const item = items.find(i => i.id === id);
        if (item) return { item, domain };
      } catch {
        continue;
      }
    }
    return null;
  }

  // Helper to get children of an item
  function getChildren(domain: string, parentId: string): WorkItem[] {
    const items = getItems(domain);
    return items.filter(item => item.partOf === parentId);
  }

  // Helper to get parent of an item
  function getParent(domain: string, item: WorkItem): WorkItem | null {
    if (!item.partOf) return null;
    const items = getItems(domain);
    return items.find(i => i.id === item.partOf) ?? null;
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
      section("active_task", (ctx) => {
        try {
          // Synchronous read for section (sections should be fast)
          const path = bindingPath(ctx.wolfDen);
          if (!existsSync(path)) {
            return `## Active Task\n\nNo task bound. Use \`task_query\` to see available work, then \`task_bind\` to start.`;
          }
          
          const content = require("fs").readFileSync(path, "utf-8");
          const binding = JSON.parse(content) as ActiveBinding | null;
          
          if (!binding || !binding.taskId) {
            return `## Active Task\n\nNo task bound. Use \`task_query\` to see available work, then \`task_bind\` to start.`;
          }

          const found = findItem(binding.taskId);
          if (!found) {
            return `## Active Task\n\nBound task ${binding.taskId} not found. Use \`task_unbind\` then \`task_bind\` to select a new task.`;
          }

          const { item: task, domain } = found;
          const lines: string[] = ["## Active Task", ""];
          
          // Get parent feature if exists
          if (task.partOf) {
            const parent = getParent(domain, task);
            if (parent && (parent.kind === "feature" || parent.kind === "initiative")) {
              const siblings = getChildren(domain, parent.id);
              lines.push(formatHierarchy(parent, siblings, task.id));
            }
          } else {
            // Task is standalone
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
          const found = findItem(args.id);
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

          const found = findItem(binding.taskId);
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
              const roots = buildKbRoots(domain);
              
              // Specific item lookup
              if (args.id) {
                const found = findItem(args.id);
                if (!found || found.domain !== domain) continue;
                
                const item = found.item;
                const lines: string[] = [`## ${domain}`, ""];
                
                // Get parent context
                if (item.partOf) {
                  const parent = getParent(domain, item);
                  if (parent) {
                    lines.push(`Parent: ${formatWorkItem(parent)}`);
                    lines.push("");
                  }
                }
                
                lines.push(`${formatWorkItem(item, item.id === binding?.taskId)}`);
                
                // Get children
                if (depth > 0) {
                  const children = getChildren(domain, item.id);
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

              // General query - read from KB markdown files
              let items = getItems(domain);
              
              // Apply filters
              if (args.kind) items = items.filter(i => i.kind === args.kind);
              if (args.stage) items = items.filter(i => i.stage === args.stage);

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

          const roots = buildKbRoots(args.domain);
          
          // Default partOf to bound task's workspace (its feature) for tasks/issues/spikes
          let partOf = args.partOf;
          if (!partOf && ["task", "issue", "spike"].includes(args.kind)) {
            const binding = await readBinding(ctx.wolfDen);
            if (binding) {
              const boundTask = findItem(binding.taskId);
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
            
            const result = createWork(roots, input);

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

          const roots = buildKbRoots(binding.domain);
          
          try {
            noteWork(roots, binding.taskId, args.text);
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

          const found = findItem(binding.taskId);
          if (!found) {
            return {
              content: [{ type: "text", text: `Task ${binding.taskId} not found.` }],
              isError: true,
            };
          }

          const roots = buildKbRoots(binding.domain);
          
          try {
            commitWorkItem(roots, found.item, args.body);
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

          const roots = buildKbRoots(binding.domain);
          
          try {
            stageWork(roots, binding.taskId, args.to as WorkItemStage);
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

          const roots = buildKbRoots(binding.domain);
          
          try {
            // Ship the task
            stageWork(roots, binding.taskId, "shipped");
            
            const found = findItem(binding.taskId);
            const result: string[] = [`Shipped: ${binding.taskId}`];
            
            // Find next sibling if requested
            const bindNext = args.bindNext ?? true;
            if (bindNext && found?.item.partOf) {
              const siblings = getChildren(binding.domain, found.item.partOf);
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

      // ─── task_link ───────────────────────────────────────────────────────
      defineTool({
        name: "task_link",
        description: "Add a dependency link from the active task to another.",
        parameters: Type.Object({
          rel: Type.String({ description: "Relation: depends_on or blocks" }),
          target: Type.String({ description: "Target work item ID" }),
        }),
        async execute(args: { rel: string; target: string }, ctx: ToolContext): Promise<ToolResult> {
          const binding = await readBinding(ctx.wolfDen);
          if (!binding) {
            return {
              content: [{ type: "text", text: "No task bound. Use task_bind first." }],
              isError: true,
            };
          }

          const roots = buildKbRoots(binding.domain);
          
          try {
            linkWork(roots, binding.taskId, args.rel as "depends_on" | "blocks", args.target);
            return {
              content: [{ type: "text", text: `${binding.taskId} ${args.rel} ${args.target}` }],
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
        description: "Remove a dependency link from the active task.",
        parameters: Type.Object({
          rel: Type.String({ description: "Relation: depends_on or blocks" }),
          target: Type.String({ description: "Target work item ID" }),
        }),
        async execute(args: { rel: string; target: string }, ctx: ToolContext): Promise<ToolResult> {
          const binding = await readBinding(ctx.wolfDen);
          if (!binding) {
            return {
              content: [{ type: "text", text: "No task bound. Use task_bind first." }],
              isError: true,
            };
          }

          const roots = buildKbRoots(binding.domain);
          
          try {
            unlinkWork(roots, binding.taskId, args.rel as "depends_on" | "blocks", args.target);
            return {
              content: [{ type: "text", text: `Removed: ${binding.taskId} ${args.rel} ${args.target}` }],
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

          const roots = buildKbRoots(binding.domain);
          
          try {
            const newParent = args.to === "none" ? null : args.to;
            moveWork(roots, binding.taskId, newParent);
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

          const items = getItems(args.domain);
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
