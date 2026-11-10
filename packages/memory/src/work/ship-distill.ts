/**
 * Ship distill: when a task ships, one model call turns its log (the task's `## Record`) into at most 5 lines
 * of its feature's Record, exactly once.
 *
 * The once-only marker is carried by the lines' ids: the lines of the LAST group carry `distilled:<taskId>` (every
 * line also has a stable `distilled:<taskId>:<kind>:<n>`), so the marker means every group landed; it shows
 * up in the stored `<!-- src:… -->` comment. The hub dedupes a line whose ids are all present, so a racing second
 * ship adds nothing, and the check below (an id in the feature Record) stops a later ship before any model call.
 * (A literal `<!-- distilled:… -->` cannot be sent: the hub refuses comment markers in line text.)
 * When the model returns nothing, a single marker line is written so the task is not retried forever.
 *
 * Only a bounded slice of the feature goes to the model: Outcomes one-liners, Record headings, last 6 bullets.
 * Never throws: a failure is `{ok:false, reason}`.
 */
import { z } from "zod";
import { WORK_DISTILL_SYSTEM, buildWorkDistillPrompt, parseWorkDistillOutput, type Engine } from "@wolfpack/engine";
import { extractRecord, RECORD_HEADING, type WorkRecordStore, type RecordAppendLine, type RecordLineKind } from "../work-record.js";
import { appendCompacting } from "./compact.js";
import { outcomesText } from "./rollup.js";

export type ShipDistillResult =
  | { ok: true; status: "distilled" | "marker-only" | "already" | "skipped"; lines: number }
  | { ok: false; reason: string };

export const distilledId = (taskId: string): string => `distilled:${taskId}`;

const MAX_TEXT = 240;

/** The model's group heading → the protocol's line kind (the hub accepts only these four). */
const GROUP_LINE_KIND: Record<string, RecordLineKind> = { Decisions: "decision", Changes: "change", Findings: "finding", "Problems & fixes": "problem" };
const kindOfGroup = (group: string): RecordLineKind => GROUP_LINE_KIND[group] ?? "change";

const recordLines = (body: string): string[] =>
  (extractRecord(body) ?? "")
    .slice(RECORD_HEADING.length)
    .split("\n")
    .map((l) => l.replace(/<!--.*?-->/g, "").trim())
    .filter(Boolean);

export async function distillTaskToFeature(opts: {
  store: WorkRecordStore;
  engine: Pick<Engine, "call">;
  taskId: string;
  /** Plain label for the lines' source (the acting wolf). */
  src: string;
  now?: () => Date;
}): Promise<ShipDistillResult> {
  const { store, engine, taskId } = opts;
  try {
    const task = await store.get(taskId);
    if (!task || !task.partOf) return { ok: true, status: "skipped", lines: 0 };
    const log = recordLines(task.body).filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
    if (!log.length) return { ok: true, status: "skipped", lines: 0 };
    const feature = await store.get(task.partOf);
    if (!feature || feature.kind !== "feature" || feature.container) return { ok: true, status: "skipped", lines: 0 };

    const marker = distilledId(taskId);
    const rec = extractRecord(feature.body) ?? "";
    const esc = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`src:[^>]*${esc}(?=[,\\s])`).test(rec)) {
      return { ok: true, status: "already", lines: 0 };
    }

    const recLines = recordLines(feature.body);
    const prompt = buildWorkDistillPrompt({
      taskId,
      title: task.title,
      log,
      outcomes: outcomesText(feature.body).split("\n").map((l) => l.trim()).filter(Boolean),
      recordHeadings: recLines.filter((l) => l.startsWith("### ")).map((l) => l.slice(4)),
      recordBullets: recLines.filter((l) => l.startsWith("- ")).map((l) => l.slice(2)).slice(-6),
    });
    const raw = await engine.call("workDistill", z.object({ lines: z.array(z.unknown()) }), { system: WORK_DISTILL_SYSTEM, prompt });
    const lines = parseWorkDistillOutput(JSON.stringify(raw));

    const at = (opts.now?.() ?? new Date()).toISOString();
    if (!lines.length) {
      const r = await appendCompacting({ store, engine, id: feature.id, kind: feature.kind, src: opts.src, group: "Changes", lines: [{ at, src: opts.src, kind: "change", text: `${taskId}: nothing durable to add`, ids: [marker] }] });
      return r.ok ? { ok: true, status: "marker-only", lines: 0 } : { ok: false, reason: `append failed: ${r.code}` };
    }
    // One append per group (the hub places a call's lines under one heading). Each line has a stable per-group id
    // (`distilled:<task>:<kind>:<n>`), so a retry after a partial failure is deduped by the hub. The completion marker
    // `distilled:<task>` goes only on the LAST group's lines, so "already" means every group was written.
    const groups = [...new Set(lines.map((l) => l.group))];
    for (const [gi, group] of groups.entries()) {
      const last = gi === groups.length - 1;
      const kind = kindOfGroup(group);
      const batch: RecordAppendLine[] = lines
        .filter((l) => l.group === group)
        .map((l, i) => ({ at, src: opts.src, kind, text: l.text.slice(0, MAX_TEXT), ids: [`${marker}:${kind}:${i + 1}`, ...(last ? [marker] : [])] }));
      const r = await appendCompacting({ store, engine, id: feature.id, kind: feature.kind, src: opts.src, group, lines: batch });
      if (!r.ok) return { ok: false, reason: `append failed: ${r.code}` };
    }
    return { ok: true, status: "distilled", lines: lines.length };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** The part of the Work client the sweep reads: list calls only (bodies come from the store). */
