/**
 * Ship distill: when a task ships, one model call turns its log (the task's `## Record`) into at most 5 lines
 * of its feature's Record, exactly once.
 *
 * The once-only marker is carried by the lines' ids: every appended line has the id `distilled:<taskId>` (plus a
 * unique `distilled:<taskId>:<n>`), so it lands in the same atomic hub append as the lines themselves and shows
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
import { extractRecord, RECORD_HEADING, type WorkRecordStore, type RecordAppendLine } from "../work-record.js";
import { outcomesText } from "./rollup.js";

export type ShipDistillResult =
  | { ok: true; status: "distilled" | "marker-only" | "already" | "skipped"; lines: number }
  | { ok: false; reason: string };

export const distilledId = (taskId: string): string => `distilled:${taskId}`;

const MAX_TEXT = 240;

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
    if (new RegExp(`src:[^>]*${esc}(?=[,:\\s])`).test(rec)) {
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
      const r = await store.appendRecord(feature.id, [{ at, src: opts.src, kind: "Changes", text: `${taskId}: nothing durable to add`, ids: [marker] }], { group: "Changes" });
      return r.ok ? { ok: true, status: "marker-only", lines: 0 } : { ok: false, reason: `append failed: ${r.code}` };
    }
    // One append per group (the hub places a call's lines under one heading); the marker id is on every line.
    let n = 0;
    for (const group of [...new Set(lines.map((l) => l.group))]) {
      const batch: RecordAppendLine[] = lines
        .filter((l) => l.group === group)
        .map((l) => ({ at, src: opts.src, kind: group, text: l.text.slice(0, MAX_TEXT), ids: [marker, `${marker}:${++n}`] }));
      const r = await store.appendRecord(feature.id, batch, { group });
      if (!r.ok) return { ok: false, reason: `append failed: ${r.code}` };
    }
    return { ok: true, status: "distilled", lines: lines.length };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
