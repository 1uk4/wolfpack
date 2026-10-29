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
import type { Actor, CreateWorkRequest, ErrorCode, PatchWorkRequest } from "@wolfpack/protocol";

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

type Item = ReturnType<typeof createWork>["item"];

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
  // The schema validates `kind` as an enum; `stage` is a free string here and is validated by the ledger event schema.
  const r = createWork(roots, req as CreateWorkInput);
  return { id: r.id as string, item: r.item };
}
export function deleteItem(roots: KbRoots, id: string): string[] {
  return deleteWork(roots, id).items.map((i) => i.id as string);
}
/** Graduation = the agent route's behaviour: mark the item graduated on the ledger. There is no LLM/distill step in that route. */
export function graduateItem(roots: KbRoots, id: string) {
  return graduateWork(roots, id).item;
}

/**
 * The whitelist of kb work-ops guard messages hubd maps to protocol codes. Every pattern is anchored. Anything unmatched is an
 * `engine_error` with a generic message (detail logged server-side). kb work-ops error types are deliberately NOT changed (sfo-01
 * runs that code), so a reworded guard message fails the per-message tests in hubd.writes.test.ts instead of silently degrading.
 */
export const GUARD_MESSAGES: readonly { name: string; re: RegExp; code: ErrorCode }[] = [
  { name: "not found", re: /^work item \S+ not found$/, code: "not_found" },
  { name: "unknown parent", re: /^parent work item \S+ not found$/, code: "invalid_request" },
  { name: "placement (create/move)", re: /^Cannot (?:create|move) "[\s\S]*": [\s\S]+$/, code: "invalid_request" },
  { name: "container cannot be moved", re: /^[\s\S]+ is a holding container and cannot be moved$/, code: "invalid_request" },
  { name: "own parent", re: /^an item cannot be its own parent$/, code: "invalid_request" },
  { name: "standing (non-initiative)", re: /^[\s\S]+ is an? \w+; only an initiative can be standing$/, code: "invalid_request" },
  { name: "dependency scope/cycle", re: /^Cannot add dependency: [\s\S]+$/, code: "invalid_request" },
  { name: "unsupported link rel", re: /^work items only link to each other \([\s\S]*\); "[\s\S]*" is not supported$/, code: "invalid_request" },
  { name: "invalid event", re: /^Invalid work\.[a-z]+ event for \S+ \u2014 [\s\S]+$/, code: "invalid_request" },
  { name: "not advanceable (criteria)", re: /^task \S+ needs a success_criteria before advancing past "plan"$/, code: "not_ready" },
  { name: "never ships", re: /^[\s\S]+ is a holding container and never ships$/, code: "not_ready" },
];

/** Map a work-ops failure to a protocol error via GUARD_MESSAGES. Everything else is `engine_error` (generic message, detail logged). */
export function mapWorkError(e: unknown): HubError {
  if (e instanceof HubError) return e;
  const m = e instanceof Error && typeof (e as NodeJS.ErrnoException).code !== "string" ? e.message : undefined;
  const hit = m === undefined ? undefined : GUARD_MESSAGES.find((g) => g.re.test(m));
  if (hit) return new HubError(hit.code, m!);
  console.error("hubd: unmapped work write failure:", e);
  return new HubError("engine_error", "internal hub error");
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

export interface WorkWriterOptions {
  roots: KbRoots;
  /** Releases the cross-process writer lock; called once, after the last queued write. */
  release: () => void;
  /** TEST SEAM: awaited inside the queue before each write runs (lets a test hold a write in flight). */
  gate?: () => Promise<void> | void;
}

export type WorkAppendedListener = (batch: { actor: Actor; events: LedgerEvent[] }) => void;

/**
 * The one entry for work mutations: serialises them in the in-process queue and fires the post-append hook.
 *
 * Close protocol: `close()` sets `closing` (new writes get a retryable `busy` error), queued writes drain, THEN the lock is
 * released. No write can run after release: admission is checked synchronously at enqueue time and the release is itself queued.
 */
export function createWorkWriter(opts: WorkWriterOptions) {
  const { roots } = opts;
  const queue = new WriteQueue();
  const listeners = new Set<WorkAppendedListener>();
  let closing = false;
  let released = false;

  const write = <T>(actor: Actor, fn: () => T): Promise<T> => {
    if (closing) return Promise.reject(new HubError("busy", "hub is shutting down; retry against the restarted hub"));
    return queue.run(async () => {
      if (released) throw new HubError("busy", "hub is shut down");
      await opts.gate?.();
      let before: number | undefined;
      try {
        before = ledgerSize(roots);
      } catch (e) {
        console.error("hubd: ledger size probe failed:", e);
      }
      let result: T | undefined;
      let failure: HubError | undefined;
      try {
        result = fn();
      } catch (e) {
        failure = mapWorkError(e);
      }
      // The hook diff must never mask the write's own result or error. It also runs when the op threw after appending.
      // INVARIANT: hubd is the SOLE writer of the ledger (writer lock + this queue), so every byte appended between `before` and
      // now belongs to this write; with any other writer the diff would misattribute their events to this actor.
      if (before !== undefined) {
        try {
          const { events } = readLedgerSince(roots, before);
          if (events.length > 0) {
            for (const l of listeners) {
              try {
                l({ actor, events });
              } catch (e) {
                console.error("hubd: work listener failed:", e);
              }
            }
          }
        } catch (e) {
          console.error("hubd: post-append hook failed:", e);
        }
      }
      if (failure) throw failure;
      return result as T;
    });
  };

  return {
    write,
    onAppended(l: WorkAppendedListener): () => void {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    /** Stop admitting writes, drain the queue, release the lock. Idempotent. */
    close(): Promise<void> {
      closing = true;
      return queue.run(() => {
        if (released) return;
        released = true;
        opts.release();
      });
    },
    get closing(): boolean {
      return closing;
    },
  };
}
