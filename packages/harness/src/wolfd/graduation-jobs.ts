/**
 * Graduation jobs: a preview or confirm runs in the background of wolfd, keyed by wolf then work item, so the HTTP
 * request that started it returns at once instead of holding a connection through a drain and a model call.
 *
 * - A start of the SAME kind while a job for the item runs returns that job (idempotent), never a second run.
 *   A start of the OTHER kind is refused with `busy`: handing back a job of another kind would leave the caller
 *   polling for an outcome that never arrives.
 * - A finished job stays in memory until the next start for its item, but not forever: a `preview_ready` expires with
 *   its token (the preview's own TTL), `graduated` and `error` after a short TTL, so the map stays bounded.
 * - A restart loses them; the status route recovers a finished preview from its token file (`pendingPreview`).
 */
import { randomUUID } from "node:crypto";
import type { ErrorCode, GraduationJob, GraduationJobKind, GraduationPreview, GraduationResult } from "@wolfpack/protocol";
import { GRADUATION_PREVIEW_TTL_MS } from "../memory/actions.js";
import { HttpError } from "./http-error.js";

export type JobOutcome = { kind: "preview"; preview: GraduationPreview } | { kind: "confirm"; result: GraduationResult };

export type JobEntry =
  | GraduationJob
  | { state: "preview_ready"; jobId: string; preview: GraduationPreview }
  | { state: "graduated"; jobId: string; result: GraduationResult }
  | { state: "error"; jobId: string; kind: GraduationJobKind; code: ErrorCode; message: string };

type Stored = { entry: JobEntry; at: number };

/** How long a finished graduated / error entry is kept. */
export const FINISHED_TTL_MS = 60 * 60 * 1000;

export interface GraduationJobsOptions {
  now?: () => number;
  previewTtlMs?: number;
  finishedTtlMs?: number;
}

export class GraduationJobs {
  private readonly byWolf = new Map<string, Map<string, Stored>>();
  private readonly now: () => number;
  private readonly previewTtl: number;
  private readonly finishedTtl: number;

  constructor(opts: GraduationJobsOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.previewTtl = opts.previewTtlMs ?? GRADUATION_PREVIEW_TTL_MS;
    this.finishedTtl = opts.finishedTtlMs ?? FINISHED_TTL_MS;
  }

  private put(wolf: string, id: string, entry: JobEntry): void {
    let items = this.byWolf.get(wolf);
    if (!items) this.byWolf.set(wolf, (items = new Map()));
    items.set(id, { entry, at: this.now() });
  }

  private expired(s: Stored): boolean {
    if (s.entry.state === "preview_ready") return this.now() - Date.parse(s.entry.preview.createdAt) > this.previewTtl;
    if (s.entry.state === "graduated" || s.entry.state === "error") return this.now() - s.at > this.finishedTtl;
    return false;
  }

  private prune(): void {
    for (const [wolf, items] of this.byWolf) {
      for (const [id, s] of items) if (this.expired(s)) items.delete(id);
      if (items.size === 0) this.byWolf.delete(wolf);
    }
  }

  /**
   * Start `run` as the job of (wolf, id), or return the running job of the same kind. Throws `busy` (HttpError) when a job
   * of the other kind runs. Never rejects afterwards: a failure becomes the job's error.
   */
  start(wolf: string, id: string, kind: GraduationJobKind, run: () => Promise<JobOutcome>, fail: (e: unknown) => { code: ErrorCode; message: string }): GraduationJob {
    this.prune();
    const current = this.get(wolf, id);
    if (current?.state === "running") {
      if (current.kind === kind) return current;
      throw new HttpError("busy", `a ${current.kind} of this feature is already running; wait for it to finish`, undefined, { kind: current.kind });
    }
    const job: GraduationJob = { jobId: randomUUID(), kind, state: "running", startedAt: new Date(this.now()).toISOString() };
    this.put(wolf, id, job);
    const failed = (e: unknown): JobEntry => {
      let f: { code: ErrorCode; message: string };
      try {
        f = fail(e);
      } catch {
        f = { code: "engine_error", message: e instanceof Error ? e.message : String(e) };
      }
      return { state: "error", jobId: job.jobId, kind, ...f };
    };
    void (async () => {
      try {
        const out = await run();
        this.put(wolf, id, out.kind === "preview" ? { state: "preview_ready", jobId: job.jobId, preview: out.preview } : { state: "graduated", jobId: job.jobId, result: out.result });
      } catch (e) {
        this.put(wolf, id, failed(e));
      }
    })().catch(() => this.put(wolf, id, { state: "error", jobId: job.jobId, kind, code: "engine_error", message: "graduation job failed" }));
    return job;
  }

  /** The in-memory state of the item, if any; an entry past its TTL counts as absent and is dropped. */
  get(wolf: string, id: string): JobEntry | undefined {
    const items = this.byWolf.get(wolf);
    const s = items?.get(id);
    if (!s) return undefined;
    if (this.expired(s)) {
      items!.delete(id);
      if (items!.size === 0) this.byWolf.delete(wolf);
      return undefined;
    }
    return s.entry;
  }
}
