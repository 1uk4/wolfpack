import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { evictOldTopics, setAsideEvicted } from "./memory.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "evict-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const topic = (id: string, updated: string | null, body = `body of ${id}`) =>
  writeFileSync(join(root, `${id}.md`), `---\nid: ${id}\ntitle: ${id}\nsummary: s\n${updated === null ? "" : `updated: ${updated}\n`}---\n\n${body}\n`);
const evicted = () => readdirSync(join(root, "evicted")).sort();
const touch = (id: string, iso: string) => utimesSync(join(root, `${id}.md`), new Date(iso), new Date(iso));

describe("evictOldTopics ordering", () => {
  it("reads a zone-less stamp as UTC and orders it against zoned stamps", () => {
    const tz = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      topic("a", "2026-10-10 10:30"); // 10:30Z, the older one (read as local PDT it would be 17:30Z)
      topic("b", "2026-10-10T17:00:00Z");
      expect(evictOldTopics(root, 1)).toEqual(["a"]);
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });

  it("falls back to file mtime when updated is missing", () => {
    topic("a", null);
    topic("b", "2026-10-10 10:00");
    touch("a", "2026-01-01T00:00:00Z");
    expect(evictOldTopics(root, 1)).toEqual(["a"]);
  });

  it("falls back to file mtime when updated is garbled", () => {
    topic("a", "not a date");
    topic("b", "2026-10-10 10:00");
    touch("a", "2026-01-01T00:00:00Z");
    expect(evictOldTopics(root, 1)).toEqual(["a"]);
  });

  it("breaks ties by filename", () => {
    topic("c", "2026-10-10 10:00");
    topic("a", "2026-10-10 10:00");
    topic("b", "2026-10-10 10:00");
    expect(evictOldTopics(root, 1)).toEqual(["a", "b"]);
  });
});

describe("evicted name collisions", () => {
  it("eviction into a name already in evicted/ keeps both bodies", () => {
    topic("t", "2026-01-01 00:00", "first body");
    topic("u", "2026-10-10 10:00");
    evictOldTopics(root, 1);
    topic("t", "2026-02-01 00:00", "second body");
    evictOldTopics(root, 1);
    const bodies = evicted().map((f) => readFileSync(join(root, "evicted", f), "utf-8"));
    expect(evicted().length).toBe(2);
    expect(bodies.some((b) => b.includes("first body"))).toBe(true);
    expect(bodies.some((b) => b.includes("second body"))).toBe(true);
  });

  it("rewrites only the frontmatter id, leaving a body line that starts with id:", () => {
    topic("t", "2026-01-01 00:00", "intro\nid: keep-me\nend");
    topic("u", "2026-10-10 10:00");
    evictOldTopics(root, 1);
    setAsideEvicted(root, "t");
    const f = evicted().find((n) => n.startsWith("t-evicted-"))!;
    const raw = readFileSync(join(root, "evicted", f), "utf-8");
    expect(raw).toContain(`---\nid: ${f.replace(/\.md$/, "")}\n`);
    expect(raw).toContain("intro\nid: keep-me\nend");
  });

  it("inserts an id when the frontmatter has none", () => {
    writeFileSync(join(root, "t.md"), `---\ntitle: t\nupdated: 2026-01-01 00:00\n---\n\nid: body-line\n`);
    topic("u", "2026-10-10 10:00");
    evictOldTopics(root, 1);
    setAsideEvicted(root, "t");
    const f = evicted().find((n) => n.startsWith("t-evicted-"))!;
    const raw = readFileSync(join(root, "evicted", f), "utf-8");
    expect(raw).toContain(`---\nid: ${f.replace(/\.md$/, "")}\n`);
    expect(raw).toContain("\nid: body-line\n");
  });
});
