/**
 * work-system.ts — Work item lifecycle (merged from wolfpack-factory)
 *
 * Visual queue + session binding + agent-callable tools for WorkItems.
 * Shows the active task in a widget below the model line, injects it
 * into the system prompt, and lets both user and agent advance stages.
 *
 * Now integrated with memory for:
 *   - Stage-aware context injection
 *   - File observation during work
 *   - Task completion summarization
 *   - Feature/initiative graduation
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth, Key, matchesKey } from "@earendil-works/pi-tui";
import {
  createWork,
  stageWork,
  noteWork,
  linkWork,
  queryWork,
  getWorkTree,
  loadWorkState,
  commitWorkItem,
  resolveWorkItem,
  deleteWork,
  STAGE_ORDER,
  isComplete,
  isBindable,
  placementError,
  moveWork,
  ensureInbox,
  type CreateWorkInput,
  type WorkQuery,
  type WorkItem,
  type WorkId,
} from "@wolfpack/kb/client";
import type { KbRoots } from "@wolfpack/kb/shared";
import {
  startFileTracking,
  stopFileTracking,
  recordFileChange,
  getFileSession,
  onWorkBound,
  addWorkNote,
  getWorkSession,
  detectTransition,
  extractTransitionContext,
  resolveShipPolicy,
  shouldConfirmShip,
  parentReadyToShip,
  initialState,
  reduce,
  leftRows,
  rightRows,
  firstTask,
  progress,
  isBlocked,
  type SelectorState,
  type SelectorKey,
  type SelectorEffect,
} from "@wolfpack/memory";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Stage display ───────────────────────────────────────────────────────────

const STAGE_COLORS: Record<string, string> = {
  idea: "\x1b[2m",
  plan: "\x1b[36m",
  feasibility: "\x1b[35m",
  approved: "\x1b[34m",
  in_build: "\x1b[33m",
  shipped: "\x1b[32m",
  live: "\x1b[32;1m",
  archived: "\x1b[2m",
};

const STAGE_ICONS: Record<string, string> = {
  idea: "💡",
  plan: "📋",
  feasibility: "🔍",
  approved: "✅",
  in_build: "🔨",
  shipped: "📦",
  live: "🟢",
  archived: "📁",
};

/** "🔨 in_build" — the stage with its symbol. */
const stageLabel = (stage: string) => `${STAGE_ICONS[stage] ?? "○"} ${stage}`;

const KIND_ICONS: Record<string, string> = {
  initiative: "🎯",
  feature: "🧩",
  task: "☑️",
  issue: "🐛",
  spike: "🔬",
  idea: "💡",
};

function kindIcon(item: WorkItem): string {
  // Show 📚 for graduated items
  if (item.graduatedTo && item.graduatedTo.length > 0) return "📚";
  return KIND_ICONS[item.kind] ?? "◇";
}

// ── Domain discovery ────────────────────────────────────────────────────────

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function discoverDomains(roots: KbRoots): string[] {
  const domains = new Set<string>(["personal"]);
  try {
    const domainsRoot = path.join(roots.kbBase, "domains");
    const entries = fs.readdirSync(domainsRoot, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith(".")) {
        domains.add(e.name);
      }
    }
  } catch {
    // KB_BASE not available
  }
  return [...domains];
}

// ── Area discovery ────────────────────────────────────────────────────────

function discoverAreas(roots: KbRoots): string[] {
  const areas = new Set<string>();
  try {
    const state = loadWorkState(roots);
    for (const item of state.values()) {
      if (item.area) areas.add(item.area as string);
    }
  } catch { /* empty */ }
  return [...areas].sort();
}

async function pickArea(ctx: any, roots: KbRoots): Promise<string | undefined> {
  const existing = discoverAreas(roots);
  if (existing.length === 0) {
    const raw = await ctx.ui.input("Area? (e.g. engineering, marketing — optional)");
    return raw ? slugify(raw) : undefined;
  }
  const options = [...existing, "+ New area", "Skip"];
  const choice = await ctx.ui.select("Area?", options);
  if (!choice || choice === "Skip") return undefined;
  if (choice === "+ New area") {
    const raw = await ctx.ui.input("New area name");
    return raw ? slugify(raw) : undefined;
  }
  return choice;
}

// ── Active task persistence ─────────────────────────────────────────────────

interface ActiveTaskState {
  workId: string;
  domain: string;
  boundAt: string;
}

function activeTaskPath(wolfDen: string): string {
  return path.join(wolfDen, "factory", "active-task.json");
}

function readActiveTask(wolfDen: string): ActiveTaskState | null {
  const p = activeTaskPath(wolfDen);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

function writeActiveTask(wolfDen: string, state: ActiveTaskState | null): void {
  const p = activeTaskPath(wolfDen);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (state === null) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
    return;
  }
  fs.writeFileSync(p, JSON.stringify(state, null, 2));
}

// ── Widget rendering ────────────────────────────────────────────────────────

/**
 * The bound-task widget above the editor: two lines.
 *   ● <task title>  plan · <workspace> 3/8
 *     ✓ <done when>
 */
function renderTaskWidget(item: WorkItem, workspace?: { title: string; done: number; total: number }): string[] {
  const stageColor = STAGE_COLORS[item.stage] ?? "";
  const clip = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1) + "…" : t);
  const ws = workspace ? ` \x1b[2m· ${clip(workspace.title, 40)} ${workspace.done}/${workspace.total}\x1b[0m` : "";
  const lines = [`\x1b[36m●\x1b[0m \x1b[1m${item.title}\x1b[0m  ${stageColor}${stageLabel(item.stage)}\x1b[0m${ws}`];
  if (item.successCriteria) lines.push(`  \x1b[2m✓ ${clip(item.successCriteria, 100)}\x1b[0m`);
  return lines;
}

