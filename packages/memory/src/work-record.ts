/**
 * Work Record — the curated knowledge of a body of work, kept in a working
 * document while it is worked on (not in den topics).
 *
 * Observations extracted while a task is bound carry `work: <task id>` and,
 * when the task sits under a real feature, `feature: <feature id>`. Den
 * consolidation skips them; this module folds them into a `## Record`
 * section instead, one rewrite per GROUPING KEY: the feature id when the
 * parent is a real feature (all its tasks share one Record), else the item's
 * own id (an Inbox or standalone item keeps its own and can graduate alone).
 * Old pending lines with only `work` group on the item.
 * A Record written on a task by an earlier version stays there, untouched:
 * it is harmless (the task's document still shows it) and not folded.
 *
 *   input   the current Record, the item's title / done-when / plan, the new
 *           observations
 *   output  a rewritten Record with fixed groups (Decisions, Changes,
 *           Findings, Problems & fixes), short bullets, capped
 *   write   PATCH the document body, replacing ONLY the `## Record` section
 *
 * Provenance: every Record line carries the ids and timestamps of the observations it came from (a trailing
 * comment, see record-sources.ts). The model maps each line to the observations it used (`from: ["o2", "r3"]`:
 * new observation 2, existing line 3); a line it does not map carries the whole batch's ids, flagged `[batch]`.
 *
 * Failure rules: an infra error (Work API down, model unavailable) leaves the
 * observations pending for the next run; an item that is archived, deleted or
 * unreachable-by-config falls back to den consolidation.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { RECORD_LINE_KINDS } from "@wolfpack/protocol";
import { LlmInfraError, WORK_RECORD_SYSTEM, type Engine } from "@wolfpack/engine";
import type { PendingCause, WorkPendingState } from "./work-pending.js";
import { formatSources, lineRef, noComments, numberRecordLines, parseRecordLines, stripSources, SOURCE_CAP, type RecordLine, type SourceRef } from "./record-sources.js";

// ── the Record section of a document ─────────────────────────────────────────

export const RECORD_HEADING = "## Record";

/** Total size the Record is kept under (the prompt asks for ~3.5k; this is the hard line). */
export const RECORD_CAP = 4000;

export interface Span {
  start: number;
  end: number;
}

/** Offsets of the lines of `body` that are outside fenced code blocks. */
function headingLines(body: string): Array<{ start: number; text: string }> {
  const out: Array<{ start: number; text: string }> = [];
  let fence: string | null = null;
  let pos = 0;
  for (const line of body.split("\n")) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (fence === null) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
    } else if (fence === null) {
      out.push({ start: pos, text: line });
    }
    pos += line.length + 1;
  }
  return out;
}

