import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
