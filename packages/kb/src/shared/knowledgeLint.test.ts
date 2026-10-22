import { describe, it, expect } from "vitest";
import { lintKnowledge, stripProperties, stripLedeRepeat, stripDetailHeading, splitHistory, hardFindings, describeFindings } from "./knowledgeLint.js";

const codes = (body: string, extra: Partial<Parameters<typeof lintKnowledge>[0]> = {}) =>
  lintKnowledge({ body, ...extra }).map((f) => f.code);

describe("lintKnowledge: positives (text from real den topics)", () => {
  it("commit hashes in commit context", () => {
    expect(codes("## Fix (commit ee17088)\nThe helper connects.")).toContain("commit-hash");
    expect(codes("Commit e23309c: backoff retry logic, polling reconnection.")).toContain("commit-hash");
    expect(codes("- **A+B (8f61c3d)**: outage backoff (1, 2, 4, 8, max 15 min)")).toContain("commit-hash");
    expect(codes("- **E (537dbfe; follow-up 276f6a9)**: both adapters report stop reason")).toContain("commit-hash");
    expect(codes("- 6 temperature-deprecated 400s: fixed by a5d377b.")).toContain("commit-hash");
  });
  it("commit hashes in History lines count too", () => {
    expect(codes("## History\n\n- Until 2026-10-21: timer was 15 minutes. Now it is 1 minute (2a47c99).")).toContain("commit-hash");
  });
  it("task and work ids", () => {
    expect(codes("Tracked in work-wolfpack-ggNO3Sv.")).toContain("work-id");
    expect(codes("Finished task AbC1234 yesterday.")).toContain("work-id");
  });
  it("test counts and suite status", () => {
    expect(codes("Verified the helper connects. 682 tests passed at the time.")).toContain("test-count");
    expect(codes("Build passes; 2 new tests cover the default.")).not.toContain("test-count");
    expect(codes("The suite is green.")).toContain("test-count");
    expect(codes("Full vitest run (758 tests)")).toContain("test-count");
  });
  it("deploy / verified status", () => {
    expect(codes("## Current design (deployed)\n- one item per sweep")).toContain("deploy-status");
    expect(codes("# KB Sweep Merge Pipeline (deployed to Dewey and Hal)\n")).toContain("deploy-status");
    expect(codes("Deployed to the VPS with the Oct 22 sync.")).toContain("deploy-status");
    expect(codes("Verified live on a real inbox item.")).toContain("deploy-status");
  });
  it("dated headings", () => {
    expect(codes("## Session 2026-10-22\ntext")).toContain("dated-heading");
    expect(codes("## Week 43 planning\ntext")).toContain("dated-heading");
    expect(codes("## As of 2026-10-22\ntext")).toContain("dated-heading");
  });
  it("oversize body (History excluded), no domain exempt", () => {
    const big = "word ".repeat(1500);
    expect(codes(big)).toContain("oversize");
    expect(codes("short\n\n## History\n\n" + "- Until 2026-10-01: x. Now y.\n".repeat(400))).not.toContain("oversize");
    expect(codes(big, { cap: 10000 })).not.toContain("oversize");
  });
  it("lede repeated in the body", () => {
    const lede = "The sweep merges one contribution per run into the best matching entry.";
    expect(codes(`${lede}\n\n## How it works\nstuff`, { summary: lede })).toContain("lede-repeat");
    expect(codes(`## How it works\nstuff`, { summary: lede })).not.toContain("lede-repeat");
  });
  it("forbidden property keys", () => {
    const f = lintKnowledge({ body: "x", properties: { commit: "abc", "test-count": "42", "eval-score": "9", task: "t", "work-id": "w", host: "sfo01" } });
    expect(f.filter((x) => x.code === "forbidden-property").map((x) => x.sample).sort()).toEqual(["commit", "eval-score", "task", "test-count", "work-id"]);
  });
});

describe("lintKnowledge: negatives", () => {
  it("a cleaned entry's dated History lines are fine (dates are legitimate there)", () => {
    const body = [
      "## How it works\nThe sweep takes one contribution per run.",
      "## History",
      "- Until 2026-10-16: the sweep ran from a systemd timer every 15 minutes. Now the harness `setInterval` is the single scheduler.",
      "- Until 2026-10-22: one cosine threshold 0.72. Now the calibrated 0.69/0.90 band with an LLM subject check applies.",
    ].join("\n\n");
    expect(codes(body)).toEqual([]);
  });
  it("ids, env names, paths and entry ids are not hashes", () => {
    expect(codes("See kb-wolfpack-is2MGai and packages/kb/src/librarian/sweep.ts. Set KB_SWEEP_BATCH=1; 0.6*600000/15 ms.")).toEqual([]);
    expect(codes("The mirror is at ~/wolves/knowledge/base. The id is deadbeef-0000 and the number 1234567890 is a size.")).toEqual([]);
    expect(codes("Entry ids look like kb-wolfpack-ab12cd3 and den ids like <topicId>~<slug>.")).toEqual([]);
  });
  it("code fences are ignored", () => {
    expect(codes("```\ngit show ee17088 # commit\n```\nplain prose")).toEqual([]);
  });
  it("plain prose with 'task' and 'tests' words", () => {
    expect(codes("Each task handler runs the tests before the build. Two tests cover the default.")).toEqual([]);
  });
  it("the eval topic is clean", () => {
    expect(codes("24 questions with answers verified against code and repos (never against the KB): 13 wolfpack, 8 snapjack, 3 personal.")).toEqual([]);
  });
});

describe("strip helpers", () => {
  it("drops forbidden properties, keeps the rest", () => {
    expect(stripProperties({ commit: "a", host: "sfo01", "test-count": "3" })).toEqual({ host: "sfo01" });
  });
  it("drops a repeated lede paragraph", () => {
    const lede = "The sweep merges one contribution per run into the best matching entry.";
    expect(stripLedeRepeat(lede, `${lede}\n\n## A\n\ntext`)).toBe("## A\n\ntext");
    expect(stripLedeRepeat("short", "short\n\nx")).toBe("short\n\nx");
  });
  it("drops a ## Detail heading", () => {
    expect(stripDetailHeading("## Detail\n\nprose\n\n## History\n")).toBe("prose\n\n## History\n");
  });
  it("splits History and describes findings", () => {
    expect(splitHistory("a\n\n## History\n- x").history).toBe("## History\n- x");
    const f = lintKnowledge({ body: "Commit e23309c: x" });
    expect(hardFindings(f)).toHaveLength(1);
    expect(describeFindings(f)).toMatch(/^- commit-hash:/);
  });
});
