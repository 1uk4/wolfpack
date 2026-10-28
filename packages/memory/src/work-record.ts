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
import { z } from "zod";
import { LlmInfraError, WORK_RECORD_SYSTEM, type Engine } from "@wolfpack/engine";
import type { PendingCause, WorkPendingState } from "./work-pending.js";
import { formatSources, lineRef, numberRecordLines, parseRecordLines, stripSources, SOURCE_CAP, type RecordLine, type SourceRef } from "./record-sources.js";

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
 * The working document for context injection, capped. The Record has
 * priority: when the whole document does not fit, the plan is clipped first
 * (it keeps at least PLAN_MIN characters). Document order is kept: plan, then Record.
 */
export function renderWorkingDocument(body: string, cap: number = DOCUMENT_CAP): string {
  const doc = stripSources(body).trim();
  if (doc.length <= cap) return doc;
  const record = extractRecord(doc) ?? "";
  const plan = withoutRecord(doc);
  const recordRoom = Math.max(0, Math.min(record.length, cap - Math.min(plan.length, PLAN_MIN) - 2));
  const planRoom = Math.max(0, cap - recordRoom - 2);
  const clip = (t: string, n: number) => (t.length <= n ? t : n <= 5 ? "" : t.slice(0, n - 5).trimEnd() + " […]");
  return [plan ? clip(plan, planRoom) : "", record ? clip(record, recordRoom) : ""].filter(Boolean).join("\n\n");
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

const one = (s: string) => s.replace(/\s+/g, " ").trim();

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
}

function renderLines(lines: RenderedLine[], withSources: boolean): string {
  const parts = GROUPS.map((name) => [name, lines.filter((l) => l.group === name)] as const)
    .filter(([, items]) => items.length > 0)
    .map(([name, items]) => `### ${name}\n\n${items.map((i) => `- ${i.text}${withSources ? formatSources(i.sources, i.batch) : ""}`).join("\n")}`);
  return [RECORD_HEADING, ...parts].join("\n\n");
}

/** Render the fixed layout without sources; empty groups are left out, order is fixed. */
export function renderRecord(r: WorkRecord): string {
  return renderLines(flatten(r).map((i) => ({ group: i.group, text: i.text, sources: [], batch: false })), false);
}

const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Attach sources to the answer's lines. A line's refs resolve to the batch's observations (`oN`) and to the
 * sources of existing lines it carries over (`rN`). With no usable ref, a line whose text is an existing line
 * keeps that line's sources, and any other line gets the whole batch's (flagged `batch`).
 * A ref to an existing line without sources (an older Record) adds none: it is not blamed on the batch.
 */
