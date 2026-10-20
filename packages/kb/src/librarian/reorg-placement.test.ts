import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "@wolfpack/engine";
import { reorg } from "./reorg.js";
import { writeSections } from "./sections.js";
import type { KbRoots } from "../shared/index.js";
import type { Section } from "../schema/knowledge.js";

describe("reorg: entries are re-homed into their own domain's tree", () => {
  let base: string;
  let roots: KbRoots;
  const VEC = [0.5, 0.5, 0.0];

  const root = (id: string, domain: string): Section =>
    ({
      id, domain, parent: null, depth: 0, label: id, title: `Root ${id}`, centroid: VEC,
      memberCount: 1, childIds: [], summary: "s", summaryHash: "h", dirty: false,
      memberCountAtLastLabel: 1, created: "2026-10-01", updated: "2026-10-01",
    }) as unknown as Section;

  const entry = (domain: string, id: string, section: string) => {
    const dir = join(roots.kbBase, "domains", domain, "entries");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.md`), `---\nid: ${id}\ntitle: ${id}\nsummary: s\nsection: ${section}\n---\n\nbody of ${id}\n`);
  };

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "kb-reorg-place-"));
    roots = { kbBase: join(base, "base"), opsRoot: join(base, "ops"), denLocal: join(base, "den") };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ embedding: VEC }))));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(base, { recursive: true, force: true });
  });

  it("moves a personal entry out of a snapjack section into a personal one", async () => {
    writeSections(roots, [root("sec-snapjack-aaaaaa", "snapjack"), root("sec-personal-bbbbbb", "personal")]);
    entry("snapjack", "kb-snapjack-AAAAAAA", "sec-snapjack-aaaaaa");
    entry("personal", "kb-personal-BBBBBBB", "sec-personal-bbbbbb");
    entry("personal", "kb-personal-MISPLCD", "sec-snapjack-aaaaaa");

    const notes: string[] = [];
    const engine = { call: vi.fn(), usage: { summarize: () => ({}) } } as unknown as Engine;
    await reorg({ engine, roots, domains: ["personal"], dryRun: true, notify: (m) => notes.push(m) });

    expect(notes).toContain("  placed: kb-personal-MISPLCD → sec-personal-bbbbbb");
    expect(notes.some((n) => n.includes("kb-personal-BBBBBBB") && n.includes("placed:"))).toBe(false);
  });
});