function renderStatusBarCompact(item: WorkItem): string {
  const icon = kindIcon(item);
  const title = item.title.length > 30
    ? item.title.slice(0, 30) + "…"
    : item.title;
  return `${icon} ${title} \x1b[2m${stageLabel(item.stage)}\x1b[0m`;
}

function renderQueueList(items: WorkItem[]): string {
  if (items.length === 0) return "\x1b[2mNo work items found.\x1b[0m";
  const lines: string[] = [];
  for (const item of items) {
    const icon = kindIcon(item);
    const area = item.area ? `\x1b[36m${item.area}\x1b[0m ` : "";
    const criteria = item.kind === "task" && item.successCriteria
      ? `\n     \x1b[2m✓ ${item.successCriteria}\x1b[0m`
      : "";
    lines.push(
      `  ${icon} \x1b[1m${item.title}\x1b[0m \x1b[2m[${item.stage}]\x1b[0m` +
      `\n     ${area}\x1b[2m${item.domain} · ${item.kind} · → ${item.assignee}\x1b[0m` +
      `\n     \x1b[2m${item.id}\x1b[0m` +
      criteria
    );
  }
  return lines.join("\n\n");
}

// ── Extension entry point ───────────────────────────────────────────────────

// ── Wizard: conversational /task new ────────────────────────────────────────

interface WizardResult {
  id: string;
  item: WorkItem;
}

async function wizardNew(
  ctx: any,
  roots: KbRoots,
  wolfName: string,
): Promise<WizardResult | null> {

  // Step 1: What do you want to do?
  const description = await ctx.ui.input("What do you want to do?");
  if (!description) return null;

  // Step 2: Domain
  const domainChoices = discoverDomains(roots);
  const domain = domainChoices.length === 1
    ? domainChoices[0]
    : await ctx.ui.select("Which domain?", domainChoices);
  if (!domain) return null;

  // Step 3: Classify
  const scopeChoice = await ctx.ui.select("What best describes this?", [
    "A one-off action I need to do",
    "Something to investigate or research",
    "A problem or bug to fix",
    "A capability to build",
    "A larger effort with multiple parts",
  ]);
  if (!scopeChoice) return null;

  const kindMap: Record<string, string> = {
    "A one-off action I need to do": "task",
    "Something to investigate or research": "spike",
    "A problem or bug to fix": "issue",
    "A capability to build": "feature",
    "A larger effort with multiple parts": "initiative",
  };
  const kind = kindMap[scopeChoice] ?? "task";

  // Step 4: Title
  const title = await ctx.ui.input("Title", description);
  if (!title) return null;

  // Step 5: Create with a starter body template
  const TEMPLATES: Record<string, string> = {
    task:       `## Plan\n\n${description}\n\n## Done when\n\n_(to be defined)_\n`,
    spike:      `## Question\n\n${description}\n\n## Findings\n\n`,
    issue:      `## Problem\n\n${description}\n\n## Expected behavior\n\n\n## Fix\n\n`,
    feature:    `## Overview\n\n${description}\n\n## Plan\n\n\n## Done when\n\n_(to be defined)_\n`,
    initiative: `## Goal\n\n${description}\n\n## Features\n\n\n## Plan\n\n`,
  };

  const result = createWork(roots, {
    kind: kind as any,
    domain,
    title,
    assignee: wolfName,
  });

  commitWorkItem(roots, result.item, TEMPLATES[kind] ?? "");
  ctx.ui.notify(`Created ${kind}: ${title}`, "info");

  return { id: result.id, item: result.item };
}


/**
 * After binding a task, show its current state and ask if the user wants
 * to iterate. If yes, paste a prompt into the editor so the agent reviews
 * and discusses the plan on the next turn.
 */
async function promptTaskIteration(
  pi: ExtensionAPI,
  ctx: any,
  roots: KbRoots,
  item: WorkItem,
): Promise<void> {
  // Read the working document
  const resolved = resolveWorkItem(roots, item.domain as string, item.id as string);
  const body = resolved?.body?.trim();

  // Build a summary of current state
  const lines: string[] = [];
  lines.push(`Bound: ${item.title} (${item.kind}, ${item.stage})`);
  if (item.successCriteria) lines.push(`Done when: ${item.successCriteria}`);
  if (body) {
    lines.push("");
    // Show first few lines of the working doc
    const preview = body.split("\n").slice(0, 8).join("\n");
    lines.push(preview);
    if (body.split("\n").length > 8) lines.push("...");
  } else {
    lines.push("\nNo plan written yet.");
  }

  ctx.ui.notify(lines.join("\n"), "info");

  const next = await ctx.ui.select("What do you want to do?", [
    "Start working",
    "Review and update the plan",
  ]);
  if (!next) return;

  // Each choice also sets the stage, moving forward only: reviewing the plan of
  // a task that is already being built does not send it back to plan.
  const target = next === "Start working" ? "in_build" : "plan";
  if (STAGE_ORDER.indexOf(item.stage as any) < STAGE_ORDER.indexOf(target as any)) {
    try {
      stageWork(roots, item.id as string, target);
    } catch (e: any) {
      // e.g. a task needs success criteria before it leaves plan
      ctx.ui.notify(`Stayed in ${item.stage}: ${e.message}`, "warning");
    }
  }

  if (next === "Review and update the plan") {
    // Start the review turn right away, rather than leaving a draft to send.
    const review =
      `Review the working document for "${item.title}" (shown in <active_task>). ` +
      `Discuss what should change, then use task_update to write the updated plan.`;
    try {
      pi.sendUserMessage(review);
    } catch {
      // sendUserMessage throws while the agent is busy: fall back to a draft.
      ctx.ui.pasteToEditor(review);
    }
  }
}

