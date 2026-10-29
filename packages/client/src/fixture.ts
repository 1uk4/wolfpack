import type { ThreadSummary, WolfSummary, WorkListItem, WorkRecordResponse } from "./types.js";

export const FIXTURE_WOLF: WolfSummary = { id: "1uk4", name: "1uk4", host: "local", status: "online" };

export const FIXTURE_THREAD: ThreadSummary = {
  id: "1uk4/home",
  wolf: "1uk4",
  kind: "home",
  title: "Home",
};

/** One scripted turn: the sequence the mock streams on submit(). */
export type ScriptStep =
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; args: unknown; updates: string[]; result: string };

export const FIXTURE_SCRIPT: ScriptStep[] = [
  { kind: "thinking", text: "The user wants me to look at a file. " },
  { kind: "thinking", text: "I should read it before answering." },
  { kind: "text", text: "Let me take a look " },
  { kind: "text", text: "at that file." },
  {
    kind: "tool",
    name: "read",
    args: { path: "README.md" },
    updates: ["# Wolfpack\n", "A pack of durable agents.\n"],
    result: "# Wolfpack\nA pack of durable agents.\n",
  },
  { kind: "text", text: "It describes " },
  { kind: "text", text: "a pack of durable agents." },
];

/** Work fixtures the mock serves: one feature with two tasks, in the domain "wolfpack". */
export const FIXTURE_WORK_DOMAIN = "wolfpack";
export const FIXTURE_WORK: WorkListItem[] = [
  { id: "work-wolfpack-feat001", title: "Fixture feature", kind: "feature", stage: "build", domain: "wolfpack", partOf: null, dependsOn: [], assignee: "1uk4", created: "2026-10-01" },
  { id: "work-wolfpack-task001", title: "First fixture task", kind: "task", stage: "done", domain: "wolfpack", partOf: "work-wolfpack-feat001", dependsOn: [], assignee: "1uk4", created: "2026-10-01" },
  { id: "work-wolfpack-task002", title: "Second fixture task", kind: "task", stage: "plan", domain: "wolfpack", partOf: "work-wolfpack-feat001", dependsOn: ["work-wolfpack-task001"], assignee: "1uk4", created: "2026-10-02" },
  { id: "work-wolfpack-old0001", title: "Graduated fixture", kind: "feature", stage: "done", domain: "wolfpack", partOf: null, dependsOn: [], graduated: "2026-09-30" },
];

export const FIXTURE_WORK_RECORDS: Record<string, WorkRecordResponse> = {
  "work-wolfpack-feat001": {
    id: "work-wolfpack-feat001",
    title: "Fixture feature",
    kind: "feature",
    stage: "build",
    domain: "wolfpack",
    partOf: null,
    dependsOn: [],
    plan: "## Plan\n\nBuild the fixture.",
    record: "Decided to keep it small.",
    updated: "2026-10-02",
    children: [
      { id: "work-wolfpack-task001", title: "First fixture task", kind: "task", stage: "done", dependsOn: [] },
      { id: "work-wolfpack-task002", title: "Second fixture task", kind: "task", stage: "plan", dependsOn: ["work-wolfpack-task001"] },
    ],
  },
  "work-wolfpack-task001": { id: "work-wolfpack-task001", title: "First fixture task", kind: "task", stage: "done", domain: "wolfpack", partOf: "work-wolfpack-feat001", dependsOn: [], successCriteria: "It works.", plan: "Do the first thing.", record: "" },
};
