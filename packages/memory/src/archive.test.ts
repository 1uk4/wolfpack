import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, existsSync, readdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendArchive, appendDiscarded, findArchived, readArchive, archivePath, discardLogPath, poolDir } from "./work-pending.js";
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

  it("keeps an id:outcome index: a second process's appends are seen, duplicates are never written", () => {
    appendArchive(root, [{ obs, outcome: "written", target: "w" }]);
    // another process appends behind our back
    const other = { ...obs, content: "elsewhere" };
    appendFileSync(archivePath(root), JSON.stringify({ id: observationHash(other), timestamp: "", recordedAt: "", content: "elsewhere", outcome: "written", target: "w", at: "x" }) + "\n");
    appendArchive(root, [{ obs: other, outcome: "written", target: "w" }, { obs, outcome: "written", target: "w" }]);
    expect(readArchive(root)).toHaveLength(2);
  });

  it("rotates to archive-<n>.jsonl at the size limit; readers scan every file in order", () => {
    process.env.WOLF_ARCHIVE_ROTATE_BYTES = "300";
    try {
      for (let i = 0; i < 6; i++) appendArchive(root, [{ obs: { ...obs, content: `c${i}` }, outcome: "written", target: "w" }]);
    } finally { delete process.env.WOLF_ARCHIVE_ROTATE_BYTES; }
    const files = readdirSync(poolDir(root)).filter((f) => f.startsWith("archive")).sort();
    expect(files).toContain("archive-1.jsonl");
    expect(files.length).toBeGreaterThan(2);
    expect(readArchive(root).map((e) => e.content)).toEqual(["c0", "c1", "c2", "c3", "c4", "c5"]);
    expect(findArchived(root, observationHash({ ...obs, content: "c0" }))?.content).toBe("c0");
    // a rotated-away entry is still deduped
    appendArchive(root, [{ obs: { ...obs, content: "c0" }, outcome: "written", target: "w" }]);
    expect(readArchive(root)).toHaveLength(6);
  });

  it("ends a torn last line before appending, so the next entry stands alone", () => {
    appendArchive(root, [{ obs, outcome: "written", target: "w" }]);
    appendFileSync(archivePath(root), '{"id":"torn","conte');
    appendArchive(root, [{ obs: { ...obs, content: "after" }, outcome: "den", target: "t" }]);
    expect(readArchive(root).map((e) => e.content)).toEqual(["chose X", "after"]);
  });

  it("holds a lock while it reads, dedupes and appends; releases it; takes over a stale one", () => {
    appendArchive(root, [{ obs, outcome: "written", target: "w" }]);
    const lock = join(poolDir(root), "archive.lock");
    expect(existsSync(lock)).toBe(false);
    writeFileSync(lock, "999999");
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    expect(appendArchive(root, [{ obs: { ...obs, content: "n" }, outcome: "written", target: "w" }])).toBe(true);
    expect(readArchive(root)).toHaveLength(2);
    expect(existsSync(lock)).toBe(false);
  });
});
