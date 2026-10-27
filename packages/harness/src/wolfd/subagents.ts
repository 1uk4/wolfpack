/**
 * SubagentManager: the durable counterpart of the terminal pi's subagent extension, inside one wolfd.
 *
 * A subagent is a task-owned pi-durable conversation owned by the thread that spawned it (engine `createOwned`), served
 * as a thread of kind `subagent`. It starts fresh with its profile's system prompt and the brief, has the profile's tools
 * but never the spawn tools (depth 1), and returns its final answer to the parent as a steer message. Its questions
 * (ask_user_question cards) go to the parent the same way; it then waits until the parent (or the operator) replies.
 *
 * State lives in `<den>/wolfd/subagents.json` and the child ledgers (subagent-store.ts); the conversation and its
 * history are the store's. After a restart `recover()` re-attaches every child, so a turn that was running goes on and
 * its result still reaches the parent; results not yet taken by a parent are redelivered.
 *
 * Isolation (ticket 7): a writer in a git cwd gets its own worktree and branch under the workspaces root; the first one
 * from a feature thread also creates `feat/<feature>` and moves the thread's cwd there (a conversation's cwd is its
 * agent state, set with `configure({ cwd })`; the engine's execution env reads it for every tool call). A writer left
 * in the shared checkout (isolation none) is refused while another writer holds it (WriterGuard). Outside git nothing
 * runs git at all.
 *
 * Concurrency: a child holds a slot from the moment it starts until it is done, failed or stopped. That includes
 * `waiting` (it asked its parent a question): it keeps its slot, because its conversation and warm claude process stay
 * loaded and the reply resumes it at once; releasing it would let a queued child take the slot and leave the answered
 * child queued behind it, parent waiting on both. Per-wolf cap (wolf.yaml `subagents.maxRunning`, default 3) is counted
 * in-process; the per-host cap (default 6) is a slot directory shared by every wolfd on the host (subagent-slots.ts).
 * A spawn past either cap is `queued` (persisted, FIFO, position in the summary) and starts when a slot frees; a resume
 * of a finished child needs a slot too and queues the same way. Home and feature threads never take one.
 * Limit: the claude bridge keeps an idle child process for its provider-wide idleTtlMs (10 min, ~200 MB) after a turn,
 * with no per-conversation release, so a done child's process can outlive its slot; the cap bounds RUNNING children,
 * not those lingering processes (lowering idleTtlMs would be provider-wide, home included).
 *
 */
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { discoverAgents, loadAgent, parseCommaList, type AgentDefinition, type AgentIsolation, type DiscoverOptions } from "@wolfpack/agents";
import { TIERS, isTier } from "@wolfpack/engine";
import { readBindingFile } from "@wolfpack/memory";
import { WriterGuard, abandonChild, createChildWorkspace, createHomeChildWorkspace, defaultIsolation, ensureFeatureWorkspace, isWriter, repoOf, resolveWorkspacesRoot, workspaceConflict, featureBranch, type RepoInfo, type Workspace } from "@wolfpack/workspaces";
import type { LedgerEntry, LedgerKind, LedgerParty, SubagentState, SubmitAck, ThreadEvent, ThreadSummary } from "@wolfpack/protocol";
import type { ConfigureOptions, EngineConversation, ThinkingLevel, WhenBusy } from "../engine/index.js";
import { HttpError } from "./http-error.js";
import { DEFAULT_HOST_MAX, SlotPool } from "./subagent-slots.js";
import { appendLedger, loadChildren, readLedger, saveChildren, type ChildRecord, type Delivery } from "./subagent-store.js";
import type { ThreadRuntime, WolfEventDraft } from "./thread.js";
import { loadThreads, setThreadWorkspace, type SavedThread } from "./threads.js";

/** The tools every spawn tool set shares; a child never gets them. */
export const SPAWN_TOOLS = ["subagent", "subagent_message", "subagents_list", "subagent_stop"] as const;
/** What a child always gets: the way to ask its parent a question. */
const CHILD_ALWAYS_TOOLS = ["ask_user_question"];
/** A profile without `tools:` gets the coding tools. */
const DEFAULT_PROFILE_TOOLS = ["read", "write", "edit", "bash"];

export interface SubagentOptions {
  /** The wolf's directory (where wolf.yaml lives): `<wolfHome>/agent/agents` is the wolf's roster layer. */
  wolfHome: string;
  /** The home thread's cwd: the default cwd of a spawn, and where `<cwd>/.pi/agents` is looked up. */
  workspace: string;
  /** The home system prompt for a cwd (its "Your workspace is …" line): a feature thread that moves gets it from the next turn. */
  instructionsFor?(cwd: string): string;
  /** Where worktrees go (wolf.yaml `workspaces.root`). Default `<wolfHome>/workspaces`. */
  workspacesRoot?: string;
  /** An existing conversation as it is stored (no reconciling with the home configuration: a child keeps its own). */
  getConversation(id: string): Promise<EngineConversation | undefined>;
  /** Terminate a child's owner task (the parked task its conversation hangs under). */
  releaseOwner(taskId: string): Promise<void>;
  /** A conversation owned by a parked task of `ownerId`. */
  createOwned(ownerId: string, init: ConfigureOptions): Promise<{ conversation: EngineConversation; taskId: string }>;
  /** A tier resolved through the wolf's model table. Throws for a tier it cannot resolve. */
  resolveTier(tier: string): { provider: string; modelId: string; thinking?: string };
  /** Names of every tool the engine can offer a conversation. */
  registeredTools(): string[];
  /** Per-wolf cap on running children (wolf.yaml `subagents.maxRunning`). Default 3. */
  maxRunning?: number;
  /** Per-host cap across every wolfd on the host. Default 6. */
  hostMax?: number;
  /** The host-wide slot directory. Default `~/.wolfpack/run/subagent-slots`. */
  slotDir?: string;
  /** How often (ms) a queued child retries a host slot another wolfd may have freed. Default 2000. */
  slotPollMs?: number;
  /** First delay (ms) before a failed delivery to a parent is tried again; doubles up to 30s. Default 500. */
  retryBaseMs?: number;
}

/** What the manager needs from the server around it. */
export interface SubagentPort {
  readonly name: string;
  readonly den: string;
  thread(id: string): ThreadRuntime | undefined;
  /** Is this a thread wolfd knows (attached, or registered on disk)? */
  knownThread(id: string): boolean;
  threadOfConversation(conversationId: string): ThreadRuntime | undefined;
  /** Register a thread for an existing or new child conversation and attach it. */
  attachChild(summary: ThreadSummary, conv: EngineConversation): Promise<ThreadRuntime>;
  /** Unregister (and close) a child's thread. */
  detachChild(id: string): Promise<void>;
  emitWolf(draft: WolfEventDraft): void;
  onError(error: unknown): void;
  settleMs: number;
}

/** What a tool call answers the model. */
export interface ToolOutcome {
  text: string;
  isError?: boolean;
}

/** The outcome of admit(): run now, or queue at `seq`. */
interface Admission {
  run: boolean;
  seq?: number;
}

export interface SpawnParams {
  agent: string;
  task: string;
  name?: string;
  model?: string;
  cwd?: string;
  isolation?: string;
}