/** A `## <name>` section: from its heading line to the next H1/H2 (or the end). */
export function findSection(body: string, heading: string): Span | null {
  const lines = headingLines(body);
  const i = lines.findIndex((l) => l.text.replace(/[ \t]+$/, "") === heading);
  if (i < 0) return null;
  const next = lines.slice(i + 1).find((l) => /^#{1,2} /.test(l.text));
  return { start: lines[i].start, end: next ? next.start : body.length };
}

const findRecord = (body: string): Span | null => findSection(body, RECORD_HEADING);

/** The Record section including its heading, or null when the document has none. */
export function extractRecord(body: string): string | null {
  const span = findRecord(body);
  return span ? body.slice(span.start, span.end).trimEnd() : null;
}

/** The document without its Record section (what the plan says). */
export function withoutRecord(body: string): string {
  const span = findRecord(body);
  return span ? (body.slice(0, span.start) + body.slice(span.end)).trim() : body.trim();
}

/**
 * Replace the `## Record` section with `record` (a full section starting at
 * the heading), creating it at the end when missing. Everything outside the
 * section is preserved byte for byte.
 */
export function replaceRecordSection(body: string, record: string): string {
  const section = record.trimEnd();
  const span = findRecord(body);
  if (!span) {
    const head = body.trimEnd();
    return head ? `${head}\n\n${section}\n` : `${section}\n`;
  }
  const rest = body.slice(span.end);
  return body.slice(0, span.start) + section + (rest ? `\n\n${rest}` : "\n");
}

/** What the agent sees of the working document: plan + Record, within this many characters. */
export const DOCUMENT_CAP = 4000;
/** The plan keeps at least this much when the Record is large. */
const PLAN_MIN = 600;

/**
 * Clip a Record section to `room` characters keeping its NEWEST lines: the heading stays, the oldest lines go,
 * and a `… N earlier lines` marker says how many. Whole lines only.
 */
function clipRecordTail(record: string, room: number): string {
  if (record.length <= room) return record;
  const [heading, ...rest] = record.split("\n");
  const lines = rest.filter((l) => l.trim() !== "");
  const kept: string[] = [];
  let used = heading.length + 40; // heading + marker
  for (let i = lines.length - 1; i >= 0; i--) {
    if (used + lines[i].length + 1 > room) break;
    used += lines[i].length + 1;
    kept.unshift(lines[i]);
  }
  return [heading, `… ${lines.length - kept.length} earlier lines`, ...kept].join("\n");
}

/**
 * The working document for context injection, capped. The Record has
 * priority: when the whole document does not fit, the plan is clipped first
 * (it keeps at least PLAN_MIN characters). Document order is kept: plan, then Record.
 */
export function renderWorkingDocument(body: string, cap: number = DOCUMENT_CAP, opts: { tail?: boolean } = {}): string {
  const doc = stripSources(body).trim();
  if (doc.length <= cap) return doc;
  const record = extractRecord(doc) ?? "";
  const plan = withoutRecord(doc);
  const recordRoom = Math.max(0, Math.min(record.length, cap - Math.min(plan.length, PLAN_MIN) - 2));
  const planRoom = Math.max(0, cap - recordRoom - 2);
  const clip = (t: string, n: number) => (t.length <= n ? t : n <= 5 ? "" : t.slice(0, n - 5).trimEnd() + " […]");
  // Append mode (`tail`): newest whole lines win, falling back to the head clip when no whole line fits. Default: the head, as before.
  const clipRecord = (): string => {
    if (!opts.tail) return clip(record, recordRoom);
    const tailed = clipRecordTail(record, recordRoom);
    return /^… \d+ earlier lines$/m.test(tailed) && tailed.split("\n").length <= 2 ? clip(record, recordRoom) : tailed;
  };
  return [plan ? clip(plan, planRoom) : "", record ? clipRecord() : ""].filter(Boolean).join("\n\n");
}

/**
 * The feature's Record as the agent sees it while bound to one of its tasks:
 * the section under a heading naming the feature, capped. "" when it has none.
 */
export function renderFeatureRecord(featureTitle: string, featureBody: string, cap: number = DOCUMENT_CAP): string {
  const record = extractRecord(featureBody);
  if (!record) return "";
  const text = stripSources(record).slice(RECORD_HEADING.length).trim();
  if (!text) return "";
  const head = `## Feature Record — ${featureTitle} (shared by all its tasks; kept up to date by memory)`;
  const room = Math.max(0, cap - head.length - 2);
  const body = text.length <= room ? text : text.slice(0, Math.max(0, room - 5)).trimEnd() + " […]";
  return `${head}\n\n${body}`;
}

// ── the feature view: feature Record + live tails of its open tasks ──────────

/** The feature Record part of the view. */
export const FEATURE_VIEW_RECORD_CAP = 2500;
/** The open-tasks block of the view, header included. */
export const FEATURE_VIEW_TASKS_CAP = 1500;
/** Open sibling tasks shown; the rest is "+N more". */
export const FEATURE_VIEW_TASKS_MAX = 5;
/** Record characters kept per open task. */
export const FEATURE_VIEW_TAIL = 300;

const CLOSED_STAGES = ["shipped", "live", "archived"];

export interface FeatureViewTask {
  id: string;
  title: string;
  stage: string;
  /** The task's working document; absent or "" when it has none. */
  body?: string;
}

/** The newest whole Record lines of a document within `max` characters. */
function recordTail(body: string, max: number): string[] {
  const rec = extractRecord(stripSources(body));
  if (!rec) return [];
  const lines = rec.split("\n").slice(1).map((l) => l.trim()).filter((l) => l.startsWith("- "));
  const out: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (used + lines[i].length > max) break;
    used += lines[i].length;
    out.unshift(lines[i]);
  }
  return out;
}

/**
 * The feature as a bound task reads it, composed at read time (no model call): the feature Record (newest content,
 * 2500 chars) then an "Open tasks" block (up to 5 open siblings, whole-line Record tails of ~300 chars, 1500 chars in all).
 * The bound task is left out (its own document shows it). "" when there is neither.
 */
