/**
 * Crawl deterministic front-end tests — discovery, dates, grouping/ordering,
 * and the run gate. Pure stages only (no LLM, no KB).
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { globToRegExp, discoverSources } from "./discover.js";
import { normalizeDate, dateFromFilename, resolveDate, ordersJourney } from "./dates.js";
import { patternStem, slugify, buildPlan, batchDate } from "./group.js";
import { gatePlan, resolveBatchFiles } from "./plan.js";
import { computeTemporal, renderTopicDoc, renderDecisions, sortEvents } from "./consolidate.js";
import type { DatedFile, SourceFile, CrawlPlan } from "./schemas.js";

function df(relPath: string, date?: string, confidence: DatedFile["dateInfo"]["confidence"] = "high"): DatedFile {
  return {
    absPath: "/x/" + relPath,
    relPath,
    bytes: 0,
    dateInfo: { date, basis: date ? "frontmatter" : "none", confidence: date ? confidence : "none" },
  };
}

describe("globToRegExp", () => {
  it("handles * and ** correctly", () => {
    expect(globToRegExp("*.md").test("a.md")).toBe(true);
    expect(globToRegExp("*.md").test("d/a.md")).toBe(false);
    expect(globToRegExp("**/*.md").test("d/a.md")).toBe(true);
    expect(globToRegExp("api/*.md").test("api/x.md")).toBe(true);
    expect(globToRegExp("api/*.md").test("api/sub/x.md")).toBe(false);
    expect(globToRegExp("**/.obsidian/**").test("a/.obsidian/x.json")).toBe(true);
  });
});

describe("dates", () => {
  it("normalizes to finest ISO form", () => {
    expect(normalizeDate("2026-09-26T10:00")).toBe("2026-09-26");
    expect(normalizeDate("2026-09")).toBe("2026-09");
    expect(normalizeDate("2026 something")).toBe("2026");
    expect(normalizeDate("nope")).toBeUndefined();
  });
  it("reads leading date from filename", () => {
    expect(dateFromFilename("2026-09-26-invite.md")).toBe("2026-09-26");
    expect(dateFromFilename("plain.md")).toBeUndefined();
  });
  it("mtime is low-confidence and does not order", () => {
    const dir = mkdtempSync(join(tmpdir(), "crawl-dates-"));
    const p = join(dir, "plain.md");
    writeFileSync(p, "no frontmatter here");
    const info = resolveDate({ absPath: p, relPath: "plain.md", bytes: 1 }, { useGit: false });
    expect(info.basis).toBe("mtime");
    expect(info.confidence).toBe("low");
    expect(ordersJourney(info)).toBe(false);
  });
  it("frontmatter beats mtime (high-confidence) and orders", () => {
    const dir = mkdtempSync(join(tmpdir(), "crawl-dates-"));
    const p = join(dir, "doc.md");
    writeFileSync(p, "---\nupdated: 2026-03-04\n---\nbody");
    const info = resolveDate({ absPath: p, relPath: "doc.md", bytes: 1 }, { useGit: false });
    expect(info.basis).toBe("frontmatter");
    expect(info.date).toBe("2026-03-04");
    expect(ordersJourney(info)).toBe(true);
  });
  it("pinned date wins as high-confidence", () => {
    const info = resolveDate({ absPath: "/x/none.md", relPath: "none.md", bytes: 1 }, { pinned: "2025-01" });
    expect(info.confidence).toBe("high");
    expect(info.date).toBe("2025-01");
  });
});

describe("grouping", () => {
  it("patternStem strips date prefix and phase suffix", () => {
    expect(patternStem("2026-09-26-invitation-unification-plan-1.md")).toBe("invitation-unification");
    expect(patternStem("2026-04-08-player-profile-sheet-design.md")).toBe("player-profile-sheet");
    expect(patternStem("plain-feature.md")).toBe("plain-feature");
  });
  it("slugify is stable", () => {
    expect(slugify("API Map")).toBe("api-map");
    expect(slugify("")).toBe("root");
  });
  it("by-folder groups by directory", () => {
    const files = [df("api/a.md", "2026-04"), df("api/b.md", "2026-05"), df("bi/c.md", "2026-03")];
    const plan = buildPlan(files, { strategy: "by-folder", domain: "snapjack", source: "/x" });
    const topics = plan.batches.map((b) => b.topic);
    expect(topics).toContain("api");
    expect(topics).toContain("bi");
  });
  it("by-folder depth cap collapses facet subfolders into one topic", () => {
    const files = [
      df("systems/auth/api/a.md", "2026-04"),
      df("systems/auth/logic/b.md", "2026-04"),
      df("systems/auth/ux/c.md", "2026-05"),
      df("api/x.md", "2026-03"),
      df("root.md", "2026-02"),
    ];
    const plan = buildPlan(files, {
      strategy: "by-folder",
      domain: "snapjack",
      source: "/x",
      folderDepth: 2,
    });
    const topics = plan.batches.map((b) => b.topic);
    expect(topics).toContain("systems-auth"); // auth/* merged
    expect(topics).toContain("api");
    expect(topics).toContain("root");
    expect(topics).not.toContain("systems-auth-api");
    // the merged auth batch holds all 3 facet files
    const auth = plan.batches.find((b) => b.topic === "systems-auth")!;
    expect(auth.files.length).toBe(3);
  });
  it("orders batches oldest to newest; undated last", () => {
    const files = [
      df("late/a.md", "2026-09"),
      df("early/b.md", "2026-01"),
      df("unknown/c.md", undefined),
    ];
    const plan = buildPlan(files, { strategy: "by-folder", domain: "d", source: "/x" });
    expect(plan.batches.map((b) => b.topic)).toEqual(["early", "late", "unknown"]);
  });
  it("batchDate picks earliest grounded date, ignores undated", () => {
    expect(batchDate([df("a", "2026-05"), df("b", "2026-02"), df("c", undefined)])).toBe("2026-02");
  });
});

