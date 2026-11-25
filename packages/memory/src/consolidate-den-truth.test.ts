import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "@wolfpack/engine";
import { consolidateSession } from "./consolidate.js";
import { readDenTopics } from "./den.js";

const WOLF = "w1";
let root: string;
let den: string;
let memoryRoot: string;

function sessionTopic(id: string, body: string, title = id, summary = `${id} summary`): void {
  const dir = join(memoryRoot, "sess-1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.md`),
    `---\nid: ${id}\ntitle: ${title}\nsummary: ${summary}\nupdated: 2026-10-20 10:00\n---\n\n${body}\n`,
  );
}

/** A body the durability gate holds back (a session log), and one it passes. */
const LOGGY_TITLE = "Workout session log";
const LOGGY = "Ran at 2026-10-20T10:00:00Z then lifted at 2026-10-20T11:00:00Z and stretched at 2026-10-20T12:00:00Z.";
const CLEAN = "Squat day uses a five by five scheme with a two minute rest.";

const noLlm = {
  call: async () => {
    throw new Error("LLM should not be called");
  },
} as unknown as Engine;

async function consolidate(logs: string[] = []): Promise<void> {
  await consolidateSession({
    engine: noLlm,
    den: { denRoot: den, wolfName: WOLF },
    memoryRoot,
    sessionId: "sess-1",
    skipClaims: true,
    onProgress: (m: string) => logs.push(m),
  });
}

