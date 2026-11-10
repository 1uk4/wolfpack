/**
 * Work writes for hubd, ported from the agent Work API router (packages/agent/src/routes/work.ts) onto the kb work-ops, in-process.
 *
 * - A PATCH request (one op, or a batch `{ops:[...]}`) is normalised into a list of ops (`normalisePatch`) and applied by ONE
 *   function (`applyOps`) that the server runs under the write queue. A batch is all-or-nothing: it is staged in a scratch copy and
 *   only appended to the real ledger (one appendFileSync) when every op succeeded.
 * - `body` and `section` ops append NO ledger event (they rewrite the .md body only), so they neither bump `updated` nor fire a
 *   work.changed event. Known gap, tracked as a follow-up; no new event type is added here.
 * - The write queue serialises every mutation in this process (hubd also holds the work-writer lock across processes).
 * - Guard failures thrown by work-ops are mapped to protocol error codes (`mapWorkError`); messages carry no absolute paths.
 */
import { appendFileSync, closeSync, cpSync, writeFileSync, unlinkSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readSync, readFileSync, rmSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, relative, isAbsolute } from "node:path";
import {
  appendWorkLedger,
  withLedgerAttribution,
  type LedgerAttribution,
  assignWork,
  commitWorkItem,
  createWork,
  deleteWork,
  graduateWork,
  linkWork,
  loadWorkState,
  moveWork,
  noteWork,
  resolveWorkItem,
  retitleWork,
  scheduleWork,
  setCriteria,
  setStanding,
  stageWork,
  unlinkWork,
  isBindable,
  type CreateWorkInput,
  WolfIdSchema,
  type WolfId,
  type WorkEvent,
  type WorkId,
} from "@wolfpack/kb/client";
import {
  now,
  workDir,
  workLedgerFile,
  assertSectionText as assertSectionTextRaw,
  replaceSection as replaceSectionRaw,
  SectionTextError,
  type KbRoots,
  type SectionName,
} from "@wolfpack/kb/shared";
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
  | { op: "recordAppend"; lines: RecordLine[]; group?: string }
  | { op: "schedule"; scheduledFor: string | null; durationMinutes?: number };


export interface RecordLine { at: string; src: string; kind: string; text: string; ids: string[] }
export const RECORD_MAX_LINES = 20;
export const RECORD_MAX_TEXT = 240;
export const RECORD_CAP_TASK = 6000;
export const RECORD_CAP_FEATURE = 4000;
/** The Record is full: 409 `log_full` (typed code in details). */
export const LOG_FULL = "log_full";
export const RECORD_GROUPS = ["Decisions", "Changes", "Findings", "Problems & fixes"] as const;

/** The stored line: `- HH:MM [src·kind] text <!-- src:id1,id2 -->` (HH:MM is the UTC time of `at`). */
function recordLineText(l: RecordLine): string {
  const m = /T(\d\d:\d\d)/.exec(l.at);
  if (!m) throw new HubError("invalid_request", "recordAppend line: at must be an ISO timestamp");
  if (/[\r\n]/.test(l.text) || l.text.length > RECORD_MAX_TEXT) throw new HubError("invalid_request", `recordAppend line: text must be one line of at most ${RECORD_MAX_TEXT} characters`);
  if (l.text.includes("<!--") || l.text.includes("-->")) throw new HubError("invalid_request", "recordAppend line: text must not contain comment markers");
  if (/[\s\]\u00b7<>]/.test(l.src)) throw new HubError("invalid_request", "recordAppend line: src must be a plain label");
  if (l.ids.some((i) => !/^[^\s,<>]+$/.test(i))) throw new HubError("invalid_request", "recordAppend line: ids must be plain tokens");
  assertSectionText(l.text);
  return `- ${m[1]} [${l.src}\u00b7${l.kind}] ${l.text.trim()}${l.ids.length ? ` <!-- src:${l.ids.join(",")} -->` : ""}`;
}

