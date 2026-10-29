/**
 * hubd: the pack authority. Serves the /v1 protocol's hub-scoped routes from a hub data directory. This ticket: work reads.
 * Later tickets slot into `dispatch` (work writes under the work-writer lock, claim, registry, /v1/events, ...).
 *
 * Auth: one shared X-API-Key; the acting identity comes from the protocol's actor (see `actorOf`).
 */
import { timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ActorSchema,
  ERROR_HTTP_STATUS,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_HEADER,
  matchRoute,
  type Actor,
  type ErrorCode,
  type ErrorEnvelope,
} from "@wolfpack/protocol";
import type { KbRoots } from "@wolfpack/kb/shared";
import { hubRoots } from "./layout.js";
import { listWorkItems, readWorkRecordFor } from "./work-reads.js";

export const API_KEY_HEADER = "x-api-key";
export const ACTOR_HEADER = "x-wolfpack-actor";

export interface HubOptions {
  dataDir: string;
  /** Required shared secret (X-API-Key). */
  apiKey: string;
  /** 0 picks an ephemeral port. Default 0. */
  port?: number;
  /** Default 127.0.0.1. */
  host?: string;
}

export interface HubServer {
  readonly dataDir: string;
  readonly roots: KbRoots;
  /** Base URL once listening. */
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

class HubError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
  }
}

const WORK_ID = /^work-[a-z0-9-]+-[a-z0-9]{4,}$/i;
const retryable = (c: ErrorCode) => c === "busy" || c === "engine_error";

/** The actor of a request: `X-Wolfpack-Actor: {"id","kind"}` (JSON). Absent = the system. Malformed = invalid_request. */
export function actorOf(req: IncomingMessage): Actor {
  const raw = req.headers[ACTOR_HEADER];
  if (typeof raw !== "string") return { id: "system", kind: "system" };
  try {
    const a = ActorSchema.safeParse(JSON.parse(raw));
    if (a.success) return a.data;
  } catch {
    /* fallthrough */
  }
  throw new HubError("invalid_request", `bad ${ACTOR_HEADER}`);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

export async function createHubServer(opts: HubOptions): Promise<HubServer> {
  if (!opts.apiKey) throw new Error("createHubServer: apiKey is required");
  const roots = hubRoots(opts.dataDir);
  mkdirSync(`${opts.dataDir}/ledger`, { recursive: true });
  const expected = Buffer.from(opts.apiKey);

  const authed = (req: IncomingMessage): boolean => {
    const got = Buffer.from(String(req.headers[API_KEY_HEADER] ?? ""));
    return got.length === expected.length && timingSafeEqual(got, expected);
  };

  async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://hubd");
    res.setHeader(PROTOCOL_VERSION_HEADER, String(PROTOCOL_VERSION));
    if (!authed(req)) throw new HubError("unauthorized", "missing or wrong X-API-Key");
    const m = matchRoute(req.method ?? "GET", url.pathname);
    if (m === undefined) throw new HubError("not_found", `no route ${url.pathname}`);
    if (m === "method") throw new HubError("invalid_request", `method ${req.method} not allowed`);
    const v = req.headers[PROTOCOL_VERSION_HEADER.toLowerCase()];
    if (typeof v === "string") {
      if (!/^\d+$/.test(v.trim())) throw new HubError("invalid_request", `bad ${PROTOCOL_VERSION_HEADER}`);
      if (Number(v) !== PROTOCOL_VERSION) throw new HubError("version_mismatch", `server speaks protocol ${PROTOCOL_VERSION}, client sent ${v}`);
    }
    actorOf(req); // validated for every request; writes (later tickets) record it on the ledger event
    const { params } = m;
    switch (m.name) {
      case "listWolves":
        // The hub is not a wolf host. (The registry ticket makes this the pack's wolf list.)
        return send(res, 200, { wolves: [] });
      case "hubListWork": {
        const domain = url.searchParams.get("domain");
        if (!domain) throw new HubError("invalid_request", "domain is required");
        const flag = url.searchParams.get("graduated");
        if (flag !== null && flag !== "true" && flag !== "false") throw new HubError("invalid_request", "graduated must be true or false");
        return send(res, 200, listWorkItems(roots, domain, flag === "true"));
      }
      case "hubGetWorkRecord": {
        if (!WORK_ID.test(params.id)) throw new HubError("invalid_request", "malformed work item id");
        const rec = readWorkRecordFor(roots, params.id);
        if (!rec) throw new HubError("not_found", `work item ${params.id}`);
        return send(res, 200, rec);
      }
      default:
        // Wolf-scoped routes (threads, memory, KB, graduation, ...) belong to the wolf hosts, not the hub.
        throw new HubError("not_found", `${m.name} is served by a wolf host, not the hub`);
    }
  }

  const server: Server = createServer((req, res) => {
    dispatch(req, res).catch((e: unknown) => {
      const err = e instanceof HubError ? e : new HubError("engine_error", e instanceof Error ? e.message : String(e));
      const env: ErrorEnvelope = { code: err.code, message: err.message, retryable: retryable(err.code) };
      if (!res.headersSent) send(res, ERROR_HTTP_STATUS[err.code], env);
      else res.end();
    });
  });
  const host = opts.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, host, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    dataDir: opts.dataDir,
    roots,
    port,
    url: `http://${host}:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
