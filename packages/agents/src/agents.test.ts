import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bundledAgentsDir, discoverAgents, isWriterProfile, loadAgent, parseAgentDefinition } from "./index.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "agents-"));
  roots.push(d);
  return d;
};
const put = (dir: string, file: string, text: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), text);
};

describe("parseAgentDefinition", () => {
  it("reads the frontmatter fields and the body", () => {
    const def = parseAgentDefinition(
      "---\nname: w\ndescription: does work\nmodel: smart\ntools: read, edit\nskills: a\npane: true\nauto-exit: false\nsession-mode: fork\nsubagent_agents: scout, worker\ncwd: sub\nisolation: worktree\nsystem-prompt: replace\ndisable-model-invocation: true\n---\n\nBody text.\n",
      "fallback",
    );
    expect(def).toMatchObject({
      name: "w",
      description: "does work",
      model: "smart",
      tools: "read, edit",
      skills: "a",
      pane: true,
      autoExit: false,
      sessionMode: "fork",
      subagentAgents: ["scout", "worker"],
      cwd: "sub",
      isolation: "worktree",
      systemPromptMode: "replace",
      disableModelInvocation: true,
      body: "Body text.",
    });
  });

  it("falls back to the file name, ignores unknown isolation and needs frontmatter", () => {
    expect(parseAgentDefinition("---\nisolation: maybe\n---\nx", "f")).toMatchObject({ name: "f", isolation: undefined, disableModelInvocation: false });
    expect(parseAgentDefinition("no frontmatter", "f")).toBeNull();
  });

  it("a writer has edit, write or bash", () => {
    expect(isWriterProfile({ tools: "read, grep" })).toBe(false);
    expect(isWriterProfile({ tools: "read, bash" })).toBe(true);
    expect(isWriterProfile({})).toBe(false);
  });
});

describe("discovery", () => {
  it("the bundled roster has the shipped profiles", () => {
    const names = discoverAgents({ cwd: tmp(), agentDir: tmp() }).map((a) => a.name);
    expect(names).toEqual(expect.arrayContaining(["scout", "worker", "planner", "reviewer", "researcher", "investigator"]));
    expect(bundledAgentsDir().endsWith(join("packages", "agents", "agents"))).toBe(true);
  });

  it("project .pi/agents beats <agentDir>/agents beats the package", () => {
    const pkg = tmp();
    const agentDir = tmp();
    const cwd = tmp();
    put(pkg, "a.md", "---\nname: a\ndescription: pkg\n---\nx");
    put(pkg, "b.md", "---\nname: b\ndescription: pkg\n---\nx");
    put(pkg, "c.md", "---\nname: c\ndescription: pkg\n---\nx");
    put(join(agentDir, "agents"), "b.md", "---\nname: b\ndescription: wolf\n---\nx");
    put(join(agentDir, "agents"), "c.md", "---\nname: c\ndescription: wolf\n---\nx");
    put(join(cwd, ".pi", "agents"), "c.md", "---\nname: c\ndescription: project\n---\nx");
    const opts = { cwd, agentDir, packageDirs: [pkg] };
    const by = Object.fromEntries(discoverAgents(opts).map((a) => [a.name, [a.description, a.source]]));
    expect(by).toEqual({ a: ["pkg", "package"], b: ["wolf", "global"], c: ["project", "project"] });
    expect(loadAgent("c", opts)?.description).toBe("project");
    expect(loadAgent("b", opts)?.description).toBe("wolf");
    expect(loadAgent("a", opts)?.description).toBe("pkg");
    expect(loadAgent("nope", opts)).toBeNull();
  });
});

describe("roster order", () => {
  it("is sorted by name whatever order the files were written or read in", () => {
    const pkg = tmp();
    for (const n of ["m", "z", "a", "q"]) put(pkg, `${n}.md`, `---\nname: ${n}\ndescription: d\n---\nx`);
    const agentDir = tmp();
    put(join(agentDir, "agents"), "b.md", "---\nname: b\ndescription: d\n---\nx");
    expect(discoverAgents({ cwd: tmp(), agentDir, packageDirs: [pkg] }).map((a) => a.name)).toEqual(["a", "b", "m", "q", "z"]);
  });
});

