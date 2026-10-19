/**
 * Work API routes — shared task/work item management.
 *
 * All wolves hit these routes over Tailscale. Storage:
 *   - Event ledger: /var/wolfpack/kb/work-events.jsonl
 *   - Materialized .md: /var/wolfpack/kb/base/domains/<domain>/work/<id>.md
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
  setCriteria,
  assignWork,
  loadWorkState,
  commitWorkItem,
  type CreateWorkInput,
  type WorkQuery,
} from "@wolfpack/kb/client";
import type { KbRoots } from "@wolfpack/kb/shared";

const KB_BASE = process.env.KB_BASE ?? "/var/wolfpack/kb/base";
const WORK_LEDGER_DIR = process.env.WORK_LEDGER_DIR ?? "/var/wolfpack/kb/work";

function makeRoots(): KbRoots {
  return {
    kbBase: KB_BASE,
    opsRoot: "/var/wolfpack/kb/ops",
    denLocal: WORK_LEDGER_DIR,
  };
}

export function workRouter(): Router {
  mkdirSync(`${WORK_LEDGER_DIR}/ledger`, { recursive: true });
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

      const items = queryWork(makeRoots(), query);
      res.json({ items });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Get single item ───────────────────────────────────────────────────
  router.get("/:id", (req: Request, res: Response) => {
    try {
      const roots = makeRoots();
      const items = loadWorkState(roots);
      const item = items.get(req.params.id as any);
      if (!item) {
        res.status(404).json({ error: `Work item not found: ${req.params.id}` });
        return;
      }
      res.json({ item });
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
      const result = createWork(makeRoots(), body);
      res.status(201).json({ id: result.id, item: result.item });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  // ── Update work item (multipurpose PATCH) ─────────────────────────────
  router.patch("/:id", (req: Request, res: Response) => {
    try {
      const roots = makeRoots();
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
      } else {
        res.status(400).json({ error: "No recognized update field. Use: stage, note, title, successCriteria, assignee, moveTo, link, unlink" });
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
      const result = deleteWork(makeRoots(), req.params.id);
      res.json({ deleted: result.items.map((i) => i.id) });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  return router;
}
