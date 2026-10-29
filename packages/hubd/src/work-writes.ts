/**
 * Work writes for hubd, ported from the agent Work API router (packages/agent/src/routes/work.ts) onto the kb work-ops, in-process.
 *
 * - A PATCH request is normalised into a list of ops (`normalisePatch`) and applied by ONE function (`applyOps`) that the server
 *   runs under the write queue; batch PATCH can feed the same function a longer list.
 * - The write queue serialises every mutation in this process (hubd also holds the work-writer lock across processes).
 * - Guard failures thrown by work-ops are mapped to protocol error codes (`mapWorkError`); messages carry no absolute paths.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import {
  assignWork,
  commitWorkItem,
  createWork,
  deleteWork,
  graduateWork,
  linkWork,
  loadWorkState,
  moveWork,
  noteWork,
  retitleWork,
  scheduleWork,
  setCriteria,
  setStanding,
  stageWork,
  unlinkWork,
  type CreateWorkInput,
} from "@wolfpack/kb/client";
import { workLedgerFile, type KbRoots } from "@wolfpack/kb/shared";
import { HubError } from "./errors.js";
import type { CreateWorkRequest, PatchWorkRequest } from "@wolfpack/protocol";

/** One ledger line appended by a write, as parsed JSON (the WorkEvent shape; opaque here). */
export type LedgerEvent = Record<string, unknown> & { type: string; id: string };

export type WorkOp =
  | { op: "stage"; to: string }
  | { op: "note"; text: string }
  | { op: "title"; title: string }
  | { op: "successCriteria"; text: string }
  | { op: "assign"; to: string }
  | { op: "moveTo"; partOf: string | null }
  | { op: "link"; rel: string; target: string }
  | { op: "unlink"; rel: string; target: string }
  | { op: "body"; text: string }
  | { op: "standing"; value: boolean }
  | { op: "schedule"; scheduledFor: string | null; durationMinutes?: number };

/** Ops only an operator may issue (PROVISIONAL: ticket 4 owns the final owner-only rules). */
export function isOwnerOnlyOp(op: WorkOp): boolean {
  return op.op === "body" || op.op === "assign";
}

export { HubError as WorkWriteError };

/** PATCH body -> ops. Exactly one field per request for now (the agent route silently took the first it saw). */
export function normalisePatch(b: PatchWorkRequest): WorkOp[] {
  const ops: WorkOp[] = [];
  const nonEmpty = (name: string, v: string): string => {
    if (!v.trim()) throw new HubError("invalid_request", `${name} must not be empty`);
    return v;
  };
  if (b.stage !== undefined) ops.push({ op: "stage", to: nonEmpty("stage", b.stage) });
  if (b.note !== undefined) ops.push({ op: "note", text: nonEmpty("note", b.note) });
  if (b.title !== undefined) ops.push({ op: "title", title: nonEmpty("title", b.title) });
  if (b.successCriteria !== undefined) ops.push({ op: "successCriteria", text: b.successCriteria });
  if (b.assignee !== undefined) ops.push({ op: "assign", to: nonEmpty("assignee", b.assignee) });
  if (b.moveTo !== undefined) ops.push({ op: "moveTo", partOf: b.moveTo });
  if (b.link !== undefined) ops.push({ op: "link", rel: b.link.rel, target: b.link.target });
  if (b.unlink !== undefined) ops.push({ op: "unlink", rel: b.unlink.rel, target: b.unlink.target });
  if (b.body !== undefined) ops.push({ op: "body", text: b.body });
  if (b.standing !== undefined) ops.push({ op: "standing", value: b.standing });
  if (b.schedule !== undefined) {
    const s = b.schedule;
    ops.push({
      op: "schedule",
      scheduledFor: s.scheduledFor === null || s.scheduledFor === "" ? null : s.scheduledFor,
      durationMinutes: s.durationMinutes == null ? undefined : s.durationMinutes,
    });
  }
  if (ops.length === 0) {
    throw new HubError("invalid_request", "no recognized update field. Use: stage, note, title, successCriteria, assignee, moveTo, link, unlink, body, schedule, standing");
  }
  if (ops.length > 1) throw new HubError("invalid_request", "one field per PATCH request");
  return ops;
}

