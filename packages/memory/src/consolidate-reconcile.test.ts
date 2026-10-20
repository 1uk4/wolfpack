import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "@wolfpack/engine";
import { contentHash, type KbRoots } from "@wolfpack/kb/shared";
import { consolidateSession } from "./consolidate.js";
import { writeDenTopic, type DenConfig } from "./den.js";

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

const stubEngine: Engine = {
  call: async () => { throw new Error("LLM should not be called"); },
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
});
