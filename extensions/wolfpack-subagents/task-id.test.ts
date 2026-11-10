import { describe, expect, it } from "vitest";
import { resolveSubagentTask } from "./task-id.ts";

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
  it("falls back to the brief when the explicit id is invalid", () => {
    expect(resolveSubagentTask({ explicit: "work-foo", brief: "work-wolfpack-gkMXNlI" })).toBe("work-wolfpack-gkMXNlI");
  });
});
