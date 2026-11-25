/**
 * Golden snapshot of the memory and task tools as the model sees them (name, description, every parameter's description),
 * work-wolfpack-rruLly7. Fixture: fixtures/prompts/A-main-wolf/memory-task-tools.txt. The rest of the wolfd tool set is in
 * packages/harness/src/wolfd/tool-descriptions-golden.test.ts (descriptions only: the catalog carries no parameters).
 *
 * A failure means a tool description changed. If deliberate, rewrite the fixture and commit it:
 *
 *   UPDATE_PROMPT_GOLDEN=1 wolfpack test run extensions/wolfpack-memory/prompts-golden.test.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { Engine } from "@wolfpack/engine";
import { renderDenContext, renderKbAccess, renderRetiredContext, updateTopicState } from "@wolfpack/memory";
import { expectGolden } from "@wolfpack/engine/dist/golden.js";
import createMemoryExtension from "./unified.js";
import createTasksExtension from "./unified-tasks.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** Every `description` in a JSON schema, as `path: text` lines (property order as declared). */
function describeSchema(schema: unknown, path: string, out: string[]): void {
  if (!schema || typeof schema !== "object") return;
  const s = schema as { description?: string; properties?: Record<string, unknown>; items?: unknown; anyOf?: unknown[]; enum?: unknown[]; required?: string[] };
  if (s.description) out.push(`  ${path || "(object)"}: ${s.description}`);
  for (const [k, v] of Object.entries(s.properties ?? {})) describeSchema(v, `${path}${path ? "." : ""}${k}${s.required?.includes(k) ? "*" : ""}`, out);
  if (s.items) describeSchema(s.items, `${path}[]`, out);
  (s.anyOf ?? []).forEach((v) => describeSchema(v, path, out));
}

it("per-request sections of the main wolf: den topics, retired notes and the KB outline, from seeded inputs", () => {
  const root = mkdtempSync(join(tmpdir(), "golden-sections-"));
  roots.push(root);
  const put = (rel: string, text: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  const topic = (id: string, summary: string) => `---\nid: ${id}\ntitle: Topic ${id}\nsummary: ${summary}\nupdated: 2026-11-01\n---\nBody of ${id}.\n`;
  put("den/memory/topics/alpha.md", topic("alpha", "First pending topic"));
  put("den/memory/topics/beta.md", topic("beta", "Second pending topic"));
  put("kb/domains/wolfpack/entries/e1.md", "---\ntitle: E1\n---\n");
  put("kb/domains/wolfpack/entries/e2.md", "---\ntitle: E2\n---\n");
  put("kb/domains/wolfpack/_digest.json", JSON.stringify({ sections: [{ title: "Hub", summary: "Hub work", entryIds: ["e1"], children: [{ title: "Sync", summary: "Mirror sync", entryIds: ["e2"] }] }] }));
  put("kb/domains/snapjack/entries/s1.md", "---\ntitle: S1\n---\n");
  const den = join(root, "den");
  updateTopicState(den, "old", { promotedAt: "2026-11-01T00:00:00.000Z", retiredAt: "2026-11-02T00:00:00.000Z", receipt: { outcome: "create", entryIds: ["e1"] } });
  const pin = (t: string | null) => String(t).split(root).join("<TMP>");
  const out = [
    `## wolf_memory\n${pin(renderDenContext(den, "fixture-wolf"))}`,
    `## wolf_memory_retired\n${pin(renderRetiredContext(den, { resolveEntry: (id) => id, readEntry: (id) => ({ title: `Title ${id}`, summary: `About ${id}` }) }))}`,
    `## kb_access\n${pin(renderKbAccess(join(root, "kb"), ["wolfpack", "snapjack"]))}`,
  ].join("\n\n");
  expectGolden(join(__dirname, "fixtures", "prompts", "A-main-wolf"), "request-sections.txt", out);
});

it("memory and task tools: name, description and parameter descriptions", () => {
  const den = mkdtempSync(join(tmpdir(), "golden-tools-"));
  roots.push(den);
  const c = { wolfDen: den, wolfName: "testwolf", domains: ["wolfpack"], wolfConfig: {}, env: {} };
  const engine = { call: async () => ({ text: "" }) } as unknown as Engine;
  const exts = [createMemoryExtension({ engine } as never, c as never), createTasksExtension({}, c as never)];
  const tools = exts.flatMap((e) => (e.tools ?? []).map((t) => ({ ext: e.name, t })));
  expect(tools.length).toBeGreaterThan(0);
  const out = tools
    .sort((a, b) => (a.t.name < b.t.name ? -1 : 1))
    .map(({ ext, t }) => {
      const params: string[] = [];
      describeSchema(JSON.parse(JSON.stringify(t.parameters)), "", params);
      return `===== ${t.name} (${ext}) =====\n${t.description}\n${params.length ? `parameters:\n${params.join("\n")}` : "parameters: none described"}`;
    })
    .join("\n\n");
  expectGolden(join(__dirname, "fixtures", "prompts", "A-main-wolf"), "memory-task-tools.txt", out);
});
