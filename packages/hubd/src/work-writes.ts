/**
 * Work writes for hubd, ported from the agent Work API router (packages/agent/src/routes/work.ts) onto the kb work-ops, in-process.
 *
 * - A PATCH request is normalised into a list of ops (`normalisePatch`) and applied by ONE function (`applyOps`) that the server
 *   runs under the write queue; batch PATCH can feed the same function a longer list.
 * - The write queue serialises every mutation in this process (hubd also holds the work-writer lock across processes).
 * - Guard failures thrown by work-ops are mapped to protocol error codes (`mapWorkError`); messages carry no absolute paths.
 */
import { closeSync, openSync, readSync, statSync, truncateSync } from "node:fs";
import {
  appendWorkLedger,
  assignWork,
  commitWorkItem,
  createWork,
  deleteWork,
  graduateWork,
  linkWork,
  loadWorkState,
  moveWork,
  resolveWorkItem,
  noteWork,
  retitleWork,
  scheduleWork,
  setCriteria,
  setStanding,
  stageWork,
  unlinkWork,
  isBindable,
  resolveWorkItem,
  type CreateWorkInput,
  WolfIdSchema,
  type WolfId,
  type WorkEvent,
  type WorkId,
} from "@wolfpack/kb/client";
import { now, workLedgerFile, type KbRoots } from "@wolfpack/kb/shared";
import { HubError } from "./errors.js";
import type { Actor, CreateWorkRequest, ErrorCode, PatchWorkOp, PatchWorkRequest } from "@wolfpack/protocol";

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
  | { op: "section"; name: SectionName; text: string }
  | { op: "standing"; value: boolean }
  | { op: "schedule"; scheduledFor: string | null; durationMinutes?: number };

export type SectionName = "plan" | "notes";
const SECTION_HEADING: Record<SectionName, string> = { plan: "## Plan", notes: "## Notes" };

/** Ops only an operator may issue: whole-body replace and direct assignee writes. A non-operator gets 403 `forbidden`. */
export function isOwnerOnlyOp(op: WorkOp): boolean {
  return op.op === "body" || op.op === "assign";
}

/** Replace one `## <Heading>` section of a body (up to the next level-2 heading). A missing section is added (Plan before Notes). */
export function replaceSection(body: string, name: SectionName, text: string): string {
  const heading = SECTION_HEADING[name];
  const lines = body.split("\n");
  const start = lines.findIndex((l) => l.trimEnd() === heading);
  const block = [heading, "", ...(text.trim() ? [text.trim(), ""] : [])];
  if (start >= 0) {
    let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
    if (end < 0) end = lines.length;
    return [...lines.slice(0, start), ...block, ...lines.slice(end)].join("\n").trim() + "\n";
  }
  const notes = name === "plan" ? lines.findIndex((l) => l.trimEnd() === SECTION_HEADING.notes) : -1;
  if (notes >= 0) return [...lines.slice(0, notes), ...block, ...lines.slice(notes)].join("\n").trim() + "\n";
  return [body.trim(), "", ...block].join("\n").trim() + "\n";
}


/** PATCH body -> ops. A single-op body has exactly one field; a batch is `{ ops: [...] }`, each element a single-field op. */
export function normalisePatch(b: PatchWorkRequest): WorkOp[] {
  if ("ops" in b && Array.isArray((b as { ops?: unknown }).ops)) return (b as { ops: PatchWorkOp[] }).ops.flatMap(normaliseOne);
  return normaliseOne(b as PatchWorkOp);
}