export interface SweepClient {
  query(q: { kind?: string; partOf?: string }): Promise<Array<{ id: string; kind?: string; stage?: string; updated?: string }>>;
}

const SWEEP_STAGES = new Set(["shipped", "live", "archived"]);
/** Task bodies read per sweep, skipped (empty Record) ones included: bounds hub reads when many old tasks have no log. */
const MAX_SWEEP_READS = 20;

/**
 * Catch-up for tasks that shipped or were archived before the distill existed (or while the model was down):
 * distil those whose feature Record lacks `distilled:<taskId>`, oldest first, at most `limit` (default 3) model
 * attempts per run. Hub reads: one `query` for features (none when `featureId` is given), one per feature for its
 * children, one `get` per feature that has candidates, and one `get` per candidate tried (at most 20).
 * A task with no Record lines costs no model call and no limit. A failed task is left for the next run.
 * Never throws.
 */
export async function sweepPendingDistills(opts: {
  client: SweepClient;
  store: WorkRecordStore;
  engine: Pick<Engine, "call">;
  featureId?: string;
  src: string;
  limit?: number;
  now?: () => Date;
}): Promise<{ distilled: string[]; failed: string[] }> {
  const out = { distilled: [] as string[], failed: [] as string[] };
  try {
    const limit = opts.limit ?? 3;
    const featureIds = opts.featureId ? [opts.featureId] : (await opts.client.query({ kind: "feature" })).map((f) => f.id);
    const candidates: Array<{ id: string; updated: string }> = [];
    for (const fid of featureIds) {
      const kids = (await opts.client.query({ partOf: fid })).filter((k) => (k.kind ?? "task") === "task" && SWEEP_STAGES.has(k.stage ?? ""));
      if (!kids.length) continue;
      const rec = extractRecord((await opts.store.get(fid))?.body ?? "") ?? "";
      for (const k of kids) {
        const esc = distilledId(k.id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (!new RegExp(`src:[^>]*${esc}(?=[,\\s])`).test(rec)) candidates.push({ id: k.id, updated: k.updated ?? "" });
      }
    }
    candidates.sort((a, b) => a.updated.localeCompare(b.updated));
    let attempts = 0;
    let reads = 0;
    for (const c of candidates) {
      if (attempts >= limit || reads >= MAX_SWEEP_READS) break;
      reads++;
      const r = await distillTaskToFeature({ store: opts.store, engine: opts.engine, taskId: c.id, src: opts.src, now: opts.now });
      if (!r.ok) {
        attempts++;
        out.failed.push(c.id);
      } else if (r.status === "distilled" || r.status === "marker-only") {
        attempts++;
        out.distilled.push(c.id);
      }
    }
  } catch (err) {
    console.warn("[ship-distill] sweep failed:", err instanceof Error ? err.message : String(err));
  }
  return out;
}
