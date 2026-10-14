/**
 * Host health endpoint — CPU, memory, disk, wolf statuses.
 */

import { Router, type Request, type Response } from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import type { WolfManager } from "../wolf-manager.js";
import { checkServices } from "../services.js";

const exec = promisify(execFile);

export function healthRouter(manager: WolfManager): Router {
  const router = Router();

  router.post("/fix-kb-permissions", async (_req: Request, res: Response) => {
    try {
      const dirs = ["/var/wolfpack/kb/ops", "/var/wolfpack/kb/base"];
      const results: string[] = [];
      for (const dir of dirs) {
        try {
          await exec("find", ["-L", dir, "-type", "f", "-exec", "chmod", "666", "{}", ";"]);
          await exec("find", ["-L", dir, "-type", "d", "-exec", "chmod", "777", "{}", ";"]);
          results.push(`${dir}: fixed`);
        } catch (err) {
          results.push(`${dir}: ${err}`);
        }
      }
      res.json({ success: true, results });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.get("/", async (_req: Request, res: Response) => {
    try {
      const wolves = manager.list();
      const [statuses, services] = await Promise.all([
        Promise.all(wolves.map((w) => manager.status(w.id))),
        checkServices(),
      ]);

      // Basic host info
      const cpus = os.cpus();
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      const loadAvg = os.loadavg();

      // Disk usage
      let diskPercent = 0;
      let diskUsed = "";
      let diskSize = "";
      try {
        const { stdout } = await exec("df", ["-h", "/"]);
        const lines = stdout.trim().split("\n");
        if (lines.length >= 2) {
          const parts = lines[1]!.split(/\s+/);
          diskSize = parts[1] ?? "?";
          diskUsed = parts[2] ?? "?";
          diskPercent = parseInt(parts[4] ?? "0");
        }
      } catch {
        // ignore
      }

      // Uptime
      const uptimeSec = os.uptime();
      const days = Math.floor(uptimeSec / 86400);
      const hours = Math.floor((uptimeSec % 86400) / 3600);
      const uptime = days > 0 ? `${days}d ${hours}h` : `${hours}h`;

      res.json({
        hostname: os.hostname(),
        uptime,
        cpuCount: cpus.length,
        loadAvg: {
          "1m": loadAvg[0],
          "5m": loadAvg[1],
          "15m": loadAvg[2],
        },
        memory: {
          used: usedMem,
          total: totalMem,
          percent: Math.round((usedMem / totalMem) * 100),
        },
        disk: {
          used: diskUsed,
          size: diskSize,
          percent: diskPercent,
        },
        wolves: statuses,
        services,
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  return router;
}