export function renderFeatureView(feature: { title: string; body: string }, tasks: FeatureViewTask[], boundId?: string): string {
  const parts: string[] = [];
  const record = extractRecord(feature.body);
  const text = record ? stripSources(record).slice(RECORD_HEADING.length).trim() : "";
  if (text) {
    const head = `## Feature Record — ${feature.title} (shared by all its tasks; kept up to date by memory)`;
    const clipped = clipRecordTail(`${RECORD_HEADING}\n${text}`, FEATURE_VIEW_RECORD_CAP - head.length - 2);
    parts.push(`${head}\n\n${clipped.split("\n").slice(1).join("\n").trim()}`);
  }
  const open = tasks.filter((t) => !CLOSED_STAGES.includes(t.stage) && t.id !== boundId);
  if (open.length > 0) {
    const shown = open.slice(0, FEATURE_VIEW_TASKS_MAX);
    const header = "## Open tasks in this feature";
    const more = open.length > shown.length ? `\n+${open.length - shown.length} more` : "";
    const heads = shown.map((t) => `- ${t.id} "${t.title}" (${t.stage})`);
    // Lines are indented two spaces and joined by newlines: budget them out of what the headers leave.
    let room = FEATURE_VIEW_TASKS_CAP - 2 - header.length - more.length - heads.reduce((n, h) => n + h.length + 1, 0);
    const blocks = shown.map((t, i) => {
      const tail = recordTail(t.body ?? "", Math.min(FEATURE_VIEW_TAIL, Math.floor(room / (shown.length - i)))).map((l) => `  ${l}`);
      room -= tail.reduce((n, l) => n + l.length + 1, 0);
      return [heads[i], ...tail].join("\n");
    });
    parts.push([header, ...blocks].join("\n") + more);
  }
  return parts.join("\n\n");
}

// ── the Record's shape ───────────────────────────────────────────────────────

/** Refs the model names for a line: `o2` a new observation, `r3` an existing Record line. Null counts as absent. */
const From = z.array(z.string()).nullish().transform((f) => f ?? []);

/** A bullet is a plain string (older answers) or `{text, from}`. */
const Item = z.union([z.string().min(1), z.object({ text: z.string().min(1), from: From })]);

export const WorkRecordSchema = z.object({
  decisions: z.array(z.object({ decision: z.string().min(1), why: z.string().default(""), from: From })),
  changes: z.array(Item),
  findings: z.array(Item),
  problems: z.array(Item),
});
export type WorkRecord = z.input<typeof WorkRecordSchema>;

const one = (s: string) => noComments(s).replace(/\s+/g, " ").trim();

const GROUPS = ["Decisions", "Changes", "Findings", "Problems & fixes"] as const;

interface FlatItem {
  group: (typeof GROUPS)[number];
  text: string;
  from: string[];
}

function flatten(r: WorkRecord): FlatItem[] {
  const plain = (group: FlatItem["group"], items: Array<z.input<typeof Item>>): FlatItem[] =>
    items.map((i) => (typeof i === "string" ? { group, text: one(i), from: [] } : { group, text: one(i.text), from: i.from ?? [] }));
  return [
    ...(r.decisions ?? []).map((d): FlatItem => ({ group: "Decisions", text: d.why?.trim() ? `${one(d.decision)} — why: ${one(d.why)}` : one(d.decision), from: d.from ?? [] })),
    ...plain("Changes", r.changes ?? []),
    ...plain("Findings", r.findings ?? []),
    ...plain("Problems & fixes", r.problems ?? []),
  ];
}

/** A Record line ready to render: visible text plus where it came from. */
export interface RenderedLine {
  group: string;
  text: string;
  sources: SourceRef[];
  batch: boolean;
  /** Refs omitted by the cap, now or in an earlier render. */
  more?: number;
}

function renderLines(lines: RenderedLine[], withSources: boolean): string {
  const parts = GROUPS.map((name) => [name, lines.filter((l) => l.group === name)] as const)
    .filter(([, items]) => items.length > 0)
    .map(([name, items]) => `### ${name}\n\n${items.map((i) => `- ${i.text}${withSources ? formatSources(i.sources, i.batch, i.more ?? 0) : ""}`).join("\n")}`);
  return [RECORD_HEADING, ...parts].join("\n\n");
}

/** Render the fixed layout without sources; empty groups are left out, order is fixed. */
export function renderRecord(r: WorkRecord): string {
  return renderLines(flatten(r).map((i) => ({ group: i.group, text: i.text, sources: [], batch: false })), false);
}

const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const words = (t: string) => new Set(norm(t).split(" ").filter((w) => w.length > 2));
function similarity(a: string, b: string): number {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}
/** A reworded line counts as the old one when this much of their words overlap. */
const REWORD_MIN = 0.5;

/**
 * Attach sources to the answer's lines. A line's refs resolve to the batch's observations (`oN`) and to the
 * sources of existing lines it carries over (`rN`). A line with no `rN` that matches an existing line (same text, or
 * a rewording of one in the same group by word overlap) keeps that line's sources; if it also names no `oN` it gets
 * the whole batch's on top (flagged `batch`), unless the text is unchanged. A line matching nothing gets the batch.
 * A ref to an existing line without sources (an older Record) adds none: it is not blamed on the batch.
 */