const fail = (text: string): ToolOutcome => ({ text, isError: true });

export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Compact token count: 850, 3.2k, 45k. */
function formatTokens(n: number): string {
  return n < 1000 ? String(n) : n < 10000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`;
}

/** Is `dir` inside a git checkout? Looks for a `.git` entry upward, so a non-git cwd never runs git. */
function insideGit(dir: string): boolean {
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (existsSync(join(d, ".git"))) return true;
    if (dirname(d) === d) return false;
  }
}

/** A branch-safe slug: lowercase letters, digits, "." "_" "-"; never empty. */
function slugify(text: string, max = 40): string {
  const s = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/g, "");
  return s || "x";
}

/** Pinned by the mid-turn cwd test: tools called later in the same turn already run in the new cwd; the prompt names it from the next turn. */
const CWD_MOVE_NOTE = "Tools you call later in this turn already run there; your system prompt names it from your next turn.";

const WORKTREE_HINT = 'Use isolation: "worktree" for a writer that should not share the checkout.';

function realpathOr(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
}

const WORK_ID = /\bwork-[a-z0-9]+-[A-Za-z0-9]+\b/;

/** One line of "what it is doing": the tool and the first thing it was given. */
function stepOf(name: string, args: unknown): string {
  const a = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const hint = [a.path, a.file_path, a.command, a.pattern, a.query].find((v) => typeof v === "string") as string | undefined;
  const text = hint ? `${name} ${hint.replace(/\s+/g, " ").trim()}` : name;
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

export class SubagentManager {
  private records: ChildRecord[];
  private readonly unobserve = new Map<string, () => void>();
  private readonly parentWatch = new Map<string, () => void>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly lastError = new Map<string, string>();
  private readonly ledgerSeq = new Map<string, number>();
  private deliverySeq = 0;
  private closed = false;
  /** Owner releases in flight, per child: a resume waits for its child's. */
  private readonly releasing = new Map<string, Promise<void>>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly retryDelay = new Map<string, number>();
  /** The running writers, by git working dir (children; the threads themselves are checked live). */
  private readonly guard = new WriterGuard();
  private readonly featureLocks = new Map<string, Promise<unknown>>();
  private readonly pool: SlotPool;
  private readonly maxRunning: number;
  /** Children holding a slot (running or waiting). */
  private readonly held = new Set<string>();
  private queueSeq = 0;
  private gate: Promise<unknown> = Promise.resolve();
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private readonly shownPosition = new Map<string, number>();
  /** Spawns/resumes that decided to queue and have not yet put their record in: id -> queue seq (keeps FIFO tight). */
  private readonly reserved = new Map<string, number>();
  private lastSlotError = "";

  constructor(
    private readonly port: SubagentPort,
    private readonly opts: SubagentOptions,
  ) {
    this.records = loadChildren(port.den, (e) => port.onError(e));
    for (const r of this.records) for (const d of r.outbox) this.deliverySeq = Math.max(this.deliverySeq, d.n);
    for (const r of this.records) this.queueSeq = Math.max(this.queueSeq, r.queuedSeq ?? 0);
    this.maxRunning = Math.max(1, Math.floor(opts.maxRunning ?? 3));
    this.pool = new SlotPool(opts.slotDir ?? join(homedir(), ".wolfpack", "run", "subagent-slots"), Math.max(1, Math.floor(opts.hostMax ?? DEFAULT_HOST_MAX)), port.name, (e) => this.slotError(e));
  }

  close(): void {
    this.closed = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    // A clean shutdown gives its slots back; recover() takes them again for the children that go on.
    for (const id of this.held) this.pool.release(id);
    this.held.clear();
    this.pool.close();
    for (const off of this.unobserve.values()) off();
    for (const off of this.parentWatch.values()) off();
    for (const t of this.retryTimers.values()) clearTimeout(t);
    this.retryTimers.clear();
    this.unobserve.clear();
    this.parentWatch.clear();
  }

  // ------------------------------------------------------------ views

  children(parentThreadId: string): ThreadSummary[] {
    return this.records.filter((r) => r.parentThreadId === parentThreadId).map((r) => this.port.thread(r.id)?.threadSummary() ?? this.summaryOf(r));
  }

  ledgerOf(childThreadId: string): LedgerEntry[] | undefined {
    return this.records.some((r) => r.id === childThreadId) ? readLedger(this.port.den, childThreadId, (e) => this.port.onError(e)) : undefined;
  }

  isChild(threadId: string): boolean {
    return this.records.some((r) => r.id === threadId);
  }

  summaryOf(r: ChildRecord): ThreadSummary {
    return {
      id: r.id,
      wolf: this.port.name,
      kind: "subagent",
      title: r.name,
      parentThreadId: r.parentThreadId,
      agent: r.agent,
      state: r.state,
      startedAt: r.startedAt,
      ...(r.finishedAt ? { finishedAt: r.finishedAt } : {}),
      ...(r.step ? { step: r.step } : {}),
      tokens: r.tokens,
      ...(r.taskId ? { taskId: r.taskId } : {}),
      ...(r.state === "queued" ? { queuePosition: this.positionOf(r) } : {}),
    };
  }

  /** 1-based place in the queue. */
  private positionOf(r: ChildRecord): number {
    return 1 + this.records.filter((o) => o.state === "queued" && (o.queuedSeq ?? 0) < (r.queuedSeq ?? 0)).length;
  }

  private roster(): DiscoverOptions {
    return { cwd: this.opts.workspace, agentDir: join(this.opts.wolfHome, "agent") };
  }

  // ------------------------------------------------------------ tools

  /** `subagents_list`: the roster, then the calling thread's children. */
  list(callerConversationId: string): ToolOutcome {
    const agents = discoverAgents(this.roster()).filter((a) => !a.disableModelInvocation);
    const lines = agents.map((a) => {
      const badge = a.source === "project" ? " (project)" : "";
      const desc = a.description ? ` — ${a.description}` : "";
      const model = a.model ? `${a.model}, ` : "";
      return `• ${a.name}${badge} [${model}${a.pane ? "pane" : "background"}]${desc}`;
    });
    const out = [lines.length ? lines.join("\n") : "No subagent definitions found."];
    const caller = this.port.threadOfConversation(callerConversationId);
    const mine = caller ? this.records.filter((r) => r.parentThreadId === caller.summary.id) : [];
    if (mine.length > 0) {
      const now = Date.now();
      out.push(
        "\nYour sub-agents:\n" +
          mine
            .map((r) => {
              const secs = Math.floor(((r.finishedAt ? Date.parse(r.finishedAt) : now) - Date.parse(r.runStartedAt)) / 1000);
              return `• ${r.name} [${r.agent}] ${r.state} — ${formatElapsed(Math.max(0, secs))}${r.step && r.state === "running" ? `, ${r.step}` : ""}, ${formatTokens(r.tokens)} tokens`;
            })
            .join("\n"),
      );
    }
    return { text: out.join("\n") };
  }

  /** `subagent`: spawn a child and return at once. */
  async spawn(callerConversationId: string, params: SpawnParams): Promise<ToolOutcome> {
    const parent = this.port.threadOfConversation(callerConversationId);
    if (!parent) return fail("Cannot spawn: the calling conversation is not a thread of this wolf.");
    // Depth 1: only home and feature threads spawn. (A child is not even offered the tool.)
    if (parent.summary.kind === "subagent") return fail("Sub-agents cannot spawn sub-agents. Do the work yourself, or ask your parent via ask_user_question.");

    const roster = discoverAgents(this.roster());
    const permitted = roster.map((a) => a.name).join(", ") || "(none)";
    if (!params.agent) return fail(`You must specify which agent to spawn via the "agent" field. Available agents: ${permitted}.`);
    const def = roster.find((a) => a.name === params.agent) ? loadAgent(params.agent, this.roster()) : null;
    if (!def) return fail(`You may not spawn the "${params.agent}" agent — it is not a known agent. Available agents: ${permitted}.`);
    if (!params.task?.trim()) return fail("`task` (the brief) is required.");

    const tier = params.model ?? def.model ?? "smart";
    if (!isTier(tier)) return fail(`subagent model must be a tier (${TIERS.join("|")}), got ${JSON.stringify(tier)}`);
    let model: ReturnType<SubagentOptions["resolveTier"]>;
    try {
      model = this.opts.resolveTier(tier);
    } catch (e) {
      return fail(`Cannot resolve model tier "${tier}": ${e instanceof Error ? e.message : String(e)}`);
    }
    if (params.isolation !== undefined && params.isolation !== "worktree" && params.isolation !== "none") return fail(`isolation must be "worktree" or "none", got ${JSON.stringify(params.isolation)}`);

    const { tools, missing } = this.childTools(def);
    const name = this.uniqueName(parent.summary.id, params.name?.trim() || def.name);
    const id = `${this.port.name}/sub-${randomUUID().slice(0, 8)}`;
    const plan = await this.planIsolation({ parent, def, requested: params.isolation as AgentIsolation | undefined, cwd: this.resolveCwd(params.cwd, def, parent), name, id });
    if (!plan.ok) return fail(plan.error);
    const { isolation, cwd, note: isolationNote } = plan;
    const now = new Date().toISOString();
    const taskId = WORK_ID.exec(params.task)?.[0] ?? this.boundTask(parent);

    const init: ConfigureOptions = {
      model: { provider: model.provider, modelId: model.modelId },
      ...(model.thinking ? { thinkingLevel: model.thinking as ThinkingLevel } : {}),
      tools,
      cwd,
      instructions: childInstructions(def, name),
    };
    let owned: Awaited<ReturnType<SubagentOptions["createOwned"]>>;
    try {
      owned = await this.opts.createOwned(parent.conv.id, init);
    } catch (e) {
      // (createOwned has already terminated the owner task if only the conversation failed)
      this.guard.releaseAll(id);
      if (plan.workspace) await this.dropWorkspace(plan.workspace);
      return fail(`Could not start the sub-agent: ${e instanceof Error ? e.message : String(e)}`);
    }

    let adm: Admission;
    try {
      adm = await this.admit(id);
    } catch (e) {
      await this.opts.releaseOwner(owned.taskId).catch((err) => this.port.onError(err));
      return fail(`Could not start the sub-agent: ${e instanceof Error ? e.message : String(e)}`);
    }
    const run = adm.run;
    const rec: ChildRecord = {
      id,
      conversationId: owned.conversation.id,
      ownerTaskId: owned.taskId,
      parentThreadId: parent.summary.id,
      agent: def.name,
      name,
      brief: params.task,
      tier,
      cwd,
      isolation,
      ...(plan.workspace ? { workspace: plan.workspace } : {}),
      ...(plan.guardDir ? { guardDir: plan.guardDir } : {}),
      state: run ? "running" : "queued",
      ...(adm.seq ? { queuedSeq: adm.seq } : {}),
      startedAt: now,
      runStartedAt: now,
      tokens: 0,
      ...(taskId ? { taskId } : {}),
      outbox: [],
    };
    // Registry first, like feature threads: a crash after this leaves a child wolfd re-attaches, never an orphan conversation.
    this.records.push(rec);
    this.reserved.delete(id);
    this.persist();
    try {
      await this.attach(rec, owned.conversation);
    } catch (e) {
      await this.discard(rec);
      return fail(`Could not start the sub-agent: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (run) {
      try {
        await owned.conversation.submit({ input: params.task, whenBusy: "reject" });
      } catch (e) {
        await this.discard(rec);
        return fail(`Sub-agent "${name}" could not start: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    this.ledger(rec, "parent", "child", "brief", params.task);
    this.announce(rec);
    if (!run) {
      this.shownPosition.set(id, this.positionOf(rec)); // (announced just above)
      void this.pump(); // (a slot may have freed while this spawn was being set up; also starts the poll)
    }

    const notes = [
      missing.length ? `Notice: this runtime has no ${missing.join(", ")} tool${missing.length > 1 ? "s" : ""}; the sub-agent runs without ${missing.length > 1 ? "them" : "it"}.` : "",
      isolationNote,
    ].filter(Boolean);
    return {
      text:
        (notes.length ? `${notes.join(" ")} ` : "") +
        (run
          ? `Sub-agent "${name}" launched and is now running. `
          : `Sub-agent "${name}" is queued (position ${this.positionOf(rec)}): ${this.maxRunning} sub-agents per wolf and ${this.pool.hostMax} per host run at once. It starts by itself when a slot frees. `) +
        `Do NOT generate or assume any results — you have no idea what the sub-agent will do or produce. ` +
        `The results will be delivered to you automatically as a steer message when the sub-agent finishes. ` +
        `Until then, move on to other work or tell the user you're waiting.`,
    };
  }

  /** `subagent_message`: steer a running child, or resume a finished or waiting one. The next result is delivered again. */
  async message(callerConversationId: string, name: string, message: string): Promise<ToolOutcome> {
    const parent = this.port.threadOfConversation(callerConversationId);
    if (!name?.trim()) return fail("Provide the subagent's `name` to steer (if running) or resume (if finished).");
    if (!message?.trim()) return fail("`message` is required.");
    const rec = parent ? this.byName(parent.summary.id, name.trim()) : undefined;
    if (!rec) {
      const known = parent ? this.records.filter((r) => r.parentThreadId === parent.summary.id).map((r) => r.name) : [];
      return fail(`No subagent named "${name}" in this thread. ` + (known.length ? `Known subagents: ${known.join(", ")}.` : "No subagents have been spawned in this thread yet."));
    }
    try {
      const was = rec.state;
      await this.send(rec, message, "parent", "steer");
      return {
        text:
          was === "running"
            ? `Message delivered to sub-agent "${rec.name}". Its result will arrive as a steer message.`
            : `Sub-agent "${rec.name}" resumed with your message. Its result will arrive as a steer message; don't poll.`,
      };
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  }

  /** `subagent_stop`: cancel a child's turn. */
  async stopByName(callerConversationId: string, name: string): Promise<ToolOutcome> {
    const parent = this.port.threadOfConversation(callerConversationId);
    const rec = parent && name?.trim() ? this.byName(parent.summary.id, name.trim()) : undefined;
    if (!rec) return fail(`No subagent named "${name}" in this thread.`);
    return this.stop(rec.id, "parent");
  }

  /** Token use of one model response of a conversation (every child's afterResponse reports here). */
  usage(conversationId: string, tokens: number): void {
    const rec = this.records.find((r) => r.conversationId === conversationId);
    if (!rec || !(tokens > 0)) return;
    rec.tokens += tokens;
    this.persist();
    this.announce(rec);
  }

  // ------------------------------------------------------- protocol side

  /** The operator types into a child (steers it if running, resumes it otherwise). */
  async submitFromOwner(threadId: string, text: string, whenBusy: WhenBusy, refs: Parameters<ThreadRuntime["submit"]>[2]): Promise<SubmitAck> {
    const rec = this.records.find((r) => r.id === threadId);
    if (!rec) throw new HttpError("not_found", `thread ${threadId}`);
    return this.send(rec, text, "owner", whenBusy, refs);
  }

  /** The operator stops a child (the Stop control, or abort on its thread). */
  async abortFromOwner(threadId: string): Promise<void> {
    await this.stop(threadId, "owner");
  }

  private async send(rec: ChildRecord, text: string, from: "parent" | "owner", whenBusy: WhenBusy, refs: Parameters<ThreadRuntime["submit"]>[2] = []): Promise<SubmitAck> {
    const thread = this.port.thread(rec.id);
    if (!thread) throw new HttpError("not_found", `thread ${rec.id}`);
    const live = thread.isRunning;
    if (live && whenBusy === "reject") throw new HttpError("busy", `thread ${rec.id} is busy`);
    if (rec.state === "queued") {
      // Not started yet: the message waits with it and goes in when its slot comes.
      (rec.pending ??= []).push(text);
      this.persist();
      this.ledger(rec, from, "child", "steer", text);
      return { messageId: randomUUID(), disposition: "queued" };
    }
    // An owner release still in flight must finish first: its abort could otherwise kill the turn started below.
    await this.releasing.get(rec.id);
    if (!live && rec.guardDir) {
      // A resumed writer is a running writer again: it needs its working dir free.
      const held = this.guard.acquire(rec.guardDir, rec.id);
      if (!held.ok) throw new HttpError("invalid_request", `cannot resume "${rec.name}": ${this.holderName(held.owner)} is working in ${rec.guardDir}. ${WORKTREE_HINT}`);
    }
    if (!live && !this.held.has(rec.id)) {
      // A finished child needs a slot to run again; with none free the resume queues.
      const adm = await this.admit(rec.id);
      if (!adm.run) {
        rec.queuedSeq = adm.seq;
        rec.pending = [text];
        this.reserved.delete(rec.id);
        this.setState(rec, "queued");
        this.ledger(rec, from, "child", "resume", text);
        return { messageId: randomUUID(), disposition: "queued" };
      }
    }
    if (!live) {
      // Not `running` until the submit has landed; `resuming` (persisted first) lets recover() tell whether it did.
      rec.resuming = { at: thread.messageCount() };
      this.persist();
    }
    try {
      const ack = await thread.submit(text, whenBusy, refs);
      // If the turn already finished, settle() cleared `resuming` and set the final state: leave it.
      if (!live && rec.resuming) {
        // The new run's clock starts now. (The turn-start event may already have set running.)
        rec.runStartedAt = new Date().toISOString();
        delete rec.finishedAt;
        delete rec.step;
        rec.state = "running";
        this.persist();
        this.announce(rec);
      }
      this.ledger(rec, from, "child", live ? "steer" : "resume", text);
      return ack;
    } catch (e) {
      if (!live) {
        delete rec.resuming;
        if (rec.state === "done" || rec.state === "failed" || rec.state === "stopped") this.releaseSlot(rec);
        this.persist();
        if (rec.state === "done" || rec.state === "failed" || rec.state === "stopped") this.guard.releaseAll(rec.id);
      }
      throw e;
    }
  }

  private async stop(id: string, by: "parent" | "owner"): Promise<ToolOutcome> {
    const rec = this.records.find((r) => r.id === id);
    const thread = this.port.thread(id);
    if (!rec || !thread) return fail(`No subagent ${id}.`);
    if (rec.state === "done" || rec.state === "failed" || rec.state === "stopped") return { text: `Sub-agent "${rec.name}" is not running (${rec.state}).` };
    if (thread.isRunning) {
      rec.stopping = by;
      this.persist();
      await thread.abort();
      // The turn-end event normally settles the state; make sure it did.
      if (rec.stopping) this.finishStopped(rec, by);
    } else {
      this.finishStopped(rec, by);
    }
    return { text: `Sub-agent "${rec.name}" stopped. Message it with subagent_message to resume it.` };
  }

  // ----------------------------------------------------------- lifecycle

  /** Re-attach every persisted child (call after the feature threads, before the engine resumes). */
  async recover(): Promise<void> {
    // The previous wolfd of this wolf is gone (one per wolf): whatever slots it left are stale.
    this.pool.dropOwn();
    for (const rec of [...this.records]) {
      try {
        const conv = await this.opts.getConversation(rec.conversationId);
        if (!conv) {
          this.port.onError(new Error(`subagent ${rec.id}: conversation ${rec.conversationId} is gone`));
          continue;
        }
        // Writers that were active hold their working dir again (the guard is in memory).
        if (rec.guardDir && (rec.state === "running" || rec.state === "queued" || rec.state === "waiting" || rec.resuming)) this.guard.acquire(rec.guardDir, rec.id);
        const thread = await this.attach(rec, conv);
        // Children that were running or waiting still hold their slot (even past a cap that has since been lowered).
        if (rec.state === "running" || rec.state === "waiting") await this.hold(rec);
        if (rec.ownerTaskId && (rec.state === "done" || rec.state === "failed" || rec.state === "stopped") && !rec.resuming) void this.releaseOwnerOf(rec);
        if (rec.resuming) {
          // A resume was submitted: did it land before the crash?
          const landed = thread.messageCount() > rec.resuming.at;
          if (!landed) {
            delete rec.resuming; // no: the previous answer was already handled, nothing to redo (a queued resume stays queued)
            this.persist();
          } else if (thread.isRunning) {
            await this.hold(rec);
            rec.state = "running";
            delete rec.finishedAt;
            delete rec.queuedSeq;
            delete rec.pending;
            this.persist();
          } else {
            await this.hold(rec);
            this.finishTurn(rec, thread, "complete"); // landed and finished: this is a NEW answer
          }
        } else if (rec.state === "running") {
          if (!thread.hadHistory) {
            // Crashed between creating the conversation and submitting the brief.
            await conv.submit({ input: this.startInput(rec, false), whenBusy: "reject" });
            delete rec.pending;
            this.persist();
          } else if (!thread.isRunning) {
            // The turn ended but wolfd went down before the result was recorded.
            this.finishTurn(rec, thread, "complete");
          }
        }
      } catch (e) {
        this.port.onError(new Error(`subagent ${rec.id} not attached: ${e instanceof Error ? e.message : String(e)}`));
      }
    }
    // Queued children (and queued resumes) start as slots allow.
    void this.pump();
    for (const parentId of new Set(this.records.filter((r) => r.outbox.length > 0).map((r) => r.parentThreadId))) this.flush(parentId);
  }

  private async attach(rec: ChildRecord, conv: EngineConversation): Promise<ThreadRuntime> {
    const thread = await this.port.attachChild(this.summaryOf(rec), conv);
    this.unobserve.set(rec.id, thread.observe((ev) => this.onChildEvent(rec, thread, ev)));
    this.watchParent(rec.parentThreadId);
    return thread;
  }

  /** Deliveries held back for a parent with an unanswered card go out when its next turn starts. */
  private watchParent(parentId: string): void {
    if (this.parentWatch.has(parentId)) return;
    const parent = this.port.thread(parentId);
    if (!parent) return;
    this.parentWatch.set(
      parentId,
      parent.observe((ev) => {
        if (ev.type === "turn-start") this.flush(parentId);
      }),
    );
  }

  private onChildEvent(rec: ChildRecord, thread: ThreadRuntime, ev: ThreadEvent): void {
    if (this.closed) return;
    switch (ev.type) {
      case "turn-start":
        if (rec.state !== "running") this.setState(rec, "running");
        return;
      case "tool-start":
        rec.step = stepOf(ev.name, ev.args);
        this.announce(rec);
        return;
      case "error":
        this.lastError.set(rec.id, ev.message);
        return;
      case "turn-end":
        this.finishTurn(rec, thread, ev.reason);
        return;
      default:
        return;
    }
  }

  /** A child's turn ended: record how, and tell the parent. */
  private finishTurn(rec: ChildRecord, thread: ThreadRuntime, reason: "complete" | "aborted" | "error"): void {
    const name = rec.name;
    const followUp = `\n\nFollow up with subagent_message({ name: "${name}", message: "…" })`;
    const elapsed = formatElapsed(Math.max(0, Math.floor((Date.now() - Date.parse(rec.runStartedAt)) / 1000)));
    if (rec.stopping || reason === "aborted") {
      this.finishStopped(rec, rec.stopping ?? "owner");
      return;
    }
    if (reason === "error") {
      const message = this.lastError.get(rec.id) ?? "the turn failed";
      this.lastError.delete(rec.id);
      this.ledger(rec, "child", "parent", "error", message);
      this.settle(
        rec,
        "failed",
        `Sub-agent "${name}" failed after ${elapsed} (provider/agent error — auto-retry exhausted).\n\nError: ${message}\n\n` +
          `The subagent did not produce a result. You can retry by spawning a new subagent or resume the session with subagent_message.${followUp}`,
      );
      return;
    }
    const pending = thread.cards.pending();
    if (pending.length > 0) {
      const question = pending
        .flatMap((p) => p.card.fields.map((f) => f.label))
        .filter(Boolean)
        .join("\n");
      this.ledger(rec, "child", "parent", "question", question);
      this.settle(
        rec,
        "waiting",
        `Sub-agent "${name}" asks (${elapsed}):\n\n${question}\n\nReply with subagent_message({ name: "${name}", message: "…" }) — the same name works whether it is still running or has since exited. It stays open until you reply.`,
      );
      return;
    }
    const summary = thread.lastAssistantText() || "(no output)";
    this.ledger(rec, "child", "parent", "result", summary);
    this.settle(rec, "done", `Sub-agent "${name}" completed (${elapsed}).\n\n${summary}${followUp}`);
  }

  private finishStopped(rec: ChildRecord, by: "parent" | "owner"): void {
    delete rec.stopping;
    this.ledger(rec, by, "child", "stop", by === "owner" ? "stopped by the operator" : "stopped by the parent");
    // The parent that stopped it knows; one stopped from the console has to be told.
    this.settle(rec, "stopped", by === "owner" ? `Sub-agent "${rec.name}" was stopped by the operator.\n\nFollow up with subagent_message({ name: "${rec.name}", message: "…" }) to resume it.` : undefined);
  }

  // ------------------------------------------------------------ delivery

  /**
   * A turn is over: set the state and queue the message for the parent in ONE persist, so a crash can never leave a
   * finished child with nothing to deliver (or a delivery for a child still marked running).
   */
  private settle(rec: ChildRecord, state: SubagentState, text?: string): void {
    delete rec.resuming;
    delete rec.step;
    if (text !== undefined) {
      const n = ++this.deliverySeq;
      // The id must be unique across restarts (the counter restarts from the outbox): the parent-side check is by id.
      rec.outbox.push({ n, id: `${rec.id.split("/").pop()}.${randomUUID().slice(0, 8)}`, text });
    }
    this.setState(rec, state);
    if (state === "done" || state === "failed" || state === "stopped") {
      this.guard.releaseAll(rec.id);
      void this.releaseOwnerOf(rec);
    }
    if (text !== undefined) this.flush(rec.parentThreadId);
  }

  /**
   * Owner-task lifecycle. The parked owner task exists so the store knows the conversation is a child (memory quiet, no
   * binding). It is made at spawn, so a queued child has one while it waits for a slot; it lives while the child is active (queued, running, waiting), and ends when the child reaches done, failed
   * or stopped: a conversation whose owner task is terminal still runs turns (a resume works), and keeps its ownership
   * record, so nothing is lost, while parked tasks stay bounded by the number of ACTIVE children. A spawn that never got
   * going releases it too (discard), and so does releaseParent.
   */
  // Relies on pi-durable: a conversation whose owner task ended still runs turns (pinned by the 'pi-durable contract' test).
  private releaseOwnerOf(rec: ChildRecord): Promise<void> {
    const pending = this.releasing.get(rec.id);
    if (pending) return pending;
    const taskId = rec.ownerTaskId;
    if (!taskId) return Promise.resolve();
    const p = (async () => {
      try {
        await this.opts.releaseOwner(taskId);
        rec.ownerTaskId = "";
        this.persist();
      } catch (e) {
        this.port.onError(e);
      }
    })().finally(() => this.releasing.delete(rec.id));
    this.releasing.set(rec.id, p);
    return p;
  }

  /** A parent thread is going away: stop its active children and end all their owner tasks. */
  async releaseParent(parentThreadId: string): Promise<void> {
    for (const rec of this.records.filter((r) => r.parentThreadId === parentThreadId)) {
      if (rec.state === "running" || rec.state === "queued" || rec.state === "waiting") await this.stop(rec.id, "parent");
      await this.releaseOwnerOf(rec);
      this.guard.releaseAll(rec.id);
    }
  }

  /** Deliver everything waiting for `parentId`, oldest first, one at a time. */
  private flush(parentId: string): void {
    if (this.closed) return;
    const prev = this.chains.get(parentId) ?? Promise.resolve();
    this.chains.set(
      parentId,
      prev.then(() => this.drain(parentId)).catch((e) => this.port.onError(e)),
    );
  }

  private async drain(parentId: string): Promise<void> {
    for (;;) {
      if (this.closed) return;
      let next: { rec: ChildRecord; d: Delivery } | undefined;
      for (const rec of this.records) {
        if (rec.parentThreadId !== parentId) continue;
        for (const d of rec.outbox) if (!next || d.n < next.d.n) next = { rec, d };
      }
      if (!next) return;
      const parent = this.port.thread(parentId);
      // Registered but not attached (it failed at boot): keep the outbox, deliver once it attaches.
      if (!parent && this.port.knownThread(parentId)) return;
      if (!parent) {
        // The parent is unknown to wolfd: nobody can take these. Say so and drop them.
        for (const rec of this.records) {
          if (rec.parentThreadId !== parentId) continue;
          for (const d of rec.outbox) {
            this.ledger(rec, "system", "parent", "error", `undeliverable: parent thread ${parentId} is gone`);
            this.port.onError(new Error(`subagent ${rec.id}: delivery ${d.id} dropped, parent ${parentId} is gone`));
          }
          rec.outbox = [];
        }
        this.persist();
        return;
      }
      // An idle parent with an unanswered card would have it dismissed by the message: hold until its next turn starts.
      if (!parent.isRunning && parent.cards.pending().length > 0) return;
      const { rec, d } = next;
      // Exactly once: the id travels in the steer text. A crash after the submit but before the removal below leaves the
      // entry here; the parent already holds the id, so it is only removed.
      if (!parent.hasUserText(`[delivery ${d.id}]`)) {
        try {
          // Steer: into the parent's running turn, or, when it is idle, as the message that starts one.
          await parent.submit(`${d.text}\n\n[delivery ${d.id}]`, "steer");
        } catch (e) {
          this.port.onError(e);
          this.retryLater(parentId);
          return;
        }
      }
      this.retryDelay.delete(parentId);
      rec.outbox = rec.outbox.filter((x) => x.n !== d.n);
      this.persist();
    }
  }

  /** A delivery failed: try this parent again after a growing delay (kept in the outbox meanwhile). */
  private retryLater(parentId: string): void {
    if (this.closed || this.retryTimers.has(parentId)) return;
    const base = this.opts.retryBaseMs ?? 500;
    const delay = Math.min(30_000, (this.retryDelay.get(parentId) ?? base / 2) * 2);
    this.retryDelay.set(parentId, delay);
    const t = setTimeout(() => {
      this.retryTimers.delete(parentId);
      this.flush(parentId);
    }, delay);
    t.unref();
    this.retryTimers.set(parentId, t);
  }

  /** Remove a child worktree and branch that never ran (errors are reported, not thrown). */
  private async dropWorkspace(ws: Workspace): Promise<void> {
    await abandonChild(ws).catch((e) => this.port.onError(e));
  }

  /** Undo a spawn that did not get going: forget the child, close its thread, end its owner task. */
  private async discard(rec: ChildRecord): Promise<void> {
    this.records = this.records.filter((r) => r !== rec);
    this.guard.releaseAll(rec.id);
    this.releaseSlot(rec);
    this.persist();
    if (rec.workspace) await this.dropWorkspace(rec.workspace);
    await this.port.detachChild(rec.id).catch((e) => this.port.onError(e));
    await this.opts.releaseOwner(rec.ownerTaskId).catch((e) => this.port.onError(e));
  }

  // ------------------------------------------------------------- helpers

  // ----------------------------------------------------- caps and queue

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.gate.then(fn, fn);
    this.gate = run.catch(() => {});
    return run;
  }

  /** A slot-directory failure: reported once per distinct message (the queue retries every poll). */
  private slotError(e: unknown): void {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === this.lastSlotError) return;
    this.lastSlotError = msg;
    this.port.onError(new Error(`subagent slots (${this.pool.dir}): ${msg}; sub-agents queue until it works`));
  }

  /**
   * Whether `id` runs now (and then holds its slot) or waits, never ahead of one already queued (FIFO). A decision to
   * queue reserves its place in the order at once, inside the serialized section. Never rejects.
   */
  private admit(id: string): Promise<Admission> {
    return this.serialize(async () => {
      try {
        if (this.reserved.size === 0 && !this.records.some((r) => r.state === "queued") && (await this.take(id))) return { run: true };
      } catch (e) {
        this.slotError(e);
      }
      const seq = ++this.queueSeq;
      this.reserved.set(id, seq);
      return { run: false, seq };
    });
  }

  /** Take a wolf slot and a host slot, or neither. Never throws. */
  private async take(id: string): Promise<boolean> {
    if (this.closed || this.held.size >= this.maxRunning) return false;
    if (!(await this.pool.tryAcquire(id))) return false;
    if (this.closed) {
      this.pool.release(id); // wolfd closed while the slot was being taken
      return false;
    }
    this.held.add(id);
    return true;
  }

  /** Hold a slot regardless of the caps (a child that was already running at boot). */
  private async hold(rec: ChildRecord): Promise<void> {
    if (!(await this.pool.claim(rec.id))) {
      this.held.add(rec.id); // (it is running: it counts against the wolf cap even without a host slot file)
      return;
    }
    if (this.closed) {
      this.pool.release(rec.id);
      return;
    }
    this.held.add(rec.id);
  }

  private releaseSlot(rec: ChildRecord): void {
    this.releaseSlotOf(rec.id);
  }

  private releaseSlotOf(id: string): void {
    if (this.held.delete(id)) this.pool.release(id);
  }

  /** What a starting child is told: its brief (a child that never ran) and the messages that arrived while it queued. */
  private startInput(rec: ChildRecord, resume: boolean): string {
    return [...(resume ? [] : [rec.brief]), ...(rec.pending ?? [])].join("\n\n");
  }

  /** Start queued children, oldest first, while slots are free; then refresh their positions. Never rejects. */
  private pump(): Promise<void> {
    return this.serialize(async () => {
      try {
        await this.pumpOnce();
      } catch (e) {
        this.port.onError(e);
      }
    });
  }

  private async pumpOnce(): Promise<void> {
    while (!this.closed) {
      const next = this.records.filter((r) => r.state === "queued").sort((a, b) => (a.queuedSeq ?? 0) - (b.queuedSeq ?? 0))[0];
      if (!next) break;
      // A spawn that decided to queue ahead of it has not put its record in yet: it goes first.
      if ([...this.reserved.values()].some((q) => q < (next.queuedSeq ?? 0))) break;
      if (!(await this.take(next.id))) break;
      if (next.state !== "queued") {
        // Stopped (or otherwise settled) while its slot was being taken.
        this.releaseSlotOf(next.id);
        continue;
      }
      await this.start(next);
    }
    if (this.closed) return;
    const queued = this.records.filter((r) => r.state === "queued");
    for (const id of [...this.shownPosition.keys()]) if (!queued.some((r) => r.id === id)) this.shownPosition.delete(id);
    for (const r of queued) {
      const pos = this.positionOf(r);
      if (this.shownPosition.get(r.id) !== pos) {
        this.shownPosition.set(r.id, pos);
        this.announce(r);
      }
    }
    // Another wolfd may free a host slot without telling us: poll while anything waits.
    if (queued.length > 0 && !this.pollTimer) {
      this.pollTimer = setInterval(() => void this.pump(), this.opts.slotPollMs ?? 2000);
      this.pollTimer.unref();
    } else if (queued.length === 0 && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  /** A queued child got its slot: submit what it was waiting to do. */
  private async start(rec: ChildRecord): Promise<void> {
    const thread = this.port.thread(rec.id);
    if (!thread) {
      this.ledger(rec, "system", "parent", "error", "could not start: the child's thread is not attached");
      this.settle(rec, "failed", `Sub-agent "${rec.name}" could not start: its thread is not attached.`);
      return;
    }
    const resume = thread.hadHistory || thread.messageCount() > 0; // (hadHistory is the state at attach)
    const now = new Date().toISOString();
    try {
      if (resume) {
        // As in send(): the marker (persisted first) tells recover() whether the submit landed.
        rec.resuming = { at: thread.messageCount() };
        this.persist();
        await thread.submit(this.startInput(rec, true), "reject");
        delete rec.pending;
        if (rec.resuming) {
          rec.runStartedAt = now;
          this.setState(rec, "running");
        }
        await this.cancelIfStopped(rec, thread);
      } else {
        // Running is recorded before the brief goes in (recover() resubmits a brief that never landed).
        rec.runStartedAt = now;
        this.setState(rec, "running");
        await thread.conv.submit({ input: this.startInput(rec, false), whenBusy: "reject" });
        delete rec.pending;
        this.persist();
        await this.cancelIfStopped(rec, thread);
      }
    } catch (e) {
      delete rec.resuming;
      const message = e instanceof Error ? e.message : String(e);
      this.ledger(rec, "child", "parent", "error", message);
      this.settle(rec, "failed", `Sub-agent "${rec.name}" could not start: ${message}`);
    }
  }

  /** A stop that came while start() was submitting only marked the child: the turn it then started must not run on. */
  private async cancelIfStopped(rec: ChildRecord, thread: ThreadRuntime): Promise<void> {
    if (rec.state !== "stopped" || !thread.isRunning) return;
    rec.stopping = "parent";
    await thread.abort().catch((e) => this.port.onError(e));
    if (rec.stopping) delete rec.stopping;
  }

  /**
   * Where a spawn runs. Isolation is the explicit request, else the profile's, else a worktree for a writer in a git
   * cwd (outside git always none, and no git runs). A worktree child gets its own branch: from the feature branch for a
   * feature thread (created, and the thread moved into it, on the first one), else from the current HEAD of the cwd's
   * repo (merging it back is left to the caller). A writer left in a shared checkout is refused while another writer
   * holds it: a running child, or another home/feature thread mid-turn there (the calling thread does not count).
   */
  private async planIsolation(a: { parent: ThreadRuntime; def: AgentDefinition; requested: AgentIsolation | undefined; cwd: string; name: string; id: string }): Promise<
    { ok: true; isolation: AgentIsolation; cwd: string; note: string; workspace?: Workspace; guardDir?: string } | { ok: false; error: string }
  > {
    const tools = parseCommaList(a.def.tools);
    const writer = isWriter(tools);
    const inGit = insideGit(a.cwd);
    const want = a.requested ?? defaultIsolation({ ...(tools ? { tools } : {}), ...(a.def.isolation ? { isolation: a.def.isolation } : {}) }, inGit);
    const inPlace = (note = ""): { ok: true; isolation: "none"; cwd: string; note: string } => ({ ok: true, isolation: "none", cwd: a.cwd, note });
    const notGit = want === "worktree" ? "Notice: the working directory is not in a git repository; the sub-agent runs there without a worktree." : "";
    if (!inGit) return inPlace(notGit);
    const repo = await repoOf(a.cwd).catch(() => null);
    if (!repo) {
      if (!writer) return inPlace();
      return { ok: false, error: `Refused: ${a.cwd} is inside a git checkout but git cannot read it (a repository without commits, or a safe.directory setting?), so a writer cannot be isolated or guarded there. Fix the repository, or spawn a read-only agent.` };
    }

    if (want === "none") {
      if (!writer) return inPlace();
      const others = await this.otherWriters(a.parent.summary.id);
      const holder = this.guard.holder(repo.toplevel);
      const busy = holder !== undefined ? this.holderName(holder) : others.find((o) => o.toplevel === repo.toplevel)?.who;
      if (busy !== undefined) {
        return { ok: false, error: `Refused: ${busy} is already writing in ${repo.toplevel}, and two writers in one checkout overwrite each other. Spawn this sub-agent with isolation: "worktree" (its own branch and worktree), or wait for the other to finish.` };
      }
      this.guard.acquire(repo.toplevel, a.id);
      return { ok: true, isolation: "none", cwd: a.cwd, note: "", guardDir: repo.toplevel };
    }

    let made: { ws: Workspace; moved?: Workspace };
    try {
      made = await this.childWorkspace(a.parent, repo, a.cwd, a.name, a.id);
    } catch (e) {
      return { ok: false, error: `Could not create the worktree: ${e instanceof Error ? e.message : String(e)}` };
    }
    const { ws, moved } = made;
    const inner = relative(repo.toplevel, realpathOr(a.cwd));
    if (writer) this.guard.acquire(ws.path, a.id);
    const note = moved ? `This thread now works in ${moved.path} on ${moved.branch}; use paths there. ${CWD_MOVE_NOTE}` : "";
    return { ok: true, isolation: "worktree", cwd: inner && !inner.startsWith("..") ? join(ws.path, inner) : ws.path, note, workspace: ws, ...(writer ? { guardDir: ws.path } : {}) };
  }

  /** The child's worktree: off the feature branch for a feature thread in this repo, else off the cwd's HEAD. `moved` is set when this spawn created the feature workspace and moved the thread. */
  private async childWorkspace(parent: ThreadRuntime, repo: RepoInfo, cwd: string, name: string, id: string): Promise<{ ws: Workspace; moved?: Workspace }> {
    const root = this.workspacesRoot();
    const parentCwd = this.parentCwd(parent);
    // The id suffix makes every child branch fresh: a retry never reuses what a failed spawn left.
    const childSlug = `${slugify(name)}-${id.split("sub-").pop()}`;
    if (parent.summary.kind === "feature" && insideGit(parentCwd)) {
      const parentRepo = await repoOf(parentCwd).catch(() => null);
      if (parentRepo && parentRepo.mainDir === repo.mainDir) {
        const { ws: featureWs, created } = await this.featureWorkspace(parent, parentRepo, parentCwd);
        const ws = await createChildWorkspace({ root, featureWs, featureSlug: featureWs.branch.replace(/^feat\//, ""), childSlug });
        return created ? { ws, moved: featureWs } : { ws };
      }
    }
    return { ws: await createHomeChildWorkspace({ root, repo, childSlug, baseDir: cwd }) };
  }

  /**
   * The feature thread's workspace, created on the first worktree spawn: `feat/<id>-<title>` cut from the thread's
   * current HEAD, the thread's cwd (and prompt) moved into it, then saved on the thread. Serialised per repo, so two
   * threads never race for a branch. Refuses a branch or path that already exists and is not this thread's.
   */
  private featureWorkspace(parent: ThreadRuntime, repo: RepoInfo, baseDir: string): Promise<{ ws: Workspace; created: boolean }> {
    const key = repo.mainDir;
    const run = async (): Promise<{ ws: Workspace; created: boolean }> => {
      const saved = this.savedThread(parent);
      if (saved?.workspace) return { ws: saved.workspace, created: false };
      const root = this.workspacesRoot();
      const slug = this.featureSlug(parent, saved);
      const taken = await workspaceConflict({ root, repo, branch: featureBranch(slug) });
      if (taken) throw new Error(`the feature workspace for this thread would be ${featureBranch(slug)}, but ${taken} and it is not recorded as this thread's workspace. Move or delete it, then spawn again; nothing was changed.`);
      const ws = await ensureFeatureWorkspace({ root, repo, featureSlug: slug, baseDir });
      try {
        await parent.conv.configure({ cwd: ws.path, ...(this.opts.instructionsFor ? { instructions: this.opts.instructionsFor(ws.path) } : {}) });
        setThreadWorkspace(this.port.den, parent.summary.id, ws, (e) => this.port.onError(e));
      } catch (e) {
        await abandonChild(ws).catch((err) => this.port.onError(err)); // just created, nothing on it
        throw e;
      }
      return { ws, created: true };
    };
    const next = (this.featureLocks.get(key) ?? Promise.resolve()).then(run, run);
    const tail = next.catch(() => undefined);
    this.featureLocks.set(key, tail);
    void tail.then(() => {
      if (this.featureLocks.get(key) === tail) this.featureLocks.delete(key);
    });
    return next;
  }

  /** `<last 7 of the work id>-<title, 30 chars>`: stable, readable, and never a bare title that could adopt someone's own branch. */
  private featureSlug(parent: ThreadRuntime, saved: SavedThread | undefined): string {
    const id = (saved?.workItemId ?? parent.summary.boundWorkItem ?? parent.summary.id).split("-").pop() ?? "";
    const tail = id.replace(/[^A-Za-z0-9]/g, "").slice(-7);
    const title = slugify(parent.summary.title ?? "", 30);
    return title && title !== "x" ? `${tail}-${title}` : tail;
  }

  private savedThread(parent: ThreadRuntime): SavedThread | undefined {
    return parent.summary.kind === "feature" ? loadThreads(this.port.den, (e) => this.port.onError(e)).find((t) => t.id === parent.summary.id) : undefined;
  }

  private workspacesRoot(): string {
    return this.opts.workspacesRoot ?? resolveWorkspacesRoot(this.opts.wolfHome);
  }

  /** A home or feature thread's cwd: a feature thread lives in its workspace once it has one. */
  private parentCwd(parent: ThreadRuntime): string {
    return this.savedThread(parent)?.workspace?.path ?? this.opts.workspace;
  }

  /** Home and feature threads other than the caller that are mid-turn, with the git toplevel they work in. */
  private async otherWriters(callerId: string): Promise<{ who: string; toplevel: string }[]> {
    const saved = loadThreads(this.port.den, (e) => this.port.onError(e));
    const out: { who: string; toplevel: string }[] = [];
    for (const id of [`${this.port.name}/home`, ...saved.map((t) => t.id)]) {
      const t = id === callerId ? undefined : this.port.thread(id);
      if (!t?.isRunning) continue;
      const cwd = saved.find((s) => s.id === id)?.workspace?.path ?? this.opts.workspace;
      const repo = insideGit(cwd) ? await repoOf(cwd).catch(() => null) : null;
      if (repo) out.push({ who: `the ${t.summary.title ?? id} thread (mid-turn)`, toplevel: repo.toplevel });
    }
    return out;
  }

  private holderName(id: string): string {
    const rec = this.records.find((r) => r.id === id);
    return rec ? `sub-agent "${rec.name}"` : `sub-agent ${id}`;
  }

  private resolveCwd(requested: string | undefined, def: AgentDefinition, parent: ThreadRuntime): string {
    if (requested) return isAbsolute(requested) ? requested : resolve(this.parentCwd(parent), requested);
    if (def.cwd) return isAbsolute(def.cwd) ? def.cwd : resolve(this.opts.wolfHome, "agent", def.cwd);
    return this.parentCwd(parent);
  }

  /** The profile's tools that this runtime has, plus ask_user_question; never the spawn tools. */
  private childTools(def: AgentDefinition): { tools: string[]; missing: string[] } {
    const registered = new Set(this.opts.registeredTools());
    const wanted = parseCommaList(def.tools) ?? DEFAULT_PROFILE_TOOLS;
    const spawn = new Set<string>(SPAWN_TOOLS);
    const tools: string[] = [];
    const missing: string[] = [];
    for (const t of [...wanted, ...CHILD_ALWAYS_TOOLS]) {
      if (spawn.has(t) || tools.includes(t)) continue;
      if (registered.has(t)) tools.push(t);
      else if (!CHILD_ALWAYS_TOOLS.includes(t)) missing.push(t);
    }
    return { tools: tools.sort(), missing };
  }

  private boundTask(parent: ThreadRuntime): string | undefined {
    try {
      return readBindingFile(this.port.den, Number(parent.conv.id))?.workId;
    } catch {
      return undefined;
    }
  }

  private byName(parentId: string, name: string): ChildRecord | undefined {
    return this.records.find((r) => r.parentThreadId === parentId && r.name === name);
  }

  private uniqueName(parentId: string, base: string): string {
    const taken = new Set(this.records.filter((r) => r.parentThreadId === parentId).map((r) => r.name));
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  }

  private setState(rec: ChildRecord, state: SubagentState): void {
    rec.state = state;
    if (state === "done" || state === "failed" || state === "stopped") {
      rec.finishedAt = new Date().toISOString();
      delete rec.step;
      delete rec.queuedSeq;
      delete rec.pending;
      this.releaseSlot(rec);
    } else if (state === "running") {
      delete rec.finishedAt;
      delete rec.queuedSeq;
    } else if (state === "queued") {
      delete rec.finishedAt;
      delete rec.step;
    }
    this.persist();
    this.announce(rec);
    // A slot may have freed, or the queue changed shape.
    if (state === "done" || state === "failed" || state === "stopped" || state === "queued") void this.pump();
  }

  /** The thread's summary changed: update it and tell the clients. */
  private announce(rec: ChildRecord): void {
    const thread = this.port.thread(rec.id);
    if (!thread) return;
    thread.summary = this.summaryOf(rec);
    this.port.emitWolf({ type: "thread-updated", thread: thread.threadSummary() });
  }

  private ledger(rec: ChildRecord, from: LedgerParty, to: LedgerParty, kind: LedgerKind, text: string): void {
    const id = (this.ledgerSeq.get(rec.id) ?? readLedger(this.port.den, rec.id, (e) => this.port.onError(e)).length) + 1;
    this.ledgerSeq.set(rec.id, id);
    try {
      appendLedger(this.port.den, rec.id, { id, at: new Date().toISOString(), from, to, kind, text });
    } catch (e) {
      this.port.onError(e);
    }
  }

  private persist(): void {
    try {
      saveChildren(this.port.den, this.records);
    } catch (e) {
      this.port.onError(e);
    }
  }
}

/** The child's instructions: its profile's prompt, then what it needs to know about running under a parent. */
function childInstructions(def: AgentDefinition, name: string): string {
  return [
    def.body ?? "",
    `You are the sub-agent "${name}", spawned by another agent (your parent), not by the user. Your final message is delivered to your parent as your result, so make it complete and self-contained. If you are blocked and need a decision only your parent can give, call ask_user_question: your parent receives the question and replies, and you continue.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
