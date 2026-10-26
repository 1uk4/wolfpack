import {
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
  type MemoryEvent,
  type SubmitAck,
  type SubmitOptions,
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
    const body = { input, whenBusy: opts.whenBusy ?? "reject" };
    return (await this.json("submit", { id: threadId }, ROUTES.submit.response.schema, body, threadId)) as SubmitAck;
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

  private async request(name: RouteName, params: Record<string, string>, init: RequestInit & { headers?: Record<string, string> } = {}, threadId?: string): Promise<Response> {
    const route = ROUTES[name];
    const res = await this.fetchFn(this.base + buildPath(name, params), {
      ...init,
      method: route.method,
      headers: { ...init.headers, [PROTOCOL_VERSION_HEADER]: String(PROTOCOL_VERSION) },
    });
    if (res.ok) return res;
    throw await this.toError(res, threadId);
  }

  private async json(name: RouteName, params: Record<string, string>, schema: { parse(x: unknown): unknown }, body?: unknown, threadId?: string): Promise<unknown> {
    const headers: Record<string, string> = {};
    const init: RequestInit & { headers: Record<string, string> } = { headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await this.request(name, params, init, threadId);
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
    let env;
    try {
      env = ErrorEnvelopeSchema.safeParse(await res.json());
    } catch {
      env = undefined;
    }
    if (!env?.success) return new ProtocolError("engine_error", `HTTP ${res.status} without error envelope`, res.status >= 500);
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