export function resolveSources(r: WorkRecord, current: RecordLine[], batch: SourceRef[]): RenderedLine[] {
  const byText = new Map(current.map((l) => [norm(l.text), l]));
  return flatten(r).map((it): RenderedLine => {
    const text = it.text.replace(/^\[[ro]\d+\]\s*/, "");
    const sources: SourceRef[] = [];
    let batchLevel = false;
    let more = 0;
    let usedBatch = false;
    let mappedO = false;
    let mappedR = false;
    const add = (refs: SourceRef[]) => {
      for (const ref of refs) if (!sources.some((s) => s.id === ref.id)) sources.push(ref);
    };
    const carry = (l: RecordLine) => { add(l.sources); batchLevel ||= l.batch; more += l.more; };
    for (const f of it.from) {
      const m = /^\[?([ro])(\d+)\]?$/i.exec(f.trim());
      if (!m) continue;
      const n = Number(m[2]) - 1;
      if (m[1].toLowerCase() === "o" && batch[n]) { mappedO = true; add([batch[n]]); }
      else if (m[1].toLowerCase() === "r" && current[n]) { mappedR = true; carry(current[n]); }
    }
    if (!mappedR) {
      const same = byText.get(norm(text));
      if (same) { carry(same); usedBatch = true; } // unchanged: its own sources are the whole story
      else {
        const near = current.filter((l) => l.group === it.group).map((l) => [l, similarity(l.text, text)] as const).sort((a, b) => b[1] - a[1])[0];
        if (near && near[1] >= REWORD_MIN) carry(near[0]); // a rewording keeps the line it replaced
      }
    }
    if (!mappedO && !mappedR && !usedBatch) { add(batch); batchLevel = true; }
    const dropped = Math.max(0, sources.length - SOURCE_CAP);
    return { group: it.group, text, sources: sources.slice(-SOURCE_CAP), batch: batchLevel, more: more + dropped };
  });
}

/** Where a Record line came from, found in a document: the line and its sources, by its ref. */
export function findRecordLine(body: string, ref: string): RecordLine | undefined {
  const rec = extractRecord(body);
  return rec ? parseRecordLines(rec).find((l) => l.ref === ref) : undefined;
}

/** Every Record line of a document with its ref and sources (empty when it has no Record). */
export function recordLines(body: string): RecordLine[] {
  const rec = extractRecord(body);
  return rec ? parseRecordLines(rec) : [];
}

export { lineRef, stripSources, type RecordLine, type SourceRef };

/** Last resort over the cap: drop the last bullet of the fullest group until it fits. */
function trimToCap(r: WorkRecord, cap: number): WorkRecord {
  const rec: WorkRecord = { decisions: [...r.decisions], changes: [...r.changes], findings: [...r.findings], problems: [...r.problems] };
  const keys = ["decisions", "changes", "findings", "problems"] as const;
  while (renderRecord(rec).length > cap) {
    const biggest = keys.reduce((a, b) => (rec[b].length > rec[a].length ? b : a));
    if (rec[biggest].length === 0) break;
    rec[biggest].pop();
  }
  return rec;
}

// ── store (the Work API, as far as the Record needs it) ──────────────────────

export interface WorkRecordItem {
  id: string;
  title: string;
  kind: string;
  stage: string;
  /** Holding container (the domain Inbox): never a Record's home. */
  container?: boolean;
  successCriteria?: string;
  /** The parent item (null: none). Undefined: the store does not say, so the observation's stored feature is used. */
  partOf?: string | null;
  /** The wolf the item is assigned to, when the API says. */
  assignee?: string;
  /** The working document ("" when none written yet). */
  body: string;
}

/** A Work API refusal: the HTTP status and the hub's own message. */
export class WorkApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
    this.name = "WorkApiError";
  }
}

/** The protocol's line kind: decision | change | finding | problem. */
export type RecordLineKind = (typeof RECORD_LINE_KINDS)[number];

/** A line for `appendRecord` (the hub's `recordAppend` line): `at` ISO time, `src` label, `kind` (the protocol's line kind), one-line `text` (<= 240), source `ids` (at least one). */
export interface RecordAppendLine { at: string; src: string; kind: RecordLineKind; text: string; ids: string[] }

export type AppendRecordResult =
  | { ok: true }
  | { ok: false; code: "log_full" }
  | { ok: false; code: "archived" | "forbidden" | "error"; message: string };

/** Hub Record caps (hubd RECORD_CAP_TASK / RECORD_CAP_FEATURE). */
export const APPEND_CAP_TASK = 6000;
export const APPEND_CAP_FEATURE = 4000;

/** Deterministic key for a batch: the item plus its sorted line ids (line text when a line has none), so a retry of the same lines replays. */
export function appendKey(id: string, lines: RecordAppendLine[]): string {
  const parts = lines.map((l) => (l.ids.length ? [...l.ids].sort().join(",") : `t:${l.text}`)).sort();
  return `ra:${createHash("sha256").update(`${id}\n${parts.join("\n")}`).digest("hex").slice(0, 40)}`;
}

