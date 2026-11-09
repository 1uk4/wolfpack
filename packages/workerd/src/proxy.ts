import { request as httpRequest, createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ERROR_HTTP_STATUS, PROTOCOL_VERSION, PROTOCOL_VERSION_HEADER, matchRoute, type ErrorCode, type WolfSummary } from "@wolfpack/protocol";
import { baseHealth, createLagMonitor, stampedVersion, type LagMonitor } from "@wolfpack/protocol/health-lag";
import type { WolfRegistry } from "./registry.js";
import { getJson, socketOf } from "./socket.js";

export interface WorkerdServerOptions {
  registry: WolfRegistry;
  /** Extra JSON for GET /healthz (children + restart counts). */
  health?: () => unknown;
  /** Timeout for the per-wolf /v1/wolves probe during aggregation. Default 1000. */
  probeTimeoutMs?: number;
}

/** Release version: the VERSION beside the bundle (workerd.mjs) or the package root (`pnpm runtime:update` stamp), else <package.json>-dev. */
const VERSION = stampedVersion([new URL("./VERSION", import.meta.url), new URL("../VERSION", import.meta.url)], new URL("../package.json", import.meta.url));

/**
 * The /healthz body is unauthenticated, so it carries names, states and counts only: per-wolf socket `url` and `logFile` paths
 * and per-domain kb `lastError` text (which can quote filesystem paths) are dropped. No field here ever held a token.
 */
function publicHealth(extra: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...extra };
  if (Array.isArray(out.wolves)) out.wolves = out.wolves.map((w) => (w && typeof w === "object" ? (({ url: _u, logFile: _l, ...rest }) => rest)(w as Record<string, unknown>) : w));
  if (out.kb && typeof out.kb === "object") {
    out.kb = Object.fromEntries(Object.entries(out.kb as Record<string, unknown>).map(([d, s]) => [d, s && typeof s === "object" ? (({ lastError: _e, ...rest }) => rest)(s as Record<string, unknown>) : s]));
  }
  return out;
}

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host"]);

function sendError(res: ServerResponse, code: ErrorCode, message: string, retryable = false, status = ERROR_HTTP_STATUS[code]): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const body = JSON.stringify({ code, message, retryable });
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function forwardHeaders(h: IncomingHttpHeaders): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = {};
  for (const [k, v] of Object.entries(h)) if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  return out;
}

/** Which wolf a /v1 request belongs to: the name in `wolves/:name/*`, or the prefix of the thread id `<wolf>/<rest>`. */
export function wolfForRoute(params: Record<string, string>): string | undefined {
  if (params.name !== undefined) return params.name;
  if (params.id !== undefined) {
    const i = params.id.indexOf("/");
    return i > 0 ? params.id.slice(0, i) : undefined;
  }
  return undefined;
}

/** workerd's HTTP face: /v1 reverse proxy (plain forward, SSE streamed unbuffered) + /healthz. */
export class WorkerdServer {
  private readonly http: Server;
  private baseUrl = "";
  /** Started once listening succeeds (a failed start leaves nothing running); stopped in close(). */
  private lag: LagMonitor | undefined;

  constructor(private readonly opts: WorkerdServerOptions) {
    this.http = createServer((req, res) => {
      this.handle(req, res).catch((e) => sendError(res, "engine_error", e instanceof Error ? e.message : "unexpected error"));
    });
  }

  get url(): string {
    return this.baseUrl;
  }