const denBody = (id: string) => readDenTopics(den).find((t) => t.id === id)?.body;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "consolidate-den-truth-"));
  den = join(root, "den");
  memoryRoot = join(root, ".memory");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("consolidate treats an existing den topic file as the source of truth", () => {
  it("keeps a hand-edited den topic when the session store re-emits the topic", async () => {
    sessionTopic("t1", "session v1");
    await consolidate();
    expect(denBody("t1")).toBe("session v1");

    const file = join(den, "memory", "topics", "t1.md");
    writeFileSync(file, readFileSync(file, "utf-8").replace("session v1", "owner edit"));
    sessionTopic("t1", "session v2");
    const logs: string[] = [];
    await consolidate(logs);

    expect(denBody("t1")).toBe("owner edit");
  });

  it("lands a new session body on an untouched den topic", async () => {
    sessionTopic("t1", "session v1");
    await consolidate();
    sessionTopic("t1", "session v2");
    await consolidate();
    expect(denBody("t1")).toBe("session v2");
  });

  it("keeps hand-set frontmatter (promotable with no reason, work) when a new session body lands", async () => {
    sessionTopic("t1", "session v1");
    await consolidate();
    const file = join(den, "memory", "topics", "t1.md");
    writeFileSync(file, readFileSync(file, "utf-8").replace("related: []", "related: []\npromotable: false\nwork: work-wolfpack-X1"));
    sessionTopic("t1", "session v2");
    await consolidate();
    const t = readDenTopics(den).find((x) => x.id === "t1");
    expect(t?.body).toBe("session v2");
    expect(t?.promotable).toBe(false);
    expect(t?.work).toBe("work-wolfpack-X1");
  });

  it("clears a gate hold once the body passes, but never a hand-set promotable: false", async () => {
    sessionTopic("held", LOGGY, LOGGY_TITLE);
    await consolidate();
    expect(readDenTopics(den).find((x) => x.id === "held")?.promotable).toBe(false);
    sessionTopic("held", CLEAN, "Squat programming");
    await consolidate();
    expect(readDenTopics(den).find((x) => x.id === "held")?.promotable).toBe(true);

    sessionTopic("hand", "v1 body");
    await consolidate();
    const file = join(den, "memory", "topics", "hand.md");
    writeFileSync(file, readFileSync(file, "utf-8").replace("related: []", "related: []\npromotable: false"));
    sessionTopic("hand", CLEAN);
    await consolidate();
    expect(readDenTopics(den).find((x) => x.id === "hand")?.promotable).toBe(false);
  });

  it("refreshes title and summary on an untouched den topic", async () => {
    sessionTopic("t1", "session v1", "Old title", "old summary");
    await consolidate();
    sessionTopic("t1", "session v2", "New title", "new summary");
    await consolidate();
    const t = readDenTopics(den).find((x) => x.id === "t1");
    expect([t?.title, t?.summary]).toEqual(["New title", "new summary"]);
  });

  it("guards and updates a den file whose name differs from its id, in place", async () => {
    sessionTopic("t1", "session v1");
    await consolidate();
    const dir = join(den, "memory", "topics");
    renameSync(join(dir, "t1.md"), join(dir, "other.md"));
    sessionTopic("t1", "session v2");
    await consolidate();
    expect(readDenTopics(den).filter((x) => x.id === "t1").map((x) => x.body)).toEqual(["session v2"]);
    expect(existsSync(join(dir, "t1.md"))).toBe(false);

    writeFileSync(join(dir, "other.md"), readFileSync(join(dir, "other.md"), "utf-8").replace("session v2", "owner edit"));
    sessionTopic("t1", "session v3");
    await consolidate();
    expect(readDenTopics(den).filter((x) => x.id === "t1").map((x) => x.body)).toEqual(["owner edit"]);
    expect(existsSync(join(dir, "t1.md"))).toBe(false);
  });

  it("a distill hold rewrites the den file in place and keeps its hand-set fields", async () => {
    sessionTopic("t1", "session v1");
    await consolidate();
    const dir = join(den, "memory", "topics");
    renameSync(join(dir, "t1.md"), join(dir, "other.md"));
    writeFileSync(join(dir, "other.md"), readFileSync(join(dir, "other.md"), "utf-8").replace("related: []", "related: []\nwork: work-wolfpack-X1"));
    sessionTopic("t1", "session v2");
    const junk = { call: async (_s: string, schema: { parse: (v: unknown) => unknown }) => schema.parse({ contributions: [{ slug: "main", title: "Sweep performance", summary: "How the sweep budgets its time.", body: "## Design\nVerified live on a real inbox item." }] }) } as unknown as Engine;
    await consolidateSession({
      engine: junk, den: { denRoot: den, wolfName: WOLF }, memoryRoot, sessionId: "sess-1",
      kbRoots: { kbBase: join(root, "kb"), opsRoot: join(root, "ops"), denLocal: join(den, "kb") },
    });
    const all = readDenTopics(den).filter((x) => x.id === "t1");
    expect(all.map((x) => [x.promotable, x.work])).toEqual([[false, "work-wolfpack-X1"]]);
    expect(existsSync(join(dir, "t1.md"))).toBe(false);
  });

  const legacyDenFile = (id: string, body: string, updated: string) => {
    const dir = join(den, "memory", "topics");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.md`), `---\nid: ${id}\ntitle: ${id}\nsummary: s\nupdated: ${updated}\nrelated: []\n---\n\n${body}\n`);
  };
  const nowStamp = () => new Date().toISOString().replace("T", " ").slice(0, 16);

  it("updates a legacy den topic (no session_hash) that consolidate wrote and nobody edited, and stamps it", async () => {
    legacyDenFile("t1", "session v1", nowStamp()); // written by an older consolidate: mtime == updated
    sessionTopic("t1", "session v2");
    await consolidate();
    expect(denBody("t1")).toBe("session v2");
    expect(readFileSync(join(den, "memory", "topics", "t1.md"), "utf-8")).toContain("session_hash:");
    sessionTopic("t1", "session v3");
    await consolidate();
    expect(denBody("t1")).toBe("session v3");
  });

  it("keeps a legacy den topic (no session_hash) edited long after consolidate wrote it", async () => {
    legacyDenFile("t1", "owner edit", "2026-10-20 10:00"); // mtime is now, far from updated
    sessionTopic("t1", "session v2");
    await consolidate();
    expect(denBody("t1")).toBe("owner edit");
  });
});