export interface WorkRecordStore {
  /** The item and its document; null when it no longer exists. Throws on any other failure (the run stays pending). */
  get(id: string): Promise<WorkRecordItem | null>;
  /** Replace ONLY the Record section; `record` is the full section starting at its heading. Throws WorkApiError on a refusal. */
  setRecord(id: string, record: string): Promise<void>;
  /** Atomically append lines to the item's Record (hub `recordAppend`). Never throws on a refusal; a resend with the same key (default: derived from item + line ids) adds nothing. */
  appendRecord(id: string, lines: RecordAppendLine[], opts?: { idempotencyKey?: string; group?: string }): Promise<AppendRecordResult>;
  /** The Work API answers a list call. Absent: a successful get is taken as proof of health. */
  healthy?(): Promise<boolean>;
}

/** The Work API over HTTP (WORK_ENDPOINT / WORK_TOKEN, like the extensions' client). */
export class HttpWorkRecordStore implements WorkRecordStore {
  private endpoint: string;
  private token: string;

  private wolf: string | undefined;

  /** `wolf`: the acting wolf sent as X-Wolf; defaults to WOLF_NAME (always set in a wolf's process, see wolf-manager writeEnv). */
  constructor(endpoint?: string, token?: string, private fetchImpl: typeof fetch = fetch, wolf?: string) {
    this.wolf = wolf ?? process.env.WOLF_NAME;
    this.endpoint = (endpoint ?? process.env.WORK_ENDPOINT ?? "").replace(/\/$/, "");
    this.token = token ?? process.env.WORK_TOKEN ?? "";
  }

  get configured(): boolean {
    return !!(this.endpoint && this.token);
  }