describe("orchestrator work-id rule", () => {
  it("tells agents to write full work ids", async () => {
    const { orchestratorRules } = await import("./orchestrator.js");
    expect(orchestratorRules({ opsRef: "x", surface: "wolfd" })).toMatch(/full `work-<domain>-<id>`/);
    const rules = orchestratorRules({ opsRef: "x", surface: "wolfd" });
    expect(rules).toContain("chip with a hover card");
    expect(rules).toContain("NOT linked inside a fenced code block");
    expect(rules).toContain("even in lists of several items");
  });
});

describe("orchestrator UI-check rule", () => {
  it("points UI checks at the verify-ui standard and keeps 3230 off limits", async () => {
    const { orchestratorRules } = await import("./orchestrator.js");
    const rules = orchestratorRules({ opsRef: "x", surface: "wolfd" });
    expect(rules).toContain("packages/agents/standards/verify-ui.md");
    expect(rules).toContain("slot URL");
    expect(rules).toContain("never touch port 3230");
  });
});

describe("bundled visualizer", () => {
  it("is in the bundled roster with read-only tools only", () => {
    const def = loadAgent("visualizer", { cwd: tmp(), agentDir: tmp() });
    expect(def).not.toBeNull();
    const tools = (def?.tools ?? "").split(",").map((t) => t.trim());
    expect(tools).toEqual(["read", "grep", "find", "ls"]);
  });
});

