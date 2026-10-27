import { z } from "zod";
import {
  ConsolidateResponseSchema,
  CreateThreadRequestSchema,
  CreateThreadResponseSchema,
  ErrorEnvelopeSchema,
  MemoryEventSchema,
  MemoryStatusSchema,
  MemoryTopicSchema,
  PromoteResponseSchema,
  SubmitAckSchema,
  SubmitRequestSchema,
  ThreadDetailSchema,
  ThreadEventSchema,
  ThreadSummarySchema,
  WolfSummarySchema,
  WorkRecordResponseSchema,
} from "./schemas.js";

/** Request header carrying the client's protocol version (single integer). */
export const PROTOCOL_VERSION_HEADER = "X-Protocol-Version";
/** SSE resume: standard header, or the `?from=` query fallback. */
export const LAST_EVENT_ID_HEADER = "Last-Event-ID";
/** Terminator frame payload (`data: [DONE]`) sent when a stream ends at turn-end. */
export const SSE_DONE = "[DONE]";

export type HttpMethod = "GET" | "POST";

/** Wire bodies: the path carries the identifier, so it is dropped from the body. */
export const SubmitBodySchema = SubmitRequestSchema.omit({ threadId: true });
export type SubmitBody = z.infer<typeof SubmitBodySchema>;
export const CreateThreadBodySchema = CreateThreadRequestSchema.omit({ wolf: true });
export type CreateThreadBody = z.infer<typeof CreateThreadBodySchema>;

export const ListWolvesResponseSchema = z.object({ wolves: z.array(WolfSummarySchema) });
export const ListThreadsResponseSchema = z.object({ threads: z.array(ThreadSummarySchema) });
export const AbortResponseSchema = z.object({ ok: z.literal(true) });

export interface RouteDef {
  readonly method: HttpMethod;
  /** Path pattern; `:name` segments are URL-encoded path params (thread ids contain `/`). */
  readonly path: string;
  /** JSON request body schema, if any. */
  readonly body?: z.ZodType;
  /** Success response: a JSON body schema, or an SSE stream of events. */
  readonly response: { readonly kind: "json"; readonly schema: z.ZodType } | { readonly kind: "sse"; readonly event: z.ZodType };
  /** Success status(es). */
  readonly status: readonly number[];
  /** Every non-2xx response is an ErrorEnvelope. */
  readonly error: z.ZodType;
}

const err = ErrorEnvelopeSchema;

