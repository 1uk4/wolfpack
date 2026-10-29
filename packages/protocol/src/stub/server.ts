import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ATTACHMENT_NAME_HEADER,
  PROTOCOL_VERSION_HEADER,
  SSE_DONE,
  SubmitBodySchema,
  AnswerCardBodySchema,
  BindThreadBodySchema,
  CreateThreadBodySchema,
  matchRoute,
} from "../routes.js";
import {
  ATTACHMENT_IMAGE_TYPES,
  ATTACHMENT_MAX_BYTES,
  ERROR_HTTP_STATUS,
  PROTOCOL_VERSION,
  type Actor,
  type Attachment,
  type MemoryStatus,
  type ErrorCode,
  type InFlightPartial,
  type LedgerEntry,
  type SubmitAck,
  type ThreadDetail,
  type ThreadEvent,
  type ThreadMessage,
  type ThreadSummary,
  type WolfSummary,
  GraduationConfirmBodySchema,
  DEFAULT_THREAD_SETTINGS,
  ThreadSettingsPatchSchema,
  CompactBodySchema,
} from "../schemas.js";

const STUB_TIER_MODELS = { main: "stub-main", smart: "stub-smart", fast: "stub-fast" };

export type ScriptStep =
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; args: unknown; updates: string[]; result: string };

export interface StubFixture {
  wolves: WolfSummary[];
  threads: ThreadSummary[];
  /** The scripted turn every submit plays. */
  script: ScriptStep[];
  /** Ledgers of subagent threads in `threads`, by thread id. */
  ledgers?: Record<string, LedgerEntry[]>;
}

export const DEFAULT_FIXTURE: StubFixture = {
  wolves: [
    { id: "1uk4", name: "1uk4", host: "local", status: "online" },
    { id: "hal", name: "hal", host: "wolf-01", status: "online" },
  ],
  threads: [{ id: "1uk4/home", wolf: "1uk4", kind: "home", title: "Home" }],
  script: [
    { kind: "thinking", text: "The user wants me to look at a file. " },
    { kind: "thinking", text: "I should read it before answering." },
    { kind: "text", text: "Let me take a look " },
    { kind: "text", text: "at that file." },
    {
      kind: "tool",
      name: "read",
      args: { path: "README.md" },
      updates: ["# Wolfpack\n", "A pack of durable agents.\n"],
      result: "# Wolfpack\nA pack of durable agents.\n",
    },
    { kind: "text", text: "It describes " },
    { kind: "text", text: "a pack of durable agents." },
  ],
};

export interface StubOptions {
  fixture?: StubFixture;
  /** Delay between scripted events in ms. Default 10. */
  delayMs?: number;
  port?: number;
}

type Distribute<T> = T extends unknown ? Omit<T, "id" | "threadId" | "at" | "actor"> : never;
type EventInput = Distribute<ThreadEvent>;
type Sub = (ev: ThreadEvent) => void;

interface ThreadState {
  summary: ThreadSummary;
  messages: ThreadMessage[];
  seq: number;
  /** PER-TURN replay buffer: cleared at turn-start, so it holds only the current (or most recent) turn. */
  buffer: ThreadEvent[];
  running: { turnId: string; abort: AbortController } | null;
  followUps: string[];
  subs: Set<Sub>;
}

class HttpError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
  }
}

const OPERATOR: Actor = { id: "operator", kind: "operator" };

/**
 * In-memory /v1 server. The reference implementation of the serving
 * semantics: server-minted per-thread event ids, per-turn replay buffer,
 * snapshot on stale resume, whenBusy matrix, error envelopes. Streams end at
 * the first turn-end with `data: [DONE]` (the console bridge's semantics).
 */
export class StubServer {
  private readonly threads = new Map<string, ThreadState>();
  private readonly wolves: WolfSummary[];
  private readonly script: ScriptStep[];
  private readonly ledgers: Record<string, LedgerEntry[]>;
  private readonly delayMs: number;
  private readonly http: Server;
  private counter = 0;
  /** `<threadId>\n<attachmentId>` -> the upload (kept in memory so `getAttachment` can serve it). */
  private readonly compactions = new Map<string, { count: number; lastAt?: string }>();
  private readonly uploads = new Map<string, { att: Attachment; bytes: Uint8Array }>();
  private baseUrl = "";

