/**
 * WolfServer: serves the /v1 protocol for ONE wolf over ONE engine conversation (its home thread) on 127.0.0.1.
 * Mirrors the StubServer's semantics (packages/protocol/src/stub/server.ts); the contract suite is the definition
 * of correct.
 *
 * Architecture:
 * - One watcher per process. `attach()` opens `conversation.watch()` once and pumps every engine batch through
 *   `createEventMapper` (seeded with the attach snapshot). Mapped drafts are stamped here with per-thread monotonic ids
 *   (the engine has none) and fan out to (a) the per-turn replay buffer (cleared at turn-start) and (b) every live SSE
 *   subscriber. The same pump keeps the message list (`messages.ts`) and the `running` flag current.
 * - HTTP handlers never talk to the engine for reads; getThread/streams/status come from the pump's state.
 *   Handlers talk to it for submit/abort only. Because events arrive asynchronously, a `started` submit waits (bounded)
 *   until the pump has seen the turn-start, and abort waits until the pump has seen the turn end, so the stream the
 *   client opens next is never empty/[DONE] by accident.
 * - Mapper "resync" (engine overflow) re-bases state from the engine snapshot and sends subscribers a protocol
 *   snapshot frame.
 * - Resuming mid-run after a crash: an attach snapshot with a run in flight is presented as a synthesized turn-start
 *   (plus a text-delta carrying the partial text) so a console reattaching sees a coherent turn.
 * Limits: one wolf, home thread only; a queued follow-up cannot be dropped by abort (the engine owns the queue).
 */
import { rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_NAME_HEADER,
  CreateThreadBodySchema,
  ERROR_HTTP_STATUS,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_HEADER,
  SSE_DONE,
  SubmitBodySchema,
  matchRoute,
  type Actor,
  type AttachmentRef,
  type ConsolidateResponse,
  type ErrorCode,
  type InFlightPartial,
  type KbPipelineResponse,
  type LastPromote,
  type PromoteResponse,
  type SubmitAck,
  type ThreadDetail,
  type ThreadEvent,
  type ThreadMessage,
  type ThreadSummary,
  type WolfSummary,
} from "@wolfpack/protocol";
import {
  EngineBusyError,
  createEventMapper,
  stampEvent,
  type EngineConversation,
  type SubmitOptions,
  type EngineEvent,
  type EngineSnapshot,
  type EngineWatch,
  type EventMapper,
  type MappedEvent,
  type ResyncDraft,
  type ThreadEventDraft,
} from "../engine/index.js";
import { memoryActionsFor, type MemoryActions } from "../memory/actions.js";
import { disposeMemoryEvents, memoryEventsFor, type MemoryEventBus } from "../memory/events.js";
import type { KbRoots } from "@wolfpack/kb/shared";
import { UnknownDomainError, buildKbGraph, readKbEntry } from "@wolfpack/kb/graph";
import { readDenTopics } from "@wolfpack/memory";
import { isTopicId, isWorkId, memoryState, readBound, readMemoryStatus, readMemoryTopic, readWorkRecord, type MemoryReadConfig } from "./memory-read.js";
import { prepareSocketPath } from "./socket.js";
import { applyEntry, messagesFromEntries } from "./messages.js";
import { AttachmentError, attachmentsInText, inlineAttachments, loadAttachment, storeAttachment } from "./attachments.js";

export interface WolfServerOptions {
  /** Wolf name: used as the protocol wolf id/name and in the thread id `<name>/home`. */
  name: string;
  host?: string;
  /** The home conversation. */
  conversation: EngineConversation;
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
  /** Called with faults the pump cannot surface over HTTP. */
  onError?: (error: unknown) => void;
}

class HttpError extends Error {
  /** `drain`: bytes of the request body already consumed; the server discards the rest (bounded) so the client can read this error. */
  constructor(readonly code: ErrorCode, message: string, readonly drain?: number) {
    super(message);
  }
}

const OPERATOR: Actor = { id: "operator", kind: "operator" };
const SYSTEM: Actor = { id: "wolfd", kind: "system" };

type Sub = (ev: ThreadEvent) => void;

const MEMORY_KEEPALIVE_MS = 20_000;
const MEMORY_STREAM_MAX_BUFFER = 1_000_000;

export class WolfServer {
  private readonly conv: EngineConversation;
  private readonly name: string;
  private readonly host: string;
  private readonly settleMs: number;
  private readonly summary: ThreadSummary;
  private readonly http: Server;
  private baseUrl = "";
  private socketPath: string | undefined;

