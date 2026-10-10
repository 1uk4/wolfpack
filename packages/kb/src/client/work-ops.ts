/**
 * work-ops — pure operations for the Factory work layer.
 *
 * Each op produces WorkEvent(s) and optionally materializes the .md file.
 * The caller appends events to the ledger and commits files — these functions
 * are side-effect-free building blocks.
 */
import { type KbRoots, workDir } from "../shared/index.js";
import { workId, now } from "../shared/ids.js";
import {
  type WorkItem,
  type WorkEvent,
  type WorkId,
  type WolfId,
  type LinkRel,
  foldWork,
  assertAdvanceable,
} from "../schema/work.js";
import { type DomainId, type Slug, type IsoDate } from "../schema/knowledge.js";
import { Stage } from "@wolfpack/engine";
import {
  appendWorkLedger,
  commitWorkItem,
  deleteWorkItemFile,
  loadWorkState,
  readWorkLedger,
  resolveWorkItem,
} from "./work-store.js";

// ── create ──────────────────────────────────────────────────────────────────

export interface CreateWorkInput {
  kind: WorkItem["kind"];
  domain: string;
  title: string;
  assignee: string;
  area?: string | null;
  partOf?: string | null;
  successCriteria?: string | null;
  stage?: WorkItem["stage"];
}

export interface CreateWorkResult {
  id: WorkId;
  event: WorkEvent;
  item: WorkItem;
}

function slugifyArea(s: string | null | undefined): Slug | null {
  if (!s) return null;
  const slug = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug ? (slug as unknown as Slug) : null;
}

export function createWork(roots: KbRoots, input: CreateWorkInput): CreateWorkResult {
  const id = workId(input.domain) as WorkId;
  const event: WorkEvent = {
    type: "work.created",
    id,
    at: now(),
    kind: input.kind as WorkItem["kind"],
    domain: input.domain as DomainId,
    title: input.title,
    assignee: input.assignee as WolfId,
    area: slugifyArea(input.area),
    // Blank means "no parent" — "" would fail WorkId validation.
    partOf: (input.partOf?.trim() || null) as WorkId | null,
    successCriteria: input.successCriteria ?? null,
    stage: (input.stage ?? "plan") as WorkItem["stage"],
  };

  appendWorkLedger(roots, [event]);
  const items = loadWorkState(roots);
  const item = items.get(id);
  if (!item) throw new Error(`Failed to create work item ${id} — event did not fold`);
  commitWorkItem(roots, item);
  return { id, event, item };
}

// ── stage ───────────────────────────────────────────────────────────────────

export function stageWork(
  roots: KbRoots,
  id: string,
  to: string,
): { event: WorkEvent | null; item: WorkItem } {
  const items = loadWorkState(roots);
  const item = items.get(id as WorkId);
  if (!item) throw new Error(`work item ${id} not found`);
  // Already there: record nothing (no duplicate transition events).
  if (item.stage === to) return { event: null, item };

  const err = assertAdvanceable(item, to as WorkItem["stage"]);
  if (err) throw new Error(err);

  const event: WorkEvent = {
    type: "work.staged",
    id: id as WorkId,
    at: now(),
    to: to as WorkItem["stage"],
  };

  appendWorkLedger(roots, [event]);
  const updated = loadWorkState(roots).get(id as WorkId)!;
  commitWorkItem(roots, updated, resolveWorkItem(roots, item.domain as string, id)?.body);
  return { event, item: updated };
}

// ── assign ──────────────────────────────────────────────────────────────────

export function assignWork(
  roots: KbRoots,
  id: string,
  assignee: string,
): { event: WorkEvent; item: WorkItem } {
  const items = loadWorkState(roots);
  const item = items.get(id as WorkId);
  if (!item) throw new Error(`work item ${id} not found`);

  const event: WorkEvent = {
    type: "work.assigned",
    id: id as WorkId,
    at: now(),
    assignee: assignee as WolfId,
  };

  appendWorkLedger(roots, [event]);
  const updated = loadWorkState(roots).get(id as WorkId)!;
  commitWorkItem(roots, updated, resolveWorkItem(roots, item.domain as string, id)?.body);
  return { event, item: updated };
}

// ── note ────────────────────────────────────────────────────────────────────

export function noteWork(
  roots: KbRoots,
  id: string,
  text: string,
): { event: WorkEvent; item: WorkItem } {
  const items = loadWorkState(roots);
  const item = items.get(id as WorkId);
  if (!item) throw new Error(`work item ${id} not found`);

  const event: WorkEvent = {
    type: "work.noted",
    id: id as WorkId,
    at: now(),
    text,
  };

  appendWorkLedger(roots, [event]);
  const updated = loadWorkState(roots).get(id as WorkId)!;
  commitWorkItem(roots, updated, resolveWorkItem(roots, item.domain as string, id)?.body);
  return { event, item: updated };
}