export const ROUTES = {
  listWolves: { method: "GET", path: "/v1/wolves", response: { kind: "json", schema: ListWolvesResponseSchema }, status: [200], error: err },
  listThreads: { method: "GET", path: "/v1/wolves/:name/threads", response: { kind: "json", schema: ListThreadsResponseSchema }, status: [200], error: err },
  /** Home-only and idempotent: 201 when created, 200 when the existing home thread is returned. */
  createThread: {
    method: "POST",
    path: "/v1/wolves/:name/threads",
    body: CreateThreadBodySchema,
    response: { kind: "json", schema: CreateThreadResponseSchema },
    status: [200, 201],
    error: err,
  },
  getThread: { method: "GET", path: "/v1/threads/:id", response: { kind: "json", schema: ThreadDetailSchema }, status: [200], error: err },
  submit: { method: "POST", path: "/v1/threads/:id/submit", body: SubmitBodySchema, response: { kind: "json", schema: SubmitAckSchema }, status: [200], error: err },
  abort: { method: "POST", path: "/v1/threads/:id/abort", response: { kind: "json", schema: AbortResponseSchema }, status: [200], error: err },
  /** SSE: `id: <eventId>` + `data: <ThreadEvent json>`; ends with `data: [DONE]` at the first turn-end. */
  streamThread: { method: "GET", path: "/v1/threads/:id/stream", response: { kind: "sse", event: ThreadEventSchema }, status: [200], error: err },
  /**
   * SSE: wolf-scoped MemoryEvents, `data: <MemoryEvent json>` frames. Live only (no replay, no `id:`, no Last-Event-ID);
   * unlike a thread stream it never ends with `[DONE]`, it stays open until the client disconnects.
   */
  streamWolfEvents: { method: "GET", path: "/v1/wolves/:name/events", response: { kind: "sse", event: MemoryEventSchema }, status: [200], error: err },
  /**
   * Fold the observation pool into session topics; answers with the counts. 409 `memory_unavailable` when the wolf's
   * memory is inert or not loaded; 409 `memory_busy` (retryable) while a promote runs.
   */
  consolidateMemory: {
    method: "POST",
    path: "/v1/wolves/:name/memory/consolidate",
    response: { kind: "json", schema: ConsolidateResponseSchema },
    status: [200],
    error: err,
  },
  /**
   * Start promote as a background job: 202 `{jobId, status:"started"}` immediately; completion is reported as
   * `promote_finished` / `promote_failed` MemoryEvents with that jobId. While one runs: also 202, with
   * `{jobId: <running job>, status:"already_running"}` (nothing started). Failures are envelopes: 409
   * `memory_unavailable` (memory inert / not loaded) and 409 `promote_unavailable` (no KB roots).
   */
  promoteMemory: {
    method: "POST",
    path: "/v1/wolves/:name/memory/promote",
    response: { kind: "json", schema: PromoteResponseSchema },
    status: [202],
    error: err,
  },
  /**
   * Read-only memory status: state (live|sandbox|inert|off) with the reason, pool count/tokens against the
   * consolidate thresholds, session- and den-topic lists, last promote. Answers 200 even when memory is inert or off
   * (that is the state being reported). A wolf serves only its own den. `?thread=<id>` adds that thread's bound work
   * item (`bound`); an unknown thread is 404 `not_found`.
   */
  getMemoryStatus: { method: "GET", path: "/v1/wolves/:name/memory", response: { kind: "json", schema: MemoryStatusSchema }, status: [200], error: err },
  /**
   * One den or session topic with its body. `?scope=den|session` picks the store (default: den, then session).
   * 400 `invalid_request` for a malformed id or scope, 404 `not_found` for an unknown topic,
   * 409 `memory_unavailable` when memory is inert or off.
   */
  getMemoryTopic: { method: "GET", path: "/v1/wolves/:name/memory/topics/:id", response: { kind: "json", schema: MemoryTopicSchema }, status: [200], error: err },
  /**
   * A work item's page data (plan + Record + links), fetched through the wolf's Work API client. 404 `not_found` for an unknown item or wolf,
   * 409 `memory_unavailable` when the wolf has no Work API configured, 502 `engine_error` when it cannot be reached.
   */
  getWorkRecord: { method: "GET", path: "/v1/wolves/:name/work/:id/record", response: { kind: "json", schema: WorkRecordResponseSchema }, status: [200], error: err },
} as const satisfies Record<string, RouteDef>;

export type RouteName = keyof typeof ROUTES;

export interface RouteMatch {
  name: RouteName;
  route: RouteDef;
  params: Record<string, string>;
}

const compiled = (Object.entries(ROUTES) as [RouteName, RouteDef][]).map(([name, route]) => ({
  name,
  route,
  segments: route.path.split("/").filter(Boolean),
}));

/** Match a request to a route. `undefined` = no such path; `"method"` = path exists, wrong method. */
export function matchRoute(method: string, pathname: string): RouteMatch | "method" | undefined {
  const parts = pathname.split("/").filter(Boolean);
  let pathHit = false;
  for (const c of compiled) {
    if (c.segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < parts.length && ok; i++) {
      const seg = c.segments[i];
      if (seg.startsWith(":")) {
        try {
          params[seg.slice(1)] = decodeURIComponent(parts[i]);
        } catch {
          ok = false;
        }
      } else ok = seg === parts[i];
    }
    if (!ok) continue;
    pathHit = true;
    if (c.route.method === method) return { name: c.name, route: c.route, params };
  }
  return pathHit ? "method" : undefined;
}

/** Build a concrete path from a route pattern, URL-encoding params. */
export function buildPath(name: RouteName, params: Record<string, string> = {}): string {
  return ROUTES[name].path.replace(/:(\w+)/g, (_, k: string) => encodeURIComponent(params[k] ?? ""));
}
