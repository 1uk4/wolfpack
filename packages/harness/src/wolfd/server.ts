/**
 * WolfServer: serves the /v1 protocol for ONE wolf on 127.0.0.1, over many engine conversations: its home thread plus
 * feature threads. Each thread is a ThreadRuntime (thread.ts) holding its own running slot, buffers, subscribers, card
 * tracker and watch; routes look the thread up.
 * Mirrors the StubServer's semantics (packages/protocol/src/stub/server.ts); the contract suite is the definition
 * of correct.
 *
 * Architecture:
 * - One watcher per thread (see thread.ts for the pump). The wolf-wide activity stream (thread-status, card events
 *   of every thread) has its own id space and bounded replay buffer here.
 * - Feature threads are persisted in `<den>/wolfd/threads.json` and re-attached at startup.
 * Limits: a queued follow-up cannot be dropped by abort (the engine owns the queue).
 */
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_NAME_HEADER,
  AnswerCardBodySchema,
  BindThreadBodySchema,
  CreateThreadBodySchema,
  GraduationConfirmBodySchema,
  ERROR_HTTP_STATUS,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_HEADER,
  SubmitBodySchema,
  matchRoute,
  type ConsolidateResponse,
  type ErrorCode,
  type GraduationResult,
  type KbPipelineResponse,
  type LastPromote,
  type PromoteResponse,
  type WolfEvent,
  type ThreadSummary,
  type ThreadWorkspace,
  type WolfSummary,
} from "@wolfpack/protocol";
import {
  type EngineConversation,
} from "../engine/index.js";
import { graduationActionsFor, memoryActionsFor, type MemoryActions } from "../memory/actions.js";
import { disposeMemoryEvents, memoryEventsFor, type MemoryEventBus } from "../memory/events.js";
import type { KbRoots } from "@wolfpack/kb/shared";
import { UnknownDomainError, buildKbGraph, readKbEntry } from "@wolfpack/kb/graph";
import { readDenTopics } from "@wolfpack/memory";
import { fetchWorkItem, fetchWorkSources, isTopicId, isWorkId, memoryState, readBound, readMemoryObservations, readMemoryStatus, readMemoryTopic, readWorkList, readWorkRecord, type MemoryReadConfig } from "./memory-read.js";
import { bindConversation } from "./bind.js";
import { prepareSocketPath } from "./socket.js";
import { AttachmentError, loadAttachment, storeAttachment } from "./attachments.js";
import { HttpError } from "./http-error.js";
import { GraduationJobs } from "./graduation-jobs.js";
import { GitInfo } from "./workspace-info.js";
import { ThreadRuntime, type WolfEventDraft } from "./thread.js";
import { SubagentManager, type SubagentOptions } from "./subagents.js";
import { readFeatureClosed } from "@wolfpack/memory";
import { bindFeature, featureInfo, featureThreadId, findBindingHolder, loadThreads, removeThread, saveThread, unbindConversation } from "./threads.js";

export interface WolfServerOptions {
  /** Wolf name: used as the protocol wolf id/name and in the thread id `<name>/home`. */
  name: string;
  host?: string;
  /** The home conversation. */
  conversation: EngineConversation;
  /** Creates and reopens the conversations behind feature threads. Unset: this wolf refuses to host feature threads. */
  conversations?: ThreadConversations;
  /** Subagents: where their roster lives and how their conversations are created. Unset: this wolf has no spawn tools' manager. */
  subagents?: SubagentOptions & { bridge?: { manager?: SubagentManager } };
  /** How long submit/abort wait for the event pump to observe the effect. Default 5000. */
  settleTimeoutMs?: number;
  /** The wolf's den: its MemoryEvent bus feeds `GET /v1/wolves/:name/events`. Omitted: that stream stays empty. */
  den?: string;
  /** Whether the memory extension is installed on this wolf; picks the `memory_unavailable` message. Unset: generic. */
  memoryExtension?: boolean;
  /**
   * KB roots resolved at startup (sandbox-aware: KB_BASE / KB_OPS from the effective env, den-local state under the
   * den). Unset when the wolf has none. The KB routes (graph, entries, pipeline) read from here.
   */
  kbRoots?: KbRoots;
  /** This wolf is the librarian (wolf.yaml `memory.librarian`): reported as `librarian` on its summary. */
  librarian?: boolean;
  /** Memory settings for the read-only memory status route. Unset: sandbox off, default thresholds. */
  memoryConfig?: MemoryReadConfig;
  /** The Work API client settings (effective WORK_ENDPOINT / WORK_TOKEN) behind the work Record route. */
  work?: { endpoint?: string; token?: string };
  // ---- header git tree ----
  /** The wolf's workspace (the home thread's cwd): its git state is the home thread's `workspace`. Unset: home reports none. */
  workspace?: string;
  /** How long git answers behind `workspace` stay cached. Default 5000. */
  gitCacheMs?: number;
  // ---- /header git tree ----
  /** Called with faults the pump cannot surface over HTTP. */
  onError?: (error: unknown) => void;
}

/** How feature threads get their engine conversations (new ones, and the persisted ones again after a restart). */
export interface ThreadConversations {
  create(): Promise<EngineConversation>;
  get(id: string): Promise<EngineConversation | undefined>;
}

const WOLF_EVENT_BUFFER = 256;
const MEMORY_KEEPALIVE_MS = 20_000;
const MEMORY_STREAM_MAX_BUFFER = 1_000_000;

const GRADUATED_MESSAGE = "This feature has graduated; its thread is read-only history. Start a new feature or use home.";

export class WolfServer {
  private readonly name: string;
  private readonly host: string;
  private readonly settleMs: number;
  private readonly http: Server;
  private baseUrl = "";
  private socketPath: string | undefined;

