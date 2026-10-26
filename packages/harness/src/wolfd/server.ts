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
  CreateThreadBodySchema,
  ERROR_HTTP_STATUS,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_HEADER,
  SSE_DONE,
  SubmitBodySchema,
  matchRoute,
  type Actor,
  type ErrorCode,
  type InFlightPartial,
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
  type EngineEvent,
  type EngineSnapshot,
  type EngineWatch,
  type EventMapper,
  type MappedEvent,
  type ResyncDraft,
  type ThreadEventDraft,
} from "../engine/index.js";
import { disposeMemoryEvents, memoryEventsFor, type MemoryEventBus } from "../memory/events.js";
import { prepareSocketPath } from "./socket.js";
import { appendMessage, messageFromEntry, messagesFromEntries } from "./messages.js";

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
  /** Called with faults the pump cannot surface over HTTP. */
  onError?: (error: unknown) => void;
}

class HttpError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
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
          this.sendError(res, e instanceof HttpError ? e : new HttpError("engine_error", e instanceof Error ? e.message : "unexpected error"));
        } else res.end();
      });
    });
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
      else if (ev.type === "message_end" && !this.seenEntries.has(ev.entry.id)) {
        this.seenEntries.add(ev.entry.id);
        const m = messageFromEntry(ev.entry);
        if (m) appendMessage(this.messages, m);
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
      if (stale === "" || final === "" || final === stale) return;
      const hit: ThreadEvent[] = [];
      let n = 0;
      for (let i = this.buffer.length - 1; i >= 0 && n < stale.length; i--) {
        const e = this.buffer[i];
        if (e.type === type && e.turnId === c.turnId) {
          hit.push(e);
          n += e.text.length;
        }
      }
      hit.forEach((e, i) => {
        (e as { text: string }).text = i === hit.length - 1 ? final : "";
      });
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
        if (body.data.input.trim() === "") throw new HttpError("invalid_request", "input is required");
        return this.json(res, 200, await this.submit(body.data.input, body.data.whenBusy));
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

  // ------------------------------------------------------------ state

  private wolfSummary(): WolfSummary {
    return { id: this.name, name: this.name, host: this.host, status: this.running ? "busy" : "online" };
  }

  private checkWolf(name: string): void {
    if (name !== this.name) throw new HttpError("not_found", `wolf ${name}`);
  }

  private checkThread(id: string): void {
    if (id !== this.summary.id) throw new HttpError("not_found", `thread ${id}`);
  }

  private detail(): ThreadDetail {
    return { ...this.summary, messages: this.messages.map((m) => ({ ...m })), busy: this.running !== null, lastEventId: this.seq };
  }

  private async submit(input: string, whenBusy: "steer" | "followUp" | "reject"): Promise<SubmitAck> {
    const before = this.turnStarts;
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

function textOf(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
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
