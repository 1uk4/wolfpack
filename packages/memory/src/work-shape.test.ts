import { describe, expect, it } from "vitest";
import { CHILDREN_CAP, LOG_TAIL, logTail, shapeWorkList, shapeWorkRecord, toWorkChild, withoutLog } from "./work-shape.js";

const doc = ["## Plan", "", "Do it.", "", "```", "## Log", "- not a log line", "```", "", "## Record", "", "Kept.", "", "## Log", "", ...Array.from({ length: 12 }, (_, i) => `- **d${i}** — e${i}`)].join("\n");

describe("work-shape", () => {
  it("withoutLog drops the generated Log section but not a fenced '## Log'", () => {
    const out = withoutLog(doc);
    expect(out).toContain("- not a log line");
    expect(out).toContain("Kept.");
    expect(out).not.toContain("e11");
  });
  it("logTail takes the newest LOG_TAIL entries, oldest first, ignoring fenced lines", () => {
    const t = logTail(doc);
    expect(t).toHaveLength(LOG_TAIL);
    expect(t[0]).toBe("**d2** — e2");
    expect(t.at(-1)).toBe("**d11** — e11");
  });
  it("shapeWorkList filters graduated/archived unless asked, with defaults", () => {
    const items = [{ id: "a" }, { id: "b", graduated: "2026-01-01" }, { id: "c", stage: "archived" }, { id: "d", graduated: true }];
    expect(shapeWorkList(items, "dom", false).map((i) => i.id)).toEqual(["a"]);
    const all = shapeWorkList(items, "dom", true);
    expect(all.map((i) => i.id)).toEqual(["a", "b", "c", "d"]);
    expect(all[0]).toMatchObject({ domain: "dom", partOf: null, dependsOn: [], title: "" });
    expect(all[3].graduated).toBe("graduated");
  });
  it("shapeWorkRecord caps children, counts a container's, and splits plan from record", () => {
    const kids = Array.from({ length: CHILDREN_CAP + 1 }, (_, i) => toWorkChild({ id: `k${i}` }));
    const f = shapeWorkRecord({ id: "f", kind: "feature" }, doc, kids);
    expect(f.children).toHaveLength(CHILDREN_CAP);
    expect(f.childrenTruncated).toBe(true);
    expect(f.record).toBe("Kept.");
    expect(f.plan).not.toContain("Kept.");
    const c = shapeWorkRecord({ id: "c", container: true }, "", kids);
    expect(c.children).toBeUndefined();
    expect(c.childCount).toBe(kids.length);
  });
});
