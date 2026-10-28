import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendArchive, appendDiscarded, findArchived, readArchive, archivePath, discardLogPath } from "./work-pending.js";
import { observationHash } from "./observation-id.js";

const obs = { timestamp: "2026-10-27T10:00:00Z", recordedAt: "2026-10-27T10:00:01Z", content: "chose X", work: "work-t1", feature: "work-f1" };
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "archive-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("observation archive", () => {
  it("appends {id, timestamp, recordedAt, content, work, feature, outcome, target, at}", () => {
    expect(appendArchive(root, [{ obs, outcome: "written", target: "work-f1" }, { obs: { content: "plain", timestamp: "t" }, id: "abc", outcome: "den", target: "topic-a" }])).toBe(true);
    const lines = readFileSync(archivePath(root), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ id: observationHash(obs), ...obs, outcome: "written", target: "work-f1" });
    expect(lines[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(lines[1]).toMatchObject({ id: "abc", content: "plain", outcome: "den", target: "topic-a" });
    expect(lines[1]).not.toHaveProperty("work");
  });

  it("is append-only and does not log the same outcome twice", () => {
    appendArchive(root, [{ obs, outcome: "written", target: "work-f1" }]);
    appendArchive(root, [{ obs, outcome: "written", target: "work-f1" }, { obs: { ...obs, content: "next" }, outcome: "promoted", target: "t" }]);
    expect(readArchive(root).map((e) => [e.content, e.outcome])).toEqual([["chose X", "written"], ["next", "promoted"]]);
  });

  it("appendDiscarded writes a discarded entry whose target is the reason", () => {
    appendDiscarded(root, [{ obs, reason: "archived" }]);
    expect(findArchived(root, observationHash(obs))).toMatchObject({ outcome: "discarded", target: "archived" });
  });

  it("still reads the old discarded.jsonl, folded into the archive", () => {
    mkdirSync(join(root, ".memory", "pool"), { recursive: true });
    writeFileSync(discardLogPath(root), JSON.stringify({ ...obs, discardedAt: "2026-10-20T00:00:00Z", reason: "deleted" }) + "\nnot json\n");
    const [e] = readArchive(root);
    expect(e).toMatchObject({ id: observationHash(obs), content: "chose X", work: "work-t1", outcome: "discarded", target: "deleted", at: "2026-10-20T00:00:00Z" });
    // once the archive holds it, the old line is not repeated
    appendDiscarded(root, [{ obs, reason: "deleted" }]);
    expect(readArchive(root)).toHaveLength(1);
  });

  it("a failed append is reported, never thrown", () => {
    writeFileSync(join(root, ".memory"), "a file, not a directory");
    const errs: string[] = [];
    expect(appendArchive(root, [{ obs, outcome: "written", target: "x" }], (m) => errs.push(m))).toBe(false);
    expect(errs[0]).toContain("not written");
  });
});
