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
 * Plug-in points for later tickets: `admit()` (caps and queue, ticket 4), `resolveIsolation()` (worktrees and the
 * writer guard, tickets 7 and 8).
 */
import { randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { discoverAgents, isWriterProfile, loadAgent, parseCommaList, type AgentDefinition, type AgentIsolation, type DiscoverOptions } from "@wolfpack/agents";
import { TIERS, isTier } from "@wolfpack/engine";
import { readBindingFile } from "@wolfpack/memory";
import type { LedgerEntry, LedgerKind, LedgerParty, SubagentState, SubmitAck, ThreadEvent, ThreadSummary } from "@wolfpack/protocol";
import type { ConfigureOptions, EngineConversation, ThinkingLevel, WhenBusy } from "../engine/index.js";
import { HttpError } from "./http-error.js";
import { appendLedger, loadChildren, readLedger, saveChildren, type ChildRecord } from "./subagent-store.js";
import type { ThreadRuntime, WolfEventDraft } from "./thread.js";

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
  /** A conversation owned by a parked task of `ownerId`. */
  createOwned(ownerId: string, init: ConfigureOptions): Promise<{ conversation: EngineConversation; taskId: string }>;
  /** A tier resolved through the wolf's model table. Throws for a tier it cannot resolve. */
  resolveTier(tier: string): { provider: string; modelId: string; thinking?: string };
  /** Names of every tool the engine can offer a conversation. */
  registeredTools(): string[];
}

/** What the manager needs from the server around it. */
export interface SubagentPort {
  readonly name: string;
  readonly den: string;
  thread(id: string): ThreadRuntime | undefined;
  threadOfConversation(conversationId: string): ThreadRuntime | undefined;
  /** Register a thread for an existing or new child conversation and attach it. */
  attachChild(summary: ThreadSummary, conv: EngineConversation): Promise<ThreadRuntime>;
  emitWolf(draft: WolfEventDraft): void;
  onError(error: unknown): void;
  settleMs: number;
}

/** What a tool call answers the model. */
export interface ToolOutcome {
  text: string;
  isError?: boolean;
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

  constructor(
    private readonly port: SubagentPort,
    private readonly opts: SubagentOptions,
  ) {
    this.records = loadChildren(port.den, (e) => port.onError(e));
    for (const r of this.records) for (const d of r.outbox) this.deliverySeq = Math.max(this.deliverySeq, d.n);
  }

  close(): void {
    this.closed = true;
    for (const off of this.unobserve.values()) off();
    for (const off of this.parentWatch.values()) off();
    this.unobserve.clear();
    this.parentWatch.clear();
  }

  // ------------------------------------------------------------ views

  children(parentThreadId: string): ThreadSummary[] {
    return this.records.filter((r) => r.parentThreadId === parentThreadId).map((r) => this.port.thread(r.id)?.threadSummary() ?? this.summaryOf(r));
  }

  ledgerOf(childThreadId: string): LedgerEntry[] | undefined {
    return this.records.some((r) => r.id === childThreadId) ? readLedger(this.port.den, childThreadId) : undefined;
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
    };
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

    const cwd = this.resolveCwd(params.cwd, def);
    const { isolation, note: isolationNote } = this.resolveIsolation(def, params.isolation as AgentIsolation | undefined);
    const { tools, missing } = this.childTools(def);

