/**
 * Standalone local Work server — the Work API over any ledger dir.
 *
 * Started by the sandbox and hubd dev mode so clients (WORK_ENDPOINT /
 * WORK_TOKEN) can talk to a throwaway ledger. Everything — ledger and
 * materialized .md — lives under `ledgerDir`.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import express from "express";
import type { KbRoots } from "@wolfpack/kb/shared";
import { workRouter } from "./routes/work.js";

export interface LocalWorkServerOptions {
  /** Ledger dir; events land in <ledgerDir>/ledger/work-events.jsonl. */
  ledgerDir: string;
  /** 0 picks an ephemeral port. Default 0. */
  port?: number;
  /** Required X-API-Key value. */
  token: string;
  /** Interface to bind. Default 127.0.0.1. */
  host?: string;
}

export interface LocalWorkServer {
  server: Server;
  port: number;
  url: string;
  close(): Promise<void>;
}

export function startLocalWorkServer(opts: LocalWorkServerOptions): Promise<LocalWorkServer> {
  if (!opts.token) throw new Error("startLocalWorkServer: token is required");
  const roots: KbRoots = {
    kbBase: join(opts.ledgerDir, "base"),
    opsRoot: join(opts.ledgerDir, "ops"),
    denLocal: opts.ledgerDir,
  };

  const app = express();
  app.use(express.json({ limit: "64mb" }));
  app.get("/ping", (_req, res) => {
    res.json({ status: "ok" });
  });
  app.use((req, res, next) => {
    if (req.headers["x-api-key"] !== opts.token) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  });
  app.use("/work", workRouter(roots));

  const host = opts.host ?? "127.0.0.1";
  const server = createServer(app);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, host, () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        server,
        port,
        url: `http://${host}:${port}`,
        close: () => new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res()))),
      });
    });
  });
}