  // pump-owned thread state
  private seq = 0;
  private buffer: ThreadEvent[] = [];
  private running: { turnId: string } | null = null;
  private turnStarts = 0;
  private messages: ThreadMessage[] = [];
  private seenEntries = new Set<EngineSnapshot["entries"][number]["id"]>();
  private readonly subs = new Set<Sub>();
  private readonly waiters = new Set<() => void>();
  private homeCreated = false;
  private readonly memoryBus?: MemoryEventBus;

  private watch?: EngineWatch;
  private mapper?: EventMapper;
  private pump?: Promise<void>;
  private closing = false;

  constructor(private readonly opts: WolfServerOptions) {
    this.conv = opts.conversation;
    this.name = opts.name;
    this.host = opts.host ?? "local";
    this.settleMs = opts.settleTimeoutMs ?? 5000;
    if (opts.den) this.memoryBus = memoryEventsFor(opts.den, opts.name);
    this.summary = { id: `${this.name}/home`, wolf: this.name, kind: "home", title: "Home" };
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

  /** Attach the single watcher and start pumping. Call before listen(). */
  async attach(): Promise<void> {
    const w = await this.conv.watch();
    this.watch = w;
    this.rebase(w.snapshot, true);
    // A store with history already has its home thread: createThread then answers 200, not 201.
    this.homeCreated = w.snapshot.entries.length > 0;
    this.mapper = createEventMapper(w.snapshot);
    this.pump = this.runPump(w);
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
    await this.watch?.stop().catch(() => {});
    await this.pump?.catch(() => {});
    if (this.opts.den) disposeMemoryEvents(this.opts.den);
  }

  // ------------------------------------------------------------- pump

  private async runPump(w: EngineWatch): Promise<void> {
    try {
      for await (const batch of w.batches) this.applyBatch(batch);
      this.applyMapped(this.mapper!.flush());
    } catch (e) {
      if (!this.closing) this.opts.onError?.(e);
    }
  }

  private applyBatch(batch: readonly EngineEvent[]): void {
    for (const ev of batch) {
      if (ev.type === "snapshot") this.resetMessages(ev.entries);
      else if ((ev.type === "message_end" || ev.type === "tool_execution_end") && ev.entry && !this.seenEntries.has(ev.entry.id)) {
        this.seenEntries.add(ev.entry.id);
        applyEntry(this.messages, ev.entry);
      }
    }
    this.applyMapped(this.mapper!.push(batch));
  }

  /** Re-base thread state on an engine snapshot. `initial`: synthesize the in-flight turn into the buffer. */
  private rebase(snap: EngineSnapshot, initial: boolean): void {
    this.resetMessages(snap.entries);
    if (!snap.run) {
      this.running = null;
      return;
    }
    const turnId = `turn-${Number(snap.run.inputs[0])}`;
    if (initial) {
      this.emit({ type: "turn-start", turnId });
      const partial = textOf(snap.generation?.message);
      if (partial) this.emit({ type: "text-delta", turnId, text: partial });
    } else {
      this.running = { turnId };
    }
  }

  private resetMessages(entries: EngineSnapshot["entries"]): void {
    this.messages = messagesFromEntries(entries);
    this.seenEntries = new Set(entries.map((e) => e.id));
  }

  private applyMapped(events: MappedEvent[]): void {
    for (const ev of events) {
      if (ev.type === "resync") {
        if (ev.snapshot) this.rebase(ev.snapshot, false);
        if (ev.correction) this.correctBuffer(ev.correction);
        const snap = this.snapshotEvent();
        for (const s of [...this.subs]) s(snap);
        this.notify();
      } else this.emit(ev);
    }
  }

  /**
   * A diverged retry: the buffered deltas of the current message are stale. Rewrite them in place (ids stay, so
   * replay keeps working): the earliest stale delta carries the authoritative text, the rest are blanked.
   */
  private correctBuffer(c: NonNullable<ResyncDraft["correction"]>): void {
    const fix = (type: "text-delta" | "thinking-delta", stale: string, final: string) => {
      if (final === stale) return;
      const hit: ThreadEvent[] = [];
      let n = 0;
      for (let i = this.buffer.length - 1; i >= 0 && n < stale.length; i--) {
        const e = this.buffer[i];
        if (e.type === type && e.turnId === c.turnId) {
          hit.push(e);
          n += e.text.length;
        }
      }
      // Earliest stale delta carries the authoritative text (empty when the side shrank to nothing), the rest are blanked.
      hit.forEach((e, i) => {
        (e as { text: string }).text = i === hit.length - 1 ? final : "";
      });
      // Nothing stale was buffered for this side: the authoritative text has to be emitted as a new delta.
      if (hit.length === 0 && final !== "") this.emit({ type, turnId: c.turnId, text: final });
    };
    fix("text-delta", c.staleText, c.text);
    fix("thinking-delta", c.staleThinking, c.thinking);
  }

  private emit(draft: ThreadEventDraft): void {
    if (draft.type === "turn-start") {
      this.buffer = [];
      this.running = { turnId: draft.turnId };
      this.turnStarts++;
    }
    const actor: Actor = draft.type === "turn-start" ? OPERATOR : draft.type === "error" ? SYSTEM : { id: this.name, kind: "wolf" };
    const full = stampEvent(draft, { threadId: this.summary.id, id: ++this.seq, actor });
    this.buffer.push(full);
    if (draft.type === "turn-end") this.running = null;
    for (const s of [...this.subs]) s(full);
    this.notify();
  }

  private notify(): void {
    for (const w of [...this.waiters]) w();
  }

  /** Resolves when `pred` holds (checked after every pump event) or after the settle timeout. */
  private waitFor(pred: () => boolean): Promise<void> {
    if (pred()) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        if (!pred()) return;
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(() => {
        this.waiters.delete(done);
        resolve();
      }, this.settleMs);
      this.waiters.add(done);
    });
  }

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
        return this.json(res, 200, { threads: [this.summary] });
      case "createThread": {
        this.checkWolf(params.name);
        const body = CreateThreadBodySchema.safeParse(await readJson(req));
        if (!body.success) throw new HttpError("invalid_request", 'body must be {kind:"home"}');
        // The home thread is the engine root conversation: it always exists once the process is up.
        const status = this.homeCreated ? 200 : 201;
        this.homeCreated = true;
        return this.json(res, status, this.summary);
      }
      case "getThread":
        this.checkThread(params.id);
        return this.json(res, 200, this.detail());
      case "submit": {
        this.checkThread(params.id);
        const body = SubmitBodySchema.safeParse(await readJson(req));
        if (!body.success) throw new HttpError("invalid_request", "body must be {input, whenBusy: steer|followUp|reject}");
        const refs = body.data.attachments ?? [];
        if (body.data.input.trim() === "" && refs.length === 0) throw new HttpError("invalid_request", "input is required");
        return this.json(res, 200, await this.submit(body.data.input, body.data.whenBusy, refs));
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
          file = loadAttachment(this.opts.den, this.summary.id, params.attachmentId);
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
          "Content-Security-Policy": "default-src 'none'; sandbox",
        });
        res.end(file.bytes);
        return;
      }
      case "abort": {
        this.checkThread(params.id);
        const was = this.running !== null;
        await this.conv.abort();
        if (was) await this.waitFor(() => this.running === null);
        return this.json(res, 200, { ok: true });
      }
      case "streamThread":
        this.checkThread(params.id);
        return this.stream(req, res, url);
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
        if (thread !== null) this.checkThread(thread);
        // wolfd serves one conversation (the home thread = the engine root), so every thread resolves to its binding.
        const bound = this.opts.den ? await readBound(this.opts.den, this.conv.id, this.opts.work ?? {}) : null;
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
      case "getWorkRecord": {
        this.checkWolf(params.name);
        if (!isWorkId(params.id)) throw new HttpError("invalid_request", "malformed work item id");
        const r = await readWorkRecord(params.id, this.opts.work ?? {});
        if (r.kind === "unconfigured") throw new HttpError("memory_unavailable", "no Work API configured on this wolf (WORK_ENDPOINT / WORK_TOKEN)");
        if (r.kind === "not_found") throw new HttpError("not_found", `work item ${params.id}`);
        if (r.kind === "error") throw new HttpError("engine_error", `work API: ${r.message}`);
        return this.json(res, 200, r.value);
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
        try {
          return this.json(res, 200, buildKbGraph(roots, { domain, archivedWork: flag("archivedWork"), wikilinks: flag("wikilinks"), denTopics, den }));
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
    return { id: this.name, name: this.name, host: this.host, status: this.running ? "busy" : "online", librarian: this.opts.librarian === true };
  }

  private checkWolf(name: string): void {
    if (name !== this.name) throw new HttpError("not_found", `wolf ${name}`);
  }

  private checkThread(id: string): void {
    if (id !== this.summary.id) throw new HttpError("not_found", `thread ${id}`);
  }

  private detail(): ThreadDetail {
    const den = this.opts.den;
    const attachmentsOf = (m: ThreadMessage) => {
      const list = den && m.role === "user" ? attachmentsInText(den, this.summary.id, m.text) : [];
      return list.length ? { attachments: list } : {};
    };
    const messages = this.messages.map((m) => ({
      ...m,
      // The `{...c}` copy drops messages.ts's per-call WeakMap entries (uncapped args); fine, the copy is output-only.
      ...(m.tools ? { tools: m.tools.map((c) => ({ ...c })) } : {}),
      ...(m.objects ? { objects: m.objects.map((o) => ({ ...o })) } : {}),
      ...attachmentsOf(m),
    }));
    return { ...this.summary, messages, busy: this.running !== null, lastEventId: this.seq };
  }

  private async submit(text: string, whenBusy: "steer" | "followUp" | "reject", refs: readonly AttachmentRef[] = []): Promise<SubmitAck> {
    const before = this.turnStarts;
    let input: SubmitOptions["input"] = text;
    if (refs.length > 0) {
      if (!this.opts.den) throw new HttpError("invalid_request", "this wolf has no den to read attachments from");
      try {
        input = inlineAttachments(this.opts.den, this.summary.id, text, refs);
      } catch (e) {
        if (e instanceof AttachmentError) throw new HttpError("invalid_request", e.message);
        throw e;
      }
    }
    let r;
    try {
      r = await this.conv.submit({ input, whenBusy });
    } catch (e) {
      if (e instanceof EngineBusyError) throw new HttpError("busy", `thread ${this.summary.id} is busy`);
      throw new HttpError("engine_error", e instanceof Error ? e.message : "submit failed");
    }
    if (r.disposition === "started") await this.waitFor(() => this.turnStarts > before);
    return { messageId: r.messageId, disposition: r.disposition };
  }

  // ----------------------------------------------------------- stream

  private inFlight(): InFlightPartial | undefined {
    if (!this.running) return undefined;
    let text = "";
    let thinking = "";
    for (const e of this.buffer) {
      if (e.type === "text-delta") text += e.text;
      else if (e.type === "thinking-delta") thinking += e.text;
    }
    return { turnId: this.running.turnId, text, ...(thinking ? { thinking } : {}) };
  }

  private snapshotEvent(): ThreadEvent {
    const inFlight = this.inFlight();
    return {
      type: "snapshot",
      id: Math.max(this.seq, 1),
      threadId: this.summary.id,
      at: new Date().toISOString(),
      actor: SYSTEM,
      upToId: this.seq,
      thread: this.detail(),
      ...(inFlight ? { inFlight } : {}),
    };
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

  private stream(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const raw = req.headers["last-event-id"] ?? url.searchParams.get("from");
    const rawStr = Array.isArray(raw) ? raw[0] : raw;
    const n = rawStr == null || rawStr.trim() === "" ? NaN : Number(rawStr);
    const from = Number.isInteger(n) && n >= 0 ? n : undefined;

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    const frame = (ev: ThreadEvent) => res.write(`id: ${ev.id}\ndata: ${JSON.stringify(ev)}\n\n`);
    const done = () => {
      res.write(`data: ${SSE_DONE}\n\n`);
      res.end();
    };

    let replay: ThreadEvent[];
    let snapshot: ThreadEvent | undefined;
    const firstId = this.buffer[0]?.id;
    if (from === undefined) {
      replay = [...this.buffer];
    } else {
      // The buffer covers ids [firstId, seq]. Resuming at firstId-1 or later is gap-free.
      const stale = from > this.seq || (firstId === undefined ? from < this.seq : from < firstId - 1);
      if (stale) {
        replay = [];
        snapshot = this.snapshotEvent();
      } else {
        replay = this.buffer.filter((e) => e.id > from);
      }
    }

    if (snapshot) frame(snapshot);
    for (const ev of replay) {
      frame(ev);
      if (ev.type === "turn-end") return done();
    }
    if (!this.running) return done();

    const sub: Sub = (ev) => {
      frame(ev);
      if (ev.type === "turn-end") {
        this.subs.delete(sub);
        done();
      }
    };
    this.subs.add(sub);
    res.on("close", () => this.subs.delete(sub));
  }
}

function firstLine(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 200);
}

function textOf(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
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
