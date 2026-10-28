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
import { WorkClient, shipAndRollup } from "./work-client.js";
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
  initiativeOf,
  renderGraduationPreview,
  type GraduationPreview,
  type ConfirmedGraduation,
  workspaceHeader,
  initialState,
  reduce,
  rollupToParent,
  leftRows,
  rightRows,
  rightTree,
  relatedTo,
  firstTask,
  progress,
  isIdeasFolder,
  ideaCount,
  isBlocked,
  newWorkPrompt,
  type SelectorState,
  type SelectorKey,
  type SelectorEffect,
  renderWorkingDocument,
  extractRecord,
  replaceRecordSection,
  syncFeatureStage,
  recordFeatureId,
  renderFeatureRecord,
  bindingLabel,
  readyBoundContext,
  readyBoundReply,
  completeLine,
  withHeadsUp,
  shouldBindOnCreate,
  createSerial,
  notBoundReason,
  UNBOUND_CONTEXT,
  BINDING_RULES,
} from "@wolfpack/memory";
import { listSubscribedDomains, formatDomainChoices } from "@wolfpack/kb";
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
  /** The task's parent feature at bind time. */
  featureId?: string;
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
function renderTaskWidget(item: WorkItem, workspace?: { title: string; done: number; total: number }, autoShip = false, ready = false): string[] {
  const stageColor = STAGE_COLORS[item.stage] ?? "";
  const clip = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1) + "…" : t);
  const ws = workspace ? ` \x1b[2m· ${clip(workspace.title, 40)} ${workspace.done}/${workspace.total}\x1b[0m` : "";
  const auto = autoShip ? `  \x1b[33m⚡ auto-ship\x1b[0m` : "";
  const stage = ready ? "\x1b[32m🎓 ready to graduate\x1b[0m" : `${stageColor}${stageLabel(item.stage)}\x1b[0m`;
  const lines = [`\x1b[36m●\x1b[0m \x1b[1m${item.title}\x1b[0m  ${stage}${ws}${auto}`];
  if (item.successCriteria) lines.push(`  \x1b[2m✓ ${clip(item.successCriteria, 100)}\x1b[0m`);
  return lines;
}

/** `⛓ <short title>` plus the stage, dimmed. */
function renderStatusBarCompact(item: WorkItem, ready = false): string {
  return ready ? bindingLabel(item.title, 28, true) : `${bindingLabel(item.title)} \x1b[2m${stageLabel(item.stage)}\x1b[0m`;
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
  /** Graduation: `g` previews the distilled contributions, then sends after the owner confirms. */
  graduation?: {
    preview(id: string): Promise<GraduationPreview>;
    confirm(preview: GraduationPreview, ship: (id: string) => Promise<unknown>): Promise<ConfirmedGraduation>;
  };
}

/** What the work system exposes to the rest of the memory extension. */
export interface WorkSystemHandle {
  /** The task this session is bound to right now (memory tags observations with it). */
  getBoundWork(): { taskId: string; featureId?: string } | null;
  /** `g`: preview, confirm, send, archive (also callable without the /task panel). */
  graduate(ctx: any, itemId: string): Promise<void>;
  /** Re-read the bound item and redraw the status bar and widget. */
  refresh(ctx: any): Promise<void>;
}

