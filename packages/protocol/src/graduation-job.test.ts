import { describe, expect, it } from "vitest";
import { GraduationJobSchema, GraduationObservationsSchema, GraduationStatusSchema } from "./schemas.js";

const preview = {
  itemId: "work-x-1234567",
  kind: "feature",
  title: "F",
  domain: "d",
  contributions: [],
  foldedObservations: 0,
  warnings: [],
  archive: [],
  token: "abc123",
  createdAt: "2026-10-28T10:00:00.000Z",
  readiness: { ready: true },
};

describe("graduation job schemas", () => {
  it("a started job is running", () => {
    const job = { jobId: "j1", kind: "preview", state: "running", startedAt: "2026-10-28T10:00:00.000Z" };
    expect(GraduationJobSchema.parse(job)).toEqual(job);
    expect(GraduationJobSchema.safeParse({ ...job, state: "done" }).success).toBe(false);
    expect(GraduationJobSchema.safeParse({ ...job, kind: "other" }).success).toBe(false);
  });

  it("the status is one of none, running, preview_ready, graduated and error", () => {
    const ok = [
      { state: "none" },
      { state: "running", jobId: "j", kind: "confirm", startedAt: "2026-10-28T10:00:00.000Z" },
      { state: "preview_ready", preview },
      { state: "preview_ready", jobId: "j", preview },
      { state: "preview_ready", preview, lastError: { kind: "confirm", code: "engine_error", message: "model exploded" } },
      { state: "graduated", jobId: "j", result: { graduated: true, entries: ["a"], archived: ["x"], lateFolded: 0, unbound: 1, closedThreads: [] } },
      { state: "error", jobId: "j", kind: "preview", code: "preview_stale", message: "gone" },
    ];
    for (const s of ok) expect(GraduationStatusSchema.parse(s)).toEqual(s);
  });

  it("a preview_ready lastError needs a kind, a known code and a message", () => {
    expect(GraduationStatusSchema.safeParse({ state: "preview_ready", preview, lastError: { kind: "confirm", code: "weird", message: "m" } }).success).toBe(false);
    expect(GraduationStatusSchema.safeParse({ state: "preview_ready", preview, lastError: { kind: "confirm" } }).success).toBe(false);
  });

  it("refuses an unknown state, a preview_ready without the preview and an error with an unknown code", () => {
    expect(GraduationStatusSchema.safeParse({ state: "done" }).success).toBe(false);
    expect(GraduationStatusSchema.safeParse({ state: "preview_ready" }).success).toBe(false);
    expect(GraduationStatusSchema.safeParse({ state: "error", jobId: "j", kind: "preview", code: "weird", message: "m" }).success).toBe(false);
  });

  it("the observation count carries a total and a per-work split", () => {
    const c = { total: 3, byWork: [{ id: "a", title: "A", count: 2 }, { id: "b", count: 1 }] };
    expect(GraduationObservationsSchema.parse(c)).toEqual(c);
    expect(GraduationObservationsSchema.safeParse({ total: 1 }).success).toBe(false);
  });
});
