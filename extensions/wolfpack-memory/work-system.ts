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
  STAGE_ORDER,
  isComplete,
  isBindable,
  placementError,
  dependencyError,
  type CreateWorkInput,
  type WorkQuery,
  type WorkItem,
  type WorkId,
} from "@wolfpack/kb/client";
import { WorkClient } from "./work-client.js";
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
  readyToGraduate,
  archiveSet,
  hubOf,
  workspaceHeader,
  initialState,
  reduce,
  leftRows,
  rightRows,
  rightTree,
  relatedTo,
  firstTask,
  progress,
  isBlocked,
  NEW_WORK_PROMPT,
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
  if (item.graduated) return "📚";
  return KIND_ICONS[item.kind] ?? "◇";
}

// ── Domain discovery ────────────────────────────────────────────────────────

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// ── Area discovery ────────────────────────────────────────────────────────

async function discoverAreas(wc: WorkClient): Promise<string[]> {
  const areas = new Set<string>();
  try {
    const items = await wc.query({});
    for (const item of items) {
      if (item.area) areas.add(item.area as string);
    }
  } catch { /* empty */ }
  return [...areas].sort();
}

async function pickArea(ctx: any, wc: WorkClient): Promise<string | undefined> {
  const existing = await discoverAreas(wc);
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

function activeTaskPath(wolfDen: string, sessionId: string): string {
  return path.join(wolfDen, "factory", "sessions", sessionId, "active-task.json");
}

function readActiveTask(wolfDen: string, sessionId: string): ActiveTaskState | null {
  if (!sessionId || sessionId === "unknown") return null;
  const p = activeTaskPath(wolfDen, sessionId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

function writeActiveTask(wolfDen: string, sessionId: string, state: ActiveTaskState | null): void {
  if (!sessionId || sessionId === "unknown") return;
  const p = activeTaskPath(wolfDen, sessionId);
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
function renderTaskWidget(item: WorkItem, workspace?: { title: string; done: number; total: number }, autoShip = false): string[] {
  const stageColor = STAGE_COLORS[item.stage] ?? "";
  const clip = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1) + "…" : t);
  const ws = workspace ? ` \x1b[2m· ${clip(workspace.title, 40)} ${workspace.done}/${workspace.total}\x1b[0m` : "";
  const auto = autoShip ? `  \x1b[33m⚡ auto-ship\x1b[0m` : "";
  const lines = [`\x1b[36m●\x1b[0m \x1b[1m${item.title}\x1b[0m  ${stageColor}${stageLabel(item.stage)}\x1b[0m${ws}${auto}`];
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

/**
 * After binding a task, show its current state and ask if the user wants
 * to iterate. If yes, paste a prompt into the editor so the agent reviews
 * and discusses the plan on the next turn.
 */
async function promptTaskIteration(
  pi: ExtensionAPI,
  ctx: any,
  wc: WorkClient,
  item: WorkItem,
): Promise<void> {
  const body: string | undefined = undefined; // body now lives on the API side

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
      await client.stage(item.id as string, target);
    } catch (e: any) {
      // e.g. a task needs success criteria before it leaves plan
      ctx.ui.notify(`Stayed in ${item.stage}: ${e.message}`, "warning");
    }
  }

  if (next === "Review and update the plan") {
    // Start the review turn right away, rather than leaving a draft to send.
    const review =
      `I want to update the plan for "${item.title}" (its working document is in ` +
      `<active_task>). Ask me what I want to change before suggesting anything, then ` +
      `talk it through with me. Write the agreed plan with task_update only once I confirm.`;
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
  /** Wolf's subscribed domains */
  domains?: string[];
  /** Get the currently active domain (from /wolf:domain) */
  getCurrentDomain?: () => string | undefined;
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

  const client = new WorkClient();

  // Session-specific task binding
  let sessionId: string | null = null;
  let activeTask: ActiveTaskState | null = null;
  let activeItem: WorkItem | null = null;
  let cachedWorkspace: { title: string; done: number; total: number } | undefined;

  function getSessionId(ctx: any): string {
    return ctx?.sessionManager?.getSessionId?.() ?? ctx?.sessionId ?? "unknown";
  }

  // Debug logging to file (tail -f $WOLF_DEN/work-system.log)
  const debugLog = (msg: string, ...args: any[]) => {
    if (!process.env.WOLFPACK_DEBUG) return;
    const line = `[${new Date().toISOString()}] ${msg} ${args.map(a => JSON.stringify(a)).join(' ')}\n`;
    fs.appendFileSync(path.join(wolfDen, 'work-system.log'), line);
  };

  function ensureSessionLoaded(ctx: any): void {
    const sid = getSessionId(ctx);
    if (sid !== sessionId || (sessionId && !activeTask)) {
      debugLog('ensureSessionLoaded: loading', { sid, prev: sessionId });
      sessionId = sid;
      activeTask = readActiveTask(wolfDen, sessionId);
      debugLog('ensureSessionLoaded: loaded', { activeTask: activeTask?.workId });
    }
  }
  /** The feature this session works in. Kept when a task is unbound, so new
   *  tasks still land there; set by binding a task or opening a feature in /task. */
  let workspaceId: string | null = null;
  /** Session override for the ship policy: null = WOLFPACK_TASK_SHIP default.
   *  Toggled with `/task auto` or `a` in the /task panel. Tasks only: features
   *  always need a manual g. */
  let autoShipOverride: boolean | null = null;
  const shipPolicy = () =>
    autoShipOverride === null ? resolveShipPolicy() : autoShipOverride ? "auto" : "confirm";
  function toggleAutoShip(ctx: any): void {
    autoShipOverride = shipPolicy() !== "auto";
    updateWidget(ctx);
    if (ctx?.hasUI) {
      ctx.ui.notify(
        autoShipOverride
          ? "⚡ Auto-ship ON: the agent ships tasks without asking (features still need g)."
          : "Auto-ship OFF: task_done asks before shipping.",
        "info"
      );
    }
  }

  async function refreshActiveItem(): Promise<WorkItem | null> {
    if (!activeTask) { activeItem = null; return null; }
    try {
      activeItem = await client.get(activeTask.workId);
    } catch {
      activeItem = null;
    }
    if (!activeItem || !isBindable(activeItem)) {
      if (sessionId) {
        activeItem = null;
        activeTask = null;
        writeActiveTask(wolfDen, sessionId, null);
      }
    }
    if (activeItem?.partOf && !workspaceId) workspaceId = activeItem.partOf as string;
    // Update workspace cache for widget
    cachedWorkspace = undefined;
    if (activeItem?.partOf) {
      try {
        const all = await client.query({ domain: activeItem.domain as string });
        const feature = all.find((i) => i.id === activeItem!.partOf);
        if (feature) cachedWorkspace = { title: feature.title, ...progress(feature, all) };
      } catch { /* best effort */ }
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
      const workspace = cachedWorkspace;
      ctx.ui.setWidget("wolfpack-task", renderTaskWidget(activeItem, workspace, shipPolicy() === "auto"), {
        placement: "aboveEditor",
      });
      ctx.ui.setStatus("wolfpack-task", renderStatusBarCompact(activeItem));
    } catch {
      // stale ctx
    }
  }

  /** Bind to a work item with full tracking. Only tasks/issues/spikes bind. */
  async function bindToTask(item: WorkItem, ctx: any): Promise<boolean> {
    ensureSessionLoaded(ctx);
    if (!sessionId) return false;
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
    writeActiveTask(wolfDen, sessionId, activeTask);
    if (item.partOf) workspaceId = item.partOf as string;

    // Start tracking
    startFileTracking(item.id);
    onWorkBound(item.id as any, wolfName as any, new Date().toISOString());

    // Advance ancestors to in_build if they're in earlier stages
    try {
      let parentId = item.partOf;
      while (parentId) {
        let parent: WorkItem | undefined;
        try { parent = await client.get(parentId as string); } catch { break; }
        if (parent && ["idea", "plan", "feasibility", "approved"].includes(parent.stage)) {
          await client.stage(parent.id, "in_build");
        }
        parentId = parent?.partOf ?? null;
      }
    } catch (e) {
      // Ignore stage propagation errors - non-critical
    }

    await refreshActiveItem();
    updateWidget(ctx);
    return true;
  }

  /** Unbind from current task with tracking cleanup */
  function unbindTask(ctx: any): void {
    ensureSessionLoaded(ctx);
    if (activeTask) stopFileTracking(activeTask.workId);
    activeTask = null;
    activeItem = null;
    if (sessionId) writeActiveTask(wolfDen, sessionId, null);
    updateWidget(ctx);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  let lastCtx: any = null;

  pi.on("session_start", async (_event: unknown, ctx: any) => {
    lastCtx = ctx;
    ensureSessionLoaded(ctx);
    await refreshActiveItem();
    updateWidget(ctx);
  });

  pi.on("turn_end", async (_event: unknown, ctx: any) => {
    lastCtx = ctx;
    ensureSessionLoaded(ctx);
    await refreshActiveItem();
    updateWidget(ctx);

    // Check for stage transitions on active task
    if (activeItem && activeTask && ctx.hasUI) {
      try {
        const resolved = await client.get(activeTask.workId);
        const body = "";
        const children = await client.query({ partOf: activeTask.workId }) ?? [];
        const recentNotes = activeItem.log.slice(-3).map((l) => l.text);

        const transitionCtx = extractTransitionContext(activeItem, body, children, recentNotes);
        const signal = detectTransition(activeItem, transitionCtx);

        if (signal && signal.confidence !== "low") {
          // Show transition prompt
          const confirm = await ctx.ui.confirm(signal.prompt, signal.reason ?? "");
          if (confirm) {
            await client.stage(activeTask.workId, signal.to);
            await client.note(activeTask.workId, `Stage: ${signal.from} → ${signal.to}`);
            await refreshActiveItem();
            updateWidget(ctx);
            ctx.ui.notify(`Advanced to ${signal.to}`, "info");
          }
        }
      } catch {
        // Ignore transition detection errors
      }
    }
  });

  // ── System prompt injection ─────────────────────────────────────────────

  pi.on("before_agent_start", async (event: any, ctx: any) => {
    ensureSessionLoaded(ctx);
    await refreshActiveItem();
    debugLog('before_agent_start', { activeTask: activeTask?.workId, activeItem: activeItem?.title });
    const all = await client.query({}) ?? [];
    if (!activeItem || !activeTask) {
      // No task bound: still tell the agent which workspace new tasks go to.
      const header = workspaceHeader(workspaceId, all, null);
      if (!header) return;
      return {
        systemPrompt: event.systemPrompt + "\n<workspace>\n" + header +
          "\nNo task is bound. New tasks created with task_create go into this feature unless partOf is given.\n</workspace>\n",
      };
    }

    // Read the working document body
    const resolved = await client.get(activeTask.workId);
    const docBody = "";

    const parts: string[] = [];
    parts.push(`You are working on: "${activeItem.title}" (${activeItem.kind}, ${activeItem.stage})`);
    parts.push(`id: ${activeItem.id} | domain: ${activeItem.domain}${activeItem.area ? " | area: " + activeItem.area : ""} | assignee: ${activeItem.assignee}`);
    if (activeItem.successCriteria) {
      parts.push(`done_when: ${activeItem.successCriteria}`);
    }
    const header = workspaceHeader(activeItem.partOf as string | null, all, activeItem.id as string);
    if (header) {
      parts.push("");
      parts.push(header);
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
    if (shipPolicy() === "auto") {
      parts.push("AUTO-SHIP IS ON: when done_when is met and verified, log a task_note and call task_done yourself (no confirmation). It binds the next task in this feature; keep going until none are left. Do not graduate the feature: that stays a manual g by the user.");
    }

    // Use sections API - Pi wraps each section in a tag automatically
    const content = parts.join("\n");
    event.systemPromptOptions.sections["active_task"] = content;
    debugLog('injecting active_task section', { contentLen: content.length });
  });


  // ── Command: /task ────────────────────────────────────────────────────────

  type PanelAction = "bind" | "new" | "unbind" | { type: "bind"; target: WorkItem } | { type: "delete"; id: string } | { type: "depend"; id: string } | { type: "graduate"; id: string } | { type: "move"; id: string } | null;

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
    handler: async (rawArgs: string, ctx: any) => {
      if ((rawArgs ?? "").trim().toLowerCase() === "auto") return toggleAutoShip(ctx);
      lastCtx = ctx;

      // Pre-fetch items for subscribed domains
      let allItems: WorkItem[] = [];
      let items: WorkItem[] = [];
      try {
        const activeDomain = config.getCurrentDomain?.();
        const queryDomains = activeDomain ? [activeDomain] : (config.domains ?? []);
        if (queryDomains.length > 0) {
          const results = await Promise.all(
            queryDomains.map((d) => client.query({ domain: d }))
          );
          allItems = results.flat();
        } else {
          allItems = await client.query({}) ?? [];
        }
        items = allItems.filter((i) => i.stage !== "archived");
      } catch (e: any) {
        ctx.ui.notify(`Failed to load work items: ${e.message}`, "warning");
        return;
      }

      const action = await ctx.ui.custom<PanelAction>(
        (tui: any, theme: any, _kb: any, done: (result: PanelAction) => void) => {
          let sel: SelectorState = initialState(items, activeTask?.workId ?? null);

          let cachedLines: string[] | undefined;
          let cachedWidth = -1;

          function refresh() { cachedLines = undefined; tui.requestRender(); }

          /** The item under the cursor in the focused pane. */
          function focusedItem(): WorkItem | undefined {
            if (sel.pane === "right") return rightRows(items, sel.openId)[sel.rightIdx];
            return leftRows(items, sel.expanded)[sel.leftIdx]?.item;
          }

          let pendingBind: WorkItem | null = null;

          function apply(effect: SelectorEffect | undefined): void {
            if (!effect) return;
            if (effect.type === "unbind") unbindTask(ctx);
            else {
              const target = items.find((i) => i.id === effect.id);
              if (!target) return;
              pendingBind = target;
              if (effect.type === "open") return done({ type: "bind", target });
            }
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
              if (sel.openId) workspaceId = sel.openId;
              apply(effect);
              refresh();
              return;
            }
            if (matchesKey(data, Key.escape)) return done(null);
            if (data === "a") {
              toggleAutoShip(ctx);
              return refresh();
            }
            if (data === "n") return done("new");
            const focused = focusedItem();
            if (!focused) return;
            if (data === "x") return done({ type: "delete", id: focused.id as string });
            if (data === "D") return done({ type: "depend", id: focused.id as string });
            if (data === "m" && !focused.container) return done({ type: "move", id: focused.id as string });
            if (data === "g") {
              // From the task pane, g graduates the open feature, not the task.
              const target = sel.pane === "right" ? items.find((i) => i.id === sel.openId) : focused;
              if (target && readyToGraduate(target, allItems)) {
                return done({ type: "graduate", id: target.id as string });
              }
              ctx.ui.notify(notReadyReason(target), "warning");
              return;
            }
          }

          /** Why g can't graduate this item (shown instead of doing nothing). */
          function notReadyReason(item: WorkItem | undefined): string {
            if (!item) return "Nothing selected to graduate.";
            if (item.container) return "The Inbox never graduates.";
            if (item.graduated) return `${item.title} has already graduated.`;
            const kids = allItems.filter((i) => i.partOf === item.id);
            if (item.kind === "feature") {
              const open = kids.filter((k) => !isComplete(k)).length;
              return kids.length === 0 ? `${item.title} has no tasks yet.` : `${item.title}: ${open} task(s) still open.`;
            }
            if (item.kind === "initiative") {
              const left = kids.filter((k) => k.kind === "feature" && !k.graduated).length;
              return `${item.title}: ${left} feature(s) still to graduate (press g on each feature).`;
            }
            return `Only features and initiatives graduate; open a feature and press g.`;
          }

          /** ○ todo · ● in progress · ✔ shipped · ⛔ blocked */
          function statusIcon(t: WorkItem): string {
            if (isComplete(t)) return theme.fg("success", "\u2714");
            if (isBlocked(t, items)) return theme.fg("error", "\u26d4");
            const active = t.id === activeTask?.workId || !["plan", "idea"].includes(t.stage);
            return active ? theme.fg("accent", "\u25cf") : theme.fg("dim", "\u25cb");
          }

          /** "└▸ " under a prerequisite (indented per level), "+N" for more prerequisites. */
          const chainPrefix = (chain: number) => (chain ? theme.fg("dim", `${"  ".repeat(chain - 1)}\u2514\u25b8 `) : "");
          const extraMark = (extra: number) => (extra ? theme.fg("dim", ` +${extra}`) : "");
          /** ▲ prerequisite / ▼ waits on the focused item. */
          function relationMark(id: string): string {
            const { prereqs, dependents } = relatedTo(focusedItem(), items);
            if (prereqs.has(id)) return theme.fg("warning", " \u25b2");
            if (dependents.has(id)) return theme.fg("accent", " \u25bc");
            return "";
          }

          function renderLeft(): string[] {
            const out = [theme.fg("dim", theme.bold("WORKSPACES"))];
            const rows = leftRows(items, sel.expanded);
            if (rows.length === 0) out.push(theme.fg("dim", "No workspaces yet \u2014 n to create"));
            rows.forEach(({ item, depth, chain, extra }, i) => {
              const cursor = sel.pane === "left" && i === sel.leftIdx;
              const fold = item.kind === "initiative" ? (sel.expanded.includes(item.id as string) ? "\u25be " : "\u25b8 ") : "  ";
              const icon = item.container ? "\ud83d\udce5" : kindIcon(item);
              const { done: d, total } = progress(item, items);
              const count = total ? theme.fg("dim", ` ${d}/${total}`) : "";
              const open = item.id === sel.openId;
              const title = isComplete(item) ? theme.fg("dim", item.title)
                : cursor || open ? theme.fg("accent", item.title) : item.title;
              const stage = item.container ? ""
                : readyToGraduate(item, allItems) ? theme.fg("success", " \ud83c\udf93 ready") : ` ${STAGE_ICONS[item.stage] ?? ""}`;
              out.push(`${cursor ? theme.fg("accent", "\u203a") : " "}${"  ".repeat(depth)}${fold}${chainPrefix(chain)}${icon} ${title}${count}${stage}${extraMark(extra)}${relationMark(item.id as string)}`);
            });
            return out;
          }

          function renderRight(): string[] {
            const ws = items.find((i) => i.id === sel.openId);
            if (!ws) return [theme.fg("dim", "l / Enter on a feature to see its tasks")];
            const { done: d, total } = progress(ws, items);
            const out = [`${theme.bold(ws.title)}${total ? theme.fg("dim", ` ${d}/${total}`) : ""}`];
            if (ws.successCriteria) out.push(theme.fg("dim", `done when: ${ws.successCriteria}`));
            if (readyToGraduate(ws, allItems)) {
              out.push(theme.fg("success", "\ud83c\udf93 All tasks done: press g to graduate"));
            }
            out.push("");
            const tree = rightTree(items, sel.openId);
            if (tree.length === 0) out.push(theme.fg("dim", "No tasks yet"));
            tree.forEach(({ item: t, chain, extra }, i) => {
              const cursor = sel.pane === "right" && i === sel.rightIdx;
              const bound = t.id === activeTask?.workId;
              const title = isComplete(t) ? theme.fg("dim", t.title) : cursor ? theme.fg("accent", t.title) : t.title;
              const kind = t.kind === "task" ? "" : theme.fg("dim", ` (${t.kind})`);
              out.push(`${cursor ? theme.fg("accent", "\u25b6") : " "} ${chainPrefix(chain)}${statusIcon(t)} ${title}${kind}${extraMark(extra)}${relationMark(t.id as string)}${bound ? theme.fg("success", "  \u25c0 bound") : ""}`);
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
            add(` ${theme.fg("toolTitle", theme.bold("\ud83d\udce5 Tasks"))} ${theme.fg("dim", `\u00b7 ${wolfName}`)}` +
              (shipPolicy() === "auto" ? `  ${theme.fg("warning", "\u26a1 auto-ship on")}` : ""));
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
            const hints = ["h/j/k/l move", "Space bind", "Enter open", "n new", "m move", "D depend", "x delete", "g graduate", "a auto-ship", "Esc close"];
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
        // Conversational flow: let the agent ask questions and create the task
        try {
          pi.sendUserMessage(NEW_WORK_PROMPT);
        } catch {
          ctx.ui.pasteToEditor(NEW_WORK_PROMPT);
        }
      } else if (action === "bind" && activeItem) {
        await promptTaskIteration(pi, ctx, client, activeItem);
        await refreshActiveItem();
        updateWidget(ctx);
      } else if (typeof action === "object" && action?.type === "bind") {
        await bindToTask(action.target, ctx);
        await refreshActiveItem();
        updateWidget(ctx);
      } else if (typeof action === "object" && action?.type === "delete") {
        const tree = await client.getTree(action.id);
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
        const deleted = await client.delete(action.id);
        if (activeTask && deleted.items.some((i) => i.id === activeTask?.workId)) {
          unbindTask(ctx);
        } else {
          await refreshActiveItem();
          updateWidget(ctx);
        }
        ctx.ui.notify(`Deleted ${deleted.items.length} work item(s).`, "info");
      } else if (typeof action === "object" && action?.type === "depend") {
        // Valid prerequisites only (same feature / same initiative, no cycles).
        // Picking one the item already depends on removes it.
        const all = await client.query({}) ?? [];
        const item = all.find((i) => i.id === action.id);
        if (!item) return;
        const current = new Set((item.dependsOn ?? []).map(String));
        const choices = all.filter((t) =>
          t.id !== item.id && !t.container && (current.has(t.id as string) || (!isComplete(t) && !dependencyError(item, t, all)))
        );
        if (choices.length === 0) {
          const scope = isBindable(item) ? "other open tasks in this feature" : item.kind === "feature" ? "other features under this initiative" : "valid targets";
          ctx.ui.notify(`${item.title}: no ${scope} to depend on.`, "warning");
          return;
        }
        const labels = choices.map((t) => `${current.has(t.id as string) ? "\u2713 remove: " : ""}${kindIcon(t)} ${t.title} ${STAGE_ICONS[t.stage] ?? ""}`);
        const picked = await ctx.ui.select(`"${item.title}" depends on:`, labels);
        const target = choices[labels.indexOf(picked)];
        if (!target) return;
        try {
          if (current.has(target.id as string)) {
            await client.unlink(item.id, "depends_on", target.id as string);
            ctx.ui.notify(`Removed dependency: ${item.title} no longer waits on ${target.title}`, "info");
          } else {
            await client.link(item.id, "depends_on", target.id as string);
            ctx.ui.notify(`Added dependency: ${item.title} waits on ${target.title}`, "info");
          }
        } catch (e: any) {
          ctx.ui.notify(e.message, "error");
        }
      } else if (typeof action === "object" && action?.type === "graduate") {
        // Graduate a ready feature/initiative: ship it, then send it to the KB.
        const all = await client.query({}) ?? [];
        const item = all.find((i) => i.id === action.id);
        if (!readyToGraduate(item, all)) {
          ctx.ui.notify("Not ready to graduate.", "warning");
          return;
        }
        if (!config.onReadyToGraduate) {
          ctx.ui.notify("Graduation not configured.", "warning");
          return;
        }
        const archived = archiveSet(item, all);
        const tasks = archived.length - 1;
        const hub = item.kind === "feature" ? hubOf(item, all) : undefined;
        const what = (item.kind === "feature"
          ? "Ships the feature and sends it to Dewey as its own knowledge base entry" +
            (hub ? `, and adds it to the "${hub.title}" initiative's hub entry (the initiative stays open).` : ".")
          : "Completes the initiative: its hub entry gets a final outcome summary.") +
          ` Then archives it${tasks ? ` and its ${tasks} remaining item(s)` : ""}: they leave /task (history is kept).`;
        const ok = await ctx.ui.confirm(
          item.kind === "initiative" ? `🎓 Complete "${item.title}"?` : `🎓 Graduate "${item.title}" to the knowledge base?`,
          what
        );
        if (!ok) return;
        try {
          const shippedItem = isComplete(item) ? item : (await client.stage(item.id, "shipped"));
          if (!isComplete(item)) await client.note(item.id, "Shipped for graduation: all tasks complete.");
          ctx.ui.notify(`Graduating ${item.title}…`, "info");
          await config.onReadyToGraduate(shippedItem);
          // Graduated work is past tense: archive it and what it contained.
          for (const a of archived) await client.stage(a.id, "archived");
          await client.note(item.id, `Archived on graduation${tasks ? ` with ${tasks} item(s)` : ""}.`);
          if (activeTask && archived.some((a) => a.id === activeTask!.workId)) unbindTask(ctx);
          await refreshActiveItem();
          updateWidget(ctx);
          ctx.ui.notify(`🎓 ${item.title} graduated and archived.`, "info");
          // Its last feature delivered → the initiative can be completed (never automatic).
          const after = await client.query({}) ?? [];
          const parent = hub ? after.find((i) => i.id === hub.id) : undefined;
          if (readyToGraduate(parent, after)) {
            ctx.ui.notify(`🎓 All features of "${parent.title}" have graduated: press g on it to complete it.`, "info");
          }
        } catch (e: any) {
          ctx.ui.notify(`Graduation failed: ${e.message}`, "error");
        }
      } else if (typeof action === "object" && action?.type === "move") {
        const all = await client.query({}) ?? [];
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
          const parentId = target.inbox ? (await client.ensureInbox(item.domain as string, wolfName)).id : target.id;
          await client.move(item.id, parentId);
          await refreshActiveItem();
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
          await client.updateBody(activeItem.id, params.body);
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
          const item = await client.note(activeTask.workId, params.text);
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
          const item = await client.stage(activeTask.workId, params.to);
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
      description: "Link the active work item to another work item (depends_on / blocks): a task only to tasks in the same feature, a feature only to features under the same initiative; never across initiatives or in a cycle. Work never links to KB entries.",
      parameters: Type.Object({
        rel: Type.String({ description: "Relation: depends_on | blocks (work items link only to each other, never to KB entries)" }),
        target: Type.String({ description: "Target work item id (work-*)" }),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        if (!activeTask) return { content: [{ type: "text" as const, text: "No active task." }], isError: true };
        try {
          await client.link(activeTask.workId, params.rel, params.target);
          await refreshActiveItem();
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
      name: "task_unlink",
      description: "Remove a link from the active work item (e.g. a depends_on dependency).",
      parameters: Type.Object({
        rel: Type.String({ description: "Relation: depends_on | blocks (work items link only to each other, never to KB entries)" }),
        target: Type.String({ description: "Target id to unlink" }),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        if (!activeTask) return { content: [{ type: "text" as const, text: "No active task." }], isError: true };
        try {
          await client.unlink(activeTask.workId, params.rel, params.target);
          await refreshActiveItem();
          updateWidget(ctx);
          return { content: [{ type: "text" as const, text: `Unlinked: ${params.rel} → ${params.target}` }] };
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
          const item = await client.get(id);
          const to = params.to.trim();
          const parentId =
            to.toLowerCase() === "inbox" ? (await client.ensureInbox(item.domain as string, wolfName)).id
            : to.toLowerCase() === "none" ? null
            : to;
          const moved = await client.move(id, parentId);
          await refreshActiveItem();
          updateWidget(ctx);
          let where = "no parent";
          if (moved.partOf) { try { where = (await client.get(moved.partOf as string)).title; } catch {} }
          return { content: [{ type: "text" as const, text: `Moved ${moved.title} → ${where}` }] };
        } catch (e: any) {
          return { content: [{ type: "text" as const, text: e.message }], isError: true };
        }
      },
    })
  );

  pi.registerTool(
    defineTool({
      name: "task_create",
      description: "Create a new work item. Hierarchy: initiative > feature > task/issue/spike; tasks need a feature parent. A task/issue/spike with no partOf goes into the current workspace (the bound task's feature, or the last feature worked in this session), else the domain's Inbox. Features may be standalone or under an initiative.",
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
          partOf: params.partOf ?? (isBindable({ kind: params.kind as any }) ? activeItem?.partOf ?? workspaceId : null),
        };
        try {
          const result = await client.create(input);
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
        const items = await client.query(params) ?? [];
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
        if (shouldConfirmShip(shipPolicy(), !!ctx?.hasUI)) {
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
          const result = await client.stage(activeTask.workId, "shipped");
          shipped = result;
          await client.note(activeTask.workId, "Completed.");
          resultText = `✓ Shipped: ${shipped.title}`;
        } catch (e: any) {
          return { content: [{ type: "text" as const, text: `Failed to ship: ${e.message}` }], isError: true };
        }

        // Summarize the task into its feature (fire and forget)
        if (config.onTaskComplete) {
          config.onTaskComplete(activeTask.workId, shipped).catch(() => {});
        }

        // Find the next unfinished sibling
        try {
          let nextItem: WorkItem | null = null;
          if (shipped.partOf) {
            // Same pick as the selector: first open, unblocked task, in progress first.
            const all = await client.query({}) ?? [];
            nextItem = firstTask(rightRows(all, shipped.partOf as string), all) ?? null;
          }

          if (nextItem) {
            await bindToTask(nextItem, ctx);
            resultText += `\n→ Next: ${nextItem.title} [${nextItem.stage}]`;
          } else {
            unbindTask(ctx);
          }
        } catch {
          // Ignore sibling binding errors
        }

        // Last task done → the feature is ready to graduate. Never automatic:
        // the user graduates it with `g` in /task.
        try {
          const all = await client.query({}) ?? [];
          const feature = shipped.partOf ? all.find((i) => i.id === shipped.partOf) : undefined;
          if (readyToGraduate(feature, all)) {
            resultText += `\n🎓 All tasks under "${feature.title}" are done. It is ready to graduate: press g on it in /task.`;
          }
        } catch {
          // Ignore readiness check errors
        }

        return { content: [{ type: "text" as const, text: resultText }] };
      },
    })
  );
}
