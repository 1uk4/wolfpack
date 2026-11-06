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

// Resolved once and cached for the life of the process (wolfd calls discoverAgents on every spawn and for the roster),
// so an edit to a standard takes effect on restart/redeploy.
let standardsDir: string | undefined;
const standardCache = new Map<string, string>();
// Files already reported as unreadable: the roster is rebuilt often, so each is logged once per process.
const reportedUnreadable = new Set<string>();

/**
 * The standards shipped with wolfpack. From source and dist this is `packages/agents/standards`; in the den extension bundle
 * (discover.ts inlined into `wolfpack-subagents/index.js`) it is the `standards` folder copied next to the bundle (`wolfpack.assets`).
 */
function bundledStandardsDir(): string {
  if (standardsDir === undefined) {
    const here = dirname(fileURLToPath(import.meta.url));
    const beside = join(here, "standards");
    standardsDir = existsSync(beside) ? beside : join(here, "..", "standards");
  }
  return standardsDir;
}

const STANDARD_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

// Profiles that always get these standards, whichever directory they come from, so an override cannot drop them by omitting the frontmatter line.
const ALWAYS_STANDARDS = new Map<string, string[]>([
  ["worker", ["testing", "git"]],
  ["planner", ["testing"]],
  ["reviewer", ["testing", "git"]],
]);

/**
 * The standards a profile gets: the ones its frontmatter names plus the always-on ones for its name (matched case-insensitively
 * against both the frontmatter name and the name it was requested by), each once. Throws on an invalid standard name.
 */
export function standardsFor(agentName: string, declared: readonly string[] = [], requestedName?: string): string[] {
  const always = [agentName, requestedName].flatMap((n) => (n === undefined ? [] : (ALWAYS_STANDARDS.get(n.toLowerCase()) ?? [])));
  const names = [...new Set([...declared, ...always])];
  for (const name of names) {
    if (!STANDARD_NAME.test(name)) throw new Error(`Invalid standard name "${name}" (letters, digits, "-" and "_" only)`);
  }
  return names;
}

/** One shipped standard's text, read once; undefined (with a loud error naming the agent, standard and path) when it cannot be read. */
function readStandard(agent: string, name: string, dir: string): string | undefined {
  const file = join(dir, `${name}.md`);
  let text = standardCache.get(file);
  if (text === undefined) {
    try {
      text = readFileSync(file, "utf8").trim();
    } catch (err) {
      if (!reportedUnreadable.has(file)) {
        reportedUnreadable.add(file);
        console.error(`Agent "${agent}" loads WITHOUT standard "${name}": cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return undefined;
    }
    standardCache.set(file, text);
  }
  return text;
}

/**
 * Append the profile's standards to its body, so they reach the prompt whichever directory the profile came from.
 * An invalid standard name throws; a standard that cannot be read is logged and left out (the agent still loads).
 */
function withStandards<T extends AgentDefinition>(def: T, opts: DiscoverOptions, requestedName?: string): T {
  const names = standardsFor(def.name, def.standards, requestedName);
  if (!names.length) return def;
  const dir = opts.standardsDir ?? bundledStandardsDir();
  const texts = names.map((n) => readStandard(def.name, n, dir)).filter((t): t is string => t !== undefined);
  return { ...def, body: [def.body, ...texts].filter(Boolean).join("\n\n---\n\n") };
}

export interface DiscoverOptions {
  /** Project directory: `<cwd>/.pi/agents` overrides everything else. */
  cwd: string;
  /** The wolf's agent dir (`$PI_CODING_AGENT_DIR`, or `<wolf-home>/agent`): `<agentDir>/agents` overrides the packages. */
  agentDir: string;
  /** Package directories, lowest precedence first. Default: the bundled profiles. */
  packageDirs?: readonly string[];
  /** @internal Tests only. Where the shipped standards live; default: the bundled `standards` folder. Tests point it at a fixture. */
  standardsDir?: string;
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
    for (const file of readdirSync(dir).sort().filter((entry) => entry.endsWith(".md"))) {
      const parsed = parseAgentDefinition(readFileSync(join(dir, file), "utf8"), file.replace(/\.md$/, ""));
      if (!parsed) continue;
      try {
        agents.set(parsed.name, withStandards({ ...parsed, source }, opts));
      } catch (err) {
        // A shipped profile with an invalid standard name is a packaging bug: keep throwing. A user's profile must not take the whole roster down.
        if (source === "package") throw err;
        console.warn(`Skipping agent profile ${join(dir, file)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  // Sorted by name: readdir order is filesystem-dependent and the roster is part of the system prompt (a changed order would look like a persona change).
  return [...agents.values()].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
}

/**
 * One profile by file name (`<name>.md`): project, then the wolf's agent dir, then the package dirs in the order given.
 * Like the roster, a user profile with an invalid standard name is skipped with a warning and the next directory is tried.
 */
export function loadAgent(name: string, opts: DiscoverOptions): AgentDefinition | null {
  const [project, global, ...packages] = sources(opts).reverse();
  for (const { path: dir, source } of [project, global, ...packages.reverse()]) {
    const p = join(dir, `${name}.md`);
    if (!existsSync(p)) continue;
    const parsed = parseAgentDefinition(readFileSync(p, "utf8"), name);
    if (!parsed) continue;
    try {
      return withStandards(parsed, opts, name);
    } catch (err) {
      if (source === "package") throw err;
      console.warn(`Skipping agent profile ${p}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return null;
}
