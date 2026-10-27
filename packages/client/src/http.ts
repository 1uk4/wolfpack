import {
  ATTACHMENT_NAME_HEADER,
  ErrorEnvelopeSchema,
  LAST_EVENT_ID_HEADER,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_HEADER,
  ROUTES,
  SSE_DONE,
  buildPath,
  parseMemoryEvent,
  parseThreadEvent,
  type RouteName,
} from "@wolfpack/protocol";
import {
  BusyError,
  NotFoundError,
  ProtocolError,
  type Actor,
  type ConsoleClient,
  type ConsolidateResponse,
  type KbEntryDetail,
  type KbGraph,
  type MemoryStatus,
  type MemoryTopic,
  type WorkRecordResponse,
  type KbPipelineResponse,
  type PromoteResponse,
  type MemoryEvent,
  type Attachment,
  type SubmitAck,
  type SubmitOptions,
  type UploadOptions,
  type ThreadDetail,
  type ThreadEvent,
  type ThreadSummary,
  type WatchOptions,
  type WolfSummary,
} from "./types.js";

export interface HttpClientOptions {
  /** Server origin (optionally with a path prefix), e.g. `http://127.0.0.1:4100`. */
  baseUrl: string;
  /** Acting identity. Reserved: the v1 wire has no actor field yet, so it is not sent. */
  actor?: Actor;
  /** Injectable fetch (tests, auth wrappers). Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Consecutive failed stream reconnects tolerated before giving up. Default 5. */
  maxStreamRetries?: number;
  /** Base reconnect backoff in ms (doubles per attempt, capped at 2s). Default 50. */
  retryDelayMs?: number;
}

interface Frame {
  id?: string;
  data: string;
}

/** ConsoleClient over the /v1 HTTP+SSE protocol. Interchangeable with MockConsoleClient. */
export class HttpConsoleClient implements ConsoleClient {
  readonly actor?: Actor;
  private readonly base: string;
  private readonly fetchFn: typeof fetch;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  constructor(opts: HttpClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.actor = opts.actor;
    this.fetchFn = opts.fetch ?? ((...a) => fetch(...a));
    this.maxRetries = opts.maxStreamRetries ?? 5;
    this.retryDelayMs = opts.retryDelayMs ?? 50;
  }

  async listWolves(): Promise<WolfSummary[]> {
    const r = await this.json("listWolves", {}, ROUTES.listWolves.response.schema);
    return (r as { wolves: WolfSummary[] }).wolves;
  }

  async listThreads(wolf: string): Promise<ThreadSummary[]> {
    const r = await this.json("listThreads", { name: wolf }, ROUTES.listThreads.response.schema);
    return (r as { threads: ThreadSummary[] }).threads;
  }

  async getThread(threadId: string): Promise<ThreadDetail> {
    return (await this.json("getThread", { id: threadId }, ROUTES.getThread.response.schema, undefined, threadId)) as ThreadDetail;
  }

  async submit(threadId: string, input: string, opts: SubmitOptions = {}): Promise<SubmitAck> {
    const body = {
      input,
      whenBusy: opts.whenBusy ?? "reject",
      ...(opts.attachments?.length ? { attachments: opts.attachments } : {}),
    };
    return (await this.json("submit", { id: threadId }, ROUTES.submit.response.schema, body, threadId)) as SubmitAck;
  }