describe("run gate", () => {
  const base: CrawlPlan = {
    domain: "snapjack",
    source: "/x",
    currency: "archived",
    status: "ready",
    exclude: [],
    include: [],
    batches: [{ topic: "api", files: ["api/*.md"] }],
  };
  const files: SourceFile[] = [{ absPath: "/x/api/a.md", relPath: "api/a.md", bytes: 1 }];

  it("passes a well-formed ready plan", () => {
    const fails = gatePlan(base, { files, declared: new Set(["snapjack"]), sourceExists: true });
    expect(fails).toEqual([]);
  });
  it("rejects draft status", () => {
    const fails = gatePlan({ ...base, status: "draft" }, { files, declared: null, sourceExists: true });
    expect(fails.some((f) => f.includes("status"))).toBe(true);
  });
  it("rejects undeclared domain", () => {
    const fails = gatePlan(base, { files, declared: new Set(["other"]), sourceExists: true });
    expect(fails.some((f) => f.includes("not declared"))).toBe(true);
  });
  it("rejects a batch matching no files", () => {
    const fails = gatePlan(base, { files: [], declared: null, sourceExists: true });
    expect(fails.some((f) => f.includes("no files"))).toBe(true);
  });
  it("rejects a file claimed by two batches", () => {
    const plan = { ...base, batches: [{ topic: "a", files: ["api/*.md"] }, { topic: "b", files: ["api/a.md"] }] };
    const fails = gatePlan(plan, { files, declared: null, sourceExists: true });
    expect(fails.some((f) => f.includes("two batches"))).toBe(true);
  });
});

describe("temporal stamping", () => {
  it("computes source range from grounded dates, ignoring undated", () => {
    const files = [df("a", "2026-05"), df("b", "2026-02"), df("c", undefined)];
    const t = computeTemporal(files);
    expect(t.sourceCreated).toBe("2026-02");
    expect(t.sourceUpdated).toBe("2026-05");
    expect(t.dateBasis).toBe("frontmatter");
    expect(t.dateConfidence).toBe("high");
  });
  it("reports none when nothing is grounded", () => {
    const t = computeTemporal([df("c", undefined)]);
    expect(t.dateConfidence).toBe("none");
    expect(t.dateBasis).toBe("none");
    expect(t.sourceCreated).toBeUndefined();
  });
  it("sorts events chronologically, undated last", () => {
    const sorted = sortEvents([
      { date: "2026-05", change: "b" },
      { change: "no-date" },
      { date: "2026-02", change: "a" },
    ]);
    expect(sorted.map((e) => e.change)).toEqual(["a", "b", "no-date"]);
  });
  it("renders a Decisions section from events (undated label)", () => {
    const md = renderDecisions([{ date: "2026-02", change: "chose Glicko-2" }, { change: "TBD platform" }]);
    expect(md).toContain("## Decisions & Changes");
    expect(md).toContain("**2026-02** — chose Glicko-2");
    expect(md).toContain("**undated** — TBD platform");
  });
  it("renders frontmatter with temporal + currency", () => {
    const doc = renderTopicDoc(
      "crawl-snapjack-api",
      { title: "API", summary: "the api", body: "- POST /x", events: [{ date: "2026-04", change: "shipped API" }] },
      { sourceCreated: "2026-02", sourceUpdated: "2026-05", dateBasis: "frontmatter", dateConfidence: "high" },
      "archived",
      "/src"
    );
    expect(doc).toContain("id: crawl-snapjack-api");
    expect(doc).toContain("source_updated: 2026-05");
    expect(doc).toContain("currency: archived");
    expect(doc).toContain("- POST /x");
  });
});

describe("discover", () => {
  it("excludes junk and sorts deterministically", () => {
    const dir = mkdtempSync(join(tmpdir(), "crawl-disc-"));
    mkdirSync(join(dir, ".obsidian"), { recursive: true });
    mkdirSync(join(dir, "api"), { recursive: true });
    writeFileSync(join(dir, ".obsidian", "workspace.json"), "{}");
    writeFileSync(join(dir, "api", "b.md"), "b");
    writeFileSync(join(dir, "a.md"), "a");
    const found = discoverSources(dir).map((f) => f.relPath);
    expect(found).toEqual(["a.md", "api/b.md"]);
  });
});