  constructor(private readonly opts: StubOptions = {}) {
    const fx = opts.fixture ?? DEFAULT_FIXTURE;
    this.wolves = fx.wolves.map((w) => ({ ...w }));
    this.script = fx.script;
    this.ledgers = fx.ledgers ?? {};
    this.delayMs = opts.delayMs ?? 10;
    for (const t of fx.threads) this.addThread({ ...t });
    this.http = createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        if (!res.headersSent) this.sendError(res, e instanceof HttpError ? e : new HttpError("engine_error", e instanceof Error ? e.message : "unexpected error"));
        else res.end();
      });
    });
  }

  get url(): string {
    return this.baseUrl;
  }

  async listen(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(this.opts.port ?? 0, "127.0.0.1", () => resolve());
    });
    this.baseUrl = `http://127.0.0.1:${(this.http.address() as AddressInfo).port}`;
    return this.baseUrl;
  }

  async close(): Promise<void> {
    for (const t of this.threads.values()) t.running?.abort.abort();
    this.http.closeAllConnections();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  // ------------------------------------------------------------ http

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://stub");
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
        return this.json(res, 200, { wolves: this.wolves });
      case "listThreads": {
        this.wolf(params.name);
        return this.json(res, 200, { threads: [...this.threads.values()].filter((t) => t.summary.wolf === params.name).map((t) => t.summary) });
      }
      case "createThread": {
        const wolf = this.wolf(params.name);
        const body = CreateThreadBodySchema.safeParse(await readJson(req));
        if (!body.success) throw new HttpError("invalid_request", 'body must be {kind:"home"} or {kind:"feature", workItemId}');
        if (body.data.kind === "feature") {
          const id = `${wolf.id}/feature-${body.data.workItemId}`;
          const have = this.threads.get(id);
          if (have) return this.json(res, 200, have.summary);
          const summary: ThreadSummary = { id, wolf: wolf.id, kind: "feature", title: body.data.workItemId, boundWorkItem: body.data.workItemId };
          this.addThread(summary);
          return this.json(res, 201, summary);
        }
        const existing = [...this.threads.values()].find((t) => t.summary.wolf === wolf.id && t.summary.kind === "home");
        if (existing) return this.json(res, 200, existing.summary);
        const summary: ThreadSummary = { id: `${wolf.id}/home`, wolf: wolf.id, kind: "home", title: "Home" };
        this.addThread(summary);
        return this.json(res, 201, summary);
      }
      case "listChildren": {
        const parent = this.thread(params.id);
        return this.json(res, 200, { threads: [...this.threads.values()].filter((t) => t.summary.parentThreadId === parent.summary.id).map((t) => t.summary) });
      }
      case "getLedger": {
        const t = this.thread(params.id);
        if (t.summary.kind !== "subagent") throw new HttpError("not_found", `thread ${t.summary.id} has no ledger`);
        return this.json(res, 200, { entries: this.ledgers[t.summary.id] ?? [] });
      }
      // ---- header git tree ----
      case "getWorkspaceStatus": {
        const t = this.thread(params.id);
        const ws = t.summary.workspace;
        if (!ws) throw new HttpError("not_found", `thread ${t.summary.id} has no git workspace`);
        const children = [...this.threads.values()].filter((c) => c.summary.parentThreadId === t.summary.id && c.summary.workspace).map((c) => ({ threadId: c.summary.id, name: c.summary.title, branch: c.summary.workspace!.branch, path: c.summary.workspace!.path }));
        return this.json(res, 200, { branch: ws.branch, ahead: 0, behind: 0, dirty: [], commits: [], children });
      }
      // ---- /header git tree ----
      case "getThread":
        return this.json(res, 200, this.detail(this.thread(params.id)));
      case "submit": {
        const t = this.thread(params.id);
        if (t.summary.closed) throw new HttpError("thread_closed", t.summary.closedReason ?? "thread is closed");
        const body = SubmitBodySchema.safeParse(await readJson(req));
        if (!body.success) throw new HttpError("invalid_request", "body must be {input, whenBusy: steer|followUp|reject}");
        const refs = body.data.attachments ?? [];
        if (body.data.input.trim() === "" && refs.length === 0) throw new HttpError("invalid_request", "input is required");
        for (const r of refs) if (!this.uploads.has(`${t.summary.id}\n${r.id}`)) throw new HttpError("invalid_request", `unknown attachment ${r.id}`);
        const atts = refs.map((r) => this.uploads.get(`${t.summary.id}\n${r.id}`)!.att);
        return this.json(res, 200, this.submit(t, body.data.input, body.data.whenBusy, atts));
      }
      case "uploadAttachment": {
        const t = this.thread(params.id);
        const mime = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
        if (!mime) throw new HttpError("invalid_request", "missing Content-Type: send the image's mime type");
        if (!(ATTACHMENT_IMAGE_TYPES as readonly string[]).includes(mime)) throw new HttpError("invalid_request", `unsupported attachment type ${mime}: images only`);
        // The stub checks the size after buffering the whole body (wolfd bounds the read).
        const bytes = await readBytes(req);
        if (bytes.length === 0) throw new HttpError("invalid_request", "attachment is empty");
        if (bytes.length > ATTACHMENT_MAX_BYTES) throw new HttpError("invalid_request", `attachment too large (limit ${ATTACHMENT_MAX_BYTES} bytes)`);
        const id = `att-${++this.counter}`;
        const rawName = req.headers[ATTACHMENT_NAME_HEADER.toLowerCase()];
        let name = id;
        try {
          if (typeof rawName === "string") name = decodeURIComponent(rawName);
        } catch {
          /* keep the generated name */
        }
        const att: Attachment = { id, name, mimeType: mime, size: bytes.length };
        this.uploads.set(`${t.summary.id}\n${id}`, { att, bytes });
        return this.json(res, 201, att);
      }
      case "getAttachment": {
        const t = this.thread(params.id);
        const up = this.uploads.get(`${t.summary.id}\n${params.attachmentId}`);
        if (!up) throw new HttpError("not_found", `unknown attachment ${params.attachmentId}`);
        res.writeHead(200, { "Content-Type": up.att.mimeType, "Content-Length": up.bytes.length, "X-Content-Type-Options": "nosniff" });
        res.end(up.bytes);
        return;
      }
      case "listCards":
        this.wolf(params.name);
        return this.json(res, 200, { cards: [] });
      case "answerCard": {
        this.thread(params.id);
        if (!AnswerCardBodySchema.safeParse(await readJson(req)).success) throw new HttpError("invalid_request", "body must be {answers}");
        // The stub's scripted turns raise no cards: every card id is unknown.
        throw new HttpError("not_found", `card ${params.callId}`);
      }
      case "getThreadSettings": {
        const t = this.thread(params.id);
        return this.json(res, 200, { ...DEFAULT_THREAD_SETTINGS, ...t.summary.settings, models: STUB_TIER_MODELS });
      }
      case "putThreadSettings": {
        const t = this.thread(params.id);
        const body = ThreadSettingsPatchSchema.safeParse(await readJson(req));
        if (!body.success) throw new HttpError("invalid_request", "body must be {tier?: main|smart|fast, autoShip?: boolean} with at least one");
        if (t.summary.kind === "subagent") throw new HttpError("invalid_request", "a subagent thread's model comes from its profile");
        t.summary.settings = { ...DEFAULT_THREAD_SETTINGS, ...t.summary.settings, ...body.data };
        return this.json(res, 200, { ...t.summary.settings, models: STUB_TIER_MODELS });
      }
      case "getThreadContext": {
        const t = this.thread(params.id);
        return this.json(res, 200, { tokens: 12_000, window: 1_000_000, startAt: 200_000, waitAt: 983_616, compactions: this.compactions.get(t.summary.id) ?? { count: 0 }, compacting: false });
      }
      case "compactThread": {
        const t = this.thread(params.id);
        if (!CompactBodySchema.safeParse(await readJson(req)).success) throw new HttpError("invalid_request", "body must be {instructions?: string}");
        const c = this.compactions.get(t.summary.id) ?? { count: 0 };
        this.compactions.set(t.summary.id, { count: c.count + 1, lastAt: new Date().toISOString() });
        return this.json(res, 200, { accepted: true });
      }
      // --- feature progress: bind ---
      case "bindThread": {
        const t = this.thread(params.id);
        const body = BindThreadBodySchema.safeParse(await readJson(req));
        if (!body.success) throw new HttpError("invalid_request", "body must be {workItemId}");
        if (!/^work-[A-Za-z0-9-]+$/.test(body.data.workItemId)) throw new HttpError("invalid_request", "malformed work item id");
        const previous = t.summary.boundItem ?? t.summary.boundWorkItem;
        t.summary.boundItem = body.data.workItemId;
        return this.json(res, 200, { threadId: t.summary.id, workItemId: body.data.workItemId, ...(previous && previous !== body.data.workItemId ? { previousWorkItemId: previous } : {}) });
      }
      // --- end feature progress ---
      case "skipCard":
        this.thread(params.id);
        throw new HttpError("not_found", `card ${params.callId}`);
      case "abort": {
        const t = this.thread(params.id);
        t.followUps = [];
        t.running?.abort.abort();
        return this.json(res, 200, { ok: true });
      }
      case "streamThread":
        return this.stream(this.thread(params.id), req, res, url);
      case "consolidateMemory":
      case "promoteMemory":
        this.wolf(params.name);
        // The stub has no memory system: its wolves are the inert case.
        throw new HttpError("memory_unavailable", "memory is not loaded on this wolf");
      case "getMemoryStatus": {
        this.wolf(params.name);
        // Same inert case: the status resource still answers, saying why there is nothing to show.
        const status: MemoryStatus = { state: "off", reason: "memory is not loaded on this wolf", pool: null, sessionTopics: [], denTopics: [], lastPromote: null, bound: null };
        return this.json(res, 200, status);
      }
      case "getMemoryTopic":
        this.wolf(params.name);
        throw new HttpError("memory_unavailable", "memory is not loaded on this wolf");
      case "getMemoryObservations": {
        this.wolf(params.name);
        const limit = url.searchParams.get("limit");
        if (limit !== null && !/^[1-9]\d{0,6}$/.test(limit)) throw new HttpError("invalid_request", "limit must be a positive integer");
        throw new HttpError("memory_unavailable", "memory is not loaded on this wolf");
      }
      case "listWork": {
        this.wolf(params.name);
        if (!url.searchParams.get("domain")) throw new HttpError("invalid_request", "domain is required");
        throw new HttpError("memory_unavailable", "no Work API configured on this wolf");
      }
      case "getWorkRecord":
        this.wolf(params.name);
        throw new HttpError("not_found", `work item ${params.id}`);
      case "previewGraduation":
      case "confirmGraduation":
      case "graduationStatus":
      case "graduationObservations":
        this.wolf(params.name);
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(params.id)) throw new HttpError("invalid_request", "malformed work item id");
        if (m.name === "confirmGraduation" && !GraduationConfirmBodySchema.safeParse(await readJson(req)).success) throw new HttpError("invalid_request", "body must be {token}");
        // The stub has no Work API: it cannot graduate anything.
        throw new HttpError("memory_unavailable", "no Work API configured on this wolf");
      case "kbPipeline":
        this.wolf(params.name);
        throw new HttpError("kb_unavailable", "this wolf is not the librarian");
      case "getKbGraph":
      case "getKbEntry":
        this.wolf(params.name);
        // The stub is not the librarian.
        throw new HttpError("kb_unavailable", `wolf ${params.name} is not the librarian`);
      case "streamWolfEvents": {
        this.wolf(params.name);
        // The stub emits no memory events: an open, empty stream.
        res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
        res.write(": connected\n\n");
        return;
      }
    }
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private sendError(res: ServerResponse, e: HttpError): void {
    res.writeHead(ERROR_HTTP_STATUS[e.code], { "Content-Type": "application/json", [PROTOCOL_VERSION_HEADER]: String(PROTOCOL_VERSION) });
    res.end(JSON.stringify({ code: e.code, message: e.message, retryable: e.code === "busy" }));
  }

  // ----------------------------------------------------------- state

  private wolf(name: string): WolfSummary {
    const w = this.wolves.find((x) => x.name === name || x.id === name);
    if (!w) throw new HttpError("not_found", `wolf ${name}`);
    return w;
  }

  /** Test hook: mark a feature thread read-only history (its feature graduated). */
  closeThread(id: string, reason = "This feature has graduated; its thread is read-only history. Start a new feature or use home."): void {
    const t = this.thread(id);
    t.summary = { ...t.summary, closed: true, closedReason: reason };
  }

  private thread(id: string): ThreadState {
    const t = this.threads.get(id);
    if (!t) throw new HttpError("not_found", `thread ${id}`);
    return t;
  }

  private addThread(summary: ThreadSummary): void {
    this.threads.set(summary.id, { summary, messages: [], seq: 0, buffer: [], running: null, followUps: [], subs: new Set() });
  }

  private detail(t: ThreadState): ThreadDetail {
    return { ...t.summary, messages: t.messages.map((m) => ({ ...m })), busy: t.running !== null, lastEventId: t.seq };
  }

  private submit(t: ThreadState, input: string, whenBusy: "steer" | "followUp" | "reject", atts: Attachment[] = []): SubmitAck {
    if (!t.running) {
      const messageId = this.addUserMessage(t, input, atts);
      this.startTurn(t);
      return { messageId, disposition: "started" };
    }
    if (whenBusy === "reject") throw new HttpError("busy", `thread ${t.summary.id} is busy`);
    const messageId = this.addUserMessage(t, input, atts);
    if (whenBusy === "followUp") {
      t.followUps.push(input);
      return { messageId, disposition: "queued" };
    }
    return { messageId, disposition: "steered" };
  }

  private addUserMessage(t: ThreadState, text: string, atts: Attachment[] = []): string {
    const id = `msg-${++this.counter}`;
    t.messages.push({ id, role: "user", text, at: new Date().toISOString(), ...(atts.length ? { attachments: atts } : {}) });
    return id;
  }

  private emit(t: ThreadState, ev: EventInput): void {
    const actor: Actor = ev.type === "turn-start" ? OPERATOR : ev.type === "error" ? { id: "stub", kind: "system" } : { id: t.summary.wolf, kind: "wolf" };
    const full = { ...ev, id: ++t.seq, threadId: t.summary.id, at: new Date().toISOString(), actor } as ThreadEvent;
    t.buffer.push(full);
    for (const s of [...t.subs]) s(full);
  }

  private startTurn(t: ThreadState): void {
    const turnId = `turn-${++this.counter}`;
    const abort = new AbortController();
    t.running = { turnId, abort };
    t.buffer = [];
    this.emit(t, { type: "turn-start", turnId });
    void this.runScript(t, turnId, abort.signal);
  }

  private async runScript(t: ThreadState, turnId: string, signal: AbortSignal): Promise<void> {
    let assistantText = "";
    let reason: "complete" | "aborted" = "complete";
    try {
      let n = 0;
      for (const step of this.script) {
        if (!(await this.pause(signal))) throw new Aborted();
        if (step.kind === "thinking") {
          this.emit(t, { type: "thinking-delta", turnId, text: step.text });
        } else if (step.kind === "text") {
          assistantText += step.text;
          this.emit(t, { type: "text-delta", turnId, text: step.text });
        } else {
          const callId = `call-${turnId}-${++n}`;
          this.emit(t, { type: "tool-start", turnId, callId, name: step.name, args: step.args });
          for (const output of step.updates) {
            if (!(await this.pause(signal))) throw new Aborted();
            this.emit(t, { type: "tool-update", turnId, callId, output });
          }
          if (!(await this.pause(signal))) throw new Aborted();
          this.emit(t, { type: "tool-end", turnId, callId, result: step.result, isError: false });
        }
      }
    } catch (e) {
      if (!(e instanceof Aborted)) throw e;
      reason = "aborted";
    }
    if (assistantText) {
      t.messages.push({ id: `msg-${++this.counter}`, role: "assistant", text: assistantText, at: new Date().toISOString() });
    }
    t.running = null;
    this.emit(t, { type: "turn-end", turnId, reason });
    const next = t.followUps.shift();
    if (next !== undefined && reason === "complete") this.startTurn(t);
  }

  private pause(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const onAbort = () => {
        clearTimeout(timer);
        resolve(false);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve(true);
      }, this.delayMs);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  // ----------------------------------------------------------- stream

  private inFlight(t: ThreadState): InFlightPartial | undefined {
    if (!t.running) return undefined;
    let text = "";
    let thinking = "";
    for (const e of t.buffer) {
      if (e.type === "text-delta") text += e.text;
      else if (e.type === "thinking-delta") thinking += e.text;
    }
    return { turnId: t.running.turnId, text, ...(thinking ? { thinking } : {}) };
  }

  private stream(t: ThreadState, req: IncomingMessage, res: ServerResponse, url: URL): void {
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
    const firstId = t.buffer[0]?.id;
    if (from === undefined) {
      replay = [...t.buffer];
    } else {
      // The buffer covers ids [firstId, t.seq]. Resuming at firstId-1 or later is gap-free.
      const stale = from > t.seq || (firstId === undefined ? from < t.seq : from < firstId - 1);
      if (stale) {
        replay = [];
        const inFlight = this.inFlight(t);
        snapshot = {
          type: "snapshot",
          id: Math.max(t.seq, 1),
          threadId: t.summary.id,
          at: new Date().toISOString(),
          actor: { id: "stub", kind: "system" },
          upToId: t.seq,
          thread: this.detail(t),
          ...(inFlight ? { inFlight } : {}),
        };
      } else {
        replay = t.buffer.filter((e) => e.id > from);
      }
    }

    if (snapshot) frame(snapshot);
    for (const ev of replay) {
      frame(ev);
      if (ev.type === "turn-end") return done();
    }
    if (!t.running) return done();

    const sub: Sub = (ev) => {
      frame(ev);
      if (ev.type === "turn-end") {
        t.subs.delete(sub);
        done();
      }
    };
    t.subs.add(sub);
    res.on("close", () => t.subs.delete(sub));
  }
}

class Aborted extends Error {}

async function readBytes(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
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