function normaliseOne(b: PatchWorkOp): WorkOp[] {
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
  if (b.section !== undefined) {
    const name = b.section.name.trim().toLowerCase();
    if (name !== "plan" && name !== "notes") {
      throw new HubError("invalid_request", `section must be "plan" or "notes" (the Record is generated from the ledger and cannot be edited)`);
    }
    // A heading inside the text would restructure the body (and could forge a Record/Log section).
    if (/^#{1,2}[ \t]/m.test(b.section.text)) {
      throw new HubError("invalid_request", "section text must not contain level-1 or level-2 headings");
    }
    ops.push({ op: "section", name, text: b.section.text });
  }
  if (b.schedule !== undefined) {
    const s = b.schedule;
    ops.push({
      op: "schedule",
      scheduledFor: s.scheduledFor === null || s.scheduledFor === "" ? null : s.scheduledFor,
      durationMinutes: s.durationMinutes == null ? undefined : s.durationMinutes,
    });
  }
  if (ops.length === 0) {
    throw new HubError("invalid_request", "no recognized update field. Use: stage, note, title, successCriteria, assignee, moveTo, link, unlink, body, section, schedule, standing");
  }
  if (ops.length > 1) throw new HubError("invalid_request", "one field per op");
  return ops;
}

type Item = ReturnType<typeof createWork>["item"];

/**
 * Apply ops in order to one item, ALL-OR-NOTHING. MUST be called inside the write queue (hubd is the sole ledger writer).
 * The kb work-ops append per op, so atomicity is a rollback: note the ledger size and the item's body, and if any op throws,
 * truncate the ledger back and re-materialise the touched items' files. A rolled-back batch leaves the ledger byte-identical.
 */
export function applyOps(roots: KbRoots, id: string, ops: WorkOp[]): Item {
  const before = ledgerSize(roots);
  const cur0 = loadWorkState(roots).get(id as never);
  const body0 = cur0 ? resolveWorkItem(roots, cur0.domain as string, id)?.body : undefined;
  try {
    return applyOpsUnchecked(roots, id, ops);
  } catch (e) {
    try {
      const touched = new Set<string>([id]);
      for (const ev of readLedgerSince(roots, before).events) touched.add(ev.id);
      truncateSync(workLedgerFile(roots), before);
      const state = loadWorkState(roots);
      for (const t of touched) {
        const it = state.get(t as never);
        if (!it) continue;
        const body = t === id ? body0 : resolveWorkItem(roots, it.domain as string, t)?.body;
        commitWorkItem(roots, it, body);
      }
    } catch (re) {
      console.error("hubd: batch rollback failed:", re);
    }
    throw e;
  }
}

function applyOpsUnchecked(roots: KbRoots, id: string, ops: WorkOp[]): Item {
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
      case "section": {
        const cur = loadWorkState(roots).get(id as never);
        if (!cur) throw new Error(`work item ${id} not found`);
        const body = resolveWorkItem(roots, cur.domain as string, id)?.body ?? "";
        commitWorkItem(roots, cur, replaceSection(body, o.name, o.text));
        item = cur;
        break;
      }
    }
  }
  if (!item) throw new Error(`work item ${id} not found`);
  return item;
}

const conflict = (id: string, holder: string, why: string) =>
  new HubError("conflict", `${why}: ${id} is held by ${holder}`, { holder });

/** The actor id as a typed WolfId, or 400 `invalid_request`. Call BEFORE entering the write queue. */
export function parseWolfId(actor: Actor): WolfId {
  const r = WolfIdSchema.safeParse(actor.id);
  if (!r.success) throw new HubError("invalid_request", "the actor id is not a valid wolf id (lower-case letters, digits, hyphens)");
  return r.data;
}

/** Re-render the .md from the folded state. The ledger is the truth: if the file cannot be resolved, skip and log. */
function commitFolded(roots: KbRoots, item: Item): void {
  const resolved = resolveWorkItem(roots, item.domain as string, item.id as string);
  if (!resolved) {
    console.error(`hubd: no work file for ${item.id}; skipped the .md commit (ledger is the truth)`);
    return;
  }
  commitWorkItem(roots, item, resolved.body);
}

const CLAIMABLE_STAGES: readonly string[] = ["approved", "in_build"];

/**
 * Claim: compare-and-set. MUST run inside the write queue (the check and the append are then atomic w.r.t. other hub writes).
 * Holder = the folded `boundBy`. Succeeds when unheld or already held by `wolf`. Inheritance both ways: a child of a feature held by
 * another wolf is refused, and so is a feature while another wolf holds one of its children.
 * Appends work.assigned + work.bound (+ work.staged approved -> in_build) in ONE ledger append.
 * LEGACY: a work.bound already in an old ledger with no matching work.unbound reads as held (last writer wins); an operator clears it
 * with unclaim.
 */