// ── Work system initialization ─────────────────────────────────────────────

export interface WorkSystemConfig {
  /** Callback to get stage context for prompt injection */
  getStageContext?: (item: WorkItem) => string;
  /** Callback when task completes (for summarization) */
  onTaskComplete?: (taskId: string, item: WorkItem) => Promise<void>;
  /** Callback when feature/initiative ready to graduate */
  onReadyToGraduate?: (item: WorkItem) => Promise<void>;
}

export function initWorkSystem(pi: ExtensionAPI, config: WorkSystemConfig = {}): void {
  const wolfDen = process.env.WOLF_DEN;
  const wolfName = process.env.WOLF_NAME ?? "1uk4";
  const kbBase = process.env.KB_BASE;

  if (!wolfDen) {
    // No den = no factory. Silent skip.
    return;
  }

  const roots: KbRoots = {
    kbBase: kbBase ?? path.join(wolfDen, "kb", "base"),
    opsRoot: process.env.KB_OPS ?? path.join(wolfDen, "kb", "ops"),
    denLocal: path.join(wolfDen, "kb"),
  };

  let activeTask: ActiveTaskState | null = readActiveTask(wolfDen);
  let activeItem: WorkItem | null = null;

  function refreshActiveItem(): WorkItem | null {
    if (!activeTask) { activeItem = null; return null; }
    const state = loadWorkState(roots);
    activeItem = state.get(activeTask.workId as WorkId) ?? null;
    if (!activeItem || !isBindable(activeItem)) {
      // Stale binding (deleted) or a workspace (feature/initiative/idea) that an
      // older version bound: only tasks, issues and spikes are bindable.
      activeItem = null;
      activeTask = null;
      writeActiveTask(wolfDen, null);
    }
    return activeItem;
  }

  function updateWidget(ctx: any): void {
    try {
      if (!ctx?.hasUI) return;
      if (!activeItem) {
        ctx.ui.setWidget("wolfpack-task", undefined);
        ctx.ui.setStatus("wolfpack-task", undefined);
        return;
      }
      const all = queryWork(roots, {}) ?? [];
      const feature = activeItem.partOf ? all.find((i) => i.id === activeItem!.partOf) : undefined;
      const workspace = feature ? { title: feature.title, ...progress(feature, all) } : undefined;
      ctx.ui.setWidget("wolfpack-task", renderTaskWidget(activeItem, workspace), {
        placement: "aboveEditor",
      });
      ctx.ui.setStatus("wolfpack-task", renderStatusBarCompact(activeItem));
    } catch {
      // stale ctx
    }
  }

  /** Bind to a work item with full tracking. Only tasks/issues/spikes bind. */
  function bindToTask(item: WorkItem, ctx: any): boolean {
    if (!isBindable(item)) {
      if (ctx?.hasUI) ctx.ui.notify(`${item.title} is ${/^[aeiou]/.test(item.kind) ? "an" : "a"} ${item.kind}, a workspace: bind one of its tasks.`, "warning");
      return false;
    }
    // Stop tracking previous task if any
    if (activeTask) stopFileTracking(activeTask.workId);

    // Bind to new task
    activeTask = {
      workId: item.id,
      domain: item.domain as string,
      boundAt: new Date().toISOString(),
    };
    writeActiveTask(wolfDen, activeTask);

    // Start tracking
    startFileTracking(item.id);
    onWorkBound(item.id as any, wolfName as any, new Date().toISOString());

    // Advance ancestors to in_build if they're in earlier stages
    try {
      let parentId = item.partOf;
      while (parentId) {
        const state = loadWorkState(roots); // Reload state each iteration
        const parent = state.get(parentId as WorkId);
        if (parent && ["idea", "plan", "feasibility", "approved"].includes(parent.stage)) {
          stageWork(roots, parent.id, "in_build");
        }
        parentId = parent?.partOf ?? null;
      }
    } catch (e) {
      // Ignore stage propagation errors - non-critical
    }

    refreshActiveItem();
    updateWidget(ctx);
    return true;
  }

  /** Unbind from current task with tracking cleanup */
  function unbindTask(ctx: any): void {
    if (activeTask) stopFileTracking(activeTask.workId);
    activeTask = null;
    activeItem = null;
    writeActiveTask(wolfDen, null);
    updateWidget(ctx);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  let lastCtx: any = null;

  pi.on("session_start", (_event: unknown, ctx: any) => {
    lastCtx = ctx;
    refreshActiveItem();
    updateWidget(ctx);
  });

  pi.on("turn_end", async (_event: unknown, ctx: any) => {
    lastCtx = ctx;
    refreshActiveItem();
    updateWidget(ctx);

    // Check for stage transitions on active task
    if (activeItem && activeTask && ctx.hasUI) {
      try {
        const resolved = resolveWorkItem(roots, activeTask.domain, activeTask.workId);
        const body = resolved?.body ?? "";
        const children = queryWork(roots, { partOf: activeTask.workId }) ?? [];
        const recentNotes = activeItem.log.slice(-3).map((l) => l.text);

        const transitionCtx = extractTransitionContext(activeItem, body, children, recentNotes);
        const signal = detectTransition(activeItem, transitionCtx);

        if (signal && signal.confidence !== "low") {
          // Show transition prompt
          const confirm = await ctx.ui.confirm(signal.prompt, signal.reason ?? "");
          if (confirm) {
            const { item: updated } = stageWork(roots, activeTask.workId, signal.to);
            noteWork(roots, activeTask.workId, `Stage: ${signal.from} → ${signal.to}`);
            refreshActiveItem();
            updateWidget(ctx);
            ctx.ui.notify(`Advanced to ${signal.to}`, "info");
            
            // Trigger graduation for features/initiatives when shipped
            if (signal.to === "shipped" && (updated.kind === "feature" || updated.kind === "initiative")) {
              if (config.onReadyToGraduate) {
                config.onReadyToGraduate(updated).catch(() => {});
              }
            }
          }
        }
      } catch {
        // Ignore transition detection errors
      }
    }
  });

  // ── System prompt injection ─────────────────────────────────────────────

  pi.on("before_agent_start", (event: any, _ctx: any) => {
    refreshActiveItem();
    if (!activeItem || !activeTask) return;

    // Read the working document body
    const resolved = resolveWorkItem(roots, activeTask.domain, activeTask.workId);
    const docBody = resolved?.body ?? "";

    const parts: string[] = [];
    parts.push("<active_task>");
    parts.push(`You are working on: "${activeItem.title}" (${activeItem.kind}, ${activeItem.stage})`);
    parts.push(`id: ${activeItem.id} | domain: ${activeItem.domain}${activeItem.area ? " | area: " + activeItem.area : ""} | assignee: ${activeItem.assignee}`);
    if (activeItem.successCriteria) {
      parts.push(`done_when: ${activeItem.successCriteria}`);
    }
    if (activeItem.partOf) {
      parts.push(`part_of: ${activeItem.partOf}`);
    }

    // The working document — the agent reads and writes this
    if (docBody) {
      parts.push("");
      parts.push("## Working Document");
      parts.push(docBody);
    }

    if (activeItem.log.length > 0) {
      parts.push("");
      parts.push("## Recent Log");
      for (const entry of activeItem.log.slice(-5)) {
        parts.push(`- ${entry.at}: ${entry.text}`);
      }
    }

    // Inject stage-specific context
    if (config.getStageContext) {
      const stageContext = config.getStageContext(activeItem);
      if (stageContext) {
        parts.push("");
        parts.push(stageContext);
      }
    }

    parts.push("");
    parts.push("This is your working document for this task. Use task_update to write/update the plan, notes, or findings. Use task_note to log progress. Use task_stage to advance when done.");
    parts.push("</active_task>");

    return {
      systemPrompt: event.systemPrompt + "\n" + parts.join("\n") + "\n",
    };
  });


  // ── Command: /task ────────────────────────────────────────────────────────

  type PanelAction = "bind" | "new" | "unbind" | { type: "delete"; id: string } | { type: "depend"; id: string } | { type: "graduate"; id: string } | { type: "move"; id: string } | null;

  /** Valid new parents for an item (current parent excluded), plus Inbox/standalone. */
  function moveTargets(item: WorkItem, all: WorkItem[]): { label: string; id: string | null; inbox?: boolean }[] {
    const out: { label: string; id: string | null; inbox?: boolean }[] = [];
    if (isBindable(item) && !all.some((i) => i.container && i.domain === item.domain && i.id === item.partOf)) {
      out.push({ label: "📥 Inbox", id: null, inbox: true });
    }
    if (item.partOf && !placementError(item, null)) out.push({ label: "(no parent — standalone)", id: null });
    for (const p of all) {
      if (p.id === item.id || p.id === item.partOf || p.container || isComplete(p)) continue;
      if (!placementError(item, p)) out.push({ label: `${kindIcon(p)} ${p.title} (${p.kind})`, id: p.id as string });
    }
    return out;
  }

  pi.registerCommand("task", {
    description: "Open the task dashboard — view, select, and create work items",
    handler: async (_rawArgs: string, ctx: any) => {
      lastCtx = ctx;

      const action = await ctx.ui.custom<PanelAction>(
        (tui: any, theme: any, _kb: any, done: (result: PanelAction) => void) => {
          // Two-pane workspace browser. Navigation is the pure reducer in
          // @wolfpack/memory (work/selector.ts); this only renders + applies effects.
          let items: WorkItem[] = [];
          const reload = () => {
            items = (queryWork(roots, { assignee: wolfName }) ?? []).filter((i) => i.stage !== "archived");
          };
          reload();
          let sel: SelectorState = initialState(items, activeTask?.workId ?? null);

          let cachedLines: string[] | undefined;
          let cachedWidth = -1;

          function refresh() { cachedLines = undefined; tui.requestRender(); }

          /** The item under the cursor in the focused pane. */
          function focusedItem(): WorkItem | undefined {
            if (sel.pane === "right") return rightRows(items, sel.openId)[sel.rightIdx];
            return leftRows(items, sel.expanded)[sel.leftIdx]?.item;
          }

          function apply(effect: SelectorEffect | undefined): void {
            if (!effect) return;
            if (effect.type === "unbind") unbindTask(ctx);
            else {
              const target = items.find((i) => i.id === effect.id);
              if (!target || !bindToTask(target, ctx)) return;
              if (effect.type === "open") return done("bind");
            }
            reload();
          }

          const KEYS: Array<[(d: string) => boolean, SelectorKey]> = [
            [(d) => d === "k" || matchesKey(d, Key.up), "up"],
            [(d) => d === "j" || matchesKey(d, Key.down), "down"],
            [(d) => d === "h" || matchesKey(d, Key.left), "left"],
            [(d) => d === "l" || matchesKey(d, Key.right), "right"],
            [(d) => matchesKey(d, Key.enter), "enter"],
            [(d) => matchesKey(d, Key.space), "space"],
          ];

          function handleInput(data: string) {
            const nav = KEYS.find(([match]) => match(data))?.[1];
            if (nav) {
              const { state, effect } = reduce(sel, nav, items, activeTask?.workId ?? null);
              sel = state;
              apply(effect);
              refresh();
              return;
            }
            if (matchesKey(data, Key.escape)) return done(null);
            if (data === "n") return done("new");
            const focused = focusedItem();
            if (!focused) return;
            if (data === "x") return done({ type: "delete", id: focused.id as string });
            if (data === "D") return done({ type: "depend", id: focused.id as string });
            if (data === "m" && !focused.container) return done({ type: "move", id: focused.id as string });
            if (data === "g" && (focused.kind === "feature" || focused.kind === "initiative") &&
                focused.stage === "shipped" && !focused.container && !(focused.graduatedTo?.length)) {
              return done({ type: "graduate", id: focused.id as string });
            }
          }

          /** ○ todo · ● in progress · ✔ shipped · ⛔ blocked */
          function statusIcon(t: WorkItem): string {
            if (isComplete(t)) return theme.fg("success", "\u2714");
            if (isBlocked(t, items)) return theme.fg("error", "\u26d4");
            const active = t.id === activeTask?.workId || !["plan", "idea"].includes(t.stage);
            return active ? theme.fg("accent", "\u25cf") : theme.fg("dim", "\u25cb");
          }

          function renderLeft(): string[] {
            const out = [theme.fg("dim", theme.bold("WORKSPACES"))];
            const rows = leftRows(items, sel.expanded);
            if (rows.length === 0) out.push(theme.fg("dim", "No workspaces yet \u2014 n to create"));
            rows.forEach(({ item, depth }, i) => {
              const cursor = sel.pane === "left" && i === sel.leftIdx;
              const fold = item.kind === "initiative" ? (sel.expanded.includes(item.id as string) ? "\u25be " : "\u25b8 ") : "  ";
              const icon = item.container ? "\ud83d\udce5" : kindIcon(item);
              const { done: d, total } = progress(item, items);
              const count = total ? theme.fg("dim", ` ${d}/${total}`) : "";
              const open = item.id === sel.openId;
              const title = isComplete(item) ? theme.fg("dim", item.title)
                : cursor || open ? theme.fg("accent", item.title) : item.title;
              const stage = item.container ? "" : ` ${STAGE_ICONS[item.stage] ?? ""}`;
              out.push(`${cursor ? theme.fg("accent", "\u203a") : " "}${"  ".repeat(depth)}${fold}${icon} ${title}${count}${stage}`);
            });
            return out;
          }

          function renderRight(): string[] {
            const ws = items.find((i) => i.id === sel.openId);
            if (!ws) return [theme.fg("dim", "l / Enter on a feature to see its tasks")];
            const { done: d, total } = progress(ws, items);
            const out = [`${theme.bold(ws.title)}${total ? theme.fg("dim", ` ${d}/${total}`) : ""}`];
            if (ws.successCriteria) out.push(theme.fg("dim", `done when: ${ws.successCriteria}`));
            out.push("");
            const tasks = rightRows(items, sel.openId);
            if (tasks.length === 0) out.push(theme.fg("dim", "No tasks yet"));
            tasks.forEach((t, i) => {
              const cursor = sel.pane === "right" && i === sel.rightIdx;
              const bound = t.id === activeTask?.workId;
              const title = isComplete(t) ? theme.fg("dim", t.title) : cursor ? theme.fg("accent", t.title) : t.title;
              const kind = t.kind === "task" ? "" : theme.fg("dim", ` (${t.kind})`);
              out.push(`${cursor ? theme.fg("accent", "\u25b6") : " "} ${statusIcon(t)} ${title}${kind}${bound ? theme.fg("success", "  \u25c0 bound") : ""}`);
              if (cursor && t.successCriteria) out.push(theme.fg("dim", `     done when: ${t.successCriteria}`));
              if (cursor && isBlocked(t, items)) {
                const waiting = (t.dependsOn ?? []).map((id) => items.find((i) => i.id === id))
                  .filter((x): x is WorkItem => !!x && !isComplete(x)).map((x) => x.title).join(", ");
                out.push(theme.fg("error", `     \u26d4 waiting on: ${waiting}`));
              }
            });
            return out;
          }

          function render(width: number): string[] {
            if (cachedLines && cachedWidth === width) return cachedLines;
            const lines: string[] = [];
            const add = (s: string) => lines.push(truncateToWidth(s, width));

            add(theme.fg("accent", "\u2500".repeat(width)));
            add(` ${theme.fg("toolTitle", theme.bold("\ud83d\udce5 Tasks"))} ${theme.fg("dim", `\u00b7 ${wolfName}`)}`);
            add(activeTask && activeItem
              ? ` ${theme.fg("success", "\u25b6")} ${theme.fg("accent", activeItem.title)} ${theme.fg("dim", stageLabel(activeItem.stage))}`
              : ` ${theme.fg("dim", "No task bound \u2014 open a feature, then Space on a task")}`);
            add("");

            const leftW = Math.max(24, Math.min(46, Math.floor(width * 0.4)));
            const rightW = Math.max(10, width - leftW - 3);
            const L = renderLeft();
            const R = renderRight();
            for (let i = 0; i < Math.max(L.length, R.length); i++) {
              const l = truncateToWidth(L[i] ?? "", leftW);
              const pad = " ".repeat(Math.max(0, leftW - visibleWidth(l)));
              add(`${l}${pad} ${theme.fg("dim", "\u2502")} ${truncateToWidth(R[i] ?? "", rightW)}`);
            }

            add("");
            const hints = ["h/j/k/l move", "Space bind", "Enter open", "n new", "m move", "D depend", "x delete", "g graduate", "Esc close"];
            add(` ${theme.fg("dim", hints.join(" \u00b7 "))}`);
            add(theme.fg("accent", "\u2500".repeat(width)));

            cachedLines = lines;
            cachedWidth = width;
            return lines;
          }

          return {
            render,
            invalidate: () => { cachedLines = undefined; },
            handleInput,
          };
        }
      );

      if (action === "new") {
        const result = await wizardNew(ctx, roots, wolfName);
        if (result && bindToTask(result.item, ctx)) {
          // Kick off iteration on the new item
          await promptTaskIteration(pi, ctx, roots, result.item);
          refreshActiveItem();
          updateWidget(ctx);
        }
      } else if (action === "bind" && activeItem) {
        // Show current state and offer iteration
        await promptTaskIteration(pi, ctx, roots, activeItem);
        refreshActiveItem();
        updateWidget(ctx);
      } else if (typeof action === "object" && action?.type === "delete") {
        const tree = getWorkTree(roots, action.id);
        const target = tree[0];
        if (!target) {
          ctx.ui.notify("Work item not found.", "warning");
          return;
        }
        const children = tree.slice(1);
        const childWarning = children.length > 0
          ? `\n\nThis will also delete ${children.length} child item(s):\n` + children.map((i) => `- ${i.title} (${i.kind})`).join("\n")
          : "";
        const ok = await ctx.ui.confirm(
          `Delete ${target.kind}: ${target.title}?`,
          `This permanently deletes the work item file and appends delete event(s) to the work ledger.${childWarning}`,
        );
        if (!ok) return;
        const deleted = deleteWork(roots, action.id);
        if (activeTask && deleted.items.some((i) => i.id === activeTask?.workId)) {
          unbindTask(ctx);
        } else {
          refreshActiveItem();
          updateWidget(ctx);
        }
        ctx.ui.notify(`Deleted ${deleted.items.length} work item(s).`, "info");
      } else if (typeof action === "object" && action?.type === "depend") {
        // Show picker for dependency target
        const allItems = (queryWork(roots, { assignee: wolfName }) ?? [])
          .filter((i) => i.id !== action.id && !(i.dependsOn ?? []).includes(action.id as any));
        if (allItems.length === 0) {
          ctx.ui.notify("No other work items to depend on.", "warning");
          return;
        }
        const target = await ctx.ui.select(
          "This item depends on:",
          allItems.map((i) => `${kindIcon(i)} ${i.title} [${i.stage}]`),
        );
        if (!target) return;
        const idx = allItems.findIndex((i) => target.includes(i.title));
        if (idx < 0) return;
        const depTarget = allItems[idx];
        linkWork(roots, action.id, "depends_on", depTarget.id as string);
        ctx.ui.notify(`Added dependency: → ${depTarget.title}`, "info");
      } else if (typeof action === "object" && action?.type === "graduate") {
        // Graduate shipped feature/initiative to KB
        const item = (queryWork(roots, {}) ?? []).find(i => i.id === action.id);
        if (!item) {
          ctx.ui.notify("Work item not found.", "error");
          return;
        }
        const confirm = await ctx.ui.confirm(
          `Graduate "${item.title}" to KB?`,
          "This will create a knowledge base entry from this ${item.kind}."
        );
        if (!confirm) return;
        // Trigger graduation callback
        if (config.onReadyToGraduate) {
          ctx.ui.notify(`Graduating ${item.title}...`, "info");
          await config.onReadyToGraduate(item);
          ctx.ui.notify(`${item.kind} graduated to KB.`, "info");
        } else {
          ctx.ui.notify("Graduation not configured.", "warning");
        }
      } else if (typeof action === "object" && action?.type === "move") {
        const all = queryWork(roots, {}) ?? [];
        const item = all.find((i) => i.id === action.id);
        if (!item) return;
        const choices = moveTargets(item, all);
        if (choices.length === 0) {
          ctx.ui.notify(`Nowhere valid to move ${item.title}.`, "warning");
          return;
        }
        const picked = await ctx.ui.select(`Move "${item.title}" under:`, choices.map((c) => c.label));
        const target = choices.find((c) => c.label === picked);
        if (!target) return;
        try {
          const parentId = target.inbox ? ensureInbox(roots, item.domain as string, wolfName).id : target.id;
          moveWork(roots, item.id, parentId);
          refreshActiveItem();
          updateWidget(ctx);
          ctx.ui.notify(`Moved ${item.title} → ${target.label}`, "info");
        } catch (e: any) {
          ctx.ui.notify(e.message, "error");
        }
      } else if (action === "unbind") {
        ctx.ui.notify("Task unbound.", "info");
      }
    },
  });


  // ── Agent-callable tools ────────────────────────────────────────────────

  pi.registerTool(
    defineTool({
      name: "task_update",
      description: "Update the active work item's working document (plan, notes, findings). This replaces the body of the .md file. Read the current content from the system prompt's <active_task> Working Document section, then write back the updated version.",
      parameters: Type.Object({
        body: Type.String({ description: "The full updated markdown body for the work item (everything below the frontmatter)" }),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        if (!activeTask || !activeItem) return { content: [{ type: "text" as const, text: "No active task." }], isError: true };
        try {
          commitWorkItem(roots, activeItem, params.body);
          return { content: [{ type: "text" as const, text: `Updated working document for: ${activeItem.title}` }] };
        } catch (e: any) {
          return { content: [{ type: "text" as const, text: e.message }], isError: true };
        }
      },
    })
  );

  pi.registerTool(
    defineTool({
      name: "task_note",
      description: "Add a progress note to the active work item's log.",
      parameters: Type.Object({
        text: Type.String({ description: "The progress note text" }),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        if (!activeTask) return { content: [{ type: "text" as const, text: "No active task. Ask the user to /task use first." }], isError: true };
        try {
          const { item } = noteWork(roots, activeTask.workId, params.text);
          activeItem = item;
          updateWidget(ctx);
          return { content: [{ type: "text" as const, text: `Logged: ${params.text} (${item.log.length} entries)` }] };
        } catch (e: any) {
          return { content: [{ type: "text" as const, text: e.message }], isError: true };
        }
      },
    })
  );

  pi.registerTool(
    defineTool({
      name: "task_stage",
      description: "Advance the active work item to a new stage. Stages: idea → plan → feasibility → approved → in_build → shipped → live → archived.",
      parameters: Type.Object({
        to: Type.String({ description: "Target stage" }),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        if (!activeTask) return { content: [{ type: "text" as const, text: "No active task." }], isError: true };
        try {
          const { item } = stageWork(roots, activeTask.workId, params.to);
          activeItem = item;
          updateWidget(ctx);
          return { content: [{ type: "text" as const, text: `${item.title} → ${item.stage}` }] };
        } catch (e: any) {
          return { content: [{ type: "text" as const, text: e.message }], isError: true };
        }
      },
    })
  );

  pi.registerTool(
    defineTool({
      name: "task_link",
      description: "Link the active work item to a KB entry or another work item.",
      parameters: Type.Object({
        rel: Type.String({ description: "Relation: references | depends_on | blocks | graduated_to" }),
        target: Type.String({ description: "Target id (kb-* for entries, work-* for work items)" }),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        if (!activeTask) return { content: [{ type: "text" as const, text: "No active task." }], isError: true };
        try {
          const { item } = linkWork(roots, activeTask.workId, params.rel, params.target);
          activeItem = item;
          updateWidget(ctx);
          return { content: [{ type: "text" as const, text: `Linked: ${params.rel} → ${params.target}` }] };
        } catch (e: any) {
          return { content: [{ type: "text" as const, text: e.message }], isError: true };
        }
      },
    })
  );

  pi.registerTool(
    defineTool({
      name: "task_move",
      description: "Move a work item under a different parent (re-parent). Hierarchy: task/issue/spike under a feature or the Inbox; feature under an initiative or standalone. Defaults to the bound task.",
      parameters: Type.Object({
        to: Type.String({ description: "New parent work item ID, \"inbox\" for the domain's Inbox, or \"none\" to make a feature standalone" }),
        id: Type.Optional(Type.String({ description: "Work item to move (default: the bound task)" })),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const id = params.id ?? activeTask?.workId;
        if (!id) return { content: [{ type: "text" as const, text: "No id given and no task bound." }], isError: true };
        try {
          const item = loadWorkState(roots).get(id as WorkId);
          if (!item) throw new Error(`work item ${id} not found`);
          const to = params.to.trim();
          const parentId =
            to.toLowerCase() === "inbox" ? ensureInbox(roots, item.domain as string, wolfName).id
            : to.toLowerCase() === "none" ? null
            : to;
          const { event, item: moved } = moveWork(roots, id, parentId);
          refreshActiveItem();
          updateWidget(ctx);
          const where = moved.partOf ? loadWorkState(roots).get(moved.partOf as WorkId)?.title : "no parent";
          return { content: [{ type: "text" as const, text: event ? `Moved ${moved.title} → ${where}` : `${moved.title} is already under ${where}` }] };
        } catch (e: any) {
          return { content: [{ type: "text" as const, text: e.message }], isError: true };
        }
      },
    })
  );

  pi.registerTool(
    defineTool({
      name: "task_create",
      description: "Create a new work item. Hierarchy: initiative > feature > task/issue/spike; tasks need a feature parent. A task/issue/spike with no partOf goes into the bound task's feature, or the domain's Inbox if none is bound. Features may be standalone or under an initiative.",
      parameters: Type.Object({
        kind: Type.String({ description: "idea | initiative | feature | task | issue | spike" }),
        domain: Type.String({ description: "Domain: snapjack | wolfpack | personal" }),
        title: Type.String({ description: "Short title for the work item" }),
        area: Type.Optional(Type.String({ description: "Horizontal area: marketing, engineering, analysis…" })),
        successCriteria: Type.Optional(Type.String({ description: "Done-condition (required for tasks)" })),
        assignee: Type.Optional(Type.String({ description: "Wolf to assign (default: current wolf)" })),
        partOf: Type.Optional(Type.String({ description: "Parent work item ID (a feature for task/issue/spike; an initiative or none for a feature)" })),
      }),
      async execute(_id, params, _signal, _onUpdate, _ctx) {
        const input: CreateWorkInput = {
          kind: params.kind as any,
          domain: params.domain,
          title: params.title,
          assignee: params.assignee ?? wolfName,
          area: params.area,
          successCriteria: params.successCriteria,
          // Work units default to the bound task's workspace (its feature);
          // createWork files them in the Inbox when there is none.
          partOf: params.partOf ?? (isBindable({ kind: params.kind as any }) ? activeItem?.partOf : null),
        };
        try {
          const result = createWork(roots, input);
          return { content: [{ type: "text" as const, text: `Created ${result.id}: ${result.item.title} [${result.item.stage}]` }] };
        } catch (e: any) {
          return { content: [{ type: "text" as const, text: e.message }], isError: true };
        }
      },
    })
  );

  pi.registerTool(
    defineTool({
      name: "task_query",
      description: "Query work items. Returns matching items from the factory.",
      parameters: Type.Object({
        domain: Type.Optional(Type.String()),
        assignee: Type.Optional(Type.String()),
        area: Type.Optional(Type.String()),
        stage: Type.Optional(Type.String()),
        kind: Type.Optional(Type.String()),
      }),
      async execute(_id, params, _signal, _onUpdate, _ctx) {
        const items = queryWork(roots, params) ?? [];
        const lines = items.map((i) =>
          `${i.id} | ${i.title} [${i.stage}] ${i.domain}${i.area ? "/" + i.area : ""} → ${i.assignee}`
        );
        return { content: [{ type: "text" as const, text: items.length ? lines.join("\n") : "No matching work items." }] };
      },
    })
  );

  pi.registerTool(
    defineTool({
      name: "task_done",
      description: "Mark the active task as shipped and bind to the next unfinished sibling task. Use this when the current task's success criteria are met. Unless the wolf's ship policy is auto (WOLFPACK_TASK_SHIP=auto), the user is asked to confirm first; if they decline, the task is not shipped.",
      parameters: Type.Object({}),
      async execute(_id, _params, _signal, onUpdate, ctx) {
        if (!activeTask || !activeItem) return { content: [{ type: "text" as const, text: "No active task." }], isError: true };

        // Human gate (default) vs. agent loops (auto / no UI attached).
        if (shouldConfirmShip(resolveShipPolicy(), !!ctx?.hasUI)) {
          const ok = await ctx.ui.confirm(
            `📦 Mark "${activeItem.title}" as shipped?`,
            activeItem.successCriteria ? `Done when: ${activeItem.successCriteria}` : ""
          );
          if (!ok) {
            return {
              content: [{
                type: "text" as const,
                text: `Not shipped: the user declined. "${activeItem.title}" stays in ${activeItem.stage}. Ask what is still missing before calling task_done again.`,
              }],
            };
          }
        }

        let shipped: WorkItem;
        let resultText = "";
        
        try {
          // onUpdate disabled - may cause Pi crash
          const result = stageWork(roots, activeTask.workId, "shipped");
          shipped = result.item;
          noteWork(roots, activeTask.workId, "Completed.");
          resultText = `✓ Shipped: ${shipped.title}`;
        } catch (e: any) {
          return { content: [{ type: "text" as const, text: `Failed to ship: ${e.message}` }], isError: true };
        }

        // Summarize the task into its parent. Not awaited here — unless the
        // parent ships below, in which case its summary must land first.
        const summarized = config.onTaskComplete
          ? config.onTaskComplete(activeTask.workId, shipped).catch(() => {})
          : Promise.resolve();

        // Find the next unfinished sibling
        try {
          let nextItem: WorkItem | null = null;
          if (shipped.partOf) {
            // Same pick as the selector: first open, unblocked task, in progress first.
            const all = queryWork(roots, {}) ?? [];
            nextItem = firstTask(rightRows(all, shipped.partOf as string), all) ?? null;
          }

          if (nextItem) {
            bindToTask(nextItem, ctx);
            resultText += `\n→ Next: ${nextItem.title} [${nextItem.stage}]`;
          } else {
            unbindTask(ctx);
          }
        } catch {
          // Ignore sibling binding errors
        }

        // Last open task under a feature/initiative → offer to ship it, which
        // graduates it into the KB. Same ship policy as the task itself.
        try {
          const parent = shipped.partOf ? loadWorkState(roots).get(shipped.partOf as WorkId) : undefined;
          const children = parent ? queryWork(roots, { partOf: parent.id as string }) ?? [] : [];
          if (parentReadyToShip(parent, children)) {
            const ok =
              !shouldConfirmShip(resolveShipPolicy(), !!ctx?.hasUI) ||
              (await ctx.ui.confirm(
                `📦 All tasks under "${parent.title}" are done. Ship the ${parent.kind}?`,
                "Shipping it graduates it into the knowledge base."
              ));
            if (ok) {
              if (ctx?.hasUI) ctx.ui.notify(`Summarizing "${shipped.title}" into ${parent.kind} before graduating…`, "info");
              await summarized;
              const { item: shippedParent } = stageWork(roots, parent.id, "shipped");
              noteWork(roots, parent.id, "Shipped: all child tasks complete.");
              await config.onReadyToGraduate?.(shippedParent);
              resultText += `\n📦 Shipped ${parent.kind} "${parent.title}" and sent it to the knowledge base`;
            } else {
              resultText += `\n🎯 All tasks under "${parent.title}" are complete; it stays ${parent.stage}. Ship it from /task when ready.`;
            }
          }
        } catch (e: any) {
          resultText += `\n⚠ Could not ship the parent: ${e.message}`;
        }

        return { content: [{ type: "text" as const, text: resultText }] };
      },
    })
  );
}
