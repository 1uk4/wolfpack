import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ATTACHMENT_NAME_HEADER,
  PROTOCOL_VERSION_HEADER,
  SSE_DONE,
  SubmitBodySchema,
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
  type SubmitAck,
  type ThreadDetail,
  type ThreadEvent,
  type ThreadMessage,
  type ThreadSummary,
  type WolfSummary,
} from "../schemas.js";

export type ScriptStep =
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; args: unknown; updates: string[]; result: string };

export interface StubFixture {
  wolves: WolfSummary[];
  threads: ThreadSummary[];
  /** The scripted turn every submit plays. */
  script: ScriptStep[];
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
  private readonly delayMs: number;
  private readonly http: Server;
  private counter = 0;
  /** `<threadId>\n<attachmentId>` of every upload (bytes are not kept). */
  private readonly uploads = new Set<string>();
  private baseUrl = "";

  constructor(private readonly opts: StubOptions = {}) {
    const fx = opts.fixture ?? DEFAULT_FIXTURE;
    this.wolves = fx.wolves.map((w) => ({ ...w }));
    this.script = fx.script;
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
        if (!body.success) throw new HttpError("invalid_request", "body must be {kind:\"home\"}");
        const existing = [...this.threads.values()].find((t) => t.summary.wolf === wolf.id && t.summary.kind === "home");
        if (existing) return this.json(res, 200, existing.summary);
        const summary: ThreadSummary = { id: `${wolf.id}/home`, wolf: wolf.id, kind: "home", title: "Home" };
        this.addThread(summary);
        return this.json(res, 201, summary);
      }
      case "getThread":
        return this.json(res, 200, this.detail(this.thread(params.id)));
      case "submit": {
        const t = this.thread(params.id);
        const body = SubmitBodySchema.safeParse(await readJson(req));
        if (!body.success) throw new HttpError("invalid_request", "body must be {input, whenBusy: steer|followUp|reject}");
        const refs = body.data.attachments ?? [];
        if (body.data.input.trim() === "" && refs.length === 0) throw new HttpError("invalid_request", "input is required");
        for (const r of refs) if (!this.uploads.has(`${t.summary.id}\n${r.id}`)) throw new HttpError("invalid_request", `unknown attachment ${r.id}`);
        return this.json(res, 200, this.submit(t, body.data.input, body.data.whenBusy));
      }
      case "uploadAttachment": {
        const t = this.thread(params.id);
        const mime = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
        if (!mime) throw new HttpError("invalid_request", "missing Content-Type: send the image's mime type");
        if (!(ATTACHMENT_IMAGE_TYPES as readonly string[]).includes(mime)) throw new HttpError("invalid_request", `unsupported attachment type ${mime}: images only`);
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
        this.uploads.add(`${t.summary.id}\n${id}`);
        return this.json(res, 201, att);
      }
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
      case "getWorkRecord":
        this.wolf(params.name);
        throw new HttpError("not_found", `work item ${params.id}`);
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

  private submit(t: ThreadState, input: string, whenBusy: "steer" | "followUp" | "reject"): SubmitAck {
    if (!t.running) {
      const messageId = this.addUserMessage(t, input);
      this.startTurn(t);
      return { messageId, disposition: "started" };
    }
    if (whenBusy === "reject") throw new HttpError("busy", `thread ${t.summary.id} is busy`);
    const messageId = this.addUserMessage(t, input);
    if (whenBusy === "followUp") {
      t.followUps.push(input);
      return { messageId, disposition: "queued" };
    }
    return { messageId, disposition: "steered" };
  }

  private addUserMessage(t: ThreadState, text: string): string {
    const id = `msg-${++this.counter}`;
    t.messages.push({ id, role: "user", text, at: new Date().toISOString() });
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
