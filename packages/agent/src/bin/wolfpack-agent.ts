#!/usr/bin/env node
/**
 * Wolfpack Agent — entry point.
 *
 * Starts the HTTP API server for managing wolves on this host.
 */

import express from "express";
import { WolfManager } from "../wolf-manager.js";
import { authMiddleware } from "../auth.js";
import { wolvesRouter } from "../routes/wolves.js";
import { logsRouter } from "../routes/logs.js";
import { healthRouter } from "../routes/health.js";

const PORT = parseInt(process.env.WOLFPACK_AGENT_PORT ?? "3141");
const DATA_DIR = process.env.WOLFPACK_AGENT_DATA ?? "/opt/wolfpack";

async function main() {
  const manager = new WolfManager(DATA_DIR);
  await manager.init();

  const app = express();
  app.use(express.json());
  app.use(authMiddleware);

  app.use("/wolves", wolvesRouter(manager));
  app.use("/logs", logsRouter(manager));
  app.use("/health", healthRouter(manager));

  app.get("/ping", (_req, res) => {
    res.json({ status: "ok", version: "0.1.0" });
  });

  app.listen(PORT, () => {
    const count = manager.list().length;
    console.log(
      `🐺 wolfpack-agent listening on :${PORT} (${count} wolves registered)`,
    );
  });
}

main().catch((err) => {
  console.error("Failed to start wolfpack-agent:", err);
  process.exit(1);
});
