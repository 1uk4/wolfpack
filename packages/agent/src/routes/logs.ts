/**
 * Log streaming routes — SSE for real-time, GET for tail.
 */

import { Router, type Request, type Response } from "express";
import { spawn } from "node:child_process";
import type { WolfManager } from "../wolf-manager.js";

export function logsRouter(manager: WolfManager): Router {
  const router = Router();

  router.get("/:nameOrId", async (req: Request, res: Response) => {
    const config = manager.resolve(req.params.nameOrId);
    if (!config) {
      res.status(404).json({ error: `Wolf not found: ${req.params.nameOrId}` });
      return;
    }

    const follow = req.query.follow === "true" || req.query.follow === "1";
    const lines = parseInt(req.query.lines as string) || 100;
    const service = `wolf-${config.id}.service`;

    if (follow) {
      // SSE streaming
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const child = spawn("journalctl", [
        "-u",
        service,
        "-f",
        "--no-pager",
        "-n",
        String(lines),
      ]);

      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        for (const line of text.split("\n")) {
          if (line) res.write(`data: ${line}\n\n`);
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        res.write(`data: [stderr] ${chunk.toString()}\n\n`);
      });

      child.on("close", () => {
        res.end();
      });

      req.on("close", () => {
        child.kill();
      });
    } else {
      // One-shot tail
      try {
        const child = spawn("journalctl", [
          "-u",
          service,
          "-n",
          String(lines),
          "--no-pager",
        ]);

        let output = "";
        child.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });

        child.on("close", (code) => {
          if (code !== 0) {
            res.status(500).json({ error: `journalctl exited ${code}` });
            return;
          }
          res.json({ wolf: config.name, lines: output.split("\n") });
        });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    }
  });

  return router;
}
