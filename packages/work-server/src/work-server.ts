/**
 * Standalone local Work server — the Work API over any ledger dir.
 *
 * Started by the sandbox and hubd dev mode so clients (WORK_ENDPOINT /
 * WORK_TOKEN) can talk to a throwaway ledger. Everything — ledger and
 * materialized .md — lives under `ledgerDir`.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { acquireWorkWriterLock, type WriterLock } from "@wolfpack/engine";
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
  /**
   * The sandbox writer lock, when the caller already holds it (it then also publishes/releases it). Without it, a ledger dir
   * that is a sandbox root (has snapshot.json) is locked HERE: exactly one server may write a sandbox ledger, whoever starts it.
   */
  writerLock?: WriterLock;
}

export interface LocalWorkServer {
  server: Server;
  port: number;
  url: string;
  close(): Promise<void>;
}

export async function startLocalWorkServer(opts: LocalWorkServerOptions): Promise<LocalWorkServer> {
  if (!opts.token) throw new Error("startLocalWorkServer: token is required");
  const expected = Buffer.from(opts.token);
  const roots: KbRoots = {
    kbBase: join(opts.ledgerDir, "base"),
    opsRoot: join(opts.ledgerDir, "ops"),
    denLocal: opts.ledgerDir,
  };

  // A sandbox's ledger copy has one writer. Take the lock before anything listens; a live second writer throws here.
  const ownLock = !opts.writerLock && existsSync(join(opts.ledgerDir, "snapshot.json")) ? acquireWorkWriterLock(opts.ledgerDir) : undefined;
  const app = express();
  app.use(express.json({ limit: "64mb" }));
  app.get("/ping", (_req, res) => {
    res.json({ status: "ok" });
  });
  app.use((req, res, next) => {
    const provided = Buffer.from(String(req.headers["x-api-key"] ?? ""));
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  });
  app.use("/work", workRouter(roots));

  const host = opts.host ?? "127.0.0.1";
  const server = createServer(app);
  return new Promise((resolve, reject) => {
    server.once("error", (e) => {
      ownLock?.release();
      reject(e);
    });
    server.listen(opts.port ?? 0, host, () => {
      const port = (server.address() as AddressInfo).port;
      const url = `http://${host}:${port}`;
      try {
        ownLock?.publish({ url, token: opts.token });
      } catch (e) {
        ownLock?.release();
        server.close();
        reject(e);
        return;
      }
      resolve({
        server,
        port,
        url,
        close: () => new Promise<void>((res, rej) => server.close((e) => { ownLock?.release(); e ? rej(e) : res(); })),
      });
    });
  });
}
