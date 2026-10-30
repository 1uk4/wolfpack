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
import { appendFileSync, closeSync, fsyncSync, ftruncateSync, writeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
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
import { now, workDir, workLedgerFile, type KbRoots } from "@wolfpack/kb/shared";
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

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const ATX_H12 = /^ {0,3}#{1,2}(?:[ \t]|$)/;
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/;
const ATX_ANY = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const CONTAINER_PREFIX = /^(?: {0,3}>[ \t]?| {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$))/;

/** CRLF / lone CR -> LF. The body is stored and compared with LF only. */
function toLf(s: string): string {
  return s.replace(/\r\n?/g, "\n");
}

/**
 * Per line: is it inside a fenced code block (``` or ~~~, CommonMark rules: closing fence is the same char, at least as long,
 * nothing else on the line). The fence lines themselves count as fenced. `unclosed` is true when the last fence never closes.
 */
function fenceMap(lines: string[]): { fenced: boolean[]; unclosed: boolean } {
  const fenced: boolean[] = [];
  let open: { ch: string; len: number } | undefined;
  for (const l of lines) {
    if (open) {
      fenced.push(true);
      const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(l);
      if (m && m[1][0] === open.ch && m[1].length >= open.len) open = undefined;
      continue;
    }
    const m = FENCE_OPEN.exec(l);
    if (m && !(m[1][0] === "`" && m[2].includes("`"))) {
      open = { ch: m[1][0], len: m[1].length };
      fenced.push(true);
    } else fenced.push(false);
  }
  return { fenced, unclosed: open !== undefined };
}

/** Is line `i` (outside a fence) an H1/H2, ATX (also inside a quote / list-item prefix) or setext (underline under a text line)? */
function isHeading12(lines: string[], fenced: boolean[], i: number): boolean {
  if (fenced[i]) return false;
  let l = lines[i];
  for (let n = 0; n < 8; n++) {
    if (ATX_H12.test(l)) return true;
    const m = CONTAINER_PREFIX.exec(l);
    if (!m) break;
    l = l.slice(m[0].length);
  }
  // Setext: an underline right below a non-blank, non-fenced line turns that line into a heading. (After a blank line `---` is
  // a thematic break and `===` plain text, both harmless.)
  if (i === 0 || fenced[i - 1] || !SETEXT_UNDERLINE.test(lines[i])) return false;
  const prev = lines[i - 1];
  // Only a plain paragraph line can be a setext heading's text: not blank, an ATX heading, a list item, a quote, a table row,
  // or another underline / thematic break.
  return prev.trim() !== "" && !ATX_ANY.test(prev) && !CONTAINER_PREFIX.test(prev) && !prev.includes("|") && !SETEXT_UNDERLINE.test(prev) && !/^ {0,3}([-*_])([ \t]*\1){2,}[ \t]*$/.test(prev);
}

/**
 * Reject section text that could restructure the body. `stripGeneratedLog` cuts the body at a column-0 `## Log` + list item, and
 * any CommonMark parser would see an H1/H2 (ATX with 0-3 spaces indent or a bare `##`, setext `Log\n---` / `Log\n===`) as a new
 * section. Headings inside fenced code are legitimate content; an unclosed fence would swallow the next real heading, so it is refused.
 */
export function assertSectionText(text: string): void {
  const lines = toLf(text).split("\n");
  const { fenced, unclosed } = fenceMap(lines);
  if (unclosed) throw new HubError("invalid_request", "section text has an unclosed code fence");
  for (let i = 0; i < lines.length; i++) {
    if (isHeading12(lines, fenced, i)) {
      throw new HubError("invalid_request", `section text must not contain level-1 or level-2 headings (line ${i + 1}); put them in a code fence`);
    }
  }
}

/**
 * Replace one `## <Heading>` section of a body, up to the next H1/H2 outside a code fence (or the end). Fence-aware for both the
 * start and the end heading; CRLF is normalised to LF. A missing section is added (Plan before Notes, else appended). Duplicate
 * headings are REJECTED (`invalid_request`): which one to replace would be a guess; an operator can fix the body with a `body` op.
 */
export function replaceSection(body: string, name: SectionName, text: string): string {
  const heading = SECTION_HEADING[name];
  const lines = toLf(body).split("\n");
  const { fenced } = fenceMap(lines);
  // `## Plan`, also with a closing hash sequence (`## Plan ##`), outside code fences.
  const at = (h: string) => {
    const re = new RegExp(`^ {0,3}##[ \\t]+${h.slice(3)}(?:[ \\t]+#+)?[ \\t]*$`);
    return lines.flatMap((l, i) => (!fenced[i] && re.test(l) ? [i] : []));
  };
  const starts = at(heading);
  if (starts.length > 1) throw new HubError("invalid_request", `the body has more than one "${heading}" heading; fix it with a body replace`);
  const block = [heading, "", ...(text.trim() ? [toLf(text).trim(), ""] : [])];
  const join_ = (parts: string[][]) => parts.flat().join("\n").trim() + "\n";
  if (starts.length === 1) {
    const start = starts[0];
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (isHeading12(lines, fenced, i)) {
        // A setext heading starts at its text line, one above the underline.
        end = !ATX_H12.test(lines[i]) && SETEXT_UNDERLINE.test(lines[i]) ? i - 1 : i;
        break;
      }
    }
    return join_([lines.slice(0, start), block, lines.slice(end)]);
  }
  const notes = name === "plan" ? at(SECTION_HEADING.notes) : [];
  if (notes.length >= 1) return join_([lines.slice(0, notes[0]), block, lines.slice(notes[0])]);
  const head = [...lines];
  while (head.length && head[head.length - 1].trim() === "") head.pop();
  return join_([head, head.length ? [""] : [], block]);
}

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
  return op.op === "body" || op.op === "section";
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
 */