// ── link ────────────────────────────────────────────────────────────────────

export function linkWork(
  roots: KbRoots,
  id: string,
  rel: string,
  target: string,
): { event: WorkEvent; item: WorkItem } {
  const items = loadWorkState(roots);
  const item = items.get(id as WorkId);
  if (!item) throw new Error(`work item ${id} not found`);

  const event: WorkEvent = {
    type: "work.linked",
    id: id as WorkId,
    at: now(),
    rel: rel as LinkRel,
    target,
  };

  appendWorkLedger(roots, [event]);
  const updated = loadWorkState(roots).get(id as WorkId)!;
  commitWorkItem(roots, updated, resolveWorkItem(roots, item.domain as string, id)?.body);
  return { event, item: updated };
}

// ── update criteria ─────────────────────────────────────────────────────────

export function setCriteria(
  roots: KbRoots,
  id: string,
  successCriteria: string,
): { event: WorkEvent; item: WorkItem } {
  const items = loadWorkState(roots);
  const item = items.get(id as WorkId);
  if (!item) throw new Error(`work item ${id} not found`);

  const event: WorkEvent = {
    type: "work.criteria",
    id: id as WorkId,
    at: now(),
    successCriteria,
  };

  appendWorkLedger(roots, [event]);
  const updated = loadWorkState(roots).get(id as WorkId)!;
  commitWorkItem(roots, updated, resolveWorkItem(roots, item.domain as string, id)?.body);
  return { event, item: updated };
}

// ── retitle ─────────────────────────────────────────────────────────────────

export function retitleWork(
  roots: KbRoots,
  id: string,
  title: string,
): { event: WorkEvent; item: WorkItem } {
  const items = loadWorkState(roots);
  const item = items.get(id as WorkId);
  if (!item) throw new Error(`work item ${id} not found`);

  const event: WorkEvent = {
    type: "work.retitled",
    id: id as WorkId,
    at: now(),
    title,
  };

  appendWorkLedger(roots, [event]);
  const updated = loadWorkState(roots).get(id as WorkId)!;
  commitWorkItem(roots, updated, resolveWorkItem(roots, item.domain as string, id)?.body);
  return { event, item: updated };
}

// ── delete ─────────────────────────────────────────────────────────────────

export interface DeleteWorkResult {
  events: WorkEvent[];
  items: WorkItem[];
}

export function deleteWork(roots: KbRoots, id: string): DeleteWorkResult {
  const items = loadWorkState(roots);
  const root = items.get(id as WorkId);
  if (!root) throw new Error(`work item ${id} not found`);

  const toDelete: WorkItem[] = [];
  const seen = new Set<WorkId>();
  const collect = (item: WorkItem) => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    toDelete.push(item);
    for (const child of items.values()) {
      if (child.partOf === item.id) collect(child);
    }
  };
  collect(root);

  const at = now();
  const events: WorkEvent[] = toDelete.map((item) => ({
    type: "work.deleted",
    id: item.id,
    at,
  }));

  appendWorkLedger(roots, events);
  for (const item of toDelete) deleteWorkItemFile(roots, item);
  return { events, items: toDelete };
}

// ── list / query ────────────────────────────────────────────────────────────

export interface WorkQuery {
  domain?: string;
  assignee?: string;
  area?: string;
  stage?: string;
  kind?: string;
  partOf?: string;
}

export function queryWork(roots: KbRoots, query: WorkQuery = {}): WorkItem[] {
  const items = Array.from(loadWorkState(roots).values());
  return items.filter((item) => {
    if (query.domain && item.domain !== query.domain) return false;
    if (query.assignee && item.assignee !== query.assignee) return false;
    if (query.area && item.area !== query.area) return false;
    if (query.stage && item.stage !== query.stage) return false;
    if (query.kind && item.kind !== query.kind) return false;
    if (query.partOf && item.partOf !== query.partOf) return false;
    return true;
  });
}

export function getWorkTree(roots: KbRoots, rootId: string): WorkItem[] {
  const all = loadWorkState(roots);
  const result: WorkItem[] = [];
  const collect = (id: WorkId) => {
    const item = all.get(id);
    if (!item) return;
    result.push(item);
    for (const [childId, child] of all) {
      if (child.partOf === id) collect(childId);
    }
  };
  collect(rootId as WorkId);
  return result;
}