  /** Every thread this wolf serves, home first. */
  private readonly threads = new Map<string, ThreadRuntime>();
  private readonly homeId: string;
  private readonly opening = new Map<string, Promise<{ summary: ThreadSummary; created: boolean }>>();
  private homeCreated = false;
  private readonly memoryBus?: MemoryEventBus;
  private readonly subagents?: SubagentManager;
  // wolf-scoped activity stream (thread-status, card events): own id space, bounded replay buffer
  /** Starts at 1: a baseline carries the current cursor as its id, and ids are positive. */
  private wolfSeq = 1;
  /** Per-process epoch in the SSE id (`<boot>:<seq>`): a cursor from another process is stale, whatever its number. */
  private readonly boot = randomUUID().slice(0, 8);
  private wolfBuffer: WolfEvent[] = [];
  private readonly wolfSubs = new Set<(ev: WolfEvent) => void>();
  private closing = false;
  // ---- header git tree ----
  private readonly gitInfo: GitInfo;
  // ---- /header git tree ----

  constructor(private readonly opts: WolfServerOptions) {
    this.name = opts.name;
    this.host = opts.host ?? "local";
    this.settleMs = opts.settleTimeoutMs ?? 5000;
    if (opts.den) this.memoryBus = memoryEventsFor(opts.den, opts.name);
    this.homeId = `${this.name}/home`;
    this.gitInfo = new GitInfo(opts.gitCacheMs ?? 5000);
    if (opts.subagents && opts.den) {
      const { bridge, ...sub } = opts.subagents;
      this.subagents = new SubagentManager(
        {
          name: this.name,
          den: opts.den,
          settleMs: this.settleMs,
          thread: (id) => this.threads.get(id),
          knownThread: (id) => this.threads.has(id) || (opts.den ? loadThreads(opts.den).some((t) => t.id === id) : false),
          threadOfConversation: (cid) => [...this.threads.values()].find((t) => t.conv.id === cid),
          attachChild: async (summary, conv) => {
            const t = this.makeThread(summary, conv);
            try {
              await t.attach();
            } catch (e) {
              this.threads.delete(summary.id);
              await t.close().catch(() => {});
              throw e;
            }
            return t;
          },
          detachChild: async (id) => {
            const t = this.threads.get(id);
            this.threads.delete(id);
            await t?.close();
          },
          emitWolf: (d) => this.emitWolf(d),
          onError: (e) => this.opts.onError?.(e),
        },
        {
          ...sub,
          workStage: sub.workStage ?? (async (id) => {
            const r = await fetchWorkItem(id, this.opts.work ?? {});
            return r.kind === "ok" ? r.item.stage : undefined;
          }),
        },
      );
      if (bridge) bridge.manager = this.subagents;
    }
    this.makeThread({ id: this.homeId, wolf: this.name, kind: "home", title: "Home" }, opts.conversation);
    this.http = createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        if (!res.headersSent) {
          this.sendError(res, e instanceof HttpError ? e : new HttpError("engine_error", e instanceof Error ? e.message : "unexpected error"), req);
        } else res.end();
      });
    });
    // Explicit, never 0 (disabled): a stalled upload must not hold a socket forever. SSE streams are unaffected (the request is complete).
    this.http.headersTimeout = 30_000;
    this.http.requestTimeout = 120_000;
  }

  get url(): string {
    return this.baseUrl;
  }

  private get home(): ThreadRuntime {
    return this.threads.get(this.homeId)!;
  }

  /** Attach every thread's watcher (home, then the persisted feature threads) and start pumping. Call before listen(). */
  async attach(): Promise<void> {
    await this.home.attach();
    // A store with history already has its home thread: createThread then answers 200, not 201.
    this.homeCreated = this.home.hadHistory;
    const { den, conversations } = this.opts;
    if (!den || !conversations) return;
    for (const saved of loadThreads(den, (e) => this.opts.onError?.(e))) {
      // One bad thread must not keep the wolf from starting: report it, leave it unregistered, carry on.
      try {
        const conv = await conversations.get(saved.conversationId);
        if (!conv) {
          this.opts.onError?.(new Error(`thread ${saved.id}: conversation ${saved.conversationId} is gone`));
          continue;
        }
        const summary: ThreadSummary = { id: saved.id, wolf: this.name, kind: "feature", title: saved.title, boundWorkItem: saved.workItemId };
        const t = this.makeThread(summary, conv);
        const reason = saved.closedReason ?? (await this.closedReasonOf(saved.workItemId, Number(saved.conversationId)));
        if (reason) this.markClosed(t, reason);
        try {
          await t.attach();
        } catch (e) {
          this.threads.delete(saved.id);
          await t.close().catch(() => {});
          throw e;
        }
      } catch (e) {
        this.opts.onError?.(new Error(`thread ${saved.id} not attached: ${e instanceof Error ? e.message : String(e)}`));
      }
    }
    // Children last: their parents are attached now, so a result nobody took yet can be delivered.
    await this.subagents?.recover();
  }

  async listen(port = 0): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(port, "127.0.0.1", () => resolve());
    });
    this.baseUrl = `http://127.0.0.1:${(this.http.address() as AddressInfo).port}`;
    return this.baseUrl;
  }

  /** Listen on a unix socket (dir 0700; stale file removed, live one refused). Returns `unix:<path>`. */
  async listenSocket(path: string): Promise<string> {
    await prepareSocketPath(path);
    await new Promise<void>((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(path, () => resolve());
    });
    this.socketPath = path;
    this.baseUrl = `unix:${path}`;
    return this.baseUrl;
  }

  async close(): Promise<void> {
    this.closing = true;
    this.http.closeAllConnections();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
    if (this.socketPath) rmSync(this.socketPath, { force: true });
    this.subagents?.close();
    for (const t of this.threads.values()) await t.close();
    if (this.opts.den) disposeMemoryEvents(this.opts.den);
  }

  // ------------------------------------------------------------ threads

  private emitWolf(draft: WolfEventDraft): void {
    const full = { ...draft, id: ++this.wolfSeq, wolf: this.name, at: new Date().toISOString() } as WolfEvent;
    this.wolfBuffer.push(full);
    if (this.wolfBuffer.length > WOLF_EVENT_BUFFER) this.wolfBuffer.shift();
    for (const s of [...this.wolfSubs]) s(full);
  }

  private makeThread(summary: ThreadSummary, conv: EngineConversation): ThreadRuntime {
    const t = new ThreadRuntime(summary, conv, {
      name: this.name,
      den: this.opts.den,
      settleMs: this.settleMs,
      closing: () => this.closing,
      emitWolf: (d) => this.emitWolf(d),
      onError: (e) => this.opts.onError?.(e),
    });
    this.threads.set(summary.id, t);
    this.subagents?.watchShips(t);
    return t;
  }

  /** Read-only history: a graduated feature's thread keeps its messages, refuses new ones. */
  private markClosed(t: ThreadRuntime, reason: string): void {
    t.summary = { ...t.summary, closed: true, closedReason: reason };
    const den = this.opts.den;
    const saved = den ? loadThreads(den).find((s) => s.id === t.summary.id) : undefined;
    if (den && saved && saved.closedReason !== reason) saveThread(den, { ...saved, closedReason: reason }, (e) => this.opts.onError?.(e));
  }

  /** Why a feature thread is closed: the graduation marker the unbind leaves, or the feature's stage in the Work API. Undefined when open or unknown. */
  private async closedReasonOf(workItemId: string, conversationId: number): Promise<string | undefined> {
    const den = this.opts.den;
    if (den) {
      const m = readFeatureClosed(den, conversationId);
      if (m?.workId === workItemId) return GRADUATED_MESSAGE;
    }
    const r = await fetchWorkItem(workItemId, this.opts.work ?? {});
    if (r.kind === "ok" && (r.item.stage === "archived" || r.item.graduated)) return GRADUATED_MESSAGE;
    return undefined;
  }

  /** Close the feature threads of these work items (a graduation happened). Returns the thread ids closed. */
  closeFeatureThreads(workItemIds: string[]): string[] {
    const closed: string[] = [];
    for (const t of this.threads.values()) {
      if (t.summary.kind === "feature" && t.summary.boundWorkItem && workItemIds.includes(t.summary.boundWorkItem)) {
        this.markClosed(t, GRADUATED_MESSAGE);
        closed.push(t.summary.id);
      }
    }
    return closed;
  }

  /** Graduation jobs by `<wolf>:<work id>`: preview and confirm run in the background, a second start returns the running job. */
  private readonly graduationJobs = new GraduationJobs();

  /** The wolf's graduation actions, after the checks every graduate route shares. */
  private graduationFor(params: Record<string, string>, validated?: () => void) {
    this.checkWolf(params.name);
    if (!isWorkId(params.id)) throw new HttpError("invalid_request", "malformed work item id");
    validated?.();
    if (!this.opts.work?.endpoint) throw new HttpError("memory_unavailable", "no Work API configured on this wolf (WORK_ENDPOINT / WORK_TOKEN)");
    const actions = this.opts.den ? graduationActionsFor(this.opts.den) : undefined;
    if (!actions) throw new HttpError("memory_unavailable", "this wolf cannot graduate work (the tasks extension is not loaded)");
    return actions;
  }

  /** An error of a graduation step as the protocol code and message the job reports: the extension's refusals keep their code. */
  private graduationFailure(e: unknown): { code: ErrorCode; message: string } {
    if (e instanceof HttpError) return { code: e.code, message: e.message };
    const code = (e as { name?: string; code?: string } | undefined)?.name === "GraduationError" ? (e as { code: string }).code : undefined;
    const message = e instanceof Error ? e.message : String(e);
    if (code === "not_ready") return { code: "not_ready", message };
    if (code === "preview_stale") return { code: "preview_stale", message };
    if (code === "unavailable") return { code: "memory_unavailable", message };
    return { code: "engine_error", message };
  }

  private readonly closeChecks = new Map<string, number>();

  /** Refuse a send on a closed feature thread (409 thread_closed); a still-open one is re-checked against the feature's stage at most every 10 s. */
  private async assertOpen(t: ThreadRuntime): Promise<void> {
    if (t.summary.kind !== "feature") return;
    if (!t.summary.closed && Date.now() - (this.closeChecks.get(t.summary.id) ?? 0) > 10_000) {
      this.closeChecks.set(t.summary.id, Date.now());
      const saved = this.opts.den ? loadThreads(this.opts.den).find((s) => s.id === t.summary.id) : undefined;
      const reason = await this.closedReasonOf(t.summary.boundWorkItem ?? "", saved ? Number(saved.conversationId) : -1);
      if (reason) this.markClosed(t, reason);
    }
    if (t.summary.closed) throw new HttpError("thread_closed", t.summary.closedReason ?? GRADUATED_MESSAGE);
  }

  /** Open (or return) the feature thread for a work item: an ownerless conversation bound to the feature. */
  private openFeatureThread(workItemId: string): Promise<{ summary: ThreadSummary; created: boolean }> {
    const pending = this.opening.get(workItemId);
    if (pending) return pending;
    const p = (async () => {
      const id = featureThreadId(this.name, workItemId);
      const have = this.threads.get(id);
      if (have) return { summary: await this.withWorkspace(have.threadSummary()), created: false };
      const host = this.opts.conversations;
      if (!host || !this.opts.den) throw new HttpError("invalid_request", "this wolf cannot host feature threads");
      if (!isWorkId(workItemId)) throw new HttpError("invalid_request", "malformed work item id");
      const info = await featureInfo(workItemId, this.opts.work ?? {});
      const den = this.opts.den;
      const onError = (e: unknown) => this.opts.onError?.(e);
      // A holder that is neither home nor a known feature thread is an orphan (a crash or failure mid-create): take over.
      const holder = findBindingHolder(den, workItemId);
      if (holder !== undefined) {
        const known = new Set([this.home.conv.id, ...loadThreads(den, onError).map((t) => t.conversationId)]);
        if (known.has(String(holder))) throw new HttpError("invalid_request", `${workItemId} is already bound in conversation ${holder}; release it there first`);
        unbindConversation(den, holder);
      }
      const conv = await host.create();
      const summary: ThreadSummary = { id, wolf: this.name, kind: "feature", title: info.title, boundWorkItem: workItemId };
      // Registry first: a crash after this leaves a thread wolfd re-attaches, never a binding nobody owns.
      saveThread(den, { id, conversationId: conv.id, kind: "feature", workItemId, title: info.title }, onError);
      let t: ThreadRuntime | undefined;
      try {
        bindFeature(den, conv.id, { workId: workItemId, domain: info.domain });
        t = this.makeThread(summary, conv);
        await t.attach();
      } catch (e) {
        this.threads.delete(id);
        await t?.close().catch(() => {});
        try { unbindConversation(den, Number(conv.id)); } catch { /* best effort */ }
        try { removeThread(den, id, onError); } catch { /* best effort */ }
        throw e;
      }
      this.emitWolf({ type: "thread-status", threadId: id, status: t.status() });
      return { summary: await this.withWorkspace(t.threadSummary()), created: true };
    })().finally(() => this.opening.delete(workItemId));
    this.opening.set(workItemId, p);
    return p;
  }

  // ---- header git tree ----
  /** Where a thread works (its cwd) and the branch that cwd's branch was cut from. */
  private async locate(t: ThreadRuntime): Promise<{ dir: string; base?: string } | undefined> {
    if (t.summary.kind === "subagent") {
      const rec = this.subagents?.recordOf(t.summary.id);
      if (!rec) return undefined;
      const parent = this.threads.get(rec.parentThreadId);
      // A worktree child was cut from its parent's branch; a child sharing the cwd has no base of its own.
      const base = rec.workspace && parent ? (await this.workspaceOf(parent))?.branch : undefined;
      return { dir: rec.workspace?.path ?? rec.cwd, ...(base ? { base } : {}) };
    }
    if (t.summary.kind === "feature") {
      const saved = this.opts.den ? loadThreads(this.opts.den).find((s) => s.id === t.summary.id) : undefined;
      if (saved?.workspace) {
        const base = saved.workspaceBase ?? (await this.gitInfo.mainBranch(saved.workspace.repo.mainDir));
        return { dir: saved.workspace.path, ...(base ? { base } : {}) };
      }
    }
    return this.opts.workspace ? { dir: this.opts.workspace } : undefined;
  }

  private async workspaceOf(t: ThreadRuntime): Promise<ThreadWorkspace | undefined> {
    const at = await this.locate(t);
    return at ? this.gitInfo.workspaceOf(at.dir, at.base) : undefined;
  }

  private async withWorkspace<S extends ThreadSummary>(summary: S): Promise<S> {
    const t = this.threads.get(summary.id);
    const workspace = t ? await this.workspaceOf(t).catch(() => undefined) : undefined;
    return workspace ? ({ ...summary, workspace } as S) : summary;
  }
  // ---- /header git tree ----

  // ------------------------------------------------------------- http

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://wolfd");
    res.setHeader(PROTOCOL_VERSION_HEADER, String(PROTOCOL_VERSION));
    const m = matchRoute(req.method ?? "GET", url.pathname);
    if (m === undefined) throw new HttpError("not_found", `no route ${url.pathname}`);
    if (m === "method") throw new HttpError("invalid_request", `method ${req.method} not allowed`);

    const v = req.headers[PROTOCOL_VERSION_HEADER.toLowerCase()];
    if (typeof v === "string") {
      if (!/^\d+$/.test(v.trim())) throw new HttpError("invalid_request", `bad ${PROTOCOL_VERSION_HEADER}`);
      if (Number(v) !== PROTOCOL_VERSION) {
        throw new HttpError("version_mismatch", `server speaks protocol ${PROTOCOL_VERSION}, client sent ${v}`);
      }
    }

    const { params } = m;
    switch (m.name) {
      case "listWolves":
        return this.json(res, 200, { wolves: [this.wolfSummary()] });
      case "listThreads":
        this.checkWolf(params.name);
        return this.json(res, 200, { threads: await Promise.all([...this.threads.values()].map((t) => this.withWorkspace(t.threadSummary()))) });
      case "listCards":
        this.checkWolf(params.name);
        // A subagent's questions go to its parent, not to the operator's needs-you list.
        return this.json(res, 200, { cards: [...this.threads.values()].filter((t) => !t.isChild).flatMap((t) => t.cards.pending()) });
      case "answerCard": {
        const t = this.checkThread(params.id);
        await this.assertOpen(t);
        const body = AnswerCardBodySchema.safeParse(await readJson(req));
        if (!body.success) throw new HttpError("invalid_request", "body must be {answers: {<fieldId>: {value, other?}}}");
        return this.json(res, 200, await t.answerCard(params.callId, body.data.answers));
      }
      case "skipCard": {
        const t = this.checkThread(params.id);
        return this.json(res, 200, await t.skipCard(params.callId));
      }
      case "createThread": {
        this.checkWolf(params.name);
        const body = CreateThreadBodySchema.safeParse(await readJson(req));
        if (!body.success) throw new HttpError("invalid_request", 'body must be {kind:"home"} or {kind:"feature", workItemId}');
        if (body.data.kind === "feature") {
          const r = await this.openFeatureThread(body.data.workItemId);
          return this.json(res, r.created ? 201 : 200, r.summary);
        }
        // The home thread is the engine root conversation: it always exists once the process is up.
        const status = this.homeCreated ? 200 : 201;
        this.homeCreated = true;
        return this.json(res, status, await this.withWorkspace(this.home.threadSummary()));
      }
      // --- feature progress: bind ---
      case "bindThread": {
        const t = this.checkThread(params.id);
        if (t.isChild || t.summary.kind === "process") throw new HttpError("invalid_request", `a ${t.summary.kind} thread cannot be bound`);
        await this.assertOpen(t);
        const body = BindThreadBodySchema.safeParse(await readJson(req));
        if (!body.success) throw new HttpError("invalid_request", "body must be {workItemId}");
        if (!this.opts.den) throw new HttpError("memory_unavailable", "this wolf has no den to keep a binding in");
        const known = new Set([this.home.conv.id, ...loadThreads(this.opts.den, (e) => this.opts.onError?.(e)).map((s) => s.conversationId)]);
        const r = await bindConversation({
          den: this.opts.den,
          work: this.opts.work ?? {},
          conversationId: t.conv.id,
          ...(t.summary.kind === "feature" && t.summary.boundWorkItem ? { threadFeature: t.summary.boundWorkItem } : {}),
          knownConversations: known,
          workItemId: body.data.workItemId,
        });
        this.emitWolf({ type: "thread-updated", thread: t.threadSummary() });
        return this.json(res, 200, { threadId: t.summary.id, workItemId: body.data.workItemId, ...(r.previous ? { previousWorkItemId: r.previous } : {}) });
      }
      // --- end feature progress ---
      case "listChildren": {
        const t = this.checkThread(params.id);
        return this.json(res, 200, { threads: await Promise.all((this.subagents?.children(t.summary.id) ?? []).map((c) => this.withWorkspace(c))) });
      }
      case "getLedger": {
        const t = this.checkThread(params.id);
        const entries = this.subagents?.ledgerOf(t.summary.id);
        if (!entries) throw new HttpError("not_found", `thread ${t.summary.id} has no ledger`);
        return this.json(res, 200, { entries });
      }
      case "getThread": {
        const detail = this.checkThread(params.id).detail();
        return this.json(res, 200, await this.withWorkspace(detail));
      }
      // ---- header git tree ----
      case "getWorkspaceStatus": {
        const t = this.checkThread(params.id);
        const ws = await this.workspaceOf(t);
        if (!ws) throw new HttpError("not_found", `thread ${t.summary.id} has no git workspace`);
        return this.json(res, 200, await this.gitInfo.status(ws, this.subagents?.liveWorktrees(t.summary.id) ?? []));
      }
      // ---- /header git tree ----
      case "submit": {
        const t = this.checkThread(params.id);
        await this.assertOpen(t);
        const body = SubmitBodySchema.safeParse(await readJson(req));
        if (!body.success) throw new HttpError("invalid_request", "body must be {input, whenBusy: steer|followUp|reject}");
        const refs = body.data.attachments ?? [];
        if (body.data.input.trim() === "" && refs.length === 0) throw new HttpError("invalid_request", "input is required");
        // A subagent's messages from the operator go through its manager: ledger, resume, state.
        if (t.isChild && this.subagents) return this.json(res, 200, await this.subagents.submitFromOwner(t.summary.id, body.data.input, body.data.whenBusy, refs));
        return this.json(res, 200, await t.submit(body.data.input, body.data.whenBusy, refs));
      }
      case "uploadAttachment": {
        try {
          this.checkThread(params.id);
          if (!this.opts.den) throw new HttpError("invalid_request", "this wolf has no den to store attachments in");
        } catch (e) {
          // The body is unread: let the client finish writing and read the error.
          throw e instanceof HttpError ? new HttpError(e.code, e.message, 0) : e;
        }
        const declared = Number(req.headers["content-length"]);
        if (Number.isFinite(declared) && declared > ATTACHMENT_MAX_BYTES) {
          throw new HttpError("invalid_request", `attachment too large (limit ${ATTACHMENT_MAX_BYTES} bytes)`, 0);
        }
        const bytes = await readBytes(req, ATTACHMENT_MAX_BYTES);
        const rawName = req.headers[ATTACHMENT_NAME_HEADER.toLowerCase()];
        let name: string | undefined;
        try {
          name = typeof rawName === "string" ? decodeURIComponent(rawName) : undefined;
        } catch {
          name = undefined;
        }
        try {
          return this.json(res, 201, storeAttachment(this.opts.den, params.id, bytes, req.headers["content-type"] ?? "", name));
        } catch (e) {
          if (e instanceof AttachmentError) throw new HttpError("invalid_request", e.message);
          throw e;
        }
      }
      case "getAttachment": {
        this.checkThread(params.id);
        if (!this.opts.den) throw new HttpError("not_found", `unknown attachment ${params.attachmentId}`);
        let file;
        try {
          file = loadAttachment(this.opts.den, params.id, params.attachmentId);
        } catch (e) {
          // loadAttachment only accepts a UUID that names a file in this thread's directory: no traversal.
          if (e instanceof AttachmentError) throw new HttpError("not_found", e.message);
          throw e;
        }
        res.writeHead(200, {
          "Content-Type": file.mimeType,
          "Content-Length": file.bytes.length,
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "private, max-age=31536000, immutable",
          "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        });
        res.end(file.bytes);
        return;
      }
      case "abort": {
        const t = this.checkThread(params.id);
        if (t.isChild && this.subagents) await this.subagents.abortFromOwner(t.summary.id);
        else await t.abort();
        return this.json(res, 200, { ok: true });
      }
      case "streamThread":
        return this.checkThread(params.id).stream(req, res, url);
      case "streamWolfActivity":
        this.checkWolf(params.name);
        return this.activityStream(req, res, url);
      case "streamWolfEvents":
        this.checkWolf(params.name);
        return this.memoryStream(req, res);
      case "consolidateMemory": {
        this.checkWolf(params.name);
        const actions = this.memoryActions();
        // Consolidate shares the promote queue: refuse now rather than hold the request behind a long job.
        if (actions.isBusy()) throw new HttpError("memory_busy", "a promote is running; retry when it finishes");
        const r = await actions.consolidate().catch((e: unknown) => {
          console.error(`[wolfd] consolidate failed: ${firstLine(e)}`);
          throw new HttpError("engine_error", "consolidation failed");
        });
        const body: ConsolidateResponse = {
          observationsProcessed: r.observationsProcessed,
          topicsCreated: r.topicsCreated,
          topicsMerged: r.topicsMerged,
          topicsSkipped: r.topicsSkipped,
          claimsSubmitted: r.claimsSubmitted,
          ...(r.recordsWritten !== undefined ? { recordsWritten: r.recordsWritten } : {}),
          ...(r.observationsPending !== undefined ? { observationsPending: r.observationsPending } : {}),
          topicIds: r.topicIds ?? [],
        };
        return this.json(res, 200, body);
      }
      case "getMemoryStatus": {
        this.checkWolf(params.name);
        const thread = url.searchParams.get("thread");
        // The binding is per conversation: the asked thread's, else home's.
        const t = thread !== null ? this.checkThread(thread) : this.home;
        const bound = this.opts.den ? await readBound(this.opts.den, t.conv.id, this.opts.work ?? {}) : null;
        return this.json(res, 200, await readMemoryStatus(this.memoryReadInput(), this.lastPromote(), bound));
      }
      case "getMemoryTopic": {
        this.checkWolf(params.name);
        if (!isTopicId(params.id)) throw new HttpError("invalid_request", "malformed topic id");
        const scope = url.searchParams.get("scope");
        if (scope !== null && scope !== "den" && scope !== "session") throw new HttpError("invalid_request", "scope must be den or session");
        const { state, reason } = memoryState(this.memoryReadInput());
        if (state === "inert" || state === "off") throw new HttpError("memory_unavailable", reason);
        const topic = readMemoryTopic(this.opts.den!, params.id, scope ?? undefined);
        if (!topic) throw new HttpError("not_found", `topic ${params.id}`);
        return this.json(res, 200, topic);
      }
      case "getMemoryObservations": {
        this.checkWolf(params.name);
        const rawLimit = url.searchParams.get("limit");
        if (rawLimit !== null && !/^[1-9]\d{0,6}$/.test(rawLimit)) throw new HttpError("invalid_request", "limit must be a positive integer");
        const { state, reason } = memoryState(this.memoryReadInput());
        if (state === "inert" || state === "off") throw new HttpError("memory_unavailable", reason);
        return this.json(res, 200, await readMemoryObservations(this.opts.den!, rawLimit === null ? undefined : Number(rawLimit), this.opts.work ?? {}));
      }
      case "listWork": {
        this.checkWolf(params.name);
        const domain = url.searchParams.get("domain");
        if (!domain) throw new HttpError("invalid_request", "domain is required");
        const flag = url.searchParams.get("graduated");
        if (flag !== null && flag !== "true" && flag !== "false") throw new HttpError("invalid_request", "graduated must be true or false");
        const r = await readWorkList(domain, flag === "true", this.opts.work ?? {});
        if (r.kind === "unconfigured") throw new HttpError("memory_unavailable", "no Work API configured on this wolf (WORK_ENDPOINT / WORK_TOKEN)");
        if (r.kind === "error") throw new HttpError("engine_error", `work API: ${r.message}`);
        return this.json(res, 200, { items: r.items });
      }
      case "getWorkRecord": {
        this.checkWolf(params.name);
        if (!isWorkId(params.id)) throw new HttpError("invalid_request", "malformed work item id");
        const r = await readWorkRecord(params.id, this.opts.work ?? {});
        if (r.kind === "unconfigured") throw new HttpError("memory_unavailable", "no Work API configured on this wolf (WORK_ENDPOINT / WORK_TOKEN)");
        if (r.kind === "not_found") throw new HttpError("not_found", `work item ${params.id}`);
        if (r.kind === "error") throw new HttpError("engine_error", `work API: ${r.message}`);
        return this.json(res, 200, r.value);
      }
      case "previewGraduation": {
        const actions = this.graduationFor(params);
        const key = `${params.name}:${params.id}`;
        const job = this.graduationJobs.start(
          key,
          "preview",
          async () => ({ kind: "preview", preview: await actions.preview(params.id) }),
          (e) => this.graduationFailure(e),
        );
        return this.json(res, 200, job);
      }
      case "confirmGraduation": {
        const parsed = GraduationConfirmBodySchema.safeParse(await readJson(req));
        const actions = this.graduationFor(params, () => {
          if (!parsed.success) throw new HttpError("invalid_request", "body must be {token}");
        });
        if (!parsed.success) throw new HttpError("invalid_request", "body must be {token}");
        const token = parsed.data.token;
        const key = `${params.name}:${params.id}`;
        const job = this.graduationJobs.start(
          key,
          "confirm",
          async () => {
            const done = await actions.confirm(params.id, token);
            const result: GraduationResult = {
              graduated: true,
              entries: done.entries,
              archived: done.archived,
              lateFolded: done.lateFolded,
              unbound: done.unbound,
              closedThreads: this.closeFeatureThreads([params.id, ...done.archived]),
            };
            return { kind: "confirm", result };
          },
          (e) => this.graduationFailure(e),
        );
        return this.json(res, 200, job);
      }
      case "graduationStatus": {
        const actions = this.graduationFor(params);
        const known = this.graduationJobs.get(`${params.name}:${params.id}`);
        if (known) return this.json(res, 200, known);
        // No job in memory (wolfd restarted): a preview whose token file is still fresh is ready to confirm.
        const preview = await actions.pendingPreview(params.id).catch(() => undefined);
        return this.json(res, 200, preview ? { state: "preview_ready", preview } : { state: "none" });
      }
      case "graduationObservations": {
        const actions = this.graduationFor(params);
        try {
          return this.json(res, 200, await actions.observations(params.id));
        } catch (e) {
          const f = this.graduationFailure(e);
          throw new HttpError(f.code, f.message);
        }
      }
      case "kbPipeline": {
        this.checkWolf(params.name);
        const roots = this.requireKb();
        // Loaded on first use: only the librarian ever gets here, and the pipeline reader pulls in the librarian package.
        const { readPipeline } = await import("@wolfpack/kb/librarian");
        const body: KbPipelineResponse = readPipeline(roots);
        return this.json(res, 200, body);
      }
      case "getKbGraph": {
        this.checkWolf(params.name);
        const roots = this.requireKb();
        const flag = (k: string): boolean => {
          const v = url.searchParams.get(k);
          if (v === null || v === "false") return false;
          if (v === "true") return true;
          throw new HttpError("invalid_request", `${k} must be true or false`);
        };
        const domain = url.searchParams.get("domain") ?? undefined;
        // The den layer is this wolf's own den only, never another wolf's; with no den it reports itself off.
        const denTopics = flag("denTopics") && this.opts.den !== undefined;
        const den = denTopics && this.opts.den ? { wolf: this.name, topics: readDenTopics(this.opts.den) } : undefined;
        // Work items come from the Work API; unreachable or unconfigured, the builder falls back to the KB work files.
        const work = await fetchWorkSources(this.opts.work?.endpoint || process.env.WORK_ENDPOINT, this.opts.work?.token || process.env.WORK_TOKEN);
        try {
          return this.json(res, 200, buildKbGraph(roots, { domain, archivedWork: flag("archivedWork"), denTopics, den, work }));
        } catch (e) {
          if (e instanceof UnknownDomainError) throw new HttpError("not_found", `domain ${e.domain}`);
          throw e;
        }
      }
      case "getKbEntry": {
        this.checkWolf(params.name);
        const roots = this.requireKb();
        if (!/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/.test(params.id)) throw new HttpError("invalid_request", "malformed entry id");
        const entry = readKbEntry(roots, params.id);
        if (!entry) throw new HttpError("not_found", `entry ${params.id}`);
        return this.json(res, 200, entry);
      }
      case "promoteMemory": {
        this.checkWolf(params.name);
        const actions = this.memoryActions();
        if (!actions.promoteEnabled) throw new HttpError("promote_unavailable", "promote needs KB roots (KB_BASE and KB_OPS); this wolf has none");
        const start = actions.promote();
        // The extension emits promote_started/finished/failed itself; `done` is only observed here so a failed job
        // is not an unhandled rejection.
        if (start.status === "started") start.done.catch(() => {});
        const body: PromoteResponse = { jobId: start.jobId, status: start.status };
        return this.json(res, 202, body);
      }
    }
  }

  /**
   * The KB roots for a KB route. The KB graph / entry / pipeline routes are librarian-only: a wolf that is not the
   * librarian, or has no KB roots (no KB_BASE / KB_OPS), answers `kb_unavailable` (409).
   */
  private requireKb(): KbRoots {
    if (!this.opts.librarian) throw new HttpError("kb_unavailable", `wolf ${this.name} is not the librarian`);
    if (!this.opts.kbRoots) throw new HttpError("kb_unavailable", "this wolf has no KB roots (KB_BASE and KB_OPS)");
    return this.opts.kbRoots;
  }

  /** How the last promote on this den ended (the bus keeps it; in memory only, so null after a restart). */
  private lastPromote(): LastPromote | null {
    const ev = this.memoryBus?.lastPromoteEvent?.();
    if (ev?.type === "promote_finished") return { jobId: ev.jobId, at: ev.timestamp, result: "finished", consolidated: ev.consolidated, contributions: ev.contributions };
    if (ev?.type === "promote_failed") return { jobId: ev.jobId, at: ev.timestamp, result: "failed", message: ev.message };
    return null;
  }

  private memoryReadInput() {
    return {
      den: this.opts.den,
      extensionInstalled: this.opts.memoryExtension,
      running: this.opts.den ? memoryActionsFor(this.opts.den) !== undefined : false,
      config: this.opts.memoryConfig ?? { sandbox: false, consolidation: { threshold: 20000, poolTarget: 10000, trigger: "hybrid" as const } },
    };
  }

  /** The memory extension's actions for this wolf; `memory_unavailable` when memory is inert or not loaded. */
  private memoryActions(): MemoryActions {
    const actions = this.opts.den ? memoryActionsFor(this.opts.den) : undefined;
    if (!actions) {
      const why =
        this.opts.memoryExtension === false
          ? "memory is off: the memory extension is not loaded (add `memory` to extensions in wolf.yaml)"
          : this.opts.memoryExtension === true
            ? "memory is inert: the extension is loaded but gated off (set `sandbox` or `memory.live` in wolf.yaml)"
            : "memory is inert or not loaded on this wolf";
      throw new HttpError("memory_unavailable", why);
    }
    return actions;
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private sendError(res: ServerResponse, e: HttpError, req?: IncomingMessage): void {
    if (e.drain !== undefined && req) drainBounded(req, e.drain);
    res.writeHead(ERROR_HTTP_STATUS[e.code], { "Content-Type": "application/json", [PROTOCOL_VERSION_HEADER]: String(PROTOCOL_VERSION) });
    res.end(JSON.stringify({ code: e.code, message: e.message, retryable: e.code === "busy" || e.code === "memory_busy" }));
  }

  // ------------------------------------------------------------ state

  private wolfSummary(): WolfSummary {
    return { id: this.name, name: this.name, host: this.host, status: [...this.threads.values()].some((t) => t.isRunning) ? "busy" : "online", librarian: this.opts.librarian === true };
  }

  private checkWolf(name: string): void {
    if (name !== this.name) throw new HttpError("not_found", `wolf ${name}`);
  }

  private checkThread(id: string): ThreadRuntime {
    const t = this.threads.get(id);
    if (!t) throw new HttpError("not_found", `thread ${id}`);
    return t;
  }

  /** Live MemoryEvents of this wolf: no replay, no ids, no [DONE]; open until the client goes (or the server closes). */
  private memoryStream(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    const unsubscribe = this.memoryBus?.subscribe((ev) => {
      // A client that stopped reading must not grow our memory: drop it.
      if (res.writableLength > MEMORY_STREAM_MAX_BUFFER) return void res.destroy();
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    });
    res.write(": connected\n\n"); // flushes headers; once the client has them it is subscribed
    const ka = setInterval(() => res.write(": ka\n\n"), MEMORY_KEEPALIVE_MS);
    ka.unref();
    const gone = () => {
      clearInterval(ka);
      unsubscribe?.();
    };
    req.on("close", gone);
    res.on("close", gone);
  }

  /**
   * Wolf activity (thread status + card changes). Fresh connection: a baseline of the current state, then live. With a
   * cursor: the buffered events after it, or `resync` + baseline when the buffer cannot cover it. Open until the client goes.
   */
  private activityStream(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const raw = req.headers["last-event-id"] ?? url.searchParams.get("from");
    const rawStr = (Array.isArray(raw) ? raw[0] : raw)?.trim();
    // A cursor is `<boot>:<seq>`. Absent: fresh. Anything else (other boot, malformed) is stale.
    let from: number | "stale" | undefined;
    if (rawStr) {
      const m = /^([0-9a-f]+):(\d+)$/.exec(rawStr);
      from = m && m[1] === this.boot ? Number(m[2]) : "stale";
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    const frame = (ev: WolfEvent) => {
      if (res.destroyed || res.writableEnded) return;
      if (res.writableLength > MEMORY_STREAM_MAX_BUFFER) return void res.destroy();
      res.write(`id: ${this.boot}:${ev.id}\ndata: ${JSON.stringify(ev)}\n\n`);
    };
    // Baseline events carry the current cursor as their id: resuming from one is gap-free.
    const baseline = (): WolfEvent[] => {
      const id = this.wolfSeq;
      const at = new Date().toISOString();
      return [
        ...[...this.threads.values()].map((t): WolfEvent => ({ type: "thread-status", id, wolf: this.name, at, threadId: t.summary.id, status: t.status() })),
        ...[...this.threads.values()].filter((t) => !t.isChild).flatMap((t) => t.cards.pending()).map((card): WolfEvent => ({ type: "card-pending", id, wolf: this.name, at, card })),
      ];
    };
    const firstId = this.wolfBuffer[0]?.id;
    let replay: WolfEvent[];
    if (from === undefined) replay = baseline();
    else {
      const cursor = from === "stale" ? undefined : from;
      const stale = cursor === undefined || cursor > this.wolfSeq || (firstId === undefined ? cursor < this.wolfSeq : cursor < firstId - 1);
      replay = stale
        ? [{ type: "resync", id: this.wolfSeq, wolf: this.name, at: new Date().toISOString() }, ...baseline()]
        : this.wolfBuffer.filter((e) => e.id > cursor);
    }
    for (const ev of replay) frame(ev);
    // Subscribed in the same tick as the replay was written: no event falls between.
    this.wolfSubs.add(frame);
    res.write(": connected\n\n");
    const gone = () => {
      clearInterval(ka);
      this.wolfSubs.delete(frame);
    };
    const ka = setInterval(() => (res.destroyed || res.writableEnded ? gone() : res.write(": ka\n\n")), MEMORY_KEEPALIVE_MS);
    ka.unref();
    req.on("close", gone);
    res.on("close", gone);
  }
}

function firstLine(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 200);
}

const DRAIN_MAX_BYTES = 4 * ATTACHMENT_MAX_BYTES;

/** Discard what is left of a refused request body so the client finishes writing and reads our error; destroy past a bound. */
function drainBounded(req: IncomingMessage, already = 0): void {
  let n = already;
  req.on("data", (c: Buffer) => {
    n += c.length;
    if (n > DRAIN_MAX_BYTES) req.destroy();
  });
  req.on("error", () => {});
  req.resume();
}

/**
 * Read a raw body, failing once it exceeds `max` bytes. The request is not destroyed: the handler drains the rest
 * (see HttpError.drain) so the error response still reaches the client.
 */
function readBytes(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    const done = (fn: () => void) => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      fn();
    };
    const onData = (c: Buffer) => {
      n += c.length;
      if (n > max) {
        done(() => reject(new HttpError("invalid_request", `attachment too large (limit ${max} bytes)`, n)));
      } else chunks.push(c);
    };
    const onEnd = () => done(() => resolve(Buffer.concat(chunks)));
    const onError = (e: Error) => done(() => reject(e));
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}