  private async call(method: string, id: string, body?: unknown, extra: Record<string, string> = {}): Promise<Response> {
    if (!this.configured) throw new Error("Work API not configured (WORK_ENDPOINT / WORK_TOKEN missing)");
    return this.fetchImpl(`${this.endpoint}/work/${encodeURIComponent(id)}`, {
      method,
      headers: { "X-API-Key": this.token, ...(this.wolf ? { "X-Wolf": this.wolf } : {}), ...(body ? { "Content-Type": "application/json" } : {}), ...extra },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async healthy(): Promise<boolean> {
    if (!this.configured) return false;
    try {
      const res = await this.fetchImpl(`${this.endpoint}/work?partOf=${encodeURIComponent("work-health-probe")}`, { headers: { "X-API-Key": this.token }, signal: AbortSignal.timeout(5000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async get(id: string): Promise<WorkRecordItem | null> {
    const res = await this.call("GET", id);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Work API GET ${id}: HTTP ${res.status}`);
    const data = (await res.json()) as { item: Record<string, unknown>; body: string | null };
    const it = data.item;
    return {
      id: String(it.id),
      title: String(it.title ?? ""),
      kind: String(it.kind ?? ""),
      stage: String(it.stage ?? ""),
      container: it.container === true,
      ...(typeof it.assignee === "string" && it.assignee ? { assignee: it.assignee } : {}),
      successCriteria: typeof it.successCriteria === "string" ? it.successCriteria : undefined,
      partOf: typeof it.partOf === "string" ? it.partOf : it.partOf === null ? null : undefined,
      body: data.body ?? "",
    };
  }

  async appendRecord(id: string, lines: RecordAppendLine[], opts: { idempotencyKey?: string; group?: string } = {}): Promise<AppendRecordResult> {
    const key = opts.idempotencyKey ?? appendKey(id, lines);
    let res: Response;
    try {
      res = await this.call("PATCH", id, { op: "recordAppend", lines, ...(opts.group ? { group: opts.group } : {}) }, { "Idempotency-Key": key });
    } catch (err) {
      return { ok: false, code: "error", message: err instanceof Error ? err.message : String(err) };
    }
    if (res.ok) return { ok: true };
    let message = `Work API PATCH ${id}: HTTP ${res.status}`;
    let code: string | undefined;
    try {
      const j = (await res.json()) as { error?: unknown; code?: unknown };
      if (typeof j.error === "string" && j.error) message = j.error;
      if (typeof j.code === "string") code = j.code;
    } catch { /* keep the generic message */ }
    if (res.status === 409 && code === "log_full") return { ok: false, code: "log_full" };
    if (res.status === 409 && code === RECORD_CLOSED_CODE) return { ok: false, code: "archived", message };
    if (res.status === 403) return { ok: false, code: "forbidden", message };
    return { ok: false, code: "error", message };
  }

  async setRecord(id: string, record: string): Promise<void> {
    // The hub adds the `## Record` heading itself; the text must not hold a level-2 heading.
    const text = record.startsWith(RECORD_HEADING) ? record.slice(RECORD_HEADING.length).replace(/^\s+/, "") : record;
    const res = await this.call("PATCH", id, { section: { name: "Record", text } });
    if (res.ok) return;
    let message = `Work API PATCH ${id}: HTTP ${res.status}`;
    let code: string | undefined;
    try {
      const j = (await res.json()) as { error?: unknown; code?: unknown };
      if (typeof j.error === "string" && j.error) message = j.error;
      if (typeof j.code === "string") code = j.code;
    } catch { /* keep the generic message */ }
    throw new WorkApiError(res.status, message, code);
  }
}

/** A Work API stand-in that keeps bodies in memory: real append with the hub's caps and id dedupe (tests, offline use). */
export class InMemoryWorkRecordStore implements WorkRecordStore {
  constructor(public items: Record<string, WorkRecordItem> = {}) {}

  async get(id: string): Promise<WorkRecordItem | null> {
    return this.items[id] ?? null;
  }

  async setRecord(id: string, record: string): Promise<void> {
    const it = this.items[id];
    if (!it) throw new WorkApiError(404, "not found");
    it.body = replaceRecordSection(it.body, record);
  }

  async appendRecord(id: string, lines: RecordAppendLine[], opts: { group?: string } = {}): Promise<AppendRecordResult> {
    const it = this.items[id];
    if (!it) return { ok: false, code: "error", message: "not found" };
    if (it.stage === "archived") return { ok: false, code: "archived", message: "item is archived; its Record is closed" };
    // The hub answers 400 to a kind outside the protocol's set; the stand-in refuses it the same way.
    const badKind = lines.find((l) => !["decision", "change", "finding", "problem"].includes(l.kind));
    if (badKind) return { ok: false, code: "error", message: `invalid line kind: ${String(badKind.kind)}` };
    const rec = extractRecord(it.body)?.slice(RECORD_HEADING.length).trim() ?? "";
    const seen = new Set<string>();
    for (const m of rec.matchAll(/<!-- src:([^>]*?) -->/g)) for (const i of m[1]!.split(",")) seen.add(i);
    const fresh: string[] = [];
    for (const l of lines) {
      if (l.ids.length && l.ids.every((i) => seen.has(i))) continue;
      l.ids.forEach((i) => seen.add(i));
      fresh.push(`- ${/T(\d\d:\d\d)/.exec(l.at)?.[1] ?? "00:00"} [${l.src}\u00b7${l.kind}] ${l.text.trim()}${l.ids.length ? ` <!-- src:${l.ids.join(",")} -->` : ""}`);
    }
    if (!fresh.length) return { ok: true };
    let next: string;
    if (opts.group && it.kind === "feature") {
      const rl = rec ? rec.split("\n") : [];
      const h = rl.findIndex((x) => x.trim() === `### ${opts.group}`);
      if (h < 0) rl.push(...(rl.length ? [""] : []), `### ${opts.group}`, "", ...fresh);
      else {
        let end = rl.length;
        for (let i = h + 1; i < rl.length; i++) if (/^### /.test(rl[i]!)) { end = i; break; }
        let at = end;
        while (at > h + 1 && rl[at - 1]!.trim() === "") at--;
        rl.splice(at, 0, ...fresh);
      }
      next = rl.join("\n");
    } else next = rec ? `${rec}\n${fresh.join("\n")}` : fresh.join("\n");
    if (next.length > (it.kind === "feature" ? APPEND_CAP_FEATURE : APPEND_CAP_TASK)) return { ok: false, code: "log_full" };
    it.body = replaceRecordSection(it.body, `${RECORD_HEADING}\n\n${next}`);
    return { ok: true };
  }
}

// ── consolidation ────────────────────────────────────────────────────────────

/** An observation tagged for a work item. */
export interface WorkObservation {
  /** Unique id (observationIds over the pool); the Record keeps it as the line's source. */
  id: string;
  /** When it was observed; stored next to the id in a line's sources. */
  timestamp?: string;
  content: string;
  work: string;
  /** The task's parent feature when it was tagged. */
  feature?: string;
}

/** A real feature can hold a shared Record; the Inbox and other containers cannot. */
export const isRecordFeature = (it: WorkRecordItem | null): it is WorkRecordItem =>
  !!it && it.kind === "feature" && !it.container && it.stage !== "archived";

export type WorkRecordOutcome =
  /** Record written: the observations are consumed. */
  | { work: string; ids: string[]; status: "written"; chars: number }
  /** Item archived or deleted: the observations are discarded (logged by the caller), never sent to the den. */
  | { work: string; ids: string[]; status: "discarded"; reason: string }
  /** Work API unreachable or not configured, or an infra error: the observations stay pending for the next run. */
  | { work: string; ids: string[]; status: "pending"; reason: string; cause: PendingCause; /** Next attempt (ms epoch) while the group backs off. */ retryAt?: number; assignee?: string };

/** The hub's code for a Record write to an archived item (hubd RECORD_CLOSED). */
export const RECORD_CLOSED_CODE = "record_closed";

/** The reason a pending outcome carries when the Work API is missing or unreachable. */
export const WORK_API_UNAVAILABLE = "work-api-unavailable";

export interface ConsolidateWorkOptions {
  engine: Engine;
  /** Absent (Work API not configured) → every group stays pending; tagged observations never go to the den. */
  store?: WorkRecordStore;
  observations: WorkObservation[];
  /** Retry backoff and the 404 grace period. Absent: every group is tried now and a 404 discards at once. */
  state?: WorkPendingState;
  /** Try groups still inside their backoff (a manual Consolidate). A failure still updates the state. */
  ignoreBackoff?: boolean;
  onProgress?: (msg: string) => void;
}

const PLAN_CAP = 3000;

function buildPrompt(item: WorkRecordItem, current: string | null, obs: WorkObservation[], tooLong?: number): string {
  const plan = withoutRecord(item.body);
  return [
    `WORK ITEM: ${item.title} (${item.kind}, ${item.stage})`,
    item.successCriteria ? `DONE WHEN: ${item.successCriteria}` : "",
    "",
    "PLAN (the working document outside the Record):",
    plan ? (plan.length > PLAN_CAP ? plan.slice(0, PLAN_CAP) + "\n[…]" : plan) : "(none)",
    "",
    "CURRENT RECORD (lines are numbered [r1], [r2]…):",
    current ? numberRecordLines(current) : "(empty — no Record yet)",
    "",
    "NEW OBSERVATIONS (numbered [o1], [o2]…):",
    ...obs.map((o, i) => `- [o${i + 1}] ${o.content}`),
    tooLong ? `\nYour previous answer rendered ${tooLong} characters. Fold older detail so the Record stays under ${RECORD_CAP - 500} characters.` : "",
  ].join("\n");
}

/** A group is settled: forget its key and every task key its observations carry (an earlier run may have grouped them under the task). */
function clearEntries(state: ConsolidateWorkOptions["state"], key: string, obs: WorkObservation[]): void {
  if (!state) return;
  state.clear(key);
  for (const o of obs) state.clear(o.work);
}

const isInfra = (err: unknown) => err instanceof LlmInfraError || (err instanceof Error && err.cause instanceof LlmInfraError);

/**
 * Fold tagged observations into Records, one rewrite per grouping key (see the
 * header). In an outcome, `work` is that key (the item that holds the Record)
 * and `ids` are the observations it covers. Never throws for one group: the
 * outcome says what happened to its observations.
 */
export async function consolidateWorkRecords(opts: ConsolidateWorkOptions): Promise<WorkRecordOutcome[]> {
  const { engine, store, onProgress, state } = opts;
  const groups = new Map<string, WorkObservation[]>();
  // The key is the feature when it is a real, live feature; anything else
  // (no feature, the Inbox, deleted, archived, store unreachable) keeps the item's own.
  // Each item is read at most once per run: every read (task, feature, group key) goes through this cache. A failed read is cached too;
  // the grouping treats it as "unknown" (null: a task falls back to its stored `o.feature`, a feature is not live), but the group loop
  // below rethrows it, so the group stays pending instead of being taken for deleted.
  const reads = new Map<string, { item: WorkRecordItem | null } | { err: unknown }>();
  const readItem = async (id: string) => {
    if (!reads.has(id)) {
      try { reads.set(id, { item: await store!.get(id) }); } catch (err) { reads.set(id, { err }); }
    }
    return reads.get(id)!;
  };
  const getOrNull = async (id: string): Promise<WorkRecordItem | null> => {
    const r = await readItem(id);
    return "item" in r ? r.item : null;
  };
  const liveFeature = async (id: string): Promise<boolean> => isRecordFeature(await getOrNull(id));
  // The feature is resolved NOW from the task's current parent (a task moved since the observation was tagged follows it).
  // Only a task that cannot be read (or a store that does not report parents) falls back to the stored feature, then to the task.
  for (const o of opts.observations) {
    let key = o.work;
    if (store) {
      const task = await getOrNull(o.work);
      if (task && task.partOf !== undefined) {
        const parent = task.partOf;
        if (isRecordFeature(task)) key = task.id; // bound to the feature itself
        else if (parent && (await liveFeature(parent))) key = parent;
      } else if (o.feature && (await liveFeature(o.feature))) key = o.feature;
    }
    groups.set(key, [...(groups.get(key) ?? []), o]);
  }

  const outcomes: WorkRecordOutcome[] = [];
  for (const [work, obs] of groups) {
    const ids = obs.map((o) => o.id);
    if (!store) {
      onProgress?.(`  work ${work}: no Work API configured, ${obs.length} observation(s) stay pending`);
      state?.pending(work, "work-api-unavailable");
      outcomes.push({ work, ids, status: "pending", reason: WORK_API_UNAVAILABLE, cause: "work-api-unavailable" });
      continue;
    }
    if (state && !opts.ignoreBackoff && !state.due(work)) {
      onProgress?.(`  work ${work}: backing off, ${obs.length} observation(s) stay pending`);
      outcomes.push({ work, ids, status: "pending", reason: "backoff", cause: state.entry(work)?.cause ?? "work-api-unavailable", ...(state.entry(work)?.nextAttemptAt ? { retryAt: state.entry(work)!.nextAttemptAt } : {}), ...(state.entry(work)?.assignee ? { assignee: state.entry(work)!.assignee } : {}) });
      continue;
    }
    let phase: PendingCause = "work-api-unavailable";
    let assignee: string | undefined;
    try {
      const read = await readItem(work);
      if ("err" in read) throw read.err;
      const item = read.item;
      assignee = item?.assignee;
      if (!item && store.healthy && !(await store.healthy())) throw new Error("Work API unhealthy: a 404 proves nothing");
      if (!item && state && !state.missing(work)) {
        onProgress?.(`  work ${work}: not found, waiting to confirm before discarding ${obs.length} observation(s)`);
        outcomes.push({ work, ids, status: "pending", reason: "not found, in grace period", cause: "work-api-unavailable" });
        continue;
      }
      if (!item || item.stage === "archived") {
        clearEntries(state, work, obs);
        const reason = item ? "archived" : "deleted";
        onProgress?.(`  work ${work}: item is ${reason}, ${obs.length} observation(s) are discarded`);
        outcomes.push({ work, ids: obs.map((o) => o.id), status: "discarded", reason });
        continue;
      }

      const current = extractRecord(item.body);
      const ask = async (tooLong?: number) => {
        phase = "consolidation-failed";
        const r = WorkRecordSchema.parse(
          await engine.call("workRecord", WorkRecordSchema, {
            system: WORK_RECORD_SYSTEM,
            prompt: buildPrompt(item, current, obs, tooLong),
          }),
        );
        phase = "work-api-unavailable";
        return r;
      };

      let record: WorkRecord = await ask();
      let rendered = renderRecord(record);
      if (rendered.length > RECORD_CAP) {
        record = await ask(rendered.length);
        rendered = renderRecord(record);
        if (rendered.length > RECORD_CAP) record = trimToCap(record, RECORD_CAP);
      }
      // The cap counts what is read; the sources ride along as comments.
      rendered = renderLines(resolveSources(record, current ? parseRecordLines(current) : [], obs.map((o) => ({ id: o.id, ...(o.timestamp ? { timestamp: o.timestamp } : {}) }))), true);

      // Only the Record section is written (a section op), so a plan edit made while the model ran cannot be overwritten:
      // no re-read before the write.
      await store.setRecord(work, rendered);
      clearEntries(state, work, obs);
      onProgress?.(`  work ${work}: Record rewritten (${rendered.length} chars) from ${obs.length} observation(s)`);
      outcomes.push({ work, ids: obs.map((o) => o.id), status: "written", chars: stripSources(rendered).length });
    } catch (err) {
      const reason = err instanceof Error ? err.message.split("\n")[0] : String(err);
      // The item was archived between the read and the write: same as the archived path, the observations are discarded.
      if (err instanceof WorkApiError && err.status === 409 && err.code === RECORD_CLOSED_CODE) {
        clearEntries(state, work, obs);
        onProgress?.(`  work ${work}: item is archived, ${obs.length} observation(s) are discarded`);
        outcomes.push({ work, ids, status: "discarded", reason: "archived" });
        continue;
      }
      // A 403 is final, not an outage: kept pending with the hub's message, no backoff, retried on the next run only.
      if (err instanceof WorkApiError && err.status === 403) {
        onProgress?.(`  work ${work}: refused by the hub, ${obs.length} observation(s) stay pending — ${reason}`);
        // Deliberate: nextAttemptAt stays 0 for "forbidden", so a refused item costs one model call per run. Refusals are rare now that
        // the Record is open to every wolf, and that cost is accepted.
        state?.pending(work, "forbidden", { message: reason, ...(assignee ? { assignee } : {}) });
        outcomes.push({ work, ids, status: "pending", reason, cause: "forbidden", ...(assignee ? { assignee } : {}) });
        continue;
      }
      onProgress?.(`  work ${work}: ${isInfra(err) ? "model unavailable" : "failed"}, ${obs.length} observation(s) stay pending — ${reason}`);
      state?.pending(work, phase);
      const retryAt = state?.entry(work)?.nextAttemptAt;
      outcomes.push({ work, ids, status: "pending", reason, cause: phase, ...(retryAt ? { retryAt } : {}) });
    }
  }
  state?.save();
  return outcomes;
}
