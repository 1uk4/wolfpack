/**
 * Wolf management API routes.
 */

import { Router, type Request, type Response } from "express";
import type { WolfManager } from "../wolf-manager.js";
import type {
  CreateWolfRequest,
  UpdateWolfConfigRequest,
  UpdateBundleRequest,
} from "../types.js";

export function wolvesRouter(manager: WolfManager): Router {
  const router = Router();

  // List all wolves
  router.get("/", async (_req: Request, res: Response) => {
    try {
      const wolves = manager.list();
      const statuses = await Promise.all(
        wolves.map((w) => manager.status(w.id)),
      );
      res.json({ wolves: statuses });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Create wolf
  router.post("/", async (req: Request, res: Response) => {
    try {
      const body = req.body as CreateWolfRequest;
      if (!body.name || !body.runtime || !body.role) {
        res
          .status(400)
          .json({ error: "name, runtime, and role are required" });
        return;
      }
      const wolf = await manager.create(body);
      res.status(201).json({ wolf });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Get wolf status (by name or ID)
  router.get("/:nameOrId", async (req: Request, res: Response) => {
    try {
      const config = manager.resolve(req.params.nameOrId);
      if (!config) {
        res.status(404).json({ error: `Wolf not found: ${req.params.nameOrId}` });
        return;
      }
      const status = await manager.status(config.id);
      // Include the full config so the CLI can rebuild/propagate bundles.
      res.json({ ...status, config });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Replace identity bundle in place (propagate extension updates) + restart
  router.put("/:nameOrId/bundle", async (req: Request, res: Response) => {
    try {
      const config = manager.resolve(req.params.nameOrId);
      if (!config) {
        res.status(404).json({ error: `Wolf not found: ${req.params.nameOrId}` });
        return;
      }
      const body = req.body as Record<string, unknown>;
      
      // Detect pi-durable format: {runtime, harness, wolfYaml, agentsMd, models, extensions}
      if (body.runtime === "pi-durable" && body.harness) {
        const updated = await manager.updatePiDurableBundle(
          config.id,
          body.harness as string,
          body.wolfYaml as string,
          body.agentsMd as string,
          body.extensions as Record<string, string> | undefined,
          body.models as string | undefined,
        );
        res.json({ wolf: updated });
        return;
      }
      
      // Legacy pi format: {bundle, manifest}
      if (!body.bundle || !body.manifest) {
        res.status(400).json({ error: "bundle and manifest are required" });
        return;
      }
      const updated = await manager.updateBundle(
        config.id,
        body.bundle as string,
        body.manifest as UpdateBundleRequest["manifest"],
      );
      res.json({ wolf: updated });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Update wolf config
  router.patch("/:nameOrId/config", async (req: Request, res: Response) => {
    try {
      const config = manager.resolve(req.params.nameOrId);
      if (!config) {
        res.status(404).json({ error: `Wolf not found: ${req.params.nameOrId}` });
        return;
      }
      const updates = req.body as UpdateWolfConfigRequest;
      const updated = await manager.updateConfig(config.id, updates);
      res.json({ wolf: updated });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Restart wolf
  router.post("/:nameOrId/restart", async (req: Request, res: Response) => {
    try {
      const config = manager.resolve(req.params.nameOrId);
      if (!config) {
        res.status(404).json({ error: `Wolf not found: ${req.params.nameOrId}` });
        return;
      }
      
      // Clear session if requested (pi-durable only)
      if (req.body?.clearSession && config.runtime === "pi-durable") {
        const { unlink } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const sessionPath = join(`/home/wolf-${config.id}/den`, "session.sqlite");
        try {
          await unlink(sessionPath);
        } catch {
          // Session file might not exist
        }
      }
      
      await manager.restart(config.id);
      res.json({ success: true, restarted: config.name });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Stop wolf
  router.post("/:nameOrId/stop", async (req: Request, res: Response) => {
    try {
      const config = manager.resolve(req.params.nameOrId);
      if (!config) {
        res.status(404).json({ error: `Wolf not found: ${req.params.nameOrId}` });
        return;
      }
      await manager.stop(config.id);
      res.json({ success: true, stopped: config.name });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Remove wolf
  router.delete("/:nameOrId", async (req: Request, res: Response) => {
    try {
      const config = manager.resolve(req.params.nameOrId);
      if (!config) {
        res.status(404).json({ error: `Wolf not found: ${req.params.nameOrId}` });
        return;
      }
      await manager.remove(config.id);
      res.json({ success: true, removed: config.name });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  return router;
}
