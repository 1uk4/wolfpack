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