export function initWorkSystem(pi: ExtensionAPI, config: WorkSystemConfig = {}): WorkSystemHandle | void {
  const wolfDen = process.env.WOLF_DEN;
  const wolfName = process.env.WOLF_NAME ?? "wolf";
  const kbBase = process.env.KB_BASE;

  if (!wolfDen) {
    // No den = no factory. Silent skip.
    return;
  }

  const client = new WorkClient();

  /**
   * A subagent child (PI_SUBAGENT_AGENT) never binds: the binding belongs to the
   * orchestrator. No status, no binding context or rules, no auto-bind, no
   * heads-up; task_bind / task_unbind refuse. The other work tools keep working.
   */
  const isSubagent = () => !!process.env.PI_SUBAGENT_AGENT;
  const SUBAGENT_NO_BIND = "Subagents don't bind: the orchestrator owns the binding.";
  const headsUp = (reply: string, working: { id: string; title?: string }) =>
    isSubagent() ? reply : withHeadsUp(reply, working, boundRef());

  // ── Outcomes: a shipped child is folded into its feature's ## Outcomes ──
  // Every feature keeps the section (the Inbox does not). Errors are logged —
  // a bad rollup never blocks the ship.
  async function shipWithRollup(id: string): Promise<WorkItem> {
    return shipAndRollup(client, id, rollupToParent, (err) => debugLog("rollupToParent failed", { id, err: String(err) }));
  }

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
    // Always re-read: the file can change out from under us (another process,
    // out-of-band edit). Cost is one small JSON read per turn.
    if (sid !== sessionId) {
      debugLog('ensureSessionLoaded: session change', { sid, prev: sessionId });
      sessionId = sid;
    }
    // An unknown session has no file to re-read: memory is all there is.
    if (sessionId === "unknown" && !isSubagent()) return;
    activeTask = isSubagent() ? null : readActiveTask(wolfDen, sessionId);
  }
  /**
   * Every tool starts from the binding as it is NOW: re-read from the file (a
   * rebind may have been made elsewhere) and, when the cached item is not the
   * bound one, re-fetch it so no tool names a stale item.
   */
  async function syncBinding(ctx: any): Promise<void> {
    ensureSessionLoaded(ctx);
    if (!activeTask) { activeItem = null; return; }
    if (activeItem?.id !== activeTask.workId) await refreshActiveItem();
  }
  /** Runs the create-then-bind decisions one at a time: parallel task_create calls must see each other's binding. */
  const bindSerial = createSerial();
  function getBoundWork(): { taskId: string; featureId?: string } | null {
    const t = sessionId ? readActiveTask(wolfDen!, sessionId) : activeTask;
    return t ? { taskId: t.workId, ...(t.featureId ? { featureId: t.featureId } : {}) } : null;
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

  /** Bound to a FINISHED feature (its last task shipped): see bindToFeature. */
  const isFeatureBinding = (item: WorkItem | null) =>
    !!item && !!activeTask && item.kind === "feature" && !item.container && activeTask.featureId === item.id;
  /** The bound item is done and waits for a manual graduation (a finished feature or loose task). */
  let boundReady = false;

  async function refreshActiveItem(): Promise<WorkItem | null> {
    if (!activeTask) { activeItem = null; boundReady = false; return null; }
    try {
      activeItem = await client.get(activeTask.workId);
    } catch {
      activeItem = null;
    }
    const featureBound = isFeatureBinding(activeItem);
    // A feature binding ends when the feature is graduated or archived.
    if (!activeItem || !(isBindable(activeItem) || featureBound) || (featureBound && (activeItem.graduated || activeItem.stage === "archived"))) {
      if (sessionId) {
        activeItem = null;
        activeTask = null;
        writeActiveTask(wolfDen, sessionId, null);
      }
    }
    if (activeItem?.partOf && !workspaceId && !featureBound) workspaceId = activeItem.partOf as string;
    // Update workspace cache for widget
    cachedWorkspace = undefined;
    boundReady = false;
    if (activeItem && (featureBound || activeItem.partOf)) {
      try {
        const all = await client.query({ domain: activeItem.domain as string });
        boundReady = readyToGraduate(activeItem, all);
        const feature = featureBound ? undefined : all.find((i) => i.id === activeItem!.partOf);
        if (feature) cachedWorkspace = { title: feature.title, ...progress(feature, all) };
      } catch { /* best effort */ }
    } else if (activeItem) {
      try { boundReady = readyToGraduate(activeItem, await client.query({ domain: activeItem.domain as string })); } catch { /* best effort */ }
    }
    return activeItem;
  }

  function updateWidget(ctx: any): void {
    try {
      if (!ctx?.hasUI || isSubagent()) return;
      if (!activeItem) {
        ctx.ui.setWidget("wolfpack-task", undefined);
        ctx.ui.setStatus("wolfpack-task", `\x1b[2m${bindingLabel(null)}\x1b[0m`);
        return;
      }
      const workspace = cachedWorkspace;
      ctx.ui.setWidget("wolfpack-task", renderTaskWidget(activeItem, workspace, shipPolicy() === "auto", boundReady), {
        placement: "aboveEditor",
      });
      ctx.ui.setStatus("wolfpack-task", renderStatusBarCompact(activeItem, boundReady));
    } catch {
      // stale ctx
    }
  }

  /** Bind to a work item with full tracking. Only tasks/issues/spikes bind. */
  async function bindToTask(item: WorkItem, ctx: any): Promise<boolean> {
    if (isSubagent()) return false;
    ensureSessionLoaded(ctx);
    if (!sessionId) return false;
    if (!isBindable(item)) {
      if (ctx?.hasUI) ctx.ui.notify(`${item.title} is ${/^[aeiou]/.test(item.kind) ? "an" : "a"} ${item.kind}, a workspace: bind one of its tasks.`, "warning");
      return false;
    }
    // Stop tracking previous task if any
    if (activeTask) stopFileTracking(activeTask.workId);

    // Bind to new task. Its Record lives on the parent when that is a real
    // feature; under the Inbox (or nothing) it keeps its own.
    const featureId = await recordFeatureId(client, item);
    activeTask = {
      workId: item.id,
      domain: item.domain as string,
      boundAt: new Date().toISOString(),
      ...(featureId ? { featureId } : {}),
    };
    writeActiveTask(wolfDen, sessionId, activeTask);
    if (item.partOf) workspaceId = item.partOf as string;

    // Start tracking
    startFileTracking(item.id);
    onWorkBound(item.id as any, wolfName as any, new Date().toISOString());

    // A feature follows its tasks into build (non-critical)
    await syncFeatureStage(client, item).catch(() => {});

    await refreshActiveItem();
    updateWidget(ctx);
    return true;
  }

  /**
   * Bind to a FINISHED feature (the last task of it shipped): the session stays
   * on the feature until it is graduated or the user unbinds, and follow-up
   * discussion goes to the feature's Record (work = feature = the feature id).
   */
  async function bindToFeature(feature: WorkItem, ctx: any): Promise<boolean> {
    if (isSubagent()) return false;
    ensureSessionLoaded(ctx);
    if (!sessionId || feature.kind !== "feature" || feature.container) return false;
    if (activeTask) stopFileTracking(activeTask.workId);
    activeTask = {
      workId: feature.id,
      domain: feature.domain as string,
      boundAt: new Date().toISOString(),
      featureId: feature.id,
    };
    writeActiveTask(wolfDen!, sessionId, activeTask);
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
  /** Transitions the user said No to ("<id>:<from>-><to>"); not offered again this session. */
  const declinedTransitions = new Set<string>();

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
    if (activeItem && activeTask && ctx.hasUI && activeItem.kind !== "feature") {
      try {
        const resolved = await client.get(activeTask.workId);
        const body = "";
        const children = await client.query({ partOf: activeTask.workId }) ?? [];
        const recentNotes = activeItem.log.slice(-3).map((l) => l.text);

        const transitionCtx = extractTransitionContext(activeItem, body, children, recentNotes);
        const signal = detectTransition(activeItem, transitionCtx);

        const key = signal ? `${activeTask.workId}:${signal.from}->${signal.to}` : "";
        if (signal && signal.confidence !== "low" && !declinedTransitions.has(key)) {
          // Show transition prompt
          const confirm = await ctx.ui.confirm(signal.prompt, signal.reason ?? "");
          if (!confirm) declinedTransitions.add(key);
          if (confirm) {
            if (signal.to === "shipped") {
              await shipWithRollup(activeTask.workId);
            } else {
              const moved = await client.stage(activeTask.workId, signal.to);
              if (moved.stage === "in_build") await syncFeatureStage(client, moved).catch(() => {});
            }
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
    if (isSubagent()) return;
    ensureSessionLoaded(ctx);
    await refreshActiveItem();
    debugLog('before_agent_start', { activeTask: activeTask?.workId, activeItem: activeItem?.title });
    const all = await client.query({}) ?? [];
    if (!activeItem || !activeTask) {
      // No task bound: still tell the agent which workspace new tasks go to.
      const header = workspaceHeader(workspaceId, all, null);
      return {
        systemPrompt: event.systemPrompt + "\n<workspace>\n" + (header ? header + "\n" : "") +
          UNBOUND_CONTEXT +
          (header ? "\nNew tasks created with task_create go into this feature unless partOf is given." : "") +
          "\n" + BINDING_RULES + "\n</workspace>\n",
      };
    }

    // Read the working document body
    let docBody = "";
    try {
      const { body } = await client.getWithBody(activeTask.workId);
      docBody = renderWorkingDocument(body ?? "");
    } catch {
      // No document this turn; the rest of the context still goes in.
    }

    // The Record is kept on the feature: show it next to the task's own document.
    let featureRecord = "";
    if (activeTask.featureId && activeTask.featureId !== activeTask.workId) {
      try {
        const f = await client.getWithBody(activeTask.featureId);
        featureRecord = renderFeatureRecord(f.item.title, f.body ?? "");
      } catch { /* the task's own context still goes in */ }
    }

    const parts: string[] = [];
    if (boundReady) {
      parts.push(readyBoundContext(activeItem));
      parts.push("");
    }
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
      parts.push("## Working Document (plan + Record)");
      parts.push(docBody);
      parts.push("The Record is kept up to date by memory from this session's observations; task_update never replaces it. If the document above ends in […] it is clipped: do not write it back with task_update.");
    }

    if (featureRecord) {
      parts.push("");
      parts.push(featureRecord);
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
    parts.push(BINDING_RULES);
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


  /** `g`: preview the distilled contributions, send only after the owner confirms, then archive. */
  async function graduateItem(ctx: any, itemId: string): Promise<void> {
    // Graduate a ready feature/initiative: ship it, then send it to the KB.
    const all = await client.query({}) ?? [];
    const item = all.find((i) => i.id === itemId);
    if (!readyToGraduate(item, all)) {
      ctx.ui.notify("Not ready to graduate.", "warning");
      return;
    }
    if (!config.graduation) {
      ctx.ui.notify("Graduation not configured.", "warning");
      return;
    }
    const initiative = item.kind === "feature" ? initiativeOf(item, all) : undefined;
    let preview: GraduationPreview;
    try {
      ctx.ui.notify(`Distilling "${item.title}" for the knowledge base…`, "info");
      preview = await config.graduation.preview(item.id as string);
    } catch (e: any) {
      ctx.ui.notify(`Graduation failed: ${e.message}`, "error");
      return;
    }
    const text = renderGraduationPreview(preview);
    if (preview.blocked) {
      ctx.ui.notify(text, "warning");
      return;
    }
    const ok = await ctx.ui.confirm(
      item.kind === "initiative" ? `🎓 Complete "${item.title}"?` : `🎓 Graduate "${item.title}" to the knowledge base?`,
      text
    );
    if (!ok) {
      ctx.ui.notify("Graduation cancelled: nothing was sent.", "info");
      return;
    }
    try {
      ctx.ui.notify(`Graduating ${item.title}…`, "info");
      const done = await config.graduation.confirm(preview, shipWithRollup);
      if (activeTask && done.archived.includes(activeTask.workId)) unbindTask(ctx);
      await refreshActiveItem();
      updateWidget(ctx);
      ctx.ui.notify(`🎓 ${item.title} graduated and archived (${done.sent.length} contribution${done.sent.length === 1 ? "" : "s"} sent to Dewey).`, "info");
      // Its last feature delivered → the initiative can be completed (never automatic).
      const after = await client.query({}) ?? [];
      const parent = initiative ? after.find((i) => i.id === initiative.id) : undefined;
      if (readyToGraduate(parent, after)) {
        ctx.ui.notify(`🎓 All features of "${parent.title}" have graduated: press g on it to complete it.`, "info");
      }
    } catch (e: any) {
      ctx.ui.notify(`Graduation failed: ${e.message}`, "error");
    }
  }

  // ── Command: /task ────────────────────────────────────────────────────────

  type PanelAction = "bind" | "new" | { type: "bind"; target: WorkItem } | { type: "delete"; id: string } | { type: "depend"; id: string } | { type: "graduate"; id: string } | { type: "move"; id: string } | { type: "ship"; id: string } | { type: "standing"; id: string } | null;

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
            if (isIdeasFolder(focused)) return; // synthetic folder: nothing to act on
            if (data === "x") return done({ type: "delete", id: focused.id as string });
            if (data === "D") return done({ type: "depend", id: focused.id as string });
            if (data === "m" && !focused.container) return done({ type: "move", id: focused.id as string });
            if (data === "S") {
              if (focused.kind !== "initiative") {
                ctx.ui.notify("Only an initiative can be standing.", "warning");
                return;
              }
              return done({ type: "standing", id: focused.id as string });
            }
            if (data === "g") {
              // Try focused first — lets you graduate individual tasks (e.g.
              // Inbox items). Fall back to the open feature (right pane) when
              // focused isn't a graduation target.
              const opened = sel.openId ? items.find((i) => i.id === sel.openId) : undefined;
              const target = readyToGraduate(focused, allItems)
                ? focused
                : (opened && readyToGraduate(opened, allItems) ? opened : focused);
              if (target && readyToGraduate(target, allItems)) {
                return done({ type: "graduate", id: target.id as string });
              }
              ctx.ui.notify(notReadyReason(target), "warning");
              return;
            }
            if (data === "s") {
              // Ship: close the panel and let the outer command handler do the
              // confirm + mutation (same pattern as delete/graduate). Features
              // and initiatives use g to graduate, not s to ship.
              if (focused.container) return;
              if (!isBindable(focused)) {
                ctx.ui.notify(`${focused.title}: already ${focused.stage}.`, "warning");
                return;
              }
              if (focused.kind !== "task" && focused.kind !== "issue" && focused.kind !== "spike") {
                ctx.ui.notify(`Press g to graduate ${focused.kind}s.`, "warning");
                return;
              }
              return done({ type: "ship", id: focused.id as string });
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
              if (item.standing) return `${item.title} is standing: it never completes. Press S to change that.`;
              const left = kids.filter((k) => k.kind === "feature" && !k.graduated).length;
              return `${item.title}: ${left} feature(s) still to graduate (press g on each feature).`;
            }
            if (item.kind === "task" || item.kind === "issue" || item.kind === "spike") {
              return `${item.title} must be shipped before graduating (press s to ship).`;
            }
            return `Idea items don't graduate; convert to a task first.`;
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
              const fold = item.kind === "initiative" || isIdeasFolder(item) ? (sel.expanded.includes(item.id as string) ? "\u25be " : "\u25b8 ") : "  ";
              const folder = isIdeasFolder(item);
              const icon = folder ? KIND_ICONS.idea : item.container ? "\ud83d\udce5" : kindIcon(item);
              const { done: d, total } = folder ? { done: 0, total: ideaCount(item, items) } : progress(item, items);
              const count = total ? theme.fg("dim", folder ? ` ${total}` : ` ${d}/${total}`) : "";
              const open = item.id === sel.openId;
              const title = isComplete(item) ? theme.fg("dim", item.title)
                : cursor || open ? theme.fg("accent", item.title) : item.title;
              const stage = item.container ? ""
                : item.standing ? theme.fg("dim", " · standing")
                : readyToGraduate(item, allItems) ? theme.fg("success", " \ud83c\udf93 ready") : ` ${STAGE_ICONS[item.stage] ?? ""}`;
              out.push(`${cursor ? theme.fg("accent", "\u203a") : " "}${"  ".repeat(depth)}${fold}${chainPrefix(chain)}${icon} ${title}${count}${stage}${item.id === activeTask?.workId ? theme.fg("success", " \u25c0 bound") : ""}${extraMark(extra)}${relationMark(item.id as string)}`);
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
              if (ws.id === activeTask?.workId) out.push(theme.fg("success", "\u26d3 Bound \u2014 ready to graduate. Follow-up discussion goes to its Record."));
            }
            out.push("");
            const tree = rightTree(items, sel.openId);
            if (tree.length === 0) out.push(theme.fg("dim", "No tasks yet"));
            tree.forEach(({ item: t, chain, extra }, i) => {
              const cursor = sel.pane === "right" && i === sel.rightIdx;
              const bound = t.id === activeTask?.workId;
              const title = isComplete(t) ? theme.fg("dim", t.title) : cursor ? theme.fg("accent", t.title) : t.title;
              const kind = t.kind === "task" ? "" : theme.fg("dim", ` (${t.kind})`);
              out.push(`${cursor ? theme.fg("accent", "\u25b6") : " "} ${chainPrefix(chain)}${statusIcon(t)} ${title}${kind}${extraMark(extra)}${relationMark(t.id as string)}${bound ? theme.fg("success", readyToGraduate(t, allItems) ? "  \u25c0 bound \u00b7 ready to graduate" : "  \u25c0 bound") : ""}`);
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
            const hints = ["h/j/k/l move", "Space bind", "Enter open", "n new", "s ship", "m move", "D depend", "x delete", "g graduate", "S standing", "a auto-ship", "Esc close"];
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
          pi.sendUserMessage(newWorkPrompt(listSubscribedDomains(kbBase)));
        } catch {
          ctx.ui.pasteToEditor(newWorkPrompt(listSubscribedDomains(kbBase)));
        }
      } else if (action === "bind" && activeItem) {
        await promptTaskIteration(pi, ctx, client, activeItem);
        await refreshActiveItem();
        updateWidget(ctx);
      } else if (typeof action === "object" && action?.type === "bind") {
        await bindToTask(action.target, ctx);
        await refreshActiveItem();
        updateWidget(ctx);
      } else if (typeof action === "object" && action?.type === "ship") {
        try {
          const all = await client.query({}) ?? [];
          const target = all.find((i) => i.id === action.id);
          if (!target) {
            ctx.ui.notify("Work item not found.", "warning");
            return;
          }
          const ok = await ctx.ui.confirm(
            `📦 Mark "${target.title}" as shipped?`,
            target.successCriteria ? `Done when: ${target.successCriteria}` : "",
          );
          if (!ok) return;
          const shipped = await shipWithRollup(action.id);
          await client.note(action.id, "Completed.");
          if (activeTask && activeTask.workId === action.id) unbindTask(ctx);
          await refreshActiveItem();
          updateWidget(ctx);
          ctx.ui.notify(`✓ Shipped: ${shipped.title}`, "info");
        } catch (e: any) {
          ctx.ui.notify(`Failed to ship: ${e.message}`, "error");
        }
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
        await graduateItem(ctx, action.id);
      } else if (typeof action === "object" && action?.type === "standing") {
        try {
          const cur = (await client.query({}) ?? []).find((i) => i.id === action.id);
          if (!cur) return;
          const next = !cur.standing;
          const ok = await ctx.ui.confirm(
            next ? `Make "${cur.title}" standing?` : `Stop "${cur.title}" being standing?`,
            next
              ? "It will never be offered for completion. Its features keep updating its entry as they graduate."
              : "Once all its features have graduated, it can be completed with g.",
          );
          if (!ok) return;
          await client.setStanding(action.id, next);
          ctx.ui.notify(`${cur.title}: ${next ? "standing" : "no longer standing"}.`, "info");
        } catch (e: any) {
          ctx.ui.notify(`Failed: ${e.message}`, "error");
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
      }
    },
  });


  // ── Agent-callable tools ────────────────────────────────────────────────

  /** The bound item as the heads-up line names it. */
  const boundRef = () => (activeTask ? { id: activeTask.workId, title: activeItem?.id === activeTask.workId ? activeItem.title : undefined } : null);
  const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) });
  const ID_NOTE = " Optional id: act on that item instead of the bound one (the reply then warns that it is not the bound item).";

  pi.registerTool(
    defineTool({
      name: "task_bind",
      description:
        "Bind this session to the work item you are working on (task, issue or spike). Do it BEFORE you start: the bound item decides where what you learn is kept " +
        "(its feature's Record, not den topics). One bound item per session; call it again to switch.",
      parameters: Type.Object({
        id: Type.String({ description: "Work item ID to bind to" }),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        await syncBinding(ctx);
        if (isSubagent()) return text(SUBAGENT_NO_BIND, true);
        let item: WorkItem;
        try { item = await client.get(params.id); } catch { return text(`Work item ${params.id} not found.`, true); }
        if (!isBindable(item)) return text(`Cannot bind to ${item.kind} ${item.id}: bind one of its tasks.`, true);
        const previous = boundRef();
        if (!(await bindToTask(item, ctx))) return text(`Could not bind ${item.id}.`, true);
        const switched = previous && previous.id !== item.id ? `\nSwitched from ${previous.title ?? previous.id} (${previous.id}).` : "";
        return text(`Bound to: [${item.id}] ${item.title}\nStage: ${item.stage}${item.successCriteria ? `\nSuccess: ${item.successCriteria}` : ""}${switched}`);
      },
    })
  );

  pi.registerTool(
    defineTool({
      name: "task_unbind",
      description: "Unbind from the current work item without shipping it. What you learn afterwards goes to den topics until you bind again.",
      parameters: Type.Object({}),
      async execute(_id, _params, _signal, _onUpdate, ctx) {
        await syncBinding(ctx);
        if (isSubagent()) return text(SUBAGENT_NO_BIND, true);
        ensureSessionLoaded(ctx);
        if (!activeTask) return text("No work item bound.");
        const was = activeTask.workId;
        unbindTask(ctx);
        return text(`Unbound from ${was}.`);
      },
    })
  );

  pi.registerTool(
    defineTool({
      name: "task_current",
      description: "Show the currently bound work item.",
      parameters: Type.Object({}),
      async execute(_id, _params, _signal, _onUpdate, ctx) {
        await syncBinding(ctx);
        ensureSessionLoaded(ctx);
        if (!activeTask) return text(UNBOUND_CONTEXT);
        await refreshActiveItem();
        if (!activeItem) return text(`Bound item ${activeTask?.workId ?? ""} is gone.`, true);
        const i = activeItem;
        return text(`ID: ${i.id}\nTitle: ${i.title}\nKind: ${i.kind}\nStage: ${i.stage}\nDomain: ${i.domain}${i.successCriteria ? `\nSuccess: ${i.successCriteria}` : ""}`);
      },
    })
  );

  pi.registerTool(
    defineTool({
      name: "task_update",
      description: "Update the active work item's working document (plan, notes, findings). This replaces the body of the .md file. Read the current content from the system prompt's <active_task> Working Document section, then write back the updated version." + ID_NOTE,
      parameters: Type.Object({
        body: Type.String({ description: "The full updated markdown body for the work item (everything below the frontmatter)" }),
        id: Type.Optional(Type.String({ description: "Work item to update (default: the bound one)" })),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        await syncBinding(ctx);
        const target = params.id ?? activeTask?.workId;
        if (!target || (!params.id && !activeItem)) return text("No active task. Bind one with task_bind.", true);
        try {
          // The Record belongs to memory: whatever the agent writes, the item's
          // current Record section stays as it is.
          const { item, body: current } = await client.getWithBody(target);
          const record = extractRecord(current ?? "");
          await client.updateBody(target, record ? replaceRecordSection(params.body, record) : params.body);
          return text(headsUp(`Updated working document for: ${item.title}`, { id: item.id, title: item.title }));
        } catch (e: any) {
          return text(e.message, true);
        }
      },
    })
  );

  pi.registerTool(
    defineTool({
      name: "task_note",
      description: "Add a progress note to the active work item's log." + ID_NOTE,
      parameters: Type.Object({
        text: Type.String({ description: "The progress note text" }),
        id: Type.Optional(Type.String({ description: "Work item to note (default: the bound one)" })),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        await syncBinding(ctx);
        const target = params.id ?? activeTask?.workId;
        if (!target) return text("No active task. Bind one with task_bind.", true);
        try {
          const item = await client.note(target, params.text);
          if (target === activeTask?.workId) activeItem = item;
          await syncFeatureStage(client, item).catch(() => {});
          updateWidget(ctx);
          return text(headsUp(`Logged: ${params.text} (${item.log.length} entries)`, { id: item.id, title: item.title }));
        } catch (e: any) {
          return text(e.message, true);
        }
      },
    })
  );

  pi.registerTool(
    defineTool({
      name: "task_stage",
      description:
        "Advance the active work item to a new stage. Stages: idea → plan → feasibility → approved → in_build → shipped → live → archived. " +
        "Moving an item to in_build binds it when nothing is bound." + ID_NOTE,
      parameters: Type.Object({
        to: Type.String({ description: "Target stage" }),
        id: Type.Optional(Type.String({ description: "Work item to move (default: the bound one)" })),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        await syncBinding(ctx);
        const target = params.id ?? activeTask?.workId;
        if (!target) return text("No active task. Bind one with task_bind.", true);
        try {
          const item = params.to === "shipped" || params.to === "live"
            ? await shipWithRollup(target)
            : await client.stage(target, params.to);
          if (target === activeTask?.workId) activeItem = item;
          if (item.stage === "in_build") await syncFeatureStage(client, item).catch(() => {});
          let reply = `${item.title} → ${item.stage}`;
          if (item.stage === "in_build" && !activeTask && isBindable(item) && (await bindToTask(item, ctx))) {
            reply += `\nNothing was bound, so it is bound now: what you learn goes to its Record.`;
          }
          updateWidget(ctx);
          return text(headsUp(reply, { id: item.id, title: item.title }));
        } catch (e: any) {
          return text(e.message, true);
        }
      },
    })
  );

  pi.registerTool(
    defineTool({
      name: "task_schedule",
      description:
        "Pin the active task to a calendar slot. scheduledFor is 'YYYY-MM-DD HH:MM' " +
        "(local, no TZ). durationMinutes defaults to 60. Pass clear=true to unschedule.",
      parameters: Type.Object({
        scheduledFor: Type.Optional(
          Type.String({ description: "YYYY-MM-DD HH:MM local time" })
        ),
        durationMinutes: Type.Optional(
          Type.Number({ description: "Block length in minutes (default 60)" })
        ),
        clear: Type.Optional(
          Type.Boolean({ description: "Unschedule (clears both fields)" })
        ),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        await syncBinding(ctx);
        if (!activeTask) return { content: [{ type: "text" as const, text: "No active task." }], isError: true };
        const unscheduling = params.clear === true || params.scheduledFor === "";
        const sched: string | null = unscheduling ? null : (params.scheduledFor ?? null);
        if (!unscheduling && !sched) {
          return { content: [{ type: "text" as const, text: "Provide scheduledFor='YYYY-MM-DD HH:MM' or clear=true." }], isError: true };
        }
        if (sched && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(sched)) {
          return { content: [{ type: "text" as const, text: `scheduledFor must be 'YYYY-MM-DD HH:MM', got '${sched}'.` }], isError: true };
        }
        try {
          const item = await client.schedule(activeTask.workId, sched, params.durationMinutes ?? null);
          activeItem = item;
          updateWidget(ctx);
          const label = unscheduling
            ? `${item.title} unscheduled`
            : `${item.title} @ ${sched} (${(item as any).durationMinutes ?? params.durationMinutes ?? 60} min)`;
          return { content: [{ type: "text" as const, text: label }] };
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
        await syncBinding(ctx);
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
        await syncBinding(ctx);
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
        await syncBinding(ctx);
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
      description:
        "Create a new work item. Hierarchy: initiative > feature > task/issue/spike; tasks need a feature parent. " +
        "A task/issue/spike with no partOf goes into the current workspace (the bound task's feature, or the last feature worked in this session), else the domain's Inbox. " +
        "Features may be standalone or under an initiative. " +
        "PARENT MUST BE IN THE SAME DOMAIN: a task in one domain cannot sit under a feature in another. " +
        "If no feature in the same domain fits, OMIT partOf — the item lands in that domain's Inbox and can be moved later. " +
        "Pick domain by SUBJECT: a fix to a skill is a code change in the domain that owns the code, even if the skill is about something else.",
      parameters: Type.Object({
        kind: Type.String({ description: "idea | initiative | feature | task | issue | spike" }),
        domain: Type.String({ description: `Domain: ${formatDomainChoices(listSubscribedDomains(kbBase))}` }),
        title: Type.String({ description: "Short title for the work item" }),
        area: Type.Optional(Type.String({ description: "Horizontal area: marketing, engineering, analysis…" })),
        successCriteria: Type.Optional(Type.String({ description: "Done-condition (required for tasks)" })),
        assignee: Type.Optional(Type.String({ description: "Wolf to assign (default: current wolf)" })),
        partOf: Type.Optional(Type.String({ description: "Parent work item ID (a feature for task/issue/spike; an initiative or none for a feature)" })),
        standing: Type.Optional(Type.Boolean({ description: "Initiatives only: never completes; it keeps gaining features (e.g. a new week each week)" })),
        bind: Type.Optional(Type.Boolean({ description: "Bind the new item (task/issue/spike) so what you learn goes to its Record. Default: true when nothing is bound and the item is assigned to you, else false." })),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        await syncBinding(ctx);
        // Resolve partOf first so we can check its domain. Keep the current
        // workspace-defaulting behaviour (bound task's feature; last-worked
        // feature in session).
        const resolvedPartOf =
          params.partOf ??
          (isBindable({ kind: params.kind as any }) ? activeItem?.partOf ?? workspaceId : null);

        // Cross-domain guard: if the resolved parent is in a different domain
        // than the new item, fail fast with a clear message. The server
        // enforces this too (placementError), but we save a round-trip and
        // produce a nicer error.
        if (resolvedPartOf) {
          const parent = (await client.query({})).find((i) => i.id === resolvedPartOf);
          if (parent && parent.domain !== params.domain) {
            return {
              content: [{
                type: "text" as const,
                text:
                  `Parent ${resolvedPartOf} is in domain '${parent.domain}', not '${params.domain}'. ` +
                  `A task must sit under a feature in the SAME domain. ` +
                  `Either change this item's domain to '${parent.domain}', pick a feature in '${params.domain}', or omit partOf to land in the '${params.domain}' Inbox.`,
              }],
              isError: true,
            };
          }
        }

        const input: CreateWorkInput = {
          kind: params.kind as any,
          domain: params.domain,
          title: params.title,
          assignee: params.assignee ?? wolfName,
          area: params.area,
          successCriteria: params.successCriteria,
          partOf: resolvedPartOf,
          standing: params.standing,
        };
        try {
          const result = await client.create(input);
          let reply = `Created ${result.id}: ${result.item.title} [${result.item.stage}]`;
          // One at a time, from the binding as it is now: the first task created binds, the rest see it.
          reply += await bindSerial(async () => {
            await syncBinding(ctx);
            const bindInput = { kind: params.kind, assignee: input.assignee, wolf: wolfName, bound: !!activeTask, bind: params.bind };
            if (isSubagent()) return ""; // a subagent never binds
            if (shouldBindOnCreate(bindInput)) return (await bindToTask(result.item, ctx)) ? `\nBound to it.` : `\nNot bound: could not bind it.`;
            return `\nNot bound: ${notBoundReason(bindInput)}.`;
          });
          return { content: [{ type: "text" as const, text: reply }] };
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
      description: "Mark the active task as shipped and bind to the next unfinished sibling task. Use this when the current task's success criteria are met. Unless the wolf's ship policy is auto (WOLFPACK_TASK_SHIP=auto), the user is asked to confirm first; if they decline, the task is not shipped." + ID_NOTE + " Shipping another item leaves your binding as it is.",
      parameters: Type.Object({
        id: Type.Optional(Type.String({ description: "Work item to ship (default: the bound one)" })),
      }),
      async execute(_id, params, _signal, onUpdate, ctx) {
        await syncBinding(ctx);
        if (params.id && params.id !== activeTask?.workId) {
          // Another item than the bound one: ship it, keep the binding.
          try {
            const other = await client.get(params.id);
            if (shouldConfirmShip(shipPolicy(), !!ctx?.hasUI) && !(await ctx.ui.confirm(`📦 Mark "${other.title}" as shipped?`, other.successCriteria ? `Done when: ${other.successCriteria}` : ""))) {
              return text(`Not shipped: the user declined. "${other.title}" stays in ${other.stage}.`);
            }
            const shippedOther = await shipWithRollup(params.id);
            await client.note(params.id, "Completed.");
            return text(headsUp(`✓ Shipped: ${shippedOther.title}`, { id: shippedOther.id, title: shippedOther.title }));
          } catch (e: any) {
            return text(`Failed to ship: ${e.message}`, true);
          }
        }
        if (!activeTask || !activeItem) return { content: [{ type: "text" as const, text: "No active task. Bind one with task_bind." }], isError: true };
        if (activeItem.kind === "feature") {
          return text(`Bound to the feature "${activeItem.title}", not to a task. ${boundReady ? "It is ready to graduate: the user presses g in /task." : "Bind one of its tasks to ship it."}`, true);
        }

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
          const result = await shipWithRollup(activeTask.workId);
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

        // Find the next unfinished sibling; with none left, stay on the finished
        // feature (or on the finished loose task) until it is graduated.
        try {
          const all = await client.query({}) ?? [];
          const parent = shipped.partOf ? all.find((i) => i.id === shipped.partOf) : undefined;
          const realFeature = parent && parent.kind === "feature" && !parent.container ? parent : undefined;
          if (!realFeature) {
            // A shipped loose task (Inbox or no parent) is complete: unbound. Graduating it stays the owner's call.
            if (readyToGraduate(shipped, all)) {
              resultText += `\n🎓 "${shipped.title}" is done and ready to graduate on its own: press g on it in /task.`;
            }
            unbindTask(ctx);
            resultText += `\n${completeLine(shipped.title, shipped.id as string)}`;
          } else {
            // Same pick as the selector: first open, unblocked task, in progress first.
            const nextItem = firstTask(rightRows(all, realFeature.id as string), all) ?? null;
            if (nextItem) {
              await bindToTask(nextItem, ctx);
              resultText += `\n→ Next: ${nextItem.title} [${nextItem.stage}]`;
            } else if (readyToGraduate(realFeature, all)) {
              // Last task done → the feature is ready to graduate. Never automatic:
              // the user graduates it with `g` in /task.
              await bindToFeature(realFeature, ctx);
              resultText += `\n🎓 All tasks under "${realFeature.title}" are done. It is ready to graduate: press g on it in /task.`;
              resultText += `\n${readyBoundReply(realFeature)}`;
            } else {
              unbindTask(ctx);
            }
          }
        } catch {
          // Ignore sibling binding errors
        }

        return { content: [{ type: "text" as const, text: resultText }] };
      },
    })
  );

  return { getBoundWork, graduate: graduateItem, refresh: async (ctx: any) => { ensureSessionLoaded(ctx); await refreshActiveItem(); updateWidget(ctx); } };
}