  async listen(port = 0, host = "127.0.0.1"): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(port, host, () => resolve());
    });
    this.lag ??= createLagMonitor();
    this.baseUrl = `http://${host}:${(this.http.address() as AddressInfo).port}`;
    return this.baseUrl;
  }

  close(): Promise<void> {
    this.lag?.stop();
    this.http.closeAllConnections();
    return new Promise((resolve) => this.http.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://workerd");
    const method = req.method ?? "GET";
    if (url.pathname === "/healthz" && method === "GET") {
      // Deliberately unauthenticated and deliberately rich: the pack-health wolves light (work-wolfpack-LUQ7C2B) needs per-wolf state.
      // workerd listens on loopback or the tailnet only, and publicHealth() keeps it to names, states and restart counts (no secrets, no paths).
      const extra = this.opts.health?.();
      const body = JSON.stringify({ ...baseHealth("workerd", (this.lag ??= createLagMonitor()), VERSION), ...(extra && typeof extra === "object" ? publicHealth(extra as Record<string, unknown>) : {}) }); // base fields first: an existing `ok`/`wolves` body keeps winning
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
      return;
    }
    if (!url.pathname.startsWith("/v1/")) return sendError(res, "not_found", `no such path: ${url.pathname}`);
    // /v1/wolves is answered here (never forwarded), so the version gate must live here too; forwarded routes also get wolfd's own check.
    const ver = req.headers[PROTOCOL_VERSION_HEADER.toLowerCase()];
    if (ver !== undefined) {
      if (!/^\d+$/.test(String(ver))) return sendError(res, "invalid_request", `${PROTOCOL_VERSION_HEADER} must be an integer`);
      if (Number(ver) !== PROTOCOL_VERSION) return sendError(res, "version_mismatch", `server speaks protocol ${PROTOCOL_VERSION}, client sent ${String(ver)}`);
    }
    const m = matchRoute(method, url.pathname);
    if (m === undefined) return sendError(res, "not_found", `no such path: ${url.pathname}`);
    if (m === "method") return sendError(res, "invalid_request", `method ${method} not allowed on ${url.pathname}`, false, 405);
    if (m.name === "listWolves") return this.listWolves(res);
    const wolf = wolfForRoute(m.params);
    if (!wolf || !this.opts.registry.has(wolf)) return sendError(res, "not_found", `unknown wolf: ${wolf ?? "(none)"}`);
    const upstream = this.opts.registry.upstream(wolf);
    if (!upstream) return sendError(res, "engine_error", `wolf ${wolf} is offline`, true);
    this.forward(req, res, upstream, wolf);
  }

  private forward(req: IncomingMessage, res: ServerResponse, upstream: string, wolf: string): void {
    const sock = socketOf(upstream);
    const target = new URL(req.url ?? "/", sock ? "http://wolf" : upstream);
    const where = sock ? { socketPath: sock } : { hostname: target.hostname, port: target.port };
    const up = httpRequest(
      { ...where, path: target.pathname + target.search, method: req.method, headers: forwardHeaders(req.headers) },
      (ur) => {
        res.writeHead(ur.statusCode ?? 502, forwardHeaders(ur.headers));
        res.flushHeaders();
        ur.pipe(res);
        ur.on("error", () => res.destroy());
      },
    );
    up.on("error", (e) => sendError(res, "engine_error", `wolf ${wolf} unreachable: ${e.message}`, true));
    res.on("close", () => up.destroy());
    req.pipe(up);
  }

  /**
   * Aggregate: one entry per supervised wolf. Online wolves are probed (their own /v1/wolves) so `busy` passes
   * through; if the probe fails the wolf is reported plain `online` (child healthy) — never busy-guessed.
   */
  private async listWolves(res: ServerResponse): Promise<void> {
    const timeout = this.opts.probeTimeoutMs ?? 1000;
    const wolves = await Promise.all(
      this.opts.registry.wolves().map(async (w): Promise<WolfSummary> => {
        const base: WolfSummary = { id: w.id, name: w.name, host: w.host, status: "offline" };
        const upstream = this.opts.registry.upstream(w.name);
        if (!upstream) return base;
        try {
          const body = (await getJson(upstream, "/v1/wolves", timeout)) as { wolves?: WolfSummary[] };
          const own = body.wolves?.find((x) => x.name === w.name);
          if (own) return { ...base, host: own.host, status: own.status, ...(own.librarian !== undefined ? { librarian: own.librarian } : {}), ...(own.kbReadable !== undefined ? { kbReadable: own.kbReadable } : {}), ...(own.color !== undefined ? { color: own.color } : {}) };
        } catch {
          /* fall through */
        }
        return { ...base, status: "online" };
      }),
    );
    const body = JSON.stringify({ wolves });
    res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    res.end(body);
  }
}