export function claimItem(roots: KbRoots, id: string, wolf: WolfId): Item {
  const items = loadWorkState(roots);
  const item = items.get(id as WorkId);
  if (!item) throw new HubError("not_found", `work item ${id} not found`);
  if (item.container) throw new HubError("invalid_request", "a holding container cannot be claimed");
  if (item.kind !== "feature" && !isBindable(item)) throw new HubError("invalid_request", `a ${item.kind} cannot be claimed (features, tasks, issues and spikes only)`);
  if (item.graduated) throw new HubError("invalid_request", `${id} is graduated`);
  if (!CLAIMABLE_STAGES.includes(item.stage)) throw new HubError("invalid_request", `${id} is in stage ${item.stage}; only approved or in_build items can be claimed`);
  if (item.boundBy && item.boundBy !== wolf) throw conflict(id, item.boundBy, "already claimed");
  const parent = item.partOf ? items.get(item.partOf) : undefined;
  if (parent && parent.kind === "feature" && parent.boundBy && parent.boundBy !== wolf) {
    throw conflict(id, parent.boundBy, `its feature ${parent.id} is claimed`);
  }
  if (item.kind === "feature") {
    for (const c of items.values()) {
      if (c.partOf === item.id && c.boundBy && c.boundBy !== wolf) throw conflict(id, c.boundBy, `its task ${c.id} is claimed`);
    }
  }
  const at = now();
  const events: WorkEvent[] = [];
  if (item.assignee !== wolf) events.push({ type: "work.assigned", id: item.id, at, assignee: wolf });
  if (item.boundBy !== wolf) events.push({ type: "work.bound", id: item.id, at, wolf });
  if (item.stage === "approved") events.push({ type: "work.staged", id: item.id, at, to: "in_build" });
  if (events.length === 0) return item;
  appendWorkLedger(roots, events);
  const updated = loadWorkState(roots).get(item.id)!;
  commitFolded(roots, updated);
  return updated;
}

/** Unclaim: the holder or an operator appends work.unbound; the stage and assignee stay. Inside the write queue. */
export function unclaimItem(roots: KbRoots, id: string, actor: Actor): Item {
  const item = loadWorkState(roots).get(id as WorkId);
  if (!item) throw new HubError("not_found", `work item ${id} not found`);
  if (!item.boundBy) return item;
  if (actor.kind !== "operator" && actor.id !== item.boundBy) throw conflict(id, item.boundBy, "only the holder or the owner can release");
  appendWorkLedger(roots, [{ type: "work.unbound", id: item.id, at: now(), wolf: item.boundBy }]);
  const updated = loadWorkState(roots).get(item.id)!;
  commitFolded(roots, updated);
  return updated;
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
  } catch (e) {
    // A missing ledger is empty; any other failure is surfaced (the caller must not mistake it for "nothing appended").
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { events: [], end: 0 };
    throw e;
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

/** Current ledger size; a missing ledger is 0. Any other stat failure (EACCES, EIO, ...) throws, so the hook skips its diff. */
export function ledgerSize(roots: KbRoots): number {
  try {
    return statSync(workLedgerFile(roots)).size;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw e;
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
  const failedListeners = new Set<() => void>();
  // The diff could not be taken (probe or read failed): events may have been appended unseen. Tell subscribers.
  const appendFailed = () => {
    for (const l of failedListeners) {
      try {
        l();
      } catch (e) {
        console.error("hubd: append-failed listener failed:", e);
      }
    }
  };
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
      const probeFailed = before === undefined;
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
          appendFailed();
        }
      } else if (probeFailed) appendFailed();
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
    /** Fired when a write's ledger diff could not be taken, so appended events may have gone unannounced. Returns an unsubscribe. */
    onAppendFailed(l: () => void): () => void {
      failedListeners.add(l);
      return () => void failedListeners.delete(l);
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
