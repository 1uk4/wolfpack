/**
 * Roster discovery. Later directories win: package, then the wolf's agent dir, then the project (`<cwd>/.pi/agents`).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAgentDefinition, type AgentDefinition, type AgentSource, type ListedAgentDefinition } from "./profile.js";

/** The profiles shipped with wolfpack (`packages/agents/agents`). */
export function bundledAgentsDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "agents");
}

export interface DiscoverOptions {
  /** Project directory: `<cwd>/.pi/agents` overrides everything else. */
  cwd: string;
  /** The wolf's agent dir (`$PI_CODING_AGENT_DIR`, or `<wolf-home>/agent`): `<agentDir>/agents` overrides the packages. */
  agentDir: string;
  /** Package directories, lowest precedence first. Default: the bundled profiles. */
  packageDirs?: readonly string[];
}

/** Directories in precedence order, lowest first. */
function sources(opts: DiscoverOptions): Array<{ path: string; source: AgentSource }> {
  return [
    ...(opts.packageDirs ?? [bundledAgentsDir()]).map((path) => ({ path, source: "package" as AgentSource })),
    { path: join(opts.agentDir, "agents"), source: "global" },
    { path: join(opts.cwd, ".pi", "agents"), source: "project" },
  ];
}

/** Every profile in the roster, same-named ones overridden by the higher-precedence directory. */
export function discoverAgents(opts: DiscoverOptions): ListedAgentDefinition[] {
  const agents = new Map<string, ListedAgentDefinition>();
  for (const { path: dir, source } of sources(opts)) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".md"))) {
      const parsed = parseAgentDefinition(readFileSync(join(dir, file), "utf8"), file.replace(/\.md$/, ""));
      if (!parsed) continue;
      agents.set(parsed.name, { ...parsed, source });
    }
  }
  return [...agents.values()];
}

/** One profile by file name (`<name>.md`): project, then the wolf's agent dir, then the package dirs in the order given. */
export function loadAgent(name: string, opts: DiscoverOptions): AgentDefinition | null {
  const [project, global, ...packages] = sources(opts).reverse();
  for (const { path: dir } of [project, global, ...packages.reverse()]) {
    const p = join(dir, `${name}.md`);
    if (!existsSync(p)) continue;
    const parsed = parseAgentDefinition(readFileSync(p, "utf8"), name);
    if (parsed) return parsed;
  }
  return null;
}