export function applyOps(roots: KbRoots, id: string, ops: WorkOp[], hooks: ApplyHooks = {}): Item {
  assertNotMixed(ops);
  if (ops.length <= 1) return applyOpsUnchecked(roots, id, ops);
  const cur0 = loadWorkState(roots).get(id as never);
  if (!cur0) throw new Error(`work item ${id} not found`);
  const domain = cur0.domain as string;
  if (ops.every(isContentOp)) {
    // Fold every edit over the body first (any failure throws before a write), then ONE atomic .md write.
    let body = resolveWorkItem(roots, domain, id)?.body ?? "";
    for (const o of ops) body = o.op === "body" ? o.text : o.op === "section" ? replaceSection(body, o.name, o.text) : body;
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
    const item = applyOpsUnchecked(scratch, id, ops);
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

/** Unclaim: the holder or an operator appends work.unbound (anyone else gets 403 `forbidden`); the stage and assignee stay. Inside the write queue. */
export function unclaimItem(roots: KbRoots, id: string, actor: Actor): Item {
  const item = loadWorkState(roots).get(id as WorkId);
  if (!item) throw new HubError("not_found", `work item ${id} not found`);
  if (!item.boundBy) return item;
  if (actor.kind !== "operator" && actor.id !== item.boundBy) throw new HubError("forbidden", `only the holder or the owner can release: ${id} is held by ${item.boundBy}`, { holder: item.boundBy });
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
  /** Attribution to stamp (`by`, `tokenId`, `hostId`) on every ledger event this actor's write appends. Undefined = stamp nothing. */
  stamp?: (actor: Actor) => Record<string, string> | undefined;
}

/** Rewrite the ledger bytes after `offset` with `stamp` merged into each event (sole writer, inside the write queue). */
function stampTail(roots: KbRoots, offset: number, stamp: Record<string, string>): void {
  const file = workLedgerFile(roots);
  const raw = readFileSync(file);
  if (raw.length <= offset) return;
  const lines = raw.subarray(offset).toString("utf8").split("\n");
  const out = lines.map((l) => {
    if (!l.trim()) return l;
    try {
      const o = JSON.parse(l) as Record<string, unknown>;
      return JSON.stringify({ ...o, ...stamp });
    } catch {
      return l;
    }
  });
  const fd = openSync(file, "r+");
  try {
    const buf = Buffer.from(out.join("\n"), "utf8");
    ftruncateSync(fd, offset);
    writeSync(fd, buf, 0, buf.length, offset);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
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
          const st = opts.stamp?.(actor);
          if (st) stampTail(roots, before, st);
        } catch (e) {
          console.error("hubd: could not stamp attribution on the ledger tail:", e);
        }
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
