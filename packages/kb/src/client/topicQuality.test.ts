import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assessTopic, isTrivialChange, normalizeBody } from "./topicQuality.js";
import { emitDelta, isTrivialRepromote } from "./emitDelta.js";
import type { KbRoots } from "../shared/index.js";

const workoutLog = {
  title: "Workout Log — Monday Upper Push (Oct 21, 2026)",
  summary: "Mon Oct 21 Upper Push completed: abs, full lifts",
  body: `## Session: mon-upper-push-oct21

**Date:** 2026-10-21
**Type:** Upper Push
**Started:** ~8:04 PM

### Lifts
- DB flat press: 4×6-8 at 70 lb/hand
- Assisted pull-up: 4×6-10 at 120 lb resistance

### Notes
- Session had an earlier incomplete attempt that was abandoned`,
};

const weekPlanning = {
  title: "Week 43 Planning",
  summary: "Reading goal, job application, daily planning feature rename",
  body: `# Week 43 Planning

## Reading Goal
**Goal**: Complete chapters 3-9 by Sunday Oct 25

## Week 43 — Monday Oct 20
Started chapter 3.`,
};

const diary = {
  title: "Section Placement Bug Fix",
  summary: "bug fix",
  body: `## Bug Discovery (October 17, 17:30)
Found it today.
### Proposed Fix (October 17)
Drafted yesterday.
### Fix Implementation (October 19, 19:10-19:12)
Done.`,
};

const actionLog = {
  title: "Repo cleanup",
  summary: "cleanup",
  body: [
    "- Removed dead code in a1b2c3d",
    "- Fixed the build in 5de1684",
    "- Added tests for the sweep",
    "- Updated docs",
    "- Deployed to sfo-01",
    "- Merged the branch",
    "- Ran the full suite",
  ].join("\n"),
};

const timestamps = {
  title: "Sweep notes",
  summary: "s",
  body: "- 2026-10-21 18:04 started sweep\n- 2026-10-21 18:09 sweep failed\n- 2026-10-21 18:30 retried\n- 2026-10-21 18:41 done",
};

const currentState = {
  title: "KB Web Dashboard Architecture",
  summary: "KB dashboard served by wolfpack-agent at :3141",
  body: `# KB Web Dashboard

The dashboard is served by wolfpack-agent at :3141/dashboard, Tailscale-only with no extra auth.

## Data
GET /api/kb reads the registry and returns sections, entries and relations.

## Decisions
- vis-network physics graph, because the hierarchy layout collapsed large domains.
- Introduced in commit 5de1684 (Oct 16 reorg); see also 9f3a2b1.`,
};

const trainingProgram = {
  title: "4-Day Hybrid Athlete Training Split",
  summary: "Upper A, Lower A, Upper B, Lower B",
  body: `# Training split

- Upper A: strength, 4×6-8
- Lower A: quad-heavy
- Upper B: hypertrophy
- Lower B: posterior chain

Deload every fourth week. Progress when all sets hit the top of the rep range.`,
};

const mentionsDeadline = {
  title: "Pure job application",
  summary: "Deadline Oct 25",
  body: "Applying for Software Engineer at Pure (NYC, on-site). Deadline: 2026-10-25. Link kept in the work item.",
};

describe("assessTopic — session logs fail", () => {
  it.each([
    ["workout log", workoutLog],
    ["week planning", weekPlanning],
    ["dated-heading diary", diary],
    ["past-tense action bullets with hashes", actionLog],
    ["ISO timestamps", timestamps],
  ])("%s is not promotable", (_n, t) => {
    const q = assessTopic(t);
    expect(q.promotable).toBe(false);
    expect(q.reason).toMatch(/session log/);
  });
});

describe("assessTopic — durable topics pass", () => {
  it.each([
    ["current-state architecture with commit refs and a date", currentState],
    ["training split", trainingProgram],
    ["one ISO deadline", mentionsDeadline],
  ])("%s is promotable", (_n, t) => {
    expect(assessTopic(t).promotable).toBe(true);
  });

  it("ignores dates inside code fences", () => {
    const body = "# Format\n\n```\n## 2026-10-21\n### Oct 21\n### Oct 22\n```\n\nEntries use ISO dates.";
    expect(assessTopic({ title: "Changelog format", body }).promotable).toBe(true);
  });
});

describe("isTrivialChange", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `Fact number ${i} about the system`).join("\n");

  it("treats whitespace, punctuation and case changes as trivial", () => {
    expect(isTrivialChange("The API is at :3141.\n\nIt is Tailscale-only.", "the api is at 3141\nit is tailscale only")).toBe(true);
    expect(normalizeBody("A,  B!\n\n\nC")).toBe("a b\nc");
  });

  it("treats a real change in a short body as meaningful", () => {
    expect(isTrivialChange("Port is 3141.", "Port is 3142.")).toBe(false);
  });

  it("treats one changed line in a long body as trivial, several as meaningful", () => {
    const base = lines(40);
    expect(isTrivialChange(base, base.replace("Fact number 3 ", "Fact number three "))).toBe(true);
    expect(isTrivialChange(base, base + "\nAnother new fact")).toBe(true);
    const changed = base.split("\n").map((l, i) => (i % 5 === 0 ? l + " changed" : l)).join("\n");
    expect(isTrivialChange(base, changed)).toBe(false);
  });
});

describe("isTrivialRepromote", () => {
  let root: string;
  let roots: KbRoots;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "trivial-repromote-"));
    roots = { kbBase: join(root, "kb"), opsRoot: join(root, "ops"), denLocal: join(root, "den", "kb") };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const emit = (body: string) =>
    emitDelta({ roots, wolf: "w1", denTopicId: "t1", change: "create", domainHint: "wolfpack", summary: "s", body });

  it("is false before anything was emitted", () => {
    expect(isTrivialRepromote(roots, "t1", "body")).toBe(false);
  });

  it("is true for a punctuation-only change after an emit, false for a real one", () => {
    emit("The dashboard runs on port 3141.");
    expect(isTrivialRepromote(roots, "t1", "the dashboard runs on port 3141")).toBe(true);
    expect(isTrivialRepromote(roots, "t1", "The dashboard runs on port 4000.")).toBe(false);
  });
});
