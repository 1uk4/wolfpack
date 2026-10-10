import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "@wolfpack/engine";
import { sweep, graduationEntryId } from "./sweep.js";
import { scrubGraduation } from "./produce.js";
import { readLedger } from "./ledger.js";
import type { KbRoots } from "../shared/index.js";

describe("graduationEntryId", () => {
  it("uses the entry_id a graduation names, and only for graduations", () => {
    expect(graduationEntryId({ graduation: "feature", entryId: "kb-wolfpack-UbWXWMv" }, "wolfpack")).toBe("kb-wolfpack-UbWXWMv");
    expect(graduationEntryId({ entryId: "kb-wolfpack-UbWXWMv" }, "wolfpack")).toBeNull();
    expect(() => graduationEntryId({ graduation: "hub" }, "wolfpack")).toThrow(/needs entry_id/);
    expect(() => graduationEntryId({ graduation: "hub", entryId: "kb-other-UbWXWMv" }, "wolfpack")).toThrow(/needs entry_id/);
  });
});

describe("scrubGraduation", () => {
  const base = { title: "Task panel (work-wolfpack-AbC1234)", kind: { type: "fact" }, summary: "Built in work-wolfpack-AbC1234.", detail: "See work-wp-Zz99999 for more.", confidence: "high", facets: {}, properties: {}, proposedRelations: [] } as any;
  it("strips work ids; hubs are always overview", () => {
    const f = scrubGraduation(base, "feature");
    expect(`${f.title} ${f.summary} ${f.detail}`).not.toMatch(/work-/);
    expect(f.title).toBe("Task panel");
    expect(f.kind).toEqual({ type: "fact" });
    expect(scrubGraduation(base, "hub").kind).toEqual({ type: "overview" });
  });
});

