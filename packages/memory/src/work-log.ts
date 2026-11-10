/**
 * Task log: turns the observations waiting for a task into a few Haiku-written lines and appends them to the task's Record
 * (hub `recordAppend`). The append-only counterpart of `consolidateWorkRecords`, with the same outcome shape plus `target`.
 *
 * Grouping: by `o.work`, one engine call and one append per group. An observation with only `feature`, or with
 * `work === feature`, is keyed to the feature and goes to the feature's own log.
 * Untagged observations (no work, no feature) are not this module's job: they are skipped, get no outcome, and so stay in the pool.
 *
 * Outcomes per group: written (appended, or the model found nothing durable: batch consumed) · discarded (item deleted or
 * archived) · pending (infra/model error, hub `error`, `forbidden`, or a full log; kept with backoff in `pending`).
 */
import { z } from "zod";
import { LlmInfraError, WORK_LOG_SYSTEM, buildWorkLogPrompt, parseWorkLogOutput, type Engine } from "@wolfpack/engine";
import type { PendingCause, WorkPendingState } from "./work-pending.js";
import { appendCompacting } from "./work/compact.js";
import { extractRecord, type RecordAppendLine, type WorkObservation, type WorkRecordItem, type WorkRecordOutcome, type WorkRecordStore } from "./work-record.js";

/** An observation as the log sees it: `work` may be empty when only `feature` is set. */
export type WorkLogObservation = Omit<WorkObservation, "work"> & { work?: string };

/** Same as a Record outcome, plus the item that holds the log (the task, or the feature for feature-only groups). */
export type WorkLogOutcome = WorkRecordOutcome & { target: string };

export interface AppendWorkLogOptions {
  engine: Engine;
  store: WorkRecordStore;
  observations: WorkLogObservation[];
  /** Backoff and the 404 grace period, as in `consolidateWorkRecords`. Absent: every group is tried now and a 404 discards at once. */
  pending?: WorkPendingState;
  now?: () => Date;
  /** Label stored on every line: the wolf or agent. */
  src: string;
}

/** The reason a pending outcome carries when the item's log has no room. */
export const LOG_FULL = "log_full";

const RECENT = 8;
const Schema = z.object({ lines: z.array(z.unknown()) }).passthrough();

const isInfra = (err: unknown) => err instanceof LlmInfraError || (err instanceof Error && err.cause instanceof LlmInfraError);

/** The last log lines of an item: Record bullets without their source comments or bullet marker. */
function recentLines(body: string): string[] {
  const rec = extractRecord(body);
  if (!rec) return [];
  return rec
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).replace(/\s*<!--.*?-->\s*$/, "").trim())
    .slice(-RECENT);
}

export async function appendWorkLog(opts: AppendWorkLogOptions): Promise<WorkLogOutcome[]> {
  const { engine, store, src, pending } = opts;
  const now = opts.now ?? (() => new Date());
  const groups = new Map<string, WorkLogObservation[]>();
  for (const o of opts.observations) {
    const key = o.work || o.feature;
    if (!key) continue; // untagged: not ours
    groups.set(key, [...(groups.get(key) ?? []), o]);
  }

  const outcomes: WorkLogOutcome[] = [];
  for (const [target, obs] of groups) {
    const ids = obs.map((o) => o.id);
    if (pending && !pending.due(target)) {
      const e = pending.entry(target);
      outcomes.push({ work: target, target, ids, status: "pending", reason: "backoff", cause: e?.cause ?? "work-api-unavailable", ...(e?.nextAttemptAt ? { retryAt: e.nextAttemptAt } : {}), ...(e?.assignee ? { assignee: e.assignee } : {}) });
      continue;
    }
    let phase: PendingCause = "work-api-unavailable";
    let assignee: string | undefined;
    try {
      const item: WorkRecordItem | null = await store.get(target);
      assignee = item?.assignee;
      if (!item && store.healthy && !(await store.healthy())) throw new Error("Work API unhealthy: a 404 proves nothing");
      if (!item && pending && !pending.missing(target)) {
        outcomes.push({ work: target, target, ids, status: "pending", reason: "not found, in grace period", cause: "work-api-unavailable" });
        continue;
      }
      if (!item || item.stage === "archived") {
        pending?.clear(target);
        outcomes.push({ work: target, target, ids, status: "discarded", reason: item ? "archived" : "deleted" });
        continue;
      }

      phase = "consolidation-failed";
      const raw = await engine.call("workLog", Schema, {
        system: WORK_LOG_SYSTEM,
        prompt: buildWorkLogPrompt({ title: item.title, observations: obs.map((o) => o.content), recentLines: recentLines(item.body) }),
      });
      phase = "work-api-unavailable";
      const lines = parseWorkLogOutput(JSON.stringify(raw));

      if (lines.length > 0) {
        const at = now().toISOString();
        const append: RecordAppendLine[] = lines.map((l) => {
          const mapped = l.from.flatMap((f) => {
            const n = /^o(\d+)$/.exec(f)?.[1];
            const o = n ? obs[Number(n) - 1] : undefined;
            return o ? [o.id] : [];
          });
          // A line the model did not map carries the whole batch.
          return { at, src, kind: l.kind, text: l.text, ids: [...new Set(mapped.length ? mapped : ids)] };
        });
        // On log_full: compact once and retry once (appendCompacting); still full falls through to the pending branch below.
        const res = await appendCompacting({ store, engine, id: target, kind: item.kind, src, lines: append });
        if (!res.ok) {
          if (res.code === "archived") {
            pending?.clear(target);
            outcomes.push({ work: target, target, ids, status: "discarded", reason: "archived" });
            continue;
          }
          if (res.code === "log_full") {
            pending?.pending(target, "consolidation-failed");
            const retryAt = pending?.entry(target)?.nextAttemptAt;
            outcomes.push({ work: target, target, ids, status: "pending", reason: LOG_FULL, cause: "consolidation-failed", ...(retryAt ? { retryAt } : {}) });
            continue;
          }
          const reason = res.message ?? res.code;
          if (res.code === "forbidden") {
            // Final, like a 403 in the fold: kept pending with the hub's message, no backoff.
            pending?.pending(target, "forbidden", { message: reason, ...(assignee ? { assignee } : {}) });
            outcomes.push({ work: target, target, ids, status: "pending", reason, cause: "forbidden", ...(assignee ? { assignee } : {}) });
            continue;
          }
          pending?.pending(target, "work-api-unavailable");
          const retryAt = pending?.entry(target)?.nextAttemptAt;
          outcomes.push({ work: target, target, ids, status: "pending", reason, cause: "work-api-unavailable", ...(retryAt ? { retryAt } : {}) });
          continue;
        }
      }
      pending?.clear(target);
      outcomes.push({ work: target, target, ids, status: "written", chars: lines.reduce((n, l) => n + l.text.length, 0) });
    } catch (err) {
      const reason = err instanceof Error ? err.message.split("\n")[0]! : String(err);
      pending?.pending(target, phase);
      const retryAt = pending?.entry(target)?.nextAttemptAt;
      outcomes.push({ work: target, target, ids, status: "pending", reason: isInfra(err) ? `model unavailable: ${reason}` : reason, cause: phase, ...(retryAt ? { retryAt } : {}) });
    }
  }
  pending?.save();
  return outcomes;
}
