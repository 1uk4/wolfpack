import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverAgents } from "./discover.js";
import { orchestratorRules } from "./orchestrator.js";
import { PROMPTS, PROMPT_MAX_BYTES, PromptWriteError, resetPromptOverride, resolvePrompt, writePromptOverride } from "./prompts.js";

let a: string;
let b: string;
beforeEach(() => {
  a = mkdtempSync(join(tmpdir(), "prompts-a-"));
  b = mkdtempSync(join(tmpdir(), "prompts-b-"));
});
afterEach(() => {
  rmSync(a, { recursive: true, force: true });
  rmSync(b, { recursive: true, force: true });
});

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof PromptWriteError ? e.code : String(e);
  }
  return "none";
};

describe("prompt resolver", () => {
  it("an override applies to its own wolf only, and reset restores the repo default", () => {
    const base = resolvePrompt("orchestrator-rules", a);
    expect(base.source).toBe("default");
    writePromptOverride(a, "orchestrator-rules", "Custom for {{opsRef}} / {{paneNote}}");
    expect(resolvePrompt("orchestrator-rules", a)).toMatchObject({ source: "override", text: "Custom for {{opsRef}} / {{paneNote}}" });
    expect(resolvePrompt("orchestrator-rules", b)).toEqual(base);
    expect(orchestratorRules({ opsRef: "/ops.md", surface: "tui", wolfHome: a })).toMatch(/^Custom for \/ops\.md \/ Each agent has its own pane/);
    expect(resetPromptOverride(a, "orchestrator-rules")).toEqual(base);
  });

  it("rejects a stale etag, an oversized text and an unknown or non-editable id; leaves no temp file", () => {
    const first = writePromptOverride(a, "orchestrator-rules", "one");
    writePromptOverride(a, "orchestrator-rules", "two", first.etag); // current etag: accepted
    expect(code(() => writePromptOverride(a, "orchestrator-rules", "three", first.etag))).toBe("stale");
    expect(code(() => writePromptOverride(a, "orchestrator-rules", "x".repeat(PROMPT_MAX_BYTES + 1)))).toBe("too_large");
    expect(code(() => writePromptOverride(a, "nope", "x"))).toBe("unknown");
    expect(readFileSync(join(a, "agent", "prompts", "orchestrator-rules.md"), "utf8")).toBe("two");
    expect(readdirSync(join(a, "agent", "prompts"))).toEqual(["orchestrator-rules.md"]);
    expect(existsSync(join(b, "agent"))).toBe(false);
  });
});

describe("prompt registry", () => {
  it("every id has a non-empty default and declares exactly the {{placeholders}} its default uses", () => {
    expect(PROMPTS.length).toBeGreaterThan(0);
    for (const def of PROMPTS) {
      const text = resolvePrompt(def.id).text;
      expect(text.trim().length, def.id).toBeGreaterThan(0);
      const used = [...new Set([...text.matchAll(/\{\{([a-zA-Z0-9_]+)\}\}/g)].map((m) => m[1]))].sort();
      expect([...def.placeholders].sort(), def.id).toEqual(used);
    }
  });
});

describe("helper profiles and standards as editable prompts", () => {
  const PROFILES = ["investigator", "planner", "researcher", "reviewer", "scout", "visualizer", "worker"];
  const STANDARDS = ["git", "testing", "verify-ui"];

  it("registers the seven profiles and three standards as editable, per-wolf entries", () => {
    for (const n of PROFILES) expect(PROMPTS.find((p) => p.id === `agent.${n}`), n).toMatchObject({ group: "Helper profiles", editable: true, store: "agents" });
    for (const n of STANDARDS) expect(PROMPTS.find((p) => p.id === `standard.${n}`), n).toMatchObject({ group: "Standards", editable: true, store: "standards" });
  });

  it("a profile edit lands where discoverAgents reads it, only for that wolf, and reset restores the default", () => {
    const base = resolvePrompt("agent.scout", a);
    expect(base.text).toMatch(/^---\nname: scout\n/);
    writePromptOverride(a, "agent.scout", "---\nname: scout\ndescription: mine\n---\nMy scout body");
    const mine = discoverAgents({ cwd: a, agentDir: join(a, "agent") }).find((x) => x.name === "scout");
    expect(mine).toMatchObject({ description: "mine", body: "My scout body", source: "global" });
    expect(discoverAgents({ cwd: b, agentDir: join(b, "agent") }).find((x) => x.name === "scout")?.description).not.toBe("mine");
    expect(resetPromptOverride(a, "agent.scout")).toEqual(base);
    expect(existsSync(join(a, "agent", "agents", "scout.md"))).toBe(false);
  });

  it("a standard edit is written under agent/standards and read back; reset restores the default", () => {
    const base = resolvePrompt("standard.testing", a);
    writePromptOverride(a, "standard.testing", "# Mine\n");
    expect(readFileSync(join(a, "agent", "standards", "testing.md"), "utf8")).toBe("# Mine\n");
    expect(resolvePrompt("standard.testing", a)).toMatchObject({ source: "override", text: "# Mine\n" });
    expect(resetPromptOverride(a, "standard.testing")).toEqual(base);
  });

  it("rejects profile frontmatter that does not parse or whose name differs from the id, leaving the file untouched", () => {
    writePromptOverride(a, "agent.worker", "---\nname: worker\n---\nok");
    const file = join(a, "agent", "agents", "worker.md");
    for (const bad of ["no frontmatter", "---\nname: other\n---\nx", "---\ndescription: no name\n---\nx", "---\nname: worker\nthis is not a pair\n---\nx", "---\nname: worker\nstandards: bad name!\n---\nx"]) {
      expect(code(() => writePromptOverride(a, "agent.worker", bad)), bad).toBe("invalid");
      expect(readFileSync(file, "utf8")).toBe("---\nname: worker\n---\nok");
    }
  });

  it("backs up the existing override before a write or a reset, and keeps the last 10 per file", () => {
    writePromptOverride(a, "orchestrator-rules", "v0");
    expect(existsSync(join(a, "agent", ".backups"))).toBe(false); // nothing to back up on first write
    for (let i = 1; i <= 12; i++) writePromptOverride(a, "orchestrator-rules", `v${i}`);
    const dir = join(a, "agent", ".backups", "prompts");
    const files = readdirSync(dir).sort();
    expect(files).toHaveLength(10);
    expect(files.every((f) => /^orchestrator-rules\.\d{17,}\.md$/.test(f))).toBe(true);
    expect(files.map((f) => readFileSync(join(dir, f), "utf8"))).toEqual(["v2", "v3", "v4", "v5", "v6", "v7", "v8", "v9", "v10", "v11"]);
    resetPromptOverride(a, "orchestrator-rules");
    expect(readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).sort()).toContain("v12");
    expect(readdirSync(dir)).toHaveLength(10);
    writePromptOverride(a, "agent.worker", "---\nname: worker\n---\n1");
    writePromptOverride(a, "agent.worker", "---\nname: worker\n---\n2");
    expect(readdirSync(join(a, "agent", ".backups", "agents"))).toHaveLength(1);
  });
});
