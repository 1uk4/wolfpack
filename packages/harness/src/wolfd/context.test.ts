import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { childInstructions } from "./subagents.js";
import { DEFAULT_STRUCTURED_OUTPUT_GUIDANCE, composeProjectContext, findUp, loadSkills } from "./context.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "wolfd-ctx-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const put = (rel: string, text: string) => {
  const p = join(home, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
};

describe("findUp", () => {
  it("nearest file wins, walking up to home", () => {
    put("AGENTS.md", "home agents");
    put("a/AGENTS.md", "a agents");
    mkdirSync(join(home, "a/b/c"), { recursive: true });
    expect(findUp("AGENTS.md", join(home, "a/b/c"), home)?.text).toBe("a agents");
    expect(findUp("AGENTS.md", join(home, "a"), home)?.text).toBe("a agents");
    expect(findUp("AGENTS.md", home, home)?.text).toBe("home agents");
  });

  it("does not look above home", () => {
    const inner = join(home, "inner");
    mkdirSync(inner);
    put("../wolfd-above-AGENTS.md", "x"); // sibling of home, never read
    expect(findUp("AGENTS.md", inner, inner)).toBeUndefined();
    expect(findUp("CLAUDE.md", inner, home)).toBeUndefined();
  });
});

describe("composeProjectContext", () => {
  it("composes identity, nearest AGENTS.md and CLAUDE.md independently, and skills", () => {
    put("AGENTS.md", "root agents");
    put("proj/CLAUDE.md", "proj claude");
    put("proj/sub/AGENTS.md", "sub agents");
    put("den/skills/alpha/SKILL.md", "---\nname: alpha-skill\ndescription: Does alpha things\n---\nbody");
    put("den/skills/beta/SKILL.md", "no frontmatter");
    mkdirSync(join(home, "den/skills/empty"), { recursive: true });
    const cwd = join(home, "proj/sub");
    const ctx = composeProjectContext({ name: "tester", domains: ["x", "y"], cwd, den: join(home, "den"), home });
    expect(ctx.agents?.text).toBe("sub agents"); // nearest wins; root's is shadowed
    expect(ctx.claude?.path).toBe(join(home, "proj/CLAUDE.md")); // CLAUDE.md found at a different level
    expect(ctx.skills.map((s) => s.name)).toEqual(["alpha-skill", "beta"]);
    expect(ctx.instructions).toContain("You are tester");
    expect(ctx.instructions).toContain("Domains: x, y");
    expect(ctx.instructions).toContain("sub agents");
    expect(ctx.instructions).not.toContain("root agents");
    expect(ctx.instructions).toContain("proj claude");
    expect(ctx.instructions).toContain("- alpha-skill: Does alpha things");
    expect(ctx.instructions).not.toContain("body");
  });

  it("works with nothing present", () => {
    const ctx = composeProjectContext({ name: "bare", cwd: home, den: join(home, "den"), home });
    expect(ctx.agents).toBeUndefined();
    expect(ctx.skills).toEqual([]);
    expect(ctx.instructions).toMatch(/^You are bare/);
  });

  describe("structured output guidance", () => {
    const base = () => ({ name: "w", cwd: home, den: join(home, "den"), home });
    it("is in the default instructions as a named section", () => {
      const ins = composeProjectContext(base()).instructions;
      expect(ins).toContain("# Structured output");
      for (const t of ["show_graph", "show_checklist", "show_decision", "objectId"]) expect(ins).toContain(t);
      expect(DEFAULT_STRUCTURED_OUTPUT_GUIDANCE.split("\n").length).toBeLessThan(15);
    });
    it("a per-wolf string replaces the default", () => {
      const ins = composeProjectContext({ ...base(), structuredOutput: "Only use show_graph." }).instructions;
      expect(ins).toContain("# Structured output\n\nOnly use show_graph.");
      expect(ins).not.toContain("show_checklist");
    });
    it("an empty or whitespace string removes the section, like false", () => {
      for (const v of ["", "  \n "]) expect(composeProjectContext({ ...base(), structuredOutput: v }).instructions).not.toContain("Structured output");
    });
    it("false removes the section", () => {
      const ins = composeProjectContext({ ...base(), structuredOutput: false }).instructions;
      expect(ins).not.toContain("Structured output");
      expect(ins).not.toContain("show_graph");
    });
  });

  describe("identity and orchestrator rules", () => {
    const wolfHome = () => join(home, "wolf");
    const base = () => ({ name: "w", cwd: join(home, "ws"), den: join(home, "den"), home, wolfHome: wolfHome() });

    it("loads <wolf-home>/agent/AGENTS.md as the identity, labelled with its path, before the walk's AGENTS.md", () => {
      put("wolf/agent/AGENTS.md", "I am the owner");
      put("ws/AGENTS.md", "workspace rules");
      const ctx = composeProjectContext(base());
      expect(ctx.identity?.path).toBe(join(wolfHome(), "agent/AGENTS.md"));
      const ins = ctx.instructions;
      expect(ins).toContain(`# Identity (${join(wolfHome(), "agent/AGENTS.md")})\n\nI am the owner`);
      expect(ins.indexOf("I am the owner")).toBeLessThan(ins.indexOf("workspace rules"));
    });

    it("wolf.yaml identity wins over the agent/ fallback", () => {
      put("wolf/agent/AGENTS.md", "fallback");
      put("elsewhere/ME.md", "explicit identity");
      const ins = composeProjectContext({ ...base(), identityFile: join(home, "elsewhere/ME.md") }).instructions;
      expect(ins).toContain("explicit identity");
      expect(ins).not.toContain("fallback");
    });

    it("includes the orchestrator rules (wolfd wording) and the roster", () => {
      put("wolf/agent/agents/zed.md", "---\nname: zed\ndescription: Does zed\n---\nprompt");
      const ins = composeProjectContext(base()).instructions;
      expect(ins).toContain("# Orchestrator rules");
      expect(ins).toContain("You are the orchestrator");
      expect(ins).toContain("console's subagent modal");
      expect(ins).toMatch(/Subagent roster:\n• /);
      expect(ins).toContain("• zed");
      expect(ins).toContain("scout");
    });

    it("a missing identity file is skipped with a debug log", () => {
      const logs: string[] = [];
      const ctx = composeProjectContext({ ...base(), log: (l) => logs.push(l) });
      expect(ctx.identity).toBeUndefined();
      expect(ctx.instructions).not.toContain("# Identity");
      expect(logs.some((l) => l.startsWith("debug:") && l.includes("agent/AGENTS.md"))).toBe(true);
    });

    it("does not repeat the identity when the walk finds the same file", () => {
      put("wolf/agent/AGENTS.md", "same file once");
      const ins = composeProjectContext({ ...base(), cwd: join(home, "wolf/agent") }).instructions;
      expect(ins.split("same file once").length - 1).toBe(1);
      expect(ins).not.toContain("# AGENTS.md");
    });

    it("a feature workspace gets the same sections", () => {
      put("wolf/agent/AGENTS.md", "identity text");
      const ins = composeProjectContext({ ...base(), cwd: join(home, "wolf/workspaces/feat") }).instructions;
      expect(ins).toContain("identity text");
      expect(ins).toContain("# Orchestrator rules");
    });

    it("a subagent thread keeps only its profile prompt (neither section)", () => {
      put("wolf/agent/AGENTS.md", "identity text");
      const out = childInstructions({ name: "scout", description: "d", body: "Scout prompt." } as never, "scout-1");
      expect(out).toContain("Scout prompt.");
      expect(out).not.toContain("identity text");
      expect(out).not.toContain("orchestrator");
    });

    it("without a wolfHome (not a wolf process) neither section appears", () => {
      const ins = composeProjectContext({ name: "w", cwd: home, den: join(home, "den"), home }).instructions;
      expect(ins).not.toContain("# Identity");
      expect(ins).not.toContain("Orchestrator");
    });
  });

  it("loadSkills tolerates a missing skills dir", () => {
    expect(loadSkills(join(home, "nope"))).toEqual([]);
  });
});
