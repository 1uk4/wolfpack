import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readParentBoundTask, resolveSubagentTask } from "./task-id.ts";

describe("readParentBoundTask", () => {
  const write = (den: string, sid: string, content: string) => {
    mkdirSync(join(den, "factory", "sessions", sid), { recursive: true });
    writeFileSync(join(den, "factory", "sessions", sid, "active-task.json"), content);
  };
  it("returns the bound id, and nothing once the binding is cleared, malformed or not a work id", () => {
    const den = mkdtempSync(join(tmpdir(), "task-id-"));
    write(den, "s1", JSON.stringify({ workId: "work-wolfpack-gkMXNlI" }));
    expect(readParentBoundTask(den, "s1")).toBe("work-wolfpack-gkMXNlI");
    rmSync(join(den, "factory", "sessions", "s1", "active-task.json")); // task_unbind / task_done delete the file
    expect(readParentBoundTask(den, "s1")).toBeUndefined();
    write(den, "s2", "{not json");
    expect(readParentBoundTask(den, "s2")).toBeUndefined();
    write(den, "s3", JSON.stringify({ workId: "../../etc/passwd" }));
    expect(readParentBoundTask(den, "s3")).toBeUndefined();
    expect(readParentBoundTask(undefined, "s1")).toBeUndefined();
  });
});

describe("resolveSubagentTask", () => {
  it("prefers a valid explicit id over the brief", () => {
    expect(resolveSubagentTask({ explicit: "work-wolfpack-gkMXNlI", brief: "do work-snapjack-AbCdEf1" })).toBe(
      "work-wolfpack-gkMXNlI",
    );
  });
  it("takes the first id in the brief by position", () => {
    expect(resolveSubagentTask({ brief: "see work-wolfpack-gkMXNlI then work-snapjack-AbCdEf1" })).toBe(
      "work-wolfpack-gkMXNlI",
    );
  });
  it("finds an id inside a code fence", () => {
    expect(resolveSubagentTask({ brief: "Task:\n```\nwork-personal-Zz9Yy8X\n```" })).toBe("work-personal-Zz9Yy8X");
  });
  it("returns undefined when the brief has no id", () => {
    expect(resolveSubagentTask({ brief: "no ids here" })).toBeUndefined();
  });
  it("ignores a malformed work-foo", () => {
    expect(resolveSubagentTask({ brief: "work-foo and work-wolfpack-gkMXNlI" })).toBe("work-wolfpack-gkMXNlI");
    expect(resolveSubagentTask({ brief: "only work-foo" })).toBeUndefined();
  });
  it("inherits the parent's bound task only when neither an explicit id nor the brief names one", () => {
    const parentBound = "work-wolfpack-Par3ntB";
    expect(resolveSubagentTask({ brief: "no ids here", parentBound })).toBe(parentBound);
    expect(resolveSubagentTask({ brief: "see work-snapjack-AbCdEf1", parentBound })).toBe("work-snapjack-AbCdEf1");
    expect(resolveSubagentTask({ explicit: "work-wolfpack-gkMXNlI", brief: "x", parentBound })).toBe("work-wolfpack-gkMXNlI");
    expect(resolveSubagentTask({ brief: "no ids here" })).toBeUndefined();
  });
  it("falls back to the brief when the explicit id is invalid", () => {
    expect(resolveSubagentTask({ explicit: "work-foo", brief: "work-wolfpack-gkMXNlI" })).toBe("work-wolfpack-gkMXNlI");
  });
});