    const name = this.uniqueName(parent.summary.id, params.name?.trim() || def.name);
    const id = `${this.port.name}/sub-${randomUUID().slice(0, 8)}`;
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
      return fail(`Could not start the sub-agent: ${e instanceof Error ? e.message : String(e)}`);
    }

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
      state: this.admit(parent.summary.id) === "run" ? "running" : "queued",
      startedAt: now,
      runStartedAt: now,
      tokens: 0,
      ...(taskId ? { taskId } : {}),
      outbox: [],
    };
    // Registry first, like feature threads: a crash after this leaves a child wolfd re-attaches, never an orphan conversation.
    this.records.push(rec);
    this.persist();
    try {
      await this.attach(rec, owned.conversation);
    } catch (e) {
      this.records = this.records.filter((r) => r !== rec);
      this.persist();
      return fail(`Could not start the sub-agent: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.ledger(rec, "parent", "child", "brief", params.task);
    this.announce(rec);
    try {
      await owned.conversation.submit({ input: params.task, whenBusy: "reject" });
    } catch (e) {
      this.setState(rec, "failed");
      this.ledger(rec, "system", "parent", "error", `could not start: ${e instanceof Error ? e.message : String(e)}`);
      return fail(`Sub-agent "${name}" was created but could not start: ${e instanceof Error ? e.message : String(e)}`);
    }

    const notes = [
      missing.length ? `Notice: this runtime has no ${missing.join(", ")} tool${missing.length > 1 ? "s" : ""}; the sub-agent runs without ${missing.length > 1 ? "them" : "it"}.` : "",
      isolationNote,
    ].filter(Boolean);
    return {
      text:
        (notes.length ? `${notes.join(" ")} ` : "") +
        `Sub-agent "${name}" launched and is now running. ` +
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
    const before = { state: rec.state, finishedAt: rec.finishedAt, runStartedAt: rec.runStartedAt, step: rec.step };
    if (!live) {
      // Resumed: running at once (the turn-start event may lag the submit), the new run's clock starts now.
      rec.state = "running";
      delete rec.finishedAt;
      delete rec.step;
      rec.runStartedAt = new Date().toISOString();
      this.persist();
      this.announce(rec);
    }
    try {
      const ack = await thread.submit(text, whenBusy, refs);
      this.ledger(rec, from, "child", live ? "steer" : "resume", text);
      return ack;
    } catch (e) {
      if (!live) {
        Object.assign(rec, before);
        if (before.finishedAt === undefined) delete rec.finishedAt;
        if (before.step === undefined) delete rec.step;
        this.persist();
        this.announce(rec);
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
  async recover(getConversation: (id: string) => Promise<EngineConversation | undefined>): Promise<void> {
    for (const rec of [...this.records]) {
      try {
        const conv = await getConversation(rec.conversationId);
        if (!conv) {
          this.port.onError(new Error(`subagent ${rec.id}: conversation ${rec.conversationId} is gone`));
          continue;
        }
        const thread = await this.attach(rec, conv);
        if (rec.state === "running" || rec.state === "queued") {
          if (!thread.hadHistory) {
            // Crashed between creating the conversation and submitting the brief.
            await conv.submit({ input: rec.brief, whenBusy: "reject" });
            if (rec.state === "queued") rec.state = "running";
          } else if (!thread.isRunning) {
            // The turn ended but wolfd went down before the result was recorded.
            this.finishTurn(rec, thread, "complete");
          }
        }
      } catch (e) {
        this.port.onError(new Error(`subagent ${rec.id} not attached: ${e instanceof Error ? e.message : String(e)}`));
      }
    }
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
      this.setState(rec, "failed");
      this.ledger(rec, "child", "parent", "error", message);
      this.enqueue(
        rec,
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
      rec.step = undefined;
      this.setState(rec, "waiting");
      this.ledger(rec, "child", "parent", "question", question);
      this.enqueue(
        rec,
        `Sub-agent "${name}" asks (${elapsed}):\n\n${question}\n\nReply with subagent_message({ name: "${name}", message: "…" }) — the same name works whether it is still running or has since exited. It stays open until you reply.`,
      );
      return;
    }
    const summary = thread.lastAssistantText() || "(no output)";
    this.setState(rec, "done");
    this.ledger(rec, "child", "parent", "result", summary);
    this.enqueue(rec, `Sub-agent "${name}" completed (${elapsed}).\n\n${summary}${followUp}`);
  }

  private finishStopped(rec: ChildRecord, by: "parent" | "owner"): void {
    delete rec.stopping;
    this.setState(rec, "stopped");
    this.ledger(rec, by, "child", "stop", by === "owner" ? "stopped by the operator" : "stopped by the parent");
    // The parent that stopped it knows; one stopped from the console has to be told.
    if (by === "owner") this.enqueue(rec, `Sub-agent "${rec.name}" was stopped by the operator.\n\nFollow up with subagent_message({ name: "${rec.name}", message: "…" }) to resume it.`);
  }

  // ------------------------------------------------------------ delivery

  private enqueue(rec: ChildRecord, text: string): void {
    rec.outbox.push({ n: ++this.deliverySeq, text });
    this.persist();
    this.flush(rec.parentThreadId);
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
      const parent = this.port.thread(parentId);
      if (!parent) return;
      // An idle parent with an unanswered card would have it dismissed by the message: hold until its next turn starts.
      if (!parent.isRunning && parent.cards.pending().length > 0) return;
      let next: { rec: ChildRecord; n: number; text: string } | undefined;
      for (const rec of this.records) {
        if (rec.parentThreadId !== parentId) continue;
        for (const d of rec.outbox) if (!next || d.n < next.n) next = { rec, n: d.n, text: d.text };
      }
      if (!next) return;
      // Steer: into the parent's running turn, or, when it is idle, as the message that starts one.
      await parent.submit(next.text, "steer");
      next.rec.outbox = next.rec.outbox.filter((d) => d.n !== next!.n);
      this.persist();
    }
  }

  // ------------------------------------------------------------- helpers

  /**
   * Whether a new child runs now or waits for a slot. Ticket 4 plugs the caps (3 per wolf, 6 per host) and the queue in
   * here; until then every child runs at once.
   */
  private admit(_parentThreadId: string): "run" | "queue" {
    return "run";
  }

  /**
   * The isolation a spawn gets. Worktrees and the writer guard arrive with tickets 7 and 8: until then every child runs in
   * its cwd, and a request for a worktree is said so rather than silently ignored.
   */
  private resolveIsolation(def: AgentDefinition, requested: AgentIsolation | undefined): { isolation: AgentIsolation; note: string } {
    // The default a worktree-capable runtime would pick: the request, the profile's, else a worktree for a writer.
    const want = requested ?? def.isolation ?? (isWriterProfile(def) ? "worktree" : "none");
    // Only an explicit ask is worth a notice: a writer's silent default is the shared checkout until tickets 7 and 8.
    const asked = requested ?? def.isolation;
    return { isolation: "none", note: asked === "worktree" && want === "worktree" ? "Notice: worktree isolation is not available yet; the sub-agent runs in the shared checkout." : "" };
  }

  private resolveCwd(requested: string | undefined, def: AgentDefinition): string {
    if (requested) return isAbsolute(requested) ? requested : resolve(this.opts.workspace, requested);
    if (def.cwd) return isAbsolute(def.cwd) ? def.cwd : resolve(this.opts.wolfHome, "agent", def.cwd);
    return this.opts.workspace;
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
    } else if (state === "running") {
      delete rec.finishedAt;
    }
    this.persist();
    this.announce(rec);
  }

  /** The thread's summary changed: update it and tell the clients. */
  private announce(rec: ChildRecord): void {
    const thread = this.port.thread(rec.id);
    if (!thread) return;
    thread.summary = this.summaryOf(rec);
    this.port.emitWolf({ type: "thread-updated", thread: thread.threadSummary() });
  }

  private ledger(rec: ChildRecord, from: LedgerParty, to: LedgerParty, kind: LedgerKind, text: string): void {
    const id = (this.ledgerSeq.get(rec.id) ?? readLedger(this.port.den, rec.id).length) + 1;
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