export function resolveSources(r: WorkRecord, current: RecordLine[], batch: SourceRef[]): RenderedLine[] {
  const byText = new Map(current.map((l) => [norm(l.text), l]));
  return flatten(r).map((it): RenderedLine => {
    const text = it.text.replace(/^\[[ro]\d+\]\s*/, "");
    const sources: SourceRef[] = [];
    let batchLevel = false;
    let mapped = false;
    const add = (refs: SourceRef[]) => {
      for (const ref of refs) if (!sources.some((s) => s.id === ref.id)) sources.push(ref);
    };
    for (const f of it.from) {
      const m = /^\[?([ro])(\d+)\]?$/i.exec(f.trim());
      if (!m) continue;
      const n = Number(m[2]) - 1;
      if (m[1].toLowerCase() === "o" && batch[n]) { mapped = true; add([batch[n]]); }
      else if (m[1].toLowerCase() === "r" && current[n]) { mapped = true; add(current[n].sources); batchLevel ||= current[n].batch; }
    }
    if (!mapped) {
      const same = byText.get(norm(text));
      if (same) { add(same.sources); batchLevel = same.batch; }
      else { add(batch); batchLevel = true; }
    }
    return { group: it.group, text, sources: sources.slice(-SOURCE_CAP), batch: batchLevel };
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
  /** The working document ("" when none written yet). */
  body: string;
}

export interface WorkRecordStore {
  /** The item and its document; null when it no longer exists. Throws on any other failure (the run stays pending). */
  get(id: string): Promise<WorkRecordItem | null>;
  /** Replace the whole document. */
  setBody(id: string, body: string): Promise<void>;
  /** The Work API answers a list call. Absent: a successful get is taken as proof of health. */
  healthy?(): Promise<boolean>;
}

/** The Work API over HTTP (WORK_ENDPOINT / WORK_TOKEN, like the extensions' client). */
export class HttpWorkRecordStore implements WorkRecordStore {
  private endpoint: string;
  private token: string;

  constructor(endpoint?: string, token?: string, private fetchImpl: typeof fetch = fetch) {
    this.endpoint = (endpoint ?? process.env.WORK_ENDPOINT ?? "").replace(/\/$/, "");
    this.token = token ?? process.env.WORK_TOKEN ?? "";
  }

  get configured(): boolean {
    return !!(this.endpoint && this.token);
  }

  private async call(method: string, id: string, body?: unknown): Promise<Response> {
    if (!this.configured) throw new Error("Work API not configured (WORK_ENDPOINT / WORK_TOKEN missing)");
    return this.fetchImpl(`${this.endpoint}/work/${encodeURIComponent(id)}`, {
      method,
      headers: { "X-API-Key": this.token, ...(body ? { "Content-Type": "application/json" } : {}) },
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
      successCriteria: typeof it.successCriteria === "string" ? it.successCriteria : undefined,
      body: data.body ?? "",
    };
  }

  async setBody(id: string, body: string): Promise<void> {
    const res = await this.call("PATCH", id, { body });
    if (!res.ok) throw new Error(`Work API PATCH ${id}: HTTP ${res.status}`);
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
  | { work: string; ids: string[]; status: "pending"; reason: string; cause: PendingCause };

/** The reason a pending outcome carries when the Work API is missing or unreachable. */
export const WORK_API_UNAVAILABLE = "work-api-unavailable";

export interface ConsolidateWorkOptions {
  engine: Engine;
  /** Absent (Work API not configured) → every group stays pending; tagged observations never go to the den. */
  store?: WorkRecordStore;
  observations: WorkObservation[];
  /** Retry backoff and the 404 grace period. Absent: every group is tried now and a 404 discards at once. */
  state?: WorkPendingState;
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
  const featureOk = new Map<string, boolean>();
  for (const o of opts.observations) {
    let key = o.work;
    if (o.feature && store) {
      if (!featureOk.has(o.feature)) {
        try { featureOk.set(o.feature, isRecordFeature(await store.get(o.feature))); } catch { featureOk.set(o.feature, false); }
      }
      if (featureOk.get(o.feature)) key = o.feature;
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
    if (state && !state.due(work)) {
      onProgress?.(`  work ${work}: backing off, ${obs.length} observation(s) stay pending`);
      outcomes.push({ work, ids, status: "pending", reason: "backoff", cause: state.entry(work)?.cause ?? "work-api-unavailable" });
      continue;
    }
    let phase: PendingCause = "work-api-unavailable";
    try {
      const item = await store.get(work);
      if (!item && store.healthy && !(await store.healthy())) throw new Error("Work API unhealthy: a 404 proves nothing");
      if (!item && state && !state.missing(work)) {
        onProgress?.(`  work ${work}: not found, waiting to confirm before discarding ${obs.length} observation(s)`);
        outcomes.push({ work, ids, status: "pending", reason: "not found, in grace period", cause: "work-api-unavailable" });
        continue;
      }
      if (!item || item.stage === "archived") {
        state?.clear(work);
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

      // Re-read right before the write so a plan edit made while the model
      // ran is not overwritten (only the Record section is ours).
      const fresh = (await store.get(work)) ?? item;
      await store.setBody(work, replaceRecordSection(fresh.body, rendered));
      state?.clear(work);
      onProgress?.(`  work ${work}: Record rewritten (${rendered.length} chars) from ${obs.length} observation(s)`);
      outcomes.push({ work, ids: obs.map((o) => o.id), status: "written", chars: stripSources(rendered).length });
    } catch (err) {
      const reason = err instanceof Error ? err.message.split("\n")[0] : String(err);
      onProgress?.(`  work ${work}: ${isInfra(err) ? "model unavailable" : "failed"}, ${obs.length} observation(s) stay pending — ${reason}`);
      state?.pending(work, phase);
      outcomes.push({ work, ids, status: "pending", reason, cause: phase });
    }
  }
  state?.save();
  return outcomes;
}
