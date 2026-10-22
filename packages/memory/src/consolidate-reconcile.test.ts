import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "@wolfpack/engine";
import { contentHash, type KbRoots } from "@wolfpack/kb/shared";
import { consolidateSession } from "./consolidate.js";
import { writeDenTopic, readDenTopics, type DenConfig } from "./den.js";

const WOLF = "w1";
let root: string;
let den: string;
let memoryRoot: string;
let roots: KbRoots;

const hex10 = (body: string) => contentHash(body).slice(7, 17);

function receipt(id: string, body: string, outcome: string, detail: string): void {
  const dir = join(roots.opsRoot, "receipts", WOLF);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}-${hex10(body)}.md`),
    `---\nfrom: ${WOLF}\nden_topic_id: ${id}\noutcome: ${outcome}\nprocessed: 2026-10-19 20:20\n---\n\n${detail}\n`,
  );
}

function sessionTopic(id: string, title = id, summary = `${id} summary`, body = `${id} body`): void {
  const dir = join(memoryRoot, "sess-1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.md`),
    `---\nid: ${id}\ntitle: ${title}\nsummary: ${summary}\nupdated: 2026-10-20 10:00\n---\n\n${body}\n`,
  );
}

/** Only the distill step runs at promote: it echoes the topic as one clean contribution. */
const stubEngine: Engine = {
  call: async (step: string, schema: { parse: (v: unknown) => unknown }, opts: { prompt: string }) => {
    if (step !== "distill") throw new Error(`LLM should not be called: ${step}`);
    const title = /^TOPIC TITLE: (.*)$/m.exec(opts.prompt)?.[1] ?? "Topic";
    const body = opts.prompt.split("TOPIC BODY:\n")[1] ?? "";
    return schema.parse({ contributions: [{ slug: "main", title, summary: `${title} summary`, body: `## Details\n${body}` }] });
  },
} as unknown as Engine;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "consolidate-reconcile-"));
  den = join(root, "den");
  memoryRoot = join(root, ".memory");
  roots = { kbBase: join(root, "kb"), opsRoot: join(root, "ops"), denLocal: join(den, "kb") };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("consolidateSession reconcile", () => {
  it("archives an already-absorbed den topic during promote", async () => {
    const body = "existing topic body";
    writeDenTopic(den, { id: "absorbed", title: "absorbed", summary: "s", updated: "2026-10-20 09:00", body });
    receipt("absorbed", body, "create", "kb-wolfpack-AAAAAAA");
    writeDenTopic(den, { id: "existing", title: "existing", summary: "s", updated: "2026-10-20 09:00", body: "still pending" });
    sessionTopic("new");

    const denConfig: DenConfig = { denRoot: den, wolfName: WOLF };
    await consolidateSession({
      engine: stubEngine,
      den: denConfig,
      memoryRoot,
      sessionId: "sess-1",
      kbRoots: roots,
      skipClaims: true,
    });

    const archive = readdirSync(join(den, "memory", "archive"));
    expect(archive).toEqual(["absorbed.md"]);
    const topics = readdirSync(join(den, "memory", "topics")).filter((f) => f.endsWith(".md"));
    expect(topics.sort()).toEqual(["existing.md", "new.md"]);
  });

  it("emits the reconciled progress line before per-topic lines", async () => {
    const body = "existing topic body";
    writeDenTopic(den, { id: "absorbed", title: "absorbed", summary: "s", updated: "2026-10-20 09:00", body });
    receipt("absorbed", body, "merge", "kb-wolfpack-BBBBBBB");
    writeDenTopic(den, { id: "pending", title: "pending", summary: "s", updated: "2026-10-20 09:00", body: "pending body" });
    sessionTopic("new");

    const progress: string[] = [];
    const denConfig: DenConfig = { denRoot: den, wolfName: WOLF };
    await consolidateSession({
      engine: stubEngine,
      den: denConfig,
      memoryRoot,
      sessionId: "sess-1",
      kbRoots: roots,
      skipClaims: true,
      onProgress: (msg) => progress.push(msg),
    });

    expect(progress.length).toBeGreaterThan(0);
    expect(progress[0]).toMatch(/^reconciled: 1 archived, 1 pending$/);
    expect(progress.some((line) => line.includes("created: new"))).toBe(true);
  });

  it("emits no reconcile line when kbRoots is not provided", async () => {
    sessionTopic("new");

    const progress: string[] = [];
    const denConfig: DenConfig = { denRoot: den, wolfName: WOLF };
    await consolidateSession({
      engine: stubEngine,
      den: denConfig,
      memoryRoot,
      sessionId: "sess-1",
      skipClaims: true,
      onProgress: (msg) => progress.push(msg),
    });

    expect(progress.some((line) => line.includes("reconciled"))).toBe(false);
  });

  it("completes promote successfully even if reconcile cannot run", async () => {
    sessionTopic("new");

    // Promote completes even when there's nothing to reconcile and no den topics exist yet
    const progress: string[] = [];
    const denConfig: DenConfig = { denRoot: den, wolfName: WOLF };
    const result = await consolidateSession({
      engine: stubEngine,
      den: denConfig,
      memoryRoot,
      sessionId: "sess-1",
      kbRoots: roots,
      skipClaims: true,
      onProgress: (msg) => progress.push(msg),
    });

    // Reconcile ran (0 archived, 0 pending since there were no den topics initially)
    expect(progress[0]).toMatch(/^reconciled: 0 archived, 0 pending$/);
    // Session topic was promoted successfully
    expect(result.topicsProcessed).toBe(1);
    expect(result.topicsCreated).toBe(1);
    const topics = readdirSync(join(den, "memory", "topics")).filter((f) => f.endsWith(".md"));
    expect(topics).toEqual(["new.md"]);
  });

  it("skips session topics the KB already absorbed unchanged, and stages the rest", async () => {
    sessionTopic("old", "old", "s", "old body");
    receipt("old", "old body", "merge", "kb-wolfpack-AAAAAAA");
    sessionTopic("edited", "edited", "s", "edited body v2");
    receipt("edited", "edited body v1", "merge", "kb-wolfpack-BBBBBBB");
    sessionTopic("brand-new");

    const progress: string[] = [];
    const result = await consolidateSession({
      engine: stubEngine,
      den: { denRoot: den, wolfName: WOLF },
      memoryRoot,
      sessionId: "sess-1",
      kbRoots: roots,
      skipClaims: true,
      onProgress: (m) => progress.push(m),
    });

    const topics = readdirSync(join(den, "memory", "topics")).filter((f) => f.endsWith(".md"));
    expect(topics.sort()).toEqual(["brand-new.md", "edited.md"]);
    expect(result.topicsSkipped).toBe(1);
    expect(progress).toContain("  unchanged and already in the KB: 1 skipped");
    // A second promote archives nothing new: the absorbed topic was never staged.
    await consolidateSession({ engine: stubEngine, den: { denRoot: den, wolfName: WOLF }, memoryRoot, sessionId: "sess-1", kbRoots: roots, skipClaims: true });
    expect(existsSync(join(den, "memory", "archive"))).toBe(false);
  });

  it("logs and skips a topic with an unsafe id instead of aborting the promote", async () => {
    // Session topic whose frontmatter id would escape the topics directory.
    const dir = join(memoryRoot, "sess-1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "weird.md"), "---\nid: ../../escape\ntitle: Weird\nsummary: s\nupdated: 2026-10-20 10:00\n---\n\nweird body\n");
    sessionTopic("good");

    const progress: string[] = [];
    const result = await consolidateSession({
      engine: stubEngine,
      den: { denRoot: den, wolfName: WOLF },
      memoryRoot,
      sessionId: "sess-1",
      kbRoots: roots,
      onProgress: (msg) => progress.push(msg),
    });

    expect(progress.some((l) => l.includes("unsafe id"))).toBe(true);
    expect(result.topicsCreated).toBe(1);
    expect(result.topicsSkipped).toBe(1);
    expect(result.claimsSubmitted).toBe(1);
    expect(readdirSync(join(den, "memory", "topics")).filter((f) => f.endsWith(".md"))).toEqual(["good.md"]);
    expect(readdirSync(join(roots.opsRoot, "inbox", WOLF)).length).toBe(1);
    expect(existsSync(join(root, "escape.md"))).toBe(false);
  });
});

describe("consolidateSession durability gate", () => {
  const denConfig = (): DenConfig => ({ denRoot: den, wolfName: WOLF });
  const run = (progress: string[] = []) =>
    consolidateSession({
      engine: stubEngine,
      den: denConfig(),
      memoryRoot,
      sessionId: "sess-1",
      kbRoots: roots,
      onProgress: (m) => progress.push(m),
    });
  const inbox = () => {
    const dir = join(roots.opsRoot, "inbox", WOLF);
    return existsSync(dir) ? readdirSync(dir) : [];
  };

  it("keeps a session-log topic in the den as promotable: false and does not emit it", async () => {
    sessionTopic(
      "workout-log-oct21",
      "Workout Log — Monday Upper Push (Oct 21, 2026)",
      "Mon Oct 21 Upper Push",
      "## Session: mon-upper-push-oct21\n\n**Date:** 2026-10-21\n**Started:** ~8:04 PM\n\n- DB flat press: 4×6-8 at 70 lb/hand",
    );
    sessionTopic("dashboard", "KB Dashboard", "served at :3141", "The dashboard is served by wolfpack-agent at :3141.");

    const progress: string[] = [];
    const result = await run(progress);

    expect(result.topicsHeld).toBe(1);
    expect(result.claimsSubmitted).toBe(1);
    expect(inbox().filter((f) => f.startsWith("workout-log-oct21"))).toEqual([]);
    expect(inbox().some((f) => f.startsWith("dashboard"))).toBe(true);
    const held = readDenTopics(den).find((t) => t.id === "workout-log-oct21")!;
    expect(held.promotable).toBe(false);
    expect(held.promotableReason).toMatch(/session log/);
    expect(progress.some((m) => m.includes("held back (not promotable): workout-log-oct21"))).toBe(true);
  });

  it("skips a trivial re-promote and counts it", async () => {
    sessionTopic("dashboard", "KB Dashboard", "served", "The dashboard is served at :3141.");
    expect((await run()).claimsSubmitted).toBe(1);

    sessionTopic("dashboard", "KB Dashboard", "served", "The dashboard is served at :3141");
    const progress: string[] = [];
    const again = await run(progress);
    expect(again.claimsSubmitted).toBe(0);
    expect(again.trivialSkipped).toBe(1);
    expect(progress.some((m) => m.includes("trivial change since last emit: 1 skipped"))).toBe(true);

    sessionTopic("dashboard", "KB Dashboard", "served", "The dashboard is served at :4000.");
    expect((await run()).claimsSubmitted).toBe(1);
  });

  it("logs a topic over the soft cap but still writes it", async () => {
    sessionTopic("huge", "Huge topic", "s", "word ".repeat(2000));
    const progress: string[] = [];
    await run(progress);
    expect(progress.some((m) => m.includes("topic over 8000 chars") && m.includes("huge"))).toBe(true);
    expect(readDenTopics(den).some((t) => t.id === "huge")).toBe(true);
  });
});
