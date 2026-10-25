import { request as httpRequest, createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ERROR_HTTP_STATUS, PROTOCOL_VERSION, PROTOCOL_VERSION_HEADER, matchRoute, type ErrorCode, type WolfSummary } from "@wolfpack/protocol";
import type { WolfRegistry } from "./registry.js";

export interface WorkerdServerOptions {
  registry: WolfRegistry;
  /** Extra JSON for GET /healthz (children + restart counts). */
  health?: () => unknown;
  /** Timeout for the per-wolf /v1/wolves probe during aggregation. Default 1000. */
  probeTimeoutMs?: number;
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
    this.baseUrl = `http://${host}:${(this.http.address() as AddressInfo).port}`;
    return this.baseUrl;
  }

  close(): Promise<void> {
    this.http.closeAllConnections();
    return new Promise((resolve) => this.http.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://workerd");
    const method = req.method ?? "GET";
    if (url.pathname === "/healthz" && method === "GET") {
      const body = JSON.stringify(this.opts.health?.() ?? { ok: true });
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
    this.forward(req, res, new URL(req.url ?? "/", upstream), wolf);
  }

  private forward(req: IncomingMessage, res: ServerResponse, target: URL, wolf: string): void {
    const up = httpRequest(
      { hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: req.method, headers: forwardHeaders(req.headers) },
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
          const r = await fetch(new URL("/v1/wolves", upstream), { signal: AbortSignal.timeout(timeout) });
          const body = (await r.json()) as { wolves?: WolfSummary[] };
          const own = body.wolves?.find((x) => x.name === w.name);
          if (own) return { ...base, host: own.host, status: own.status };
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
