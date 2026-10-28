import { describe, expect, it } from "vitest";
import type { GraduationPreview, GraduationResult } from "@wolfpack/protocol";
import { GraduationJobs, type JobOutcome } from "./graduation-jobs.js";

const HOUR = 3_600_000;
const preview = (createdAt: string): GraduationPreview => ({ itemId: "w", kind: "feature", title: "F", domain: "d", contributions: [], foldedObservations: 0, warnings: [], archive: [], token: "abc", createdAt, readiness: { ready: true } });
const result: GraduationResult = { graduated: true, entries: [], archived: [], lateFolded: 0, unbound: 0, closedThreads: [] };
const fail = (e: unknown) => ({ code: "engine_error" as const, message: e instanceof Error ? e.message : String(e) });
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
};
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("GraduationJobs", () => {
  it("a same-kind start returns the running job and runs once; an other-kind start is busy", async () => {
    const jobs = new GraduationJobs();
    const d = deferred<JobOutcome>();
    let runs = 0;
    const a = jobs.start("w1", "i", "preview", () => (runs++, d.promise), fail);
    const b = jobs.start("w1", "i", "preview", () => (runs++, d.promise), fail);
    expect(b).toEqual(a);
    expect(runs).toBe(1);
    expect(() => jobs.start("w1", "i", "confirm", async () => ({ kind: "confirm", result }), fail)).toThrowError(expect.objectContaining({ code: "busy", message: expect.stringContaining("preview"), details: { kind: "preview" } }));
    expect(jobs.get("w1", "i")).toMatchObject({ state: "running", jobId: a.jobId });
    d.resolve({ kind: "preview", preview: preview(new Date().toISOString()) });
    await tick();
    expect(jobs.get("w1", "i")).toMatchObject({ state: "preview_ready", jobId: a.jobId });
    // finished: a confirm may start now
    expect(jobs.start("w1", "i", "confirm", async () => ({ kind: "confirm", result }), fail).kind).toBe("confirm");
  });

  it("a failing run becomes the job's error; a fail() that throws falls back to engine_error", async () => {
    const jobs = new GraduationJobs();
    const a = jobs.start("w", "i", "preview", async () => { throw new Error("boom"); }, () => ({ code: "not_ready", message: "mapped" }));
    await tick();
    expect(jobs.get("w", "i")).toEqual({ state: "error", jobId: a.jobId, kind: "preview", code: "not_ready", message: "mapped" });
    const b = jobs.start("w", "j", "confirm", async () => { throw new Error("boom2"); }, () => { throw new Error("mapper broke"); });
    await tick();
    expect(jobs.get("w", "j")).toEqual({ state: "error", jobId: b.jobId, kind: "confirm", code: "engine_error", message: "boom2" });
  });

  it("never leaves an unhandled rejection behind", async () => {
    const seen: unknown[] = [];
    const on = (e: unknown) => void seen.push(e);
    process.on("unhandledRejection", on);
    try {
      const jobs = new GraduationJobs();
      jobs.start("w", "i", "preview", () => Promise.reject(new Error("x")), () => { throw new Error("y"); });
      jobs.start("w", "j", "preview", () => { throw new Error("sync"); }, fail);
      await new Promise((r) => setTimeout(r, 20));
      expect(seen).toEqual([]);
      expect(jobs.get("w", "j")).toMatchObject({ state: "error", message: "sync" });
    } finally {
      process.off("unhandledRejection", on);
    }
  });

  it("an in-memory preview_ready expires with its token and is dropped", async () => {
    let now = Date.parse("2026-10-28T10:00:00Z");
    const jobs = new GraduationJobs({ now: () => now, previewTtlMs: 6 * HOUR });
    jobs.start("w", "i", "preview", async () => ({ kind: "preview", preview: preview(new Date(now).toISOString()) }), fail);
    await tick();
    now += 5 * HOUR;
    expect(jobs.get("w", "i")?.state).toBe("preview_ready");
    now += 2 * HOUR;
    expect(jobs.get("w", "i")).toBeUndefined();
  });

  it("graduated and error entries expire after the short TTL", async () => {
    let now = Date.parse("2026-10-28T10:00:00Z");
    const jobs = new GraduationJobs({ now: () => now, finishedTtlMs: HOUR });
    jobs.start("w", "g", "confirm", async () => ({ kind: "confirm", result }), fail);
    jobs.start("w", "e", "preview", async () => { throw new Error("x"); }, fail);
    await tick();
    now += HOUR / 2;
    expect(jobs.get("w", "g")?.state).toBe("graduated");
    expect(jobs.get("w", "e")?.state).toBe("error");
    now += HOUR;
    expect(jobs.get("w", "g")).toBeUndefined();
    expect(jobs.get("w", "e")).toBeUndefined();
  });

  it("a start prunes expired entries of other items and wolves", async () => {
    let now = Date.parse("2026-10-28T10:00:00Z");
    const jobs = new GraduationJobs({ now: () => now, finishedTtlMs: HOUR });
    jobs.start("old", "i", "preview", async () => { throw new Error("x"); }, fail);
    await tick();
    now += 2 * HOUR;
    jobs.start("new", "j", "preview", async () => ({ kind: "preview", preview: preview(new Date(now).toISOString()) }), fail);
    expect(jobs.get("old", "i")).toBeUndefined();
  });

  it("state does not leak between wolves or between items", async () => {
    const jobs = new GraduationJobs();
    const d = deferred<JobOutcome>();
    const a = jobs.start("w1", "i", "preview", () => d.promise, fail);
    expect(jobs.get("w2", "i")).toBeUndefined();
    expect(jobs.get("w1", "other")).toBeUndefined();
    // the same item on another wolf, and another item on the same wolf, start their own jobs (and may be of the other kind)
    const b = jobs.start("w2", "i", "confirm", async () => ({ kind: "confirm", result }), fail);
    const c = jobs.start("w1", "other", "confirm", async () => ({ kind: "confirm", result }), fail);
    expect(new Set([a.jobId, b.jobId, c.jobId]).size).toBe(3);
    await tick();
    expect(jobs.get("w1", "i")?.state).toBe("running");
    expect(jobs.get("w2", "i")?.state).toBe("graduated");
    d.resolve({ kind: "preview", preview: preview(new Date().toISOString()) });
  });
});
