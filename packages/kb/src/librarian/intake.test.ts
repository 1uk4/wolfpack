import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { drainInbox } from "./intake.js";
import { writeReceipt } from "./commit.js";
import { emitDelta, tryEmitDelta } from "../client/emitDelta.js";
import { contentHash, hashTag, isSafeSegment, safeSegment, toTopicId, type KbRoots } from "../shared/index.js";

describe("drainInbox", () => {
  let base: string;
  let roots: KbRoots;
  const inbox = (wolf = "w1") => join(roots.opsRoot, "inbox", wolf);
  const fm = (fields: Record<string, string>, body = "body") =>
    `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n\n${body}\n`;
  const valid = { from: "w1", den_topic_id: "topic-a", change: "create", content_hash: "abcdef0123456789", submitted: "2026-10-10T01:00:00Z" };
  const bad = (wolf = "w1") => join(inbox(wolf), "_bad");

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "kb-intake-"));
    roots = { kbBase: join(base, "base"), opsRoot: join(base, "ops"), denLocal: join(base, "den") };
    mkdirSync(inbox(), { recursive: true });
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(base, { recursive: true, force: true });
  });

  it("returns valid contributions", () => {
    writeFileSync(join(inbox(), "a.md"), fm(valid));
    expect(drainInbox(roots).map((c) => c.denTopicId)).toEqual(["topic-a"]);
    expect(existsSync(bad())).toBe(false);
  });

  it("moves a file missing den_topic_id to _bad/ with a reason, and still returns the next valid one", () => {
    writeFileSync(join(inbox(), "a-broken.md"), fm({ from: "w1", change: "create" }));
    writeFileSync(join(inbox(), "b-good.md"), fm(valid));
    const out = drainInbox(roots);
    expect(out.map((c) => c.denTopicId)).toEqual(["topic-a"]);
    expect(readdirSync(bad()).sort()).toEqual(["a-broken.md", "a-broken.md.reason.txt"]);
    expect(readFileSync(join(bad(), "a-broken.md.reason.txt"), "utf-8")).toMatch(/den_topic_id/);
    expect(existsSync(join(inbox(), "a-broken.md"))).toBe(false);
    // The next drain no longer sees it.
    expect(drainInbox(roots)).toHaveLength(1);
  });

  it.each(["../../escape", "..", ".", "a/b", "a\\b", "has space", "x\u0000y"])("quarantines den_topic_id %j", (id) => {
    writeFileSync(join(inbox(), "evil.md"), fm({ ...valid, den_topic_id: id }));
    writeFileSync(join(inbox(), "ok.md"), fm(valid));
    expect(drainInbox(roots).map((c) => c.denTopicId)).toEqual(["topic-a"]);
    expect(readdirSync(bad())).toContain("evil.md");
    expect(existsSync(join(base, "escape"))).toBe(false);
  });

  it("quarantines a non-hex content_hash", () => {
    writeFileSync(join(inbox(), "h.md"), fm({ ...valid, content_hash: "../../x" }));
    expect(drainInbox(roots)).toEqual([]);
    expect(readdirSync(bad())).toContain("h.md.reason.txt");
  });

  it("takes `from` from the directory name even when frontmatter disagrees", () => {
    writeFileSync(join(inbox(), "a.md"), fm({ ...valid, from: "../../etc" }));
    const [c] = drainInbox(roots);
    expect(c.from).toBe("w1");
    expect(existsSync(bad())).toBe(false);
  });

  it("accepts a file with no `from` in frontmatter", () => {
    const { from: _from, ...noFrom } = valid;
    writeFileSync(join(inbox(), "a.md"), fm(noFrom));
    expect(drainInbox(roots)[0].from).toBe("w1");
  });

  it("does not descend into _bad/ or _processed/", () => {
    mkdirSync(bad(), { recursive: true });
    writeFileSync(join(bad(), "old.md"), fm(valid));
    expect(drainInbox(roots)).toEqual([]);
  });
});

describe("safe path helpers", () => {
  it("safeSegment accepts plain names and rejects traversal", () => {
    expect(safeSegment("work-wp_1.2")).toBe("work-wp_1.2");
    for (const v of ["", ".", "..", "a/b", "../x", "a b", undefined]) expect(() => safeSegment(v)).toThrow(/unsafe/);
  });

  it("hashTag handles prefixed and bare hashes and rejects non-hex", () => {
    const h = contentHash("hello");
    expect(hashTag(h)).toBe(h.slice(7, 17));
    expect(hashTag(h.slice(7))).toBe(h.slice(7, 17));
    expect(() => hashTag("sha256:zz/../")).toThrow(/invalid content hash/);
  });
});

describe("path joins use the validated values", () => {
  let base: string;
  let roots: KbRoots;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "kb-paths-"));
    roots = { kbBase: join(base, "base"), opsRoot: join(base, "ops"), denLocal: join(base, "den") };
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("emitDelta rejects an unsafe topic id or wolf name and writes nothing", () => {
    const input = { roots, wolf: "w1", denTopicId: "../../x", change: "create" as const, body: "b", summary: "s", domainHint: "wp" };
    expect(() => emitDelta(input)).toThrow(/unsafe/);
    expect(() => emitDelta({ ...input, denTopicId: "ok", wolf: ".." })).toThrow(/unsafe/);
  });

  it("emitDelta and writeReceipt work with a non-prefixed content hash", () => {
    const c = emitDelta({ roots, wolf: "w1", denTopicId: "t1", change: "create", body: "b", summary: "s", domainHint: "wp" })!;
    expect(c).not.toBeNull();
    const bare = { ...c, contentHash: c.contentHash.slice(7), from: "w1", filePath: "x", } as never;
    writeReceipt(roots, "w1", bare, "ok", "detail");
    expect(readdirSync(join(roots.opsRoot, "receipts", "w1"))).toEqual([`t1-${c.contentHash.slice(7, 17)}.md`]);
  });
});

describe("tryEmitDelta", () => {
  it("reports an unsafe topic id and skips it, then emits the next one", () => {
    const base = mkdtempSync(join(tmpdir(), "kb-try-emit-"));
    const roots: KbRoots = { kbBase: join(base, "base"), opsRoot: join(base, "ops"), denLocal: join(base, "den") };
    try {
      const input = { roots, wolf: "w1", change: "create" as const, body: "b", summary: "s", domainHint: "wp" };
      const skipped: string[] = [];
      expect(tryEmitDelta({ ...input, denTopicId: "../../x" }, (why) => skipped.push(why))).toBeNull();
      expect(skipped).toHaveLength(1);
      expect(skipped[0]).toMatch(/unsafe/);
      expect(tryEmitDelta({ ...input, denTopicId: "fine" }, (why) => skipped.push(why))).not.toBeNull();
      expect(skipped).toHaveLength(1);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("toTopicId keeps safe ids and slugs the rest into safe ones", () => {
    expect(toTopicId("my_Topic.v2")).toBe("my_Topic.v2");
    expect(toTopicId("My Topic: ../Draft!")).toBe("my-topic-draft");
    expect(toTopicId("..")).toMatch(/^topic-[0-9a-f]{10}$/);
    for (const raw of ["a/b", "日本語", "", " "]) expect(isSafeSegment(toTopicId(raw))).toBe(true);
  });
});
