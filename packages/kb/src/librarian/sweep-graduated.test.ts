import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "@wolfpack/engine";
import { sweep, graduatedEntryId } from "./sweep.js";
import type { KbRoots } from "../shared/index.js";

describe("graduatedEntryId", () => {
  it("maps a work id to the entry id graduation records", () => {
    expect(graduatedEntryId("work-wolfpack-UbWXWMv", "wolfpack")).toBe("kb-wolfpack-UbWXWMv");
    expect(graduatedEntryId("kb-package-topic", "wolfpack")).toBeNull();
    expect(graduatedEntryId("work-wolfpack-short", "wolfpack")).toBeNull();
  });
});

describe("sweep: graduated work creates its own entry", () => {
  let base: string;
  let roots: KbRoots;
  const prompts: string[] = [];
  const inbox = () => join(roots.opsRoot, "inbox", "w1");
  const entries = () => join(roots.kbBase, "domains", "wp", "entries");
  const drop = (topic: string, hash: string, body: string) =>
    writeFileSync(
      join(inbox(), `${topic}-${hash}.md`),
      `---\nfrom: w1\nden_topic_id: ${topic}\nchange: create\ncontent_hash: ${hash}\nprev_hash: null\ndomain_hint: wp\nsubmitted: 2026-10-10T01:00:00Z\n---\n\n# ${topic}\n\n${body}\n`
    );

  const engine = {
    call: vi.fn(async (step: string, schema: { parse: (v: unknown) => unknown }, opts: { prompt: string }) => {
      if (step === "classifyToSection") return schema.parse({ section: "NEW", confidence: "low" });
      prompts.push(opts.prompt);
      return schema.parse({
        title: "Graduated feature", kind: { type: "fact" }, summary: "s", detail: "d",
        confidence: "high", facets: {}, properties: {}, proposedRelations: [],
      });
    }),
    usage: { summarize: () => ({}) },
  } as unknown as Engine;

  beforeEach(() => {
    prompts.length = 0;
    base = mkdtempSync(join(tmpdir(), "kb-grad-"));
    roots = { kbBase: join(base, "base"), opsRoot: join(base, "ops"), denLocal: join(base, "den") };
    mkdirSync(inbox(), { recursive: true });
    mkdirSync(entries(), { recursive: true });
    // A big existing entry that every contribution is maximally similar to.
    writeFileSync(join(entries(), "kb-wp-BIGBIG1.md"), "---\nid: kb-wp-BIGBIG1\nsection: sec-wp-aaaaaa\n---\nhuge catch-all");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ embedding: [1, 0, 0] }))));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(base, { recursive: true, force: true });
  });

  const run = () =>
    sweep({
      engine, roots, notify: () => {},
      loadEntryVectors: async () => [{ entryId: "kb-wp-BIGBIG1", domain: "wp", vector: [1, 0, 0] } as any],
    });

  it("creates kb-<domain>-<workId> instead of merging into a similar entry, then updates it", async () => {
    drop("work-wp-Feat001", "h1", "first graduation");
    const first = await run();
    expect(first).toMatchObject({ created: 1, merged: 0 });
    expect(existsSync(join(entries(), "kb-wp-Feat001.md"))).toBe(true);
    expect(prompts[0]).not.toContain("huge catch-all");
    expect(prompts[0]).toContain("ACTION: create");

    drop("work-wp-Feat001", "h2", "graduated again");
    const second = await run();
    expect(second).toMatchObject({ created: 0, merged: 1 });
    expect(prompts[1]).toContain("EXISTING ENTRY (kb-wp-Feat001)");
    expect(readFileSync(join(entries(), "kb-wp-BIGBIG1.md"), "utf8")).toContain("huge catch-all");
  });

  it("non-work contributions still merge by similarity", async () => {
    drop("some-den-topic", "h3", "a memory topic");
    const r = await run();
    expect(r.merged).toBe(1);
    expect(prompts[0]).toContain("EXISTING ENTRY (kb-wp-BIGBIG1)");
  });
});
