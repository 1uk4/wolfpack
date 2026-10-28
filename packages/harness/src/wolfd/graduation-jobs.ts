/**
 * Graduation jobs: a preview or confirm runs in the background of wolfd, keyed by (wolf, work item), so the HTTP
 * request that started it returns at once instead of holding a connection through a drain and a model call.
 *
 * - A start while a job for the same key is running returns that job (idempotent), never a second run.
 * - A finished job stays in memory until the next start for its key: `preview_ready` (the preview), `graduated` (the
 *   result) or `error` (an error code and message). A restart loses them; the status route recovers a finished
 *   preview from its token file (`GraduationActions.pendingPreview`).
 */
import { randomUUID } from "node:crypto";
import type { ErrorCode, GraduationJob, GraduationJobKind, GraduationPreview, GraduationResult } from "@wolfpack/protocol";

export type JobOutcome = { kind: "preview"; preview: GraduationPreview } | { kind: "confirm"; result: GraduationResult };

export type JobEntry =
  | GraduationJob
  | { state: "preview_ready"; jobId: string; preview: GraduationPreview }
  | { state: "graduated"; jobId: string; result: GraduationResult }
  | { state: "error"; jobId: string; kind: GraduationJobKind; code: ErrorCode; message: string };

export class GraduationJobs {
  private readonly entries = new Map<string, JobEntry>();

  /** Start `run` as the job of `key`, or return the job already running for it. Never rejects: a failure becomes the job's error. */
  start(key: string, kind: GraduationJobKind, run: () => Promise<JobOutcome>, fail: (e: unknown) => { code: ErrorCode; message: string }): GraduationJob {
    const current = this.entries.get(key);
    if (current?.state === "running") return current;
    const job: GraduationJob = { jobId: randomUUID(), kind, state: "running", startedAt: new Date().toISOString() };
    this.entries.set(key, job);
    void run().then(
      (out) => this.entries.set(key, out.kind === "preview" ? { state: "preview_ready", jobId: job.jobId, preview: out.preview } : { state: "graduated", jobId: job.jobId, result: out.result }),
      (e) => this.entries.set(key, { state: "error", jobId: job.jobId, kind, ...fail(e) }),
    );
    return job;
  }

  get(key: string): JobEntry | undefined {
    return this.entries.get(key);
  }
}