describe("sweep: graduated work creates its own entry", () => {
  let base: string;
  let roots: KbRoots;
  const prompts: string[] = [];
  const inbox = () => join(roots.opsRoot, "inbox", "w1");
  const entries = () => join(roots.kbBase, "domains", "wp", "entries");
  const systems: string[] = [];
  const drop = (topic: string, hash: string, body: string, grad = "") =>
    writeFileSync(
      join(inbox(), `${topic}-${hash}.md`),
      `---\nfrom: w1\nden_topic_id: ${topic}\nchange: create\ncontent_hash: ${hash}\nprev_hash: null\ndomain_hint: wp\nsubmitted: 2026-10-10T01:00:00Z\n${grad}---\n\n# ${topic}\n\n${body}\n`
    );
  const featureGrad = (id: string) => `graduation: feature\nentry_id: ${id}\n`;

  const engine = {
    call: vi.fn(async (step: string, schema: { parse: (v: unknown) => unknown }, opts: { prompt: string; system: string }) => {
      if (step === "classifyToSection") return schema.parse({ section: "NEW", confidence: "low" });
      prompts.push(opts.prompt);
      systems.push(opts.system);
      return schema.parse({
        title: "Graduated feature", kind: { type: "fact" }, summary: "s", detail: "d",
        confidence: "high", facets: {}, properties: {}, proposedRelations: [],
      });
    }),
    usage: { summarize: () => ({}) },
  } as unknown as Engine;

  beforeEach(() => {
    prompts.length = 0;
    systems.length = 0;
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

  it("creates its named entry instead of merging into a similar one, then updates it", async () => {
    drop("work-wp-Feat001", "h1", "first graduation", featureGrad("kb-wp-Feat001"));
    const first = await run();
    expect(first).toMatchObject({ created: 1, merged: 0 });
    expect(existsSync(join(entries(), "kb-wp-Feat001.md"))).toBe(true);
    expect(prompts[0]).not.toContain("huge catch-all");
    expect(prompts[0]).toContain("ACTION: create");
    expect(systems[0]).toContain("GRADUATION — FEATURE ENTRY");
    // The registry never records the work item id.
    expect(readLedger(roots).filter((e) => e.t === "aliased")).toEqual([]);

    drop("work-wp-Feat001", "h2", "graduated again", featureGrad("kb-wp-Feat001"));
    const second = await run();
    expect(second).toMatchObject({ created: 0, merged: 1 });
    // Regenerated from the dossier, never from its previous text.
    expect(prompts[1]).not.toContain("EXISTING ENTRY");
    expect(readFileSync(join(entries(), "kb-wp-BIGBIG1.md"), "utf8")).toContain("huge catch-all");
  });

  it("non-work contributions still merge by similarity", async () => {
    drop("some-den-topic", "h3", "a memory topic");
    const r = await run();
    expect(r.merged).toBe(1);
    expect(prompts[0]).toContain("EXISTING ENTRY (kb-wp-BIGBIG1)");
    expect(systems[0]).not.toContain("GRADUATION");
  });
});

describe("sweep: never merges into oversized entries", () => {
  let base: string;
  let roots: KbRoots;
  const notes: string[] = [];
  const inbox = () => join(roots.opsRoot, "inbox", "w1");
  const entries = () => join(roots.kbBase, "domains", "wp", "entries");
  const engine = {
    call: vi.fn(async (step: string, schema: { parse: (v: unknown) => unknown }) =>
      step === "classifyToSection"
        ? schema.parse({ section: "NEW", confidence: "low" })
        : schema.parse({ title: "Topic", kind: { type: "fact" }, summary: "s", detail: "d", confidence: "high", facets: {}, properties: {}, proposedRelations: [] })),
    usage: { summarize: () => ({}) },
  } as unknown as Engine;

  beforeEach(() => {
    notes.length = 0;
    base = mkdtempSync(join(tmpdir(), "kb-size-"));
    roots = { kbBase: join(base, "base"), opsRoot: join(base, "ops"), denLocal: join(base, "den") };
    mkdirSync(inbox(), { recursive: true });
    mkdirSync(entries(), { recursive: true });
    vi.stubEnv("KB_MAX_MERGE_TARGET_CHARS", "500");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ embedding: [1, 0, 0] }))));
    writeFileSync(join(inbox(), "t.md"), "---\nfrom: w1\nden_topic_id: some-topic\ncontent_hash: hx\nprev_hash: null\ndomain_hint: wp\n---\n\n# t\n\nbody\n");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    rmSync(base, { recursive: true, force: true });
  });

  const run = () =>
    sweep({ engine, roots, notify: (m) => notes.push(m),
      loadEntryVectors: async () => [{ entryId: "kb-wp-TARGET1", domain: "wp", vector: [1, 0, 0] } as any] });

  it("creates a new entry when the best match is over the limit", async () => {
    writeFileSync(join(entries(), "kb-wp-TARGET1.md"), "---\nid: kb-wp-TARGET1\nsection: sec-wp-aaaaaa\n---\n" + "x".repeat(600));
    expect(await run()).toMatchObject({ created: 1, merged: 0 });
    expect(notes.some((n) => n.includes("not merged into kb-wp-TARGET1"))).toBe(true);
  });

  it("still updates a graduation's own entry when it is over the limit", async () => {
    writeFileSync(join(entries(), "kb-wp-OWNHUB1.md"), "---\nid: kb-wp-OWNHUB1\nsection: sec-wp-aaaaaa\n---\n" + "x".repeat(600));
    writeFileSync(join(inbox(), "g.md"), "---\nfrom: w1\nden_topic_id: work-wp-OWNHUB1\ncontent_hash: hg\nprev_hash: null\ndomain_hint: wp\ngraduation: hub\nentry_id: kb-wp-OWNHUB1\n---\n\n# hub\n\nbody\n");
    rmSync(join(inbox(), "t.md"));
    expect(await run()).toMatchObject({ created: 0, merged: 1 });
    expect(notes.some((n) => n.includes("not merged into"))).toBe(false);
  });

  it("still merges into a match under the limit", async () => {
    writeFileSync(join(entries(), "kb-wp-TARGET1.md"), "---\nid: kb-wp-TARGET1\nsection: sec-wp-aaaaaa\n---\nsmall");
    expect(await run()).toMatchObject({ created: 0, merged: 1 });
  });
});
