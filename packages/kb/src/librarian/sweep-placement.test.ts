import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "@wolfpack/engine";
import { sweep } from "./sweep.js";
import { writeSections } from "./sections.js";
import type { KbRoots } from "../shared/index.js";
import type { Section } from "../schema/knowledge.js";

describe("sweep: a new entry is only placed in its own domain's sections", () => {
  let base: string;
  let roots: KbRoots;
  const VEC = [0.5, 0.5, 0.0];

  const engine = {
    call: vi.fn(async (step: string, schema: { parse: (v: unknown) => unknown }) => {
      if (step === "classifyToSection") return schema.parse({ section: "NEW", confidence: "low" });
      return schema.parse({
        title: "Poker job application",
        kind: { type: "fact" },
        summary: "A personal job application at a poker company",
        detail: "Detail",
        confidence: "high",
        facets: {},
        properties: {},
        proposedRelations: [],
      });
    }),
    usage: { summarize: () => ({}) },
  } as unknown as Engine;

  const root = (id: string, domain: string): Section =>
    ({
      id, domain, parent: null, depth: 0, label: id, title: `Root ${id}`, centroid: VEC,
      memberCount: 1, childIds: [], summary: "s", summaryHash: "h", dirty: false,
      memberCountAtLastLabel: 1, created: "2026-10-01", updated: "2026-10-01",
    }) as unknown as Section;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "kb-place-"));
    roots = { kbBase: join(base, "base"), opsRoot: join(base, "ops"), denLocal: join(base, "den") };
    mkdirSync(join(roots.opsRoot, "inbox", "w1"), { recursive: true });
    mkdirSync(join(roots.kbBase, "domains", "personal", "entries"), { recursive: true });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ embedding: VEC }))));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(base, { recursive: true, force: true });
  });

  it("routes a personal contribution into a personal section even when another domain's section comes first", async () => {
    // Another domain's root is listed first and matches the entry exactly.
    writeSections(roots, [root("sec-snapjack-aaaaaa", "snapjack"), root("sec-personal-bbbbbb", "personal")]);
    writeFileSync(
      join(roots.opsRoot, "inbox", "w1", "job-app-abc.md"),
      ["---", "from: w1", "den_topic_id: job-app", "change: create", "content_hash: sha256:abc",
       "prev_hash: null", "domain_hint: personal", "submitted: 2026-10-20T01:00:00Z", "---", "",
       "Applied to a poker platform", ""].join("\n"),
    );

    const result = await sweep({ engine, roots, loadEntryVectors: async () => [] });

    expect(result.errors).toBe(0);
    const dir = join(roots.kbBase, "domains", "personal", "entries");
    const [file] = readdirSync(dir).filter((f) => f.endsWith(".md"));
    const section = /^section: (\S+)/m.exec(readFileSync(join(dir, file), "utf8"))?.[1];
    expect(section).toBe("sec-personal-bbbbbb");
  });
});

describe("sweep: logs parents whose direct entries outgrew the split threshold (once per sweep)", () => {
  let base: string;
  let roots: KbRoots;
  const VEC = [0.5, 0.5, 0.0];
  const engine = {
    call: vi.fn(async (step: string, schema: { parse: (v: unknown) => unknown }) => {
      if (step === "classifyToSection") return schema.parse({ section: "NEW", confidence: "low" });
      return schema.parse({ title: "T", kind: { type: "fact" }, summary: "S", detail: "D", confidence: "high", facets: {}, properties: {}, proposedRelations: [] });
    }),
    usage: { summarize: () => ({}) },
  } as unknown as Engine;
  const sec = (id: string, parent: string | null): Section =>
    ({ id, domain: "personal", parent, depth: parent ? 1 : 0, label: id, title: id, centroid: VEC, memberCount: 0, childIds: [], summary: "s", summaryHash: "h", dirty: false, memberCountAtLastLabel: 0, created: "2026-10-01", updated: "2026-10-01" }) as unknown as Section;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "kb-oversized-"));
    roots = { kbBase: join(base, "base"), opsRoot: join(base, "ops"), denLocal: join(base, "den") };
    mkdirSync(join(roots.opsRoot, "inbox", "w1"), { recursive: true });
    mkdirSync(join(roots.kbBase, "domains", "personal", "entries"), { recursive: true });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ embedding: VEC }))));
  });
  afterEach(() => { vi.unstubAllGlobals(); rmSync(base, { recursive: true, force: true }); });

  it("notifies once when a parent with children holds more than splitAbove direct entries", async () => {
    writeSections(roots, [sec("sec-personal-parent", null), sec("sec-personal-kid", "sec-personal-parent")]);
    const dir = join(roots.kbBase, "domains", "personal", "entries");
    const vectors = [];
    for (let i = 0; i < 11; i++) {
      const id = `kb-personal-E${String(i).padStart(6, "0")}`;
      writeFileSync(join(dir, `${id}.md`), `---\nid: ${id}\ntitle: ${id}\ndomain: personal\nsummary: s\nsection: sec-personal-parent\n---\n\nbody\n`);
      vectors.push({ entryId: id, canonicalId: "", domain: "personal", vector: VEC });
    }
    writeFileSync(join(roots.opsRoot, "inbox", "w1", "x-abc.md"),
      ["---", "from: w1", "den_topic_id: x", "change: create", "content_hash: sha256:abc", "prev_hash: null", "domain_hint: personal", "submitted: 2026-10-20T01:00:00Z", "---", "", "text", ""].join("\n"));
    const notes: string[] = [];
    await sweep({ engine, roots, loadEntryVectors: async () => vectors, notify: (m) => notes.push(m) });
    const hits = notes.filter((m) => /a rebuild is due/.test(m));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("sec-personal-parent (11)");
  });

  it("checks every domain with a tree, even when the item touches a different one (once per sweep)", async () => {
    const other = (id: string, parent: string | null) => ({ ...sec(id, parent), domain: "snapjack" }) as Section;
    writeSections(roots, [sec("sec-personal-p", null), sec("sec-personal-k", "sec-personal-p"), other("sec-snapjack-p", null), other("sec-snapjack-k", "sec-snapjack-p")]);
    const sdir = join(roots.kbBase, "domains", "snapjack", "entries");
    mkdirSync(sdir, { recursive: true });
    for (let i = 0; i < 12; i++) {
      const id = `kb-snapjack-E${String(i).padStart(6, "0")}`;
      writeFileSync(join(sdir, `${id}.md`), `---\nid: ${id}\ntitle: ${id}\ndomain: snapjack\nsummary: s\nsection: sec-snapjack-p\n---\n\nbody\n`);
    }
    writeFileSync(join(roots.opsRoot, "inbox", "w1", "x-abc.md"),
      ["---", "from: w1", "den_topic_id: x", "change: create", "content_hash: sha256:abc", "prev_hash: null", "domain_hint: personal", "submitted: 2026-10-20T01:00:00Z", "---", "", "text", ""].join("\n"));
    const notes: string[] = [];
    await sweep({ engine, roots, loadEntryVectors: async () => [], notify: (m) => notes.push(m) });
    const hits = notes.filter((m) => /a rebuild is due/.test(m));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("sec-snapjack-p (12)");
  });
});
