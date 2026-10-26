/**
 * Work API routes — shared task/work item management.
 *
 * All wolves hit these routes over Tailscale. Storage:
 *   - Event ledger: <denLocal>/ledger/work-events.jsonl
 *   - Materialized .md: <KB_BASE>/domains/<domain>/work/<id>.md
 *
 * Auth: same agent API key (X-API-Key header).
 */

import { mkdirSync } from "node:fs";
import { Router } from "express";
import type { Request, Response } from "express";
import {
  createWork,
  queryWork,
  stageWork,
  noteWork,
  linkWork,
  unlinkWork,
  moveWork,
  deleteWork,
  retitleWork,
  scheduleWork,
  setStanding,
  setCriteria,
  assignWork,
  loadWorkState,
  commitWorkItem,
  graduateWork,
  resolveWorkItem,
  type CreateWorkInput,
  type WorkQuery,
} from "@wolfpack/kb/client";
import type { KbRoots } from "@wolfpack/kb/shared";
import { kbBase, kbOps, workLedgerDir } from "../paths.js";

/** KbRoots the Work API runs on, from the agent's env (the default mount). */
export function defaultWorkRoots(): KbRoots {
  return {
    kbBase: kbBase(),
    opsRoot: kbOps(),
    denLocal: workLedgerDir(),
  };
}

/**
 * Work API routes over the given roots. `roots.denLocal` is the ledger dir;
 * defaults to the agent's env-derived layout, resolved when the router is
 * built (not at module load).
 */
export function workRouter(roots: KbRoots = defaultWorkRoots()): Router {
  mkdirSync(`${roots.denLocal}/ledger`, { recursive: true });
  const router = Router();

  // ── Query work items ──────────────────────────────────────────────────
  router.get("/", (req: Request, res: Response) => {
    try {
      const query: WorkQuery = {};
      if (req.query.domain) query.domain = String(req.query.domain);
      if (req.query.kind) query.kind = String(req.query.kind);
      if (req.query.stage) query.stage = String(req.query.stage);
      if (req.query.assignee) query.assignee = String(req.query.assignee);
      if (req.query.area) query.area = String(req.query.area);
      if (req.query.partOf) query.partOf = String(req.query.partOf);

      const items = queryWork(roots, query);
      res.json({ items });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Get single item ───────────────────────────────────────────────────
  router.get("/:id", (req: Request, res: Response) => {
    try {
      const items = loadWorkState(roots);
      const item = items.get(req.params.id as any);
      if (!item) {
        res.status(404).json({ error: `Work item not found: ${req.params.id}` });
        return;
      }
      // Include the materialized body so clients (rollup, etc.) don't need a
      // second round-trip. Body is the markdown below the frontmatter; null
      // when the file hasn't been written yet (freshly created).
      const resolved = resolveWorkItem(roots, item.domain as string, item.id as string);
      res.json({ item, body: resolved?.body ?? null });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Create work item ──────────────────────────────────────────────────
  router.post("/", (req: Request, res: Response) => {
    try {
      const body = req.body as CreateWorkInput;
      if (!body.kind || !body.domain || !body.title || !body.assignee) {
        res.status(400).json({ error: "kind, domain, title, and assignee are required" });
        return;
      }
      const result = createWork(roots, body);
      res.status(201).json({ id: result.id, item: result.item });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  // ── Update work item (multipurpose PATCH) ─────────────────────────────
  router.patch("/:id", (req: Request, res: Response) => {
    try {
      const id = req.params.id;
      const body = req.body as Record<string, unknown>;

      let result: { item: unknown } | undefined;

      if (body.stage) {
        const r = stageWork(roots, id, String(body.stage));
        result = { item: r.item };
      } else if (body.note) {
        const r = noteWork(roots, id, String(body.note));
        result = { item: r.item };
      } else if (body.title) {
        const r = retitleWork(roots, id, String(body.title));
        result = { item: r.item };
      } else if (body.successCriteria !== undefined) {
        const r = setCriteria(roots, id, String(body.successCriteria));
        result = { item: r.item };
      } else if (body.assignee) {
        const r = assignWork(roots, id, String(body.assignee));
        result = { item: r.item };
      } else if (body.moveTo) {
        const r = moveWork(roots, id, String(body.moveTo));
        result = { item: r.item };
      } else if (body.link) {
        const link = body.link as { rel: string; target: string };
        const r = linkWork(roots, id, link.rel, link.target);
        result = { item: r.item };
      } else if (body.unlink) {
        const unlink = body.unlink as { rel: string; target: string };
        const r = unlinkWork(roots, id, unlink.rel, unlink.target);
        result = { item: r.item };
      } else if (body.body !== undefined) {
        const items = loadWorkState(roots);
        const item = items.get(id as any);
        if (!item) {
          res.status(404).json({ error: `Work item not found: ${id}` });
          return;
        }
        commitWorkItem(roots, item, String(body.body));
        result = { item };
      } else if (typeof body.standing === "boolean") {
        result = { item: setStanding(roots, id, body.standing).item };
      } else if (body.schedule !== undefined) {
        // body.schedule: { scheduledFor: string | null, durationMinutes?: number | null }
        // Pass scheduledFor=null to unschedule.
        const s = body.schedule as { scheduledFor: string | null; durationMinutes?: number | null };
        const r = scheduleWork(roots, id, {
          scheduledFor: s.scheduledFor === null || s.scheduledFor === "" ? null : String(s.scheduledFor),
          durationMinutes: s.durationMinutes == null ? undefined : Number(s.durationMinutes),
        });
        result = { item: r.item };
      } else {
        res.status(400).json({ error: "No recognized update field. Use: stage, note, title, successCriteria, assignee, moveTo, link, unlink, schedule, standing" });
        return;
      }

      res.json(result);
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  // ── Delete work item (with cascade) ───────────────────────────────────
  router.delete("/:id", (req: Request, res: Response) => {
    try {
      const result = deleteWork(roots, req.params.id);
      res.json({ deleted: result.items.map((i) => i.id) });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  // ── Graduate work item ─ marks graduated=now on the authoritative ledger. ──
  router.post("/:id/graduate", (req: Request, res: Response) => {
    try {
      const r = graduateWork(roots, req.params.id);
      res.json({ item: r.item });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  return router;
}