  async uploadAttachment(threadId: string, data: Uint8Array | Blob, opts: UploadOptions): Promise<Attachment> {
    const headers: Record<string, string> = { "Content-Type": opts.mimeType };
    if (opts.name) headers[ATTACHMENT_NAME_HEADER] = encodeURIComponent(opts.name);
    const res = await this.request("uploadAttachment", { id: threadId }, { headers, body: data as BodyInit }, threadId);
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new ProtocolError("engine_error", "response is not JSON", false);
    }
    const parsed = ROUTES.uploadAttachment.response.schema.safeParse(json);
    if (!parsed.success) throw new ProtocolError("engine_error", `unexpected response shape: ${parsed.error.message}`, false);
    return parsed.data as Attachment;
  }

  async getAttachment(threadId: string, attachmentId: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const res = await this.request("getAttachment", { id: threadId, attachmentId }, {}, threadId);
    return { bytes: new Uint8Array(await res.arrayBuffer()), mimeType: res.headers.get("content-type") ?? "application/octet-stream" };
  }

  async abort(threadId: string): Promise<void> {
    await this.json("abort", { id: threadId }, ROUTES.abort.response.schema, undefined, threadId);
  }

  async *watch(threadId: string, opts: WatchOptions = {}): AsyncGenerator<ThreadEvent> {
    // lastId: highest id yielded (or the snapshot baseline); events <= it are dropped.
    let lastId: number | undefined = opts.from;
    let failures = 0;

    for (;;) {
      const ctl = new AbortController();
      try {
        const headers: Record<string, string> = { Accept: "text/event-stream" };
        if (lastId !== undefined) headers[LAST_EVENT_ID_HEADER] = String(lastId);
        const res = await this.request("streamThread", { id: threadId }, { headers, signal: ctl.signal }, threadId);
        if (!res.body) throw new TypeError("stream response has no body");

        for await (const frame of sseFrames(res.body)) {
          if (frame.data === SSE_DONE) return;
          let json: unknown;
          try {
            json = JSON.parse(frame.data);
          } catch {
            throw new ProtocolError("invalid_request", "stream frame is not JSON", false);
          }
          const parsed = parseThreadEvent(json);
          if (parsed.kind === "unknown") continue;
          if (parsed.kind === "invalid") throw new ProtocolError("invalid_request", `invalid stream event: ${parsed.error.message}`, false);
          const ev = parsed.event;
          if (ev.type === "snapshot") {
            opts.onSnapshot?.(ev);
            lastId = ev.upToId;
            failures = 0;
            continue;
          }
          if (lastId !== undefined && ev.id <= lastId) continue;
          lastId = ev.id;
          failures = 0;
          yield ev as ThreadEvent;
          if (ev.type === "turn-end") return;
        }
        // Clean EOF without [DONE]: treat as a dropped connection.
        throw new TypeError("stream ended without [DONE]");
      } catch (e) {
        if (e instanceof ProtocolError || e instanceof BusyError || e instanceof NotFoundError) throw e;
        if (++failures > this.maxRetries) {
          throw new ProtocolError("engine_error", `stream lost: ${e instanceof Error ? e.message : String(e)}`, true);
        }
        await sleep(Math.min(2000, this.retryDelayMs * 2 ** (failures - 1)));
      } finally {
        ctl.abort();
      }
    }
  }

  async consolidateMemory(wolf: string): Promise<ConsolidateResponse> {
    return (await this.json("consolidateMemory", { name: wolf }, ROUTES.consolidateMemory.response.schema, undefined, wolf)) as ConsolidateResponse;
  }

  /** Never waits for the job. `already_running` (the running job's id) is a normal 202 answer, not an error. */
  async promoteMemory(wolf: string): Promise<PromoteResponse> {
    return (await this.json("promoteMemory", { name: wolf }, ROUTES.promoteMemory.response.schema, undefined, wolf)) as PromoteResponse;
  }

  async getMemoryStatus(wolf: string, opts: { thread?: string } = {}): Promise<MemoryStatus> {
    const query = opts.thread ? `?thread=${encodeURIComponent(opts.thread)}` : "";
    return (await this.json("getMemoryStatus", { name: wolf }, ROUTES.getMemoryStatus.response.schema, undefined, wolf, query)) as MemoryStatus;
  }

  async getMemoryTopic(wolf: string, topicId: string, opts: { scope?: "den" | "session" } = {}): Promise<MemoryTopic> {
    const query = opts.scope ? `?scope=${opts.scope}` : "";
    return (await this.json("getMemoryTopic", { name: wolf, id: topicId }, ROUTES.getMemoryTopic.response.schema, undefined, wolf, query)) as MemoryTopic;
  }

  async getWorkRecord(wolf: string, workId: string): Promise<WorkRecordResponse> {
    return (await this.json("getWorkRecord", { name: wolf, id: workId }, ROUTES.getWorkRecord.response.schema, undefined, wolf)) as WorkRecordResponse;
  }

  /** Dewey's pipeline (lanes, receipts, parked, sweep). The wolf must be the librarian: others reject with a kb_unavailable error. */
  async getKbPipeline(wolf: string): Promise<KbPipelineResponse> {
    return (await this.json("kbPipeline", { name: wolf }, ROUTES.kbPipeline.response.schema, undefined, wolf)) as KbPipelineResponse;
  }

  async getKbGraph(wolf: string, opts: { domain?: string; archivedWork?: boolean; wikilinks?: boolean; denTopics?: boolean } = {}): Promise<KbGraph> {
    const q = new URLSearchParams();
    if (opts.domain) q.set("domain", opts.domain);
    for (const k of ["archivedWork", "wikilinks", "denTopics"] as const) if (opts[k] !== undefined) q.set(k, String(opts[k]));
    const query = q.size ? `?${q}` : "";
    return (await this.json("getKbGraph", { name: wolf }, ROUTES.getKbGraph.response.schema, undefined, wolf, query)) as KbGraph;
  }

  async getKbEntry(wolf: string, id: string): Promise<KbEntryDetail> {
    return (await this.json("getKbEntry", { name: wolf, id }, ROUTES.getKbEntry.response.schema, undefined, wolf)) as KbEntryDetail;
  }

  /** Live, metadata-only MemoryEvents of a wolf. Reconnects on a dropped stream (no replay: events in the gap are lost). */
  async *watchMemory(wolf: string, opts: { signal?: AbortSignal } = {}): AsyncGenerator<MemoryEvent> {
    const { signal } = opts;
    let failures = 0;
    while (!signal?.aborted) {
      const ctl = new AbortController();
      const stop = () => ctl.abort();
      signal?.addEventListener("abort", stop);
      try {
        const res = await this.request("streamWolfEvents", { name: wolf }, { headers: { Accept: "text/event-stream" }, signal: ctl.signal }, wolf);
        if (!res.body) throw new TypeError("stream response has no body");
        for await (const frame of sseFrames(res.body)) {
          failures = 0; // only a received frame proves the connection worked
          let json: unknown;
          try {
            json = JSON.parse(frame.data);
          } catch {
            throw new ProtocolError("invalid_request", "stream frame is not JSON", false);
          }
          const parsed = parseMemoryEvent(json);
          if (parsed.kind === "unknown") continue;
          if (parsed.kind === "invalid") throw new ProtocolError("invalid_request", `invalid stream event: ${parsed.error.message}`, false);
          yield parsed.event;
        }
        // Clean EOF: the server went away; reconnect.
        throw new TypeError("stream ended");
      } catch (e) {
        if (signal?.aborted) return;
        if (e instanceof ProtocolError || e instanceof BusyError || e instanceof NotFoundError) throw e;
        if (++failures > this.maxRetries) {
          throw new ProtocolError("engine_error", `stream lost: ${e instanceof Error ? e.message : String(e)}`, true);
        }
        await sleep(Math.min(2000, this.retryDelayMs * 2 ** (failures - 1)));
      } finally {
        signal?.removeEventListener("abort", stop);
        ctl.abort();
      }
    }
  }

  // ------------------------------------------------------------ plumbing

  private async request(name: RouteName, params: Record<string, string>, init: RequestInit & { headers?: Record<string, string> } = {}, threadId?: string, query = ""): Promise<Response> {
    const route = ROUTES[name];
    const res = await this.fetchFn(this.base + buildPath(name, params) + query, {
      ...init,
      method: route.method,
      headers: { ...init.headers, [PROTOCOL_VERSION_HEADER]: String(PROTOCOL_VERSION) },
    });
    if (res.ok) return res;
    throw await this.toError(res, threadId);
  }

  private async json(name: RouteName, params: Record<string, string>, schema: { parse(x: unknown): unknown }, body?: unknown, threadId?: string, query = ""): Promise<unknown> {
    const headers: Record<string, string> = {};
    const init: RequestInit & { headers: Record<string, string> } = { headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await this.request(name, params, init, threadId, query);
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new ProtocolError("engine_error", "response is not JSON", false);
    }
    try {
      return schema.parse(data);
    } catch (e) {
      throw new ProtocolError("engine_error", `unexpected response shape: ${e instanceof Error ? e.message : String(e)}`, false);
    }
  }

  /** Map by envelope code, never by HTTP status. */
  private async toError(res: Response, threadId?: string): Promise<Error> {
    let raw: unknown;
    try {
      raw = await res.json();
    } catch {
      raw = undefined;
    }
    let env = ErrorEnvelopeSchema.safeParse(raw);
    if (!env.success) {
      // An envelope whose code this client does not know (additive growth): generic failure, server's words kept.
      const l = raw as { code?: unknown; message?: unknown; retryable?: unknown } | null;
      if (l && typeof l.code === "string" && typeof l.message === "string" && typeof l.retryable === "boolean") {
        return new ProtocolError("engine_error", l.message, l.retryable);
      }
    }
    if (!env.success) return new ProtocolError("engine_error", `HTTP ${res.status} without error envelope`, res.status >= 500);
    const { code, message, retryable } = env.data;
    if (code === "busy") return new BusyError(threadId ?? message);
    if (code === "not_found") return new NotFoundError(message);
    return new ProtocolError(code, message, retryable);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Minimal SSE parser: frames separated by blank lines; `id:`/`data:` fields, comments ignored. */
async function* sseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<Frame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const frame = parseFrame(raw);
        if (frame) yield frame;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

function parseFrame(raw: string): Frame | undefined {
  let id: string | undefined;
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const c = line.indexOf(":");
    const field = c < 0 ? line : line.slice(0, c);
    let value = c < 0 ? "" : line.slice(c + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "id") id = value;
    else if (field === "data") data.push(value);
  }
  return data.length ? { id, data: data.join("\n") } : undefined;
}
