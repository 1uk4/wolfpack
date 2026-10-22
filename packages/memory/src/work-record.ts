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
 * Failure rules: an infra error (Work API down, model unavailable) leaves the
 * observations pending for the next run; an item that is archived, deleted or
 * unreachable-by-config falls back to den consolidation.
 */
import { z } from "zod";
import { LlmInfraError, WORK_RECORD_SYSTEM, type Engine } from "@wolfpack/engine";

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
  const doc = body.trim();
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
  const text = record.slice(RECORD_HEADING.length).trim();
  if (!text) return "";
  const head = `## Feature Record — ${featureTitle} (shared by all its tasks; kept up to date by memory)`;
  const room = Math.max(0, cap - head.length - 2);
  const body = text.length <= room ? text : text.slice(0, Math.max(0, room - 5)).trimEnd() + " […]";
  return `${head}\n\n${body}`;
}

// ── the Record's shape ───────────────────────────────────────────────────────

export const WorkRecordSchema = z.object({
  decisions: z.array(z.object({ decision: z.string().min(1), why: z.string().default("") })),
  changes: z.array(z.string().min(1)),
  findings: z.array(z.string().min(1)),
  problems: z.array(z.string().min(1)),
});
export type WorkRecord = z.infer<typeof WorkRecordSchema>;

const one = (s: string) => s.replace(/\s+/g, " ").trim();

function bullets(items: string[]): string {
  return items.map((i) => `- ${one(i)}`).join("\n");
}

/** Render the fixed layout; empty groups are left out, order is fixed. */
export function renderRecord(r: WorkRecord): string {
  const groups: Array<[string, string[]]> = [
    ["Decisions", r.decisions.map((d) => (d.why.trim() ? `${one(d.decision)} — why: ${one(d.why)}` : one(d.decision)))],
    ["Changes", r.changes],
    ["Findings", r.findings],
    ["Problems & fixes", r.problems],
  ];
  const parts = groups.filter(([, items]) => items.length > 0).map(([name, items]) => `### ${name}\n\n${bullets(items)}`);
  return [RECORD_HEADING, ...parts].join("\n\n");
}

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
  /** Unique id (the observation's timestamp). */
  id: string;
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
  /** Item archived, deleted or no store: the observations go to den consolidation. */
  | { work: string; ids: string[]; status: "fallback"; reason: string }
  /** Infra error: the observations stay pending for the next run. */
  | { work: string; ids: string[]; status: "pending"; reason: string };

export interface ConsolidateWorkOptions {
  engine: Engine;
  /** Absent → every group falls back to den consolidation. */
  store?: WorkRecordStore;
  observations: WorkObservation[];
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
    "CURRENT RECORD:",
    current ?? "(empty — no Record yet)",
    "",
    "NEW OBSERVATIONS:",
    ...obs.map((o) => `- ${o.content}`),
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
  const { engine, store, onProgress } = opts;
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
    if (!store) {
      onProgress?.(`  work ${work}: no Work API configured, ${obs.length} observation(s) go to the den`);
      outcomes.push({ work, ids: obs.map((o) => o.id), status: "fallback", reason: "no Work API configured" });
      continue;
    }
    try {
      const item = await store.get(work);
      if (!item || item.stage === "archived") {
        const reason = item ? "archived" : "deleted";
        onProgress?.(`  work ${work}: item is ${reason}, ${obs.length} observation(s) go to the den`);
        outcomes.push({ work, ids: obs.map((o) => o.id), status: "fallback", reason });
        continue;
      }

      const current = extractRecord(item.body);
      const ask = async (tooLong?: number) =>
        WorkRecordSchema.parse(
          await engine.call("workRecord", WorkRecordSchema, {
            system: WORK_RECORD_SYSTEM,
            prompt: buildPrompt(item, current, obs, tooLong),
          }),
        );

      let record = await ask();
      let rendered = renderRecord(record);
      if (rendered.length > RECORD_CAP) {
        record = await ask(rendered.length);
        rendered = renderRecord(record);
        if (rendered.length > RECORD_CAP) rendered = renderRecord(trimToCap(record, RECORD_CAP));
      }

      // Re-read right before the write so a plan edit made while the model
      // ran is not overwritten (only the Record section is ours).
      const fresh = (await store.get(work)) ?? item;
      await store.setBody(work, replaceRecordSection(fresh.body, rendered));
      onProgress?.(`  work ${work}: Record rewritten (${rendered.length} chars) from ${obs.length} observation(s)`);
      outcomes.push({ work, ids: obs.map((o) => o.id), status: "written", chars: rendered.length });
    } catch (err) {
      const reason = err instanceof Error ? err.message.split("\n")[0] : String(err);
      onProgress?.(`  work ${work}: ${isInfra(err) ? "model unavailable" : "failed"}, ${obs.length} observation(s) stay pending — ${reason}`);
      outcomes.push({ work, ids: obs.map((o) => o.id), status: "pending", reason });
    }
  }
  return outcomes;
}