/** The `## Record` section text of a body ("" when absent): from the heading to the next H1/H2. */
function recordSectionText(body: string): string {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const start = lines.findIndex((l) => /^ {0,3}##[ \t]+Record[ \t]*$/.test(l));
  if (start < 0) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^ {0,3}#{1,2}(?:[ \t]|$)/.test(lines[i]!)) { end = i; break; }
  return lines.slice(start + 1, end).join("\n").trim();
}

/**
 * Append lines to the Record of `body` (pure). Skips a line whose ids are all already in the Record. Returns the new body and how many lines
 * were added; throws `log_full` (409) when the Record would pass the cap, `invalid_request` for bad lines or an unknown group.
 */
export function appendRecordLines(body: string, kind: string, lines: RecordLine[], group?: string): { body: string; added: number } {
  if (lines.length > RECORD_MAX_LINES) throw new HubError("invalid_request", `recordAppend takes at most ${RECORD_MAX_LINES} lines per call`);
  if (group !== undefined && !(RECORD_GROUPS as readonly string[]).includes(group)) throw new HubError("invalid_request", `group must be one of ${RECORD_GROUPS.join(", ")}`);
  const stored = lines.map((l) => ({ l, text: recordLineText(l) }));
  let rec = recordSectionText(body);
  const seen = new Set<string>();
  for (const m of rec.matchAll(/<!-- src:([^>]*?) -->/g)) for (const i of m[1]!.split(",")) seen.add(i);
  const fresh: string[] = [];
  for (const { l, text } of stored) {
    if (l.ids.length && l.ids.every((i) => seen.has(i))) continue;
    l.ids.forEach((i) => seen.add(i));
    fresh.push(text);
  }
  if (fresh.length === 0) return { body, added: 0 };
  if (group && kind === "feature") {
    const rl = rec ? rec.split("\n") : [];
    const h = rl.findIndex((x) => x.trim() === `### ${group}`);
    if (h < 0) rl.push(...(rl.length ? [""] : []), `### ${group}`, "", ...fresh);
    else {
      let end = rl.length;
      for (let i = h + 1; i < rl.length; i++) if (/^### /.test(rl[i]!)) { end = i; break; }
      let at = end;
      while (at > h + 1 && rl[at - 1]!.trim() === "") at--;
      rl.splice(at, 0, ...fresh);
    }
    rec = rl.join("\n");
  } else rec = rec ? `${rec}\n${fresh.join("\n")}` : fresh.join("\n");
  const cap = kind === "feature" ? RECORD_CAP_FEATURE : RECORD_CAP_TASK;
  if (rec.length > cap) throw new HubError("invalid_request", `the Record is full (limit ${cap} characters)`, { code: LOG_FULL });
  return { body: replaceSection(body, "record", rec), added: fresh.length };
}

/** The only section name the Record writer sends, matched exactly (case and spacing): the heading `## Record`. */
export const RECORD_SECTION_NAME = "Record";

/** Ops only an operator may issue: whole-body replace and direct assignee writes. A non-operator gets 403 `forbidden`. */
export function isOwnerOnlyOp(op: WorkOp): boolean {
  return op.op === "body" || op.op === "assign";
}
/** The kb section helpers (shared with the sandbox Work API) with their refusals turned into the hub's `invalid_request`. */
const asHubError = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (e) {
    if (e instanceof SectionTextError) throw new HubError("invalid_request", e.message);
    throw e;
  }
};
export const assertSectionText = (text: string): void => asHubError(() => assertSectionTextRaw(text));
export const replaceSection = (body: string, name: SectionName, text: string): string => asHubError(() => replaceSectionRaw(body, name, text));

/** PATCH body -> ops. A single-op body has exactly one field; a batch is `{ ops: [...] }`, each element a single-field op. */
export function normalisePatch(b: PatchWorkRequest): WorkOp[] {
  if ("ops" in b) {
    const ops = b.ops.flatMap(normaliseOne);
    assertNotMixed(ops);
    return ops;
  }
  return normaliseOne(b);
}

function normaliseOne(b: PatchWorkOp): WorkOp[] {
  const ops: WorkOp[] = [];
  const nonEmpty = (name: string, v: string): string => {
    if (!v.trim()) throw new HubError("invalid_request", `${name} must not be empty`);
    return v;
  };
  if (b.op !== undefined || b.lines !== undefined || b.group !== undefined) {
    if (b.op !== "recordAppend" || b.lines === undefined) throw new HubError("invalid_request", "recordAppend needs op: \"recordAppend\" and lines");
    if (Object.keys(b).some((k) => k !== "op" && k !== "lines" && k !== "group")) throw new HubError("invalid_request", "one field per op");
    if (b.lines.length > RECORD_MAX_LINES) throw new HubError("invalid_request", `recordAppend takes at most ${RECORD_MAX_LINES} lines per call`);
    b.lines.forEach(recordLineText); // validate now: a bad line is a 400 before the queue
    return [{ op: "recordAppend", lines: b.lines, group: b.group }];
  }
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
    // The Record is addressed only by its exact name; "plan" / "notes" keep their forgiving match.
    const isRecord = b.section.name === RECORD_SECTION_NAME;
    const lower = b.section.name.trim().toLowerCase();
    const name: SectionName | undefined = isRecord ? "record" : lower === "plan" || lower === "notes" ? lower : undefined;
    if (!name) throw new HubError("invalid_request", `section must be "plan", "notes" or "Record"`);
    assertSectionText(b.section.text); // a heading in the text would restructure the body (or forge the generated Log)
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

/** `body` / `section` ops rewrite the .md only (no ledger event); every other op appends to the ledger. */
export function isContentOp(op: WorkOp): boolean {
  return op.op === "body" || op.op === "section" || op.op === "recordAppend";
}

/**
 * A batch is either all ledger ops (staged, one ledger append) or all content ops (one atomic .md write). Mixing them could lose
 * the content edit if the process died after the ledger append, so it is refused outright.
 */
function assertNotMixed(ops: WorkOp[]): void {
  if (ops.length > 1 && ops.some(isContentOp) && ops.some((o) => !isContentOp(o))) {
    throw new HubError("invalid_request", "section/body ops can't be combined with ledger ops in one batch; send them separately");
  }
}

/** Dir-name prefix of staging scratch dirs: `hubd-stage-<pid>-<random>`. The pid lets a later hubd tell orphans from live ones. */
const STAGE_PREFIX = "hubd-stage-";

/** The hub-owned scratch root: `<dataDir>/tmp` (`roots.denLocal` is the hub dataDir). Nothing else lives there. */
export function stageRoot(roots: KbRoots): string {
  return join(roots.denLocal, "tmp");
}

/** Is `pid` a live process? EPERM means it exists but is not ours, so alive. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Remove scratch dirs left by a hubd that crashed mid-batch. Scans only the hub-owned `tmpRoot` (`<dataDir>/tmp`), only names
 * `hubd-stage-<pid>-<random>`. Rule: pid <= 0 is not a real hubd pid, so the dir is deleted; otherwise it is deleted only if the
 * pid is dead. `isAlive` is injectable for tests.
 */
export function sweepStageDirs(tmpRoot: string, isAlive: (pid: number) => boolean = pidAlive): number {
  let n = 0;
  let names: string[];
  try {
    names = readdirSync(tmpRoot);
  } catch {
    return 0;
  }
  for (const name of names) {
    const m = /^hubd-stage-(\d+)-[A-Za-z0-9]+$/.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid > 0 && isAlive(pid)) continue;
    try {
      rmSync(join(tmpRoot, name), { recursive: true, force: true });
      n++;
    } catch {
      /* best effort */
    }
  }
  return n;
}

type Item = ReturnType<typeof createWork>["item"];

/** TEST SEAM (failure injection): called inside a batch at the named stage; a throw simulates a crash/failure there. */
export interface ApplyHooks {
  /** After every op succeeded in the scratch copy, before anything touches the real ledger. */
  afterStaged?: () => void;
  /** After the single real ledger append, before the .md files are rendered. */
  afterAppend?: () => void;
  /** Where scratch dirs are made (default `<dataDir>/tmp`, see stageRoot). */
  tmpRoot?: string;
  /** TEST SEAM: runs where the final fold happens, after the render; a throw simulates the fold failing after the append. */
  beforeResult?: () => void;
}

/**
 * Apply ops in order to one item. MUST be called inside the write queue (hubd is the sole ledger writer).
 *
 * One op runs directly (the kb op's own behaviour). A BATCH is staged: the item's domain work dir and the ledger are copied into
 * a mkdtemp scratch root and ALL ops run there through the unchanged kb ops. Only if every op succeeded are the newly appended
 * ledger bytes appended to the real ledger with ONE appendFileSync, then the .md of every touched item is rendered from the real
 * folded state. A failing op just discards the scratch root: the real ledger and files were never touched, so nothing can be
 * left half-done, even by a crash (a crash before the append leaves nothing; after it, the ledger, the source of truth, holds
 * the whole batch and a stale .md is re-rendered by the next write to that item).
 * Once the append succeeded the batch IS committed: a render failure afterwards is logged and the call still succeeds (the .md
 * is derived; the next write to that item repairs it). A failure of the append itself is `engine_error`, never the op's 4xx.
 * A batch of only content ops (`body` / `section`) is one atomic .md write with no ledger involved; mixing is refused.
 * Cost: a batch copies the ledger and the item's domain `work/` dir under the write queue.
 * NOTE: `body` / `section` append no ledger event, so they bump no `updated` and fire no work.changed (known gap, follow-up).
 * WRITES: probe file in the item's work dir; ledger append (one event per op, batch appended once); re-render of the touched items' .md files (body/section ops: the .md only).
 */
export function applyOps(roots: KbRoots, id: string, ops: WorkOp[], hooks: ApplyHooks = {}, opts: ApplyOptions = {}): Item {
  assertNotMixed(ops);
  probeItemDomains(roots, [id]);
  // An assign can cascade to child tasks: it must be all-or-nothing, so it takes the staged path even as a single op.
  if (ops.length <= 1 && ops[0]?.op !== "assign") return applyOpsUnchecked(roots, id, ops, opts);
  const cur0 = loadWorkState(roots).get(id as never);
  if (!cur0) throw new Error(`work item ${id} not found`);
  const domain = cur0.domain as string;
  if (ops.every(isContentOp)) {
    // Fold every edit over the body first (any failure throws before a write), then ONE atomic .md write.
    let body = resolveWorkItem(roots, domain, id)?.body ?? "";
    for (const o of ops) body = o.op === "body" ? o.text : o.op === "section" ? replaceSection(body, o.name, o.text) : o.op === "recordAppend" ? appendRecordLines(body, String(cur0.kind), o.lines, o.group).body : body;
    commitWorkItem(roots, cur0, body);
    return cur0;
  }
  const stageDir = hooks.tmpRoot ?? stageRoot(roots);
  mkdirSync(stageDir, { recursive: true });
  const scratchDir = mkdtempSync(join(stageDir, `${STAGE_PREFIX}${process.pid}-`));
  try {
    const scratch: KbRoots = { kbBase: join(scratchDir, "kb", "base"), opsRoot: join(scratchDir, "kb", "ops"), denLocal: scratchDir };
    const realLedger = workLedgerFile(roots);
    const realSize = ledgerSize(roots);
    if (existsSync(realLedger)) {
      mkdirSync(dirname(workLedgerFile(scratch)), { recursive: true });
      cpSync(realLedger, workLedgerFile(scratch));
    }
    if (existsSync(workDir(roots, domain))) cpSync(workDir(roots, domain), workDir(scratch, domain), { recursive: true });
    // Placement forbids a parent in another domain (placementError in kb schema/work.ts: `parent.domain !== child.domain`), so
    // every item a batch can touch, an auto-shipped parent feature included, lives in this one domain's work/ dir.
    // The kb ops read only the ledger and the item .md files, and write only those (see report): scratch is a faithful sandbox.
    const item = applyOpsUnchecked(scratch, id, ops, opts);
    hooks.afterStaged?.();

    const bytes = readNewBytes(workLedgerFile(scratch), realSize);
    // Every event id is "touched": the target, plus anything an op changed as a side effect (an auto-shipped parent feature).
    const touched = new Set<string>([id]);
    for (const ev of readLedgerSince(scratch, realSize).events) touched.add(ev.id);
    try {
      if (bytes.length > 0) {
        mkdirSync(dirname(realLedger), { recursive: true });
        appendFileSync(realLedger, bytes);
      }
    } catch (e) {
      console.error("hubd: batch ledger append failed:", e);
      throw new HubError("engine_error", "internal hub error");
    }
    // COMMITTED from here on: the ledger holds the whole batch. Rendering is best effort.
    try {
      hooks.afterAppend?.();
      const state = loadWorkState(roots);
      for (const t of touched) {
        const real = state.get(t as never);
        if (!real) continue;
        const fresh = resolveWorkItem(scratch, real.domain as string, t);
        if (!fresh) {
          // The staged copy had no readable body: keep the existing real file if there is one, never render an undefined body.
          if (resolveWorkItem(roots, real.domain as string, t) || existsSync(join(workDir(roots, real.domain as string), `${t}.md`))) continue;
        }
        commitWorkItem(roots, real, fresh?.body ?? "");
      }
    } catch (e) {
      console.error("hubd: batch committed to the ledger but rendering the .md failed (next write repairs it):", e);
    }
    // The batch is committed; a failing fold must not turn it into a 500. Fall back to the item the staged run produced.
    try {
      hooks.beforeResult?.();
      return loadWorkState(roots).get(id as never) ?? item;
    } catch (e) {
      console.error("hubd: batch committed but the final fold failed; answering with the staged item:", e);
      return item;
    }
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

function readNewBytes(file: string, offset: number): Buffer {
  const all = readFileSync(file);
  return all.subarray(offset);
}

/** Who is applying the ops: a worker's wolf (`holder`) cascades a feature assign only to the children it holds; unset (the owner) cascades to all open children. */
export interface ApplyOptions {
  holder?: string;
}

function applyOpsUnchecked(roots: KbRoots, id: string, ops: WorkOp[], opts: ApplyOptions = {}): Item {
  let item: Item | undefined;
  for (const o of ops) {
    switch (o.op) {
      case "stage": item = stageWork(roots, id, o.to).item; break;
      case "note": item = noteWork(roots, id, o.text).item; break;
      case "title": item = retitleWork(roots, id, o.title).item; break;
      case "successCriteria": item = setCriteria(roots, id, o.text).item; break;
      case "assign": {
        const before = loadWorkState(roots);
        const self = before.get(id as never);
        // One snapshot of the open children, taken before any write: the actor's shortcut covers only those it may change.
        const kids = self?.kind === "feature"
          ? [...before.values()].filter((c) => c.partOf === id && c.kind === "task" && !["shipped", "live", "archived"].includes(String(c.stage)) && c.assignee !== o.to && (opts.holder === undefined || c.assignee === opts.holder))
          : [];
        item = assignWork(roots, id, o.to).item;
        // Each child gets its own logged event, in the same (staged) write.
        for (const c of kids) assignWork(roots, c.id as string, o.to);
        if (kids.length) item = loadWorkState(roots).get(id as never) ?? item;
        break;
      }
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
      case "recordAppend": {
        const cur = loadWorkState(roots).get(id as never);
        if (!cur) throw new Error(`work item ${id} not found`);
        if (cur.stage === "archived") throw new HubError("invalid_request", "item is archived; its Record is closed", { code: RECORD_CLOSED });
        const r = appendRecordLines(resolveWorkItem(roots, cur.domain as string, id)?.body ?? "", String(cur.kind), o.lines, o.group);
        if (r.added > 0) commitWorkItem(roots, cur, r.body);
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

/**
 * Claim and unclaim are LEDGER-FIRST: the ledger event is the truth and the .md is a derived view ("the next write to that item
 * repairs it"). A filesystem failure while re-rendering it (EROFS on a read-only store, ENOSPC...) is therefore logged, not fatal:
 * claims must keep working, and releasing a disconnected wolf's claims must succeed, on a read-only store. No probe for these ops.
 */
const loggedStaleMd = new Set<string>(); // once per item per process: a read-only store would otherwise log on every claim
function commitFoldedBestEffort(roots: KbRoots, item: Item): void {
  try {
    commitFolded(roots, item);
  } catch (e) {
    if (typeof (e as NodeJS.ErrnoException)?.code !== "string") throw e; // only filesystem errors are tolerated
    if (loggedStaleMd.has(item.id as string)) return;
    loggedStaleMd.add(item.id as string);
    console.error(`hubd: ${item.id}: ledger updated but the .md could not be re-rendered (${(e as NodeJS.ErrnoException).code}); it is repaired by the next write to the item`);
  }
}

const CLAIMABLE_STAGES: readonly string[] = ["approved", "in_build"];

/**
 * Claim: compare-and-set. MUST run inside the write queue (the check and the append are then atomic w.r.t. other hub writes).
 * Holder = the folded `boundBy`. Succeeds when unheld or already held by `wolf`. Inheritance both ways: a child of a feature held by
 * another wolf is refused, and so is a feature while another wolf holds one of its children.
 * Appends work.assigned + work.bound (+ work.staged approved -> in_build) in ONE ledger append.
 * LEGACY: a work.bound already in an old ledger with no matching work.unbound reads as held (last writer wins); an operator clears it
 * with unclaim.
 * WRITES: one ledger append (work.assigned/bound/staged); then best-effort re-render of <domain>/work/<id>.md. No probe.
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
  commitFoldedBestEffort(roots, updated);
  return updated;
}

/**
 * Unclaim: the holder or an operator appends work.unbound (anyone else gets 403 `forbidden`); the stage and assignee stay. Inside the write queue.
 * WRITES: one ledger append (work.unbound); then best-effort re-render of <domain>/work/<id>.md. No probe.
 */
export function unclaimItem(roots: KbRoots, id: string, actor: Actor): Item {
  const item = loadWorkState(roots).get(id as WorkId);
  if (!item) throw new HubError("not_found", `work item ${id} not found`);
  if (!item.boundBy) return item;
  if (actor.kind !== "operator" && actor.id !== item.boundBy) throw new HubError("forbidden", `only the holder or the owner can release: ${id} is held by ${item.boundBy}`, { holder: item.boundBy });
  appendWorkLedger(roots, [{ type: "work.unbound", id: item.id, at: now(), wolf: item.boundBy }]);
  const updated = loadWorkState(roots).get(item.id)!;
  commitFoldedBestEffort(roots, updated);
  return updated;
}

/**
 * WRITES: probe file in <domain>/work; ledger append (work.created [+ standing]); <domain>/work/<id>.md (+ parent's .md via feature stage sync).
 */
export function createItem(roots: KbRoots, req: CreateWorkRequest) {
  probeWorkStore(roots, req.domain);
  // The schema validates `kind` as an enum; `stage` is a free string here and is validated by the ledger event schema.
  const r = createWork(roots, req as CreateWorkInput);
  return { id: r.id as string, item: r.item };
}

/**
 * WRITES: probe file in each affected domain's work dir; ledger append (work.deleted per item of the subtree); unlinks each item's .md.
 */
export function deleteItem(roots: KbRoots, id: string): string[] {
  probeItemDomains(roots, [id], true);
  return deleteWork(roots, id).items.map((i) => i.id as string);
}
/**
 * Graduation = the agent route's behaviour: mark the item graduated on the ledger. There is no LLM/distill step in that route.
 * WRITES: probe file; ledger append (work.graduated); re-render of <domain>/work/<id>.md.
 */
export function graduateItem(roots: KbRoots, id: string) {
  probeItemDomains(roots, [id]);
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

/** Typed codes the work proxy puts in its `{error, code}` body for a failed WRITE (reads never get them). */
export const WORK_STORE_READ_ONLY = "work_store_read_only";
export const WORK_STORE_PERMISSION_DENIED = "work_store_permission_denied";
/** The target parent graduated or is archived (thrown by kb createWork/moveWork as ParentClosedError). */
export const PARENT_CLOSED = "parent_closed";
/** A worker wrote the Record of an archived item (the work is no longer needed; its Record is closed). */
export const RECORD_CLOSED = "record_closed";

/**
 * THE errno table for write paths (applied by `mapWorkError(e, {write: true})` only; a failed read is never mapped here):
 *   EROFS            -> `work_store_read_only`: the store is deliberately read-only (sfo-01 ProtectSystem=strict). Retrying is pointless.
 *   EACCES / EPERM   -> `work_store_permission_denied`: looks like a permission fault, NOT a setting; the owner should check it.
 *   ENOSPC/EDQUOT/EIO and the rest -> generic `engine_error` (detail logged server-side).
 * Both typed errors are `engine_error` in the protocol enum (so the envelope status of /v1/work stays ERROR_HTTP_STATUS.engine_error)
 * with the typed code in `details.code`; `memory_unavailable` (409 everywhere else) is deliberately NOT reused.
 */
const PERMISSION = "this looks like a permission fault on the hub that the owner should check";
const ERRNO_TABLE: Record<string, { code: string; probe: string; post: string } | undefined> = {
  EROFS: {
    code: WORK_STORE_READ_ONLY,
    probe: "work store is read-only: this hub cannot write work items (writes are turned off; nothing was changed)",
    post: "work store became read-only during the write: the hub ledger may hold a partial change; the owner should run `hubd work-orphans` (hubd stopped) to check",
  },
  EACCES: {
    code: WORK_STORE_PERMISSION_DENIED,
    probe: `work store write was refused with a permission error (nothing was changed); ${PERMISSION}`,
    post: `work store write was refused with a permission error during the write: the hub ledger may hold a partial change; ${PERMISSION}, then run \`hubd work-orphans\` (hubd stopped)`,
  },
  EPERM: {
    code: WORK_STORE_PERMISSION_DENIED,
    probe: `work store write was refused with a permission error (nothing was changed); ${PERMISSION}`,
    post: `work store write was refused with a permission error during the write: the hub ledger may hold a partial change; ${PERMISSION}, then run \`hubd work-orphans\` (hubd stopped)`,
  },
};
/** An error thrown by the PRE-FLIGHT probe: nothing was appended, so its message may say "nothing was changed". */
class ProbeError extends Error {
  readonly probe = true;
  constructor(readonly underlying: unknown) {
    super(underlying instanceof Error ? underlying.message : String(underlying));
    const c = (underlying as NodeJS.ErrnoException | undefined)?.code;
    if (typeof c === "string") (this as unknown as NodeJS.ErrnoException).code = c;
  }
}

/**
 * PRE-FLIGHT WRITE PROBE. A work write appends its ledger event first and writes the item .md after (kb work-ops), so a store that
 * cannot be written would leave a ledger-only item. Before any op that appends and writes a .md, create and remove a temp file in
 * the target domains/<d>/work dir; if that fails nothing has been appended and the errno is mapped (above). The ledger is never
 * truncated or rewritten. A failure AFTER a passing probe (ENOSPC mid-op...) can still leave an orphan; `hubd work-orphans` covers it.
 * Tests: hubd.readonly.test.ts "probe: ...".
 */
export type WorkStoreProbe = (dir: string, stopAt: string) => void;
/** A valid domain name is one path segment: no separators, dots-only or traversal can ever reach the join. */
const DOMAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const validDomain = (d: string): boolean => DOMAIN_NAME.test(d) && !d.includes("..");
const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const defaultProbe: WorkStoreProbe = (dir, stopAt) => {
  // The dir may not exist yet (first item of a domain): probe the nearest existing ancestor (mkdir -p needs it writable), but
  // never climb to the hub's own KB root or out of it.
  let d = dir;
  while (!isDir(d)) {
    const up = dirname(d);
    const rel = relative(stopAt, up);
    if (up === d || up === stopAt || rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      throw Object.assign(new Error(`work store directory ${relative(stopAt, dir) || dir} has no existing parent below the KB root`), { code: "ENOENT" });
    }
    d = up;
  }
  const f = join(d, `.probe-${randomBytes(8).toString("hex")}`);
  writeFileSync(f, "", { flag: "wx" });
  unlinkSync(f);
};
let probeImpl: WorkStoreProbe = defaultProbe;
/** TEST SEAM: replace the probe (e.g. to throw an EROFS error). Returns a restore function. */
export function setWorkStoreProbe(p: WorkStoreProbe): () => void {
  const prev = probeImpl;
  probeImpl = p;
  return () => void (probeImpl = prev);
}
/** Probe `domains/<domain>/work` for writability. A domain name must be one plain segment (letters, digits, `.`, `_`, `-`; no leading dot, no `..`): invalid_request for a request, engine_error when it comes from ledger state. */
export function probeWorkStore(roots: KbRoots, domain: string, source: "request" | "ledger" = "request"): void {
  // A bad name in a REQUEST is the caller's mistake (400); a bad name already in the ledger is the hub's own state problem (engine_error).
  if (!validDomain(domain)) throw new HubError(source === "ledger" ? "engine_error" : "invalid_request", source === "ledger" ? "internal hub error" : "invalid domain name");
  try {
    probeImpl(workDir(roots, domain), roots.kbBase);
  } catch (e) {
    throw new ProbeError(e);
  }
}
/** Startup sweep: remove stale `.probe-*` files (a crash between create and unlink) from every domains/<d>/work dir. Best effort; returns the count. */
export function sweepProbeFiles(roots: KbRoots): number {
  let n = 0;
  const base = join(roots.kbBase, "domains");
  let domains: string[] = [];
  try {
    domains = readdirSync(base);
  } catch {
    return 0;
  }
  for (const d of domains) {
    const dir = join(base, d, "work");
    try {
      if (lstatSync(join(base, d)).isSymbolicLink() || lstatSync(dir).isSymbolicLink()) continue;
      for (const f of readdirSync(dir)) {
        if (!/^\.probe-[0-9a-f]+$/.test(f)) continue;
        try {
          unlinkSync(join(dir, f));
          n++;
        } catch {
          /* read-only store: leave it */
        }
      }
    } catch {
      /* no work dir */
    }
  }
  return n;
}
/** Probe the domain of each item (and, with `descendants`, of everything under it); an unknown id is left to the op's own not-found. */
function probeItemDomains(roots: KbRoots, ids: string[], descendants = false): void {
  const items = loadWorkState(roots);
  const childrenOf = new Map<string, string[]>(); // built ONCE: no nested scans
  if (descendants) for (const c of items.values()) if (c.partOf) childrenOf.set(c.partOf as string, [...(childrenOf.get(c.partOf as string) ?? []), c.id as string]);
  const domains = new Set<string>();
  const seen = new Set<string>();
  const walk = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const it = items.get(id as WorkId);
    if (!it) return;
    domains.add(it.domain as string);
    for (const c of childrenOf.get(id) ?? []) walk(c);
  };
  ids.forEach(walk);
  for (const d of domains) probeWorkStore(roots, d, "ledger");
}

/**
 * Map a work-ops failure to a protocol error via GUARD_MESSAGES. Everything else is `engine_error` (generic message, detail logged).
 * With `write: true` an EROFS / EACCES / EPERM errno is mapped through ERRNO_TABLE first; reads (`write` unset) never are.
 */
export function mapWorkError(e: unknown, opts: { write?: boolean } = {}): HubError {
  if (e instanceof HubError) return e;
  if (e instanceof Error && (e as { code?: unknown }).code === PARENT_CLOSED) return new HubError("invalid_request", e.message, { code: PARENT_CLOSED });
  const errno = e instanceof Error ? (e as NodeJS.ErrnoException).code : undefined;
  const typed = opts.write && typeof errno === "string" ? ERRNO_TABLE[errno] : undefined;
  if (typed) {
    const atProbe = (e as { probe?: boolean }).probe === true;
    console.error(`hubd: work store write failed${atProbe ? " (pre-flight probe)" : " AFTER the ledger append"}:`, e);
    return new HubError("engine_error", atProbe ? typed.probe : typed.post, { code: typed.code });
  }
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
  /** Attribution merged into every ledger event this actor's write appends, AT APPEND TIME (kb withLedgerAttribution). Undefined = none. */
  stamp?: (actor: Actor) => LedgerAttribution | undefined;
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
        result = withLedgerAttribution(opts.stamp?.(actor), fn);
      } catch (e) {
        failure = mapWorkError(e, { write: true });
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
