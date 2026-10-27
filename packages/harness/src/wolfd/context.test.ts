import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    it("false removes the section", () => {
      const ins = composeProjectContext({ ...base(), structuredOutput: false }).instructions;
      expect(ins).not.toContain("Structured output");
      expect(ins).not.toContain("show_graph");
    });
  });

  it("loadSkills tolerates a missing skills dir", () => {
    expect(loadSkills(join(home, "nope"))).toEqual([]);
  });
});