describe("standards", () => {
  // A fixture standard: these tests check the loader, not the shipped text.
  const MARK = "# Fixture testing standard";
  const GIT_MARK = "# Fixture git standard";
  const count = (body: string | undefined, text: string) => (body ?? "").split(text).length - 1;
  const fixtureStandards = () => {
    const dir = tmp();
    put(dir, "testing.md", `${MARK}\nrules\n`);
    put(dir, "git.md", `${GIT_MARK}\nrules\n`);
    put(dir, "extra.md", "# Extra standard\n");
    return dir;
  };

  it("gives worker, planner and reviewer the testing standard, and worker and reviewer the git standard, each exactly once, from any source, and not the scout or the planner's git", () => {
    const standardsDir = fixtureStandards();
    const agentDir = tmp();
    const cwd = tmp();
    put(join(agentDir, "agents"), "worker.md", "---\nname: worker\n---\nmy worker");
    put(join(cwd, ".pi", "agents"), "planner.md", "---\nname: planner\nstandards: testing\n---\nmy planner");
    const opts = { cwd, agentDir, standardsDir };
    const expected = {
      worker: { testing: 1, git: 1 },
      reviewer: { testing: 1, git: 1 },
      planner: { testing: 1, git: 0 },
      scout: { testing: 0, git: 0 },
    };
    for (const [name, want] of Object.entries(expected)) {
      for (const body of [loadAgent(name, opts)?.body, discoverAgents(opts).find((a) => a.name === name)?.body]) {
        expect({ name, testing: count(body, MARK), git: count(body, GIT_MARK) }).toEqual({ name, ...want });
      }
    }
    expect(loadAgent("worker", opts)?.body).toMatch(/^my worker/);
  });

  it("a wolf's standards override wins over the shipped one and is read fresh on every load (no cache); another wolf keeps the default", () => {
    const standardsDir = fixtureStandards();
    const agentDir = tmp();
    const otherAgentDir = tmp();
    put(join(agentDir, "agents"), "worker.md", "---\nname: worker\n---\nmy worker");
    put(join(otherAgentDir, "agents"), "worker.md", "---\nname: worker\n---\nmy worker");
    const opts = { cwd: tmp(), agentDir, standardsDir };
    expect(count(loadAgent("worker", opts)?.body, MARK)).toBe(1);
    put(join(agentDir, "standards"), "testing.md", "# Wolf testing\n");
    const edited = loadAgent("worker", opts)?.body;
    expect(edited).toContain("# Wolf testing");
    expect(edited).not.toContain(MARK);
    expect(edited).toContain(GIT_MARK);
    put(join(agentDir, "standards"), "testing.md", "# Wolf testing v2\n");
    expect(discoverAgents(opts).find((a) => a.name === "worker")?.body).toContain("# Wolf testing v2");
    expect(count(loadAgent("worker", { ...opts, agentDir: otherAgentDir })?.body, MARK)).toBe(1);
  });

  it("matches the always-on names case-insensitively, by frontmatter name and by the requested name", () => {
    const agentDir = tmp();
    put(join(agentDir, "agents"), "worker.md", "---\nname: Worker\n---\nbody");
    put(join(agentDir, "agents"), "planner.md", "---\nname: Helper\n---\nbody");
    const opts = { cwd: tmp(), agentDir, standardsDir: fixtureStandards() };
    expect(count(loadAgent("worker", opts)?.body, MARK)).toBe(1);
    expect(count(loadAgent("planner", opts)?.body, MARK)).toBe(1);
  });

  it("gives any other profile only the standards its frontmatter names", () => {
    const agentDir = tmp();
    put(join(agentDir, "agents"), "x.md", "---\nname: x\nstandards: extra\n---\nbody");
    const body = loadAgent("x", { cwd: tmp(), agentDir, standardsDir: fixtureStandards() })?.body;
    expect(body).toContain("# Extra standard");
    expect(body).not.toContain(MARK);
  });

  it("loads an agent without a standard it cannot read, and logs an error naming the file, once per process", () => {
    const standardsDir = tmp();
    const agentDir = tmp();
    put(join(agentDir, "agents"), "worker.md", "---\nname: worker\n---\nmy worker");
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const opts = { cwd: tmp(), agentDir, standardsDir };
      const def = loadAgent("worker", opts);
      expect(def?.body).toBe("my worker");
      // Owner-decided contract: the loud error names the file that could not be read.
      const logged = (file: string) => err.mock.calls.filter(([m]) => String(m).includes(join(standardsDir, file))).length;
      expect(logged("testing.md")).toBe(1);
      expect(logged("git.md")).toBe(1);
      // A second load adds no further errors.
      discoverAgents(opts);
      loadAgent("worker", opts);
      expect(logged("testing.md")).toBe(1);
      expect(logged("git.md")).toBe(1);
    } finally {
      err.mockRestore();
    }
  });

  it("throws for a shipped profile whose standard name is invalid", () => {
    const pkg = tmp();
    put(pkg, "b.md", "---\nname: b\nstandards: ../x\n---\nbody");
    const opts = { cwd: tmp(), agentDir: tmp(), packageDirs: [pkg], standardsDir: fixtureStandards() };
    expect(() => loadAgent("b", opts)).toThrow(/Invalid standard name "\.\.\/x"/);
  });

  it("skips a user profile with an invalid standard name: the roster keeps the rest, and loadAgent falls through to the next directory", () => {
    const agentDir = tmp();
    const cwd = tmp();
    put(join(cwd, ".pi", "agents"), "x.md", "---\nname: x\nstandards: ../nope\n---\nproject copy");
    put(join(agentDir, "agents"), "x.md", "---\nname: x\n---\nglobal copy");
    put(join(cwd, ".pi", "agents"), "y.md", "---\nname: y\nstandards: ../nope\n---\nonly copy");
    const opts = { cwd, agentDir, standardsDir: fixtureStandards() };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const roster = discoverAgents(opts);
      expect(roster.find((a) => a.name === "x")?.body).toBe("global copy");
      expect(roster.map((a) => a.name)).toContain("worker");
      expect(roster.map((a) => a.name)).not.toContain("y");
      expect(loadAgent("x", opts)?.body).toBe("global copy");
      expect(loadAgent("y", opts)).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("orchestrator worker-reuse rule", () => {
  it("starts a fresh worker in the existing worktree once a commit has landed, and reuses only mid-work", async () => {
    const { orchestratorRules } = await import("./orchestrator.js");
    const rules = orchestratorRules({ opsRef: "x", surface: "wolfd" });
    expect(rules).toContain("once a worker's commit has landed, start a fresh worker");
    expect(rules).toContain('isolation "none"');
    expect(rules).toContain("what's done, what's left");
    expect(rules).toContain("subagent_message");
    expect(rules).toContain("packages/agents/standards/");
    expect(rules).not.toContain("spawn fresh only for independent tasks");
  });
});
