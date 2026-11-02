import { describe, expect, it } from "vitest";
import { bumpVersion, formatPlan, lastTag, parseTag, parseVersion, planRelease, type ReleaseDeps } from "./release.js";

const COMPONENTS = ["wolfd", "workerd", "hubd"];
function deps(tags: string[], affected: Record<string, string[]>): ReleaseDeps {
  return {
    tags: () => tags,
    affected: (base) => affected[base ?? ""] ?? [],
    commits: (base) => [`abc123 change since ${base ?? "start"}`],
  };
}

describe("tag discovery", () => {
  it("parses only <component>/vX.Y.Z", () => {
    expect(parseTag("wolfd/v1.2.3")?.version).toEqual({ major: 1, minor: 2, patch: 3 });
    for (const t of ["v1.2.3", "wolfd/1.2.3", "wolfd/v1.2", "wolfd/v1.2.3-rc1", "stable"]) expect(parseTag(t)).toBeNull();
  });
  it("picks the highest by semver, not string order, and ignores other components", () => {
    const tags = ["wolfd/v0.9.0", "wolfd/v0.10.0", "wolfd/v0.2.0", "hubd/v5.0.0", "wolfdx/v9.0.0"];
    expect(lastTag("wolfd", tags)).toBe("wolfd/v0.10.0");
    expect(lastTag("hubd", tags)).toBe("hubd/v5.0.0");
    expect(lastTag("workerd", tags)).toBeUndefined();
  });
});

describe("bump", () => {
  it("patch/minor/major", () => {
    const v = parseVersion("1.2.3");
    expect(bumpVersion(v, "patch")).toEqual({ major: 1, minor: 2, patch: 4 });
    expect(bumpVersion(v, "minor")).toEqual({ major: 1, minor: 3, patch: 0 });
    expect(bumpVersion(v, "major")).toEqual({ major: 2, minor: 0, patch: 0 });
  });
});

describe("planRelease", () => {
  it("a component with no tag counts as changed: v0.1.0", () => {
    const plan = planRelease({ components: COMPONENTS }, deps([], {}));
    expect(plan.map((p) => p.tag)).toEqual(["wolfd/v0.1.0", "workerd/v0.1.0", "hubd/v0.1.0"]);
    expect(plan.every((p) => p.first && p.previousTag === null)).toBe(true);
  });
  it("selects only components affected since their own last tag, suggests patch", () => {
    const tags = ["wolfd/v0.1.0", "workerd/v0.3.1", "hubd/v1.0.0"];
    const plan = planRelease({ components: COMPONENTS }, deps(tags, { "workerd/v0.3.1": ["workerd"], "hubd/v1.0.0": [] , "wolfd/v0.1.0": ["wolfd", "hubd"] }));
    expect(plan.map((p) => [p.tag, p.previousTag])).toEqual([["wolfd/v0.1.1", "wolfd/v0.1.0"], ["workerd/v0.3.2", "workerd/v0.3.1"]]);
  });
  it("honours --minor/--major and explicit version, restricted by name", () => {
    const tags = ["wolfd/v0.1.0", "hubd/v1.0.0"];
    const d = deps(tags, { "wolfd/v0.1.0": ["wolfd"], "hubd/v1.0.0": ["hubd"] });
    expect(planRelease({ components: COMPONENTS, only: ["wolfd"], bump: "minor" }, d).map((p) => p.tag)).toEqual(["wolfd/v0.2.0"]);
    expect(planRelease({ components: COMPONENTS, only: ["hubd"], bump: "major" }, d).map((p) => p.tag)).toEqual(["hubd/v2.0.0"]);
    expect(planRelease({ components: COMPONENTS, only: ["wolfd"], version: "2.0.0" }, d).map((p) => p.tag)).toEqual(["wolfd/v2.0.0"]);
  });
  it("rejects unknown components, non-increasing versions and existing tags", () => {
    const d = deps(["wolfd/v0.5.0"], { "wolfd/v0.5.0": ["wolfd"] });
    expect(() => planRelease({ components: COMPONENTS, only: ["nope"] }, d)).toThrow(/unknown component/);
    expect(() => planRelease({ components: COMPONENTS, only: ["wolfd"], version: "0.4.0" }, d)).toThrow(/not above/);
    expect(() => planRelease({ components: ["wolfd"], version: "0.1.0" }, deps(["wolfd/v0.1.0"], { "wolfd/v0.1.0": ["wolfd"] }))).toThrow(/not above/);
  });
  it("reports nothing when nothing changed", () => {
    const plan = planRelease({ components: ["wolfd"] }, deps(["wolfd/v0.1.0"], {}));
    expect(plan).toEqual([]);
    expect(formatPlan(plan)).toMatch(/Nothing to release/);
  });
  it("formats first releases and updates with commits", () => {
    const out = formatPlan(planRelease({ components: ["wolfd"] }, deps([], {})));
    expect(out).toContain("no tag yet -> wolfd/v0.1.0");
    expect(out).toContain("abc123 change since start");
  });
});
