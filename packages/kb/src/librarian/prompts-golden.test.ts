/**
 * Golden snapshots of the hub KB sweep / reorg prompts as the librarian assembles them (system E, work-wolfpack-rruLly7):
 * a safety net for the prompt cleanup. The system texts themselves (PRODUCE_SYSTEM, MATCH_SUBJECT_SYSTEM, ...) are in
 * packages/engine/src/prompts-golden.test.ts; here the full call is captured at the engine.call seam with a stub engine:
 * system + user prompt, from fixed inputs and a pinned clock. Fixtures live in fixtures/prompts/E-hub-kb/.
 * Dead paths are included on purpose (split-fat): its fixture goes when the code goes.
 *
 * A failure means a prompt's text changed. If that was deliberate, review the diff and rewrite the fixtures:
 *
 *   UPDATE_PROMPT_GOLDEN=1 wolfpack test run packages/kb/src/librarian/prompts-golden.test.ts
 *
 * then commit the changed fixtures.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import type { Engine } from "@wolfpack/engine";
import { expectGolden } from "@wolfpack/engine/dist/golden.js";
import type { ParsedContribution } from "../shared/index.js";
import { SectionId } from "../schema/knowledge.js";
import { createOracles } from "./oracles.js";
import { produceEntry } from "./produce.js";
import { splitFatEntry } from "./split-fat.js";
import { labelSection, proposeSplit, sectionSummary } from "./summarize.js";

const dir = join(__dirname, "..", "fixtures", "prompts", "E-hub-kb");

interface Call {
  step: string;
  system: string;
  prompt: string;
}
/** A stub engine that records every call, then answers with `reply(step, n)`. */
function recorder(reply: (step: string, n: number) => unknown): { engine: Engine; calls: Call[] } {
  const calls: Call[] = [];
  const engine = {
    call: async (step: string, _schema: unknown, args: { system: string; prompt: string }) => {
      calls.push({ step, system: args.system, prompt: args.prompt });
      return reply(step, calls.length - 1);
    },
  } as unknown as Engine;
  return { engine, calls };
}
const render = (calls: Call[]) => calls.map((c, i) => `===== CALL ${i + 1}: ${c.step} / SYSTEM =====\n${c.system}\n\n===== CALL ${i + 1}: ${c.step} / PROMPT =====\n${c.prompt}`).join("\n\n");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-20T09:30:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("E hub KB sweep prompts", () => {
  it("oracles: section pick, match subject, confirm subject", async () => {
    const { engine, calls } = recorder((step) => {
      if (step === "classifyToSection") return { section: "NEW", confidence: 0.5 };
      if (step === "matchSubject") return { match: "new", reason: "r" };
      return { verdict: "different", reason: "r" };
    });
    const o = createOracles(engine);
    await o.classifyToSection("A contribution about login sessions.", [
      { sectionId: "sec-a-1", title: "Auth", summary: "Login and sessions." },
      { sectionId: "sec-a-2", title: "Billing", summary: "Invoices and plans." },
    ]);
    await o.matchSubject({ title: "Login sessions", summary: "How login works." }, [
      { id: "kb-a-1111111", title: "Auth overview", summary: "Auth in general." },
      { id: "kb-a-2222222", title: "Cookie flags", summary: "Cookie settings." },
    ]);
    await o.confirmSubject({ title: "Login sessions", summary: "How login works.", body: "Body of the contribution." }, { id: "kb-a-1111111", markdown: "# Auth overview\n\nText of the entry." });
    expectGolden(dir, "oracle-calls.txt", render(calls));
  });

  it("section summary, section label and split proposal (reorg / rebuild)", async () => {
    const { engine, calls } = recorder((step) => {
      if (step === "sectionSummary") return { summary: "s" };
      if (step === "labelSection") return { title: "t" };
      return { categories: [], doesnt_fit: [] };
    });
    const members = [
      { title: "Login sessions", summary: "How login works with server sessions and cookies." },
      { title: "Cookie flags", summary: "" },
    ];
    await sectionSummary(engine, members);
    await sectionSummary(engine, members, { depth: 0, maxDepth: 3 });
    await sectionSummary(engine, members, { depth: 1, maxDepth: 3 });
    await labelSection(engine, "Login and session handling.");
    await labelSection(engine, "Login and session handling.", { sampleTitles: ["Login sessions", "Cookie flags"], parentTitle: "Auth", siblingSummaries: ["Billing and invoices."], domain: "wolfpack", depth: 2, maxDepth: 3, forbiddenTitles: ["Misc"] });
    await labelSection(engine, "Login and session handling.", { depth: 0, maxDepth: 3 });
    await proposeSplit(engine, "Auth", [
      { id: "kb-a-2222222", title: "Cookie flags", summary: "Cookie settings." },
      { id: "kb-a-1111111", title: "Login sessions" },
    ]);
    expectGolden(dir, "reorg-calls.txt", render(calls));
  });

  it("produce: create, merge of an older contribution, and the retry after a failed check", async () => {
    const opinion = (over: Record<string, unknown> = {}) => ({ title: "Login sessions", kind: { type: "architecture" }, summary: "Login uses server sessions.", detail: "Login uses server sessions with a cookie.", confidence: "high", facets: {}, properties: {}, proposedRelations: [], ...over });
    const contribution = (over: Partial<ParsedContribution> = {}) =>
      ({ from: "wolf-a", denTopicId: "topic-1", summary: "Login uses sessions.", body: "We use server sessions.", contentHash: "abc", filePath: "/tmp/t.md", currency: "live", sourceUpdated: "2026-11-01", ...over }) as ParsedContribution;
    const base = { domain: "wolfpack", section: SectionId.parse("sec-wolfpack-abc123"), placement: { basis: "routed", fit: 0.8 } as never, resolve: () => null };

    const create = recorder(() => opinion());
    await produceEntry(create.engine, { ...base, contribution: contribution() });

    const existing = "---\nid: kb-wolfpack-abc1234\ntitle: Login sessions\nfactsAsOf: 2026-11-10\ncreated: 2026-10-01\nupdated: 2026-11-10\n---\n\n# Login sessions\n\nLogin uses cookies.\n\n## History\n\n- 2026-10-01: Cookies chosen.\n";
    const merge = recorder(() => opinion());
    await produceEntry(merge.engine, { ...base, contribution: contribution({ change: "update", sourceUpdated: "2026-11-01" } as never), entryId: "kb-wolfpack-abc1234", existingMarkdown: existing, originDate: "2026-11-01", updateInPlace: true });

    // A hash in the detail is a hard lint finding: forces the one retry.
    const retry = recorder((_s, n) => opinion(n === 0 ? { detail: "Shipped in commit 3f2a9c1b4d5e and deployed." } : {}));
    await produceEntry(retry.engine, { ...base, contribution: contribution(), allowOverflow: false });

    expectGolden(dir, "produce-calls.txt", ["## create", render(create.calls), "## merge (older contribution, update in place)", render(merge.calls), "## retry after failed checks, overflow not allowed", render(retry.calls)].join("\n\n"));
  });

  it("split-fat shard proposal (dead: no caller)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "golden-splitfat-"));
    try {
      const roots = { kbBase: join(tmp, "kb"), opsRoot: join(tmp, "ops"), denLocal: join(tmp, "den") };
      mkdirSync(join(roots.kbBase, "domains", "testdom", "entries"), { recursive: true });
      mkdirSync(join(roots.denLocal, "ledger"), { recursive: true });
      const fm = ["---", "id: kb-testdom-abc1234", 'title: "Fat entry"', "domain: testdom", "section: sec-testdom-abc123", "placement:", "  basis: routed", "  fit: 0.800", "kind: overview", "maturity: stub", "authority: curated", "confidence: high", "currency: live", "facets: {}", "properties: {}", "created: 2026-01-01", "updated: 2026-01-02", "contentHash: sha256:abc", "---", "", "## Section A\n\nText of A.", "", "## Section B\n\nText of B."].join("\n");
      writeFileSync(join(roots.kbBase, "domains", "testdom", "entries", "kb-testdom-abc1234.md"), fm);
      const shard = (t: string) => ({ title: t, summary: `${t} summary`, body: `${t} body` });
      const { engine, calls } = recorder(() => ({ shards: [shard("One"), shard("Two")] }));
      await splitFatEntry({ engine, roots, entryId: "kb-testdom-abc1234", threshold: 10, dryRun: true });
      expectGolden(dir, "split-fat-calls.txt", render(calls));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
