import { describe, expect, it } from "vitest";
import { sharedFeature, subagentReportTag } from "./observation-tag.js";

const children = [
  { name: "worker-buffer-drain-3", taskId: "work-wolfpack-oxYNd46" },
  { name: "reviewer-1", taskId: "work-wolfpack-aaaaaaa" },
  { name: "scout-x" },
];

describe("subagentReportTag", () => {
  it("a line narrating one subagent's report takes that subagent's task, with its feature when known", () => {
    expect(subagentReportTag("worker-buffer-drain-3 reported the cap now retires first", children, (t) => (t === "work-wolfpack-oxYNd46" ? "work-wolfpack-81zcMyv" : undefined)))
      .toEqual({ taskId: "work-wolfpack-oxYNd46", featureId: "work-wolfpack-81zcMyv" });
  });

  it("no tag when the line names no subagent, names subagents of different tasks, or the one named has no task", () => {
    expect(subagentReportTag("the build is green", children, () => undefined)).toBeNull();
    expect(subagentReportTag("worker-buffer-drain-3 and reviewer-1 disagree", children, () => undefined)).toBeNull();
    expect(subagentReportTag("scout-x found a file", children, () => undefined)).toBeNull();
  });
});

describe("sharedFeature", () => {
  const t = (id: string, partOf?: string) => ({ taskId: id, ...(partOf ? { featureId: partOf } : {}) });
  it("several named items tag with the feature they all share", () => {
    expect(sharedFeature([t("a", "F1"), t("b", "F1")])).toEqual({ featureId: "F1" });
    expect(sharedFeature([t("a", "F1"), { featureId: "F1" }])).toEqual({ featureId: "F1" });
  });
  it("no tag when they share none, one has no feature, or a lookup failed (null): never a guess", () => {
    expect(sharedFeature([t("a", "F1"), t("b", "F2")])).toBeNull();
    expect(sharedFeature([t("a", "F1"), t("b")])).toBeNull();
    expect(sharedFeature([t("a", "F1"), null])).toBeNull();
    expect(sharedFeature([])).toBeNull();
  });
});