type Item = ReturnType<typeof loadWorkState> extends Map<unknown, infer V> ? V : never;

/** Apply ops in order to one item. MUST be called inside the write queue. Returns the item as last written. */
export function applyOps(roots: KbRoots, id: string, ops: WorkOp[]): Item {
  let item: Item | undefined;
  for (const o of ops) {
    switch (o.op) {
      case "stage": item = stageWork(roots, id, o.to).item; break;
      case "note": item = noteWork(roots, id, o.text).item; break;
      case "title": item = retitleWork(roots, id, o.title).item; break;
      case "successCriteria": item = setCriteria(roots, id, o.text).item; break;
      case "assign": item = assignWork(roots, id, o.to).item; break;
      case "moveTo": item = moveWork(roots, id, o.partOf).item; break;
      case "link": item = linkWork(roots, id, o.rel, o.target).item; break;
      case "unlink": item = unlinkWork(roots, id, o.rel, o.target).item; break;
      case "standing": item = setStanding(roots, id, o.value).item; break;
      case "schedule": item = scheduleWork(roots, id, { scheduledFor: o.scheduledFor, durationMinutes: o.durationMinutes }).item; break;
      case "body": {
        const cur = loadWorkState(roots).get(id as never);
        if (!cur) throw new Error(`work item ${id} not found`);
        commitWorkItem(roots, cur, o.text);
        item = cur;
        break;
      }
    }
  }
  if (!item) throw new Error(`work item ${id} not found`);
  return item;
}

export function createItem(roots: KbRoots, req: CreateWorkRequest) {
  const r = createWork(roots, req as unknown as CreateWorkInput);
  return { id: r.id as string, item: r.item };
}
export function deleteItem(roots: KbRoots, id: string): string[] {
  return deleteWork(roots, id).items.map((i) => i.id as string);
}
/** Graduation = the agent route's behaviour: mark the item graduated on the ledger. There is no LLM/distill step in that route. */
export function graduateItem(roots: KbRoots, id: string) {
  return graduateWork(roots, id).item;
}

/** Map a work-ops failure to a protocol error. Unknown shapes (fs errors, bugs) become `engine_error` with a generic message. */
export function mapWorkError(e: unknown): HubError {
  if (e instanceof HubError) return e;
  if (!(e instanceof Error) || typeof (e as NodeJS.ErrnoException).code === "string") return new HubError("engine_error", "internal hub error");
  const m = e.message;
  if (/^work item \S+ not found$/.test(m)) return new HubError("not_found", m);
  if (/needs a success_criteria before advancing|never ships/.test(m)) return new HubError("not_ready", m);
  return new HubError("invalid_request", m);
}

/** Serialises async/sync critical sections in this process, in arrival order; a failed section does not poison the queue. */
export class WriteQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => T | Promise<T>): Promise<T> {
    const p = this.tail.then(fn, fn);
    this.tail = p.catch(() => undefined);
    return p;
  }
}

/** Ledger bytes appended since `offset`, parsed. Lines that are not JSON objects are skipped. */
export function readLedgerSince(roots: KbRoots, offset: number): { events: LedgerEvent[]; end: number } {
  const file = workLedgerFile(roots);
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    return { events: [], end: 0 };
  }
  if (size <= offset) return { events: [], end: size };
  const buf = Buffer.alloc(size - offset);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buf, 0, buf.length, offset);
  } finally {
    closeSync(fd);
  }
  const events: LedgerEvent[] = [];
  for (const line of buf.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o && typeof o === "object") events.push(o as LedgerEvent);
    } catch {
      /* ignore */
    }
  }
  return { events, end: size };
}

export function ledgerSize(roots: KbRoots): number {
  try {
    return statSync(workLedgerFile(roots)).size;
  } catch {
    return 0;
  }
}
