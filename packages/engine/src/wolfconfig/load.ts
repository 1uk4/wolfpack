import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { DEFAULT_CONSOLIDATION, KNOWN_TOP_LEVEL_KEYS, WolfFileSchema, type WolfConfig } from "./schema.js";

export class WolfConfigError extends Error {
  constructor(
    message: string,
    readonly file: string,
  ) {
    super(`${file}: ${message}`);
    this.name = "WolfConfigError";
  }
}

export interface LoadedWolfConfig {
  config: WolfConfig;
  warnings: string[];
}

/** Why `defaultDomain` is not a valid choice for a wolf subscribed to `domains`, or null when it is (or is unset). */
export function defaultDomainProblem(defaultDomain: string | undefined, domains: readonly string[]): string | null {
  if (defaultDomain === undefined || domains.includes(defaultDomain)) return null;
  return `memory.defaultDomain "${defaultDomain}" is not one of the subscribed domains (${domains.join(", ") || "none"})`;
}

/** The domain for untagged observations: `defaultDomain` once validated against `domains`, else the first (else "wolfpack"). Throws when invalid. */
export function resolveDefaultDomain(defaultDomain: string | undefined, domains: readonly string[]): string {
  const problem = defaultDomainProblem(defaultDomain, domains);
  if (problem) throw new Error(problem);
  return defaultDomain ?? domains[0] ?? "wolfpack";
}

/** Default socket: ~/.wolfpack/run/<name>.sock */
export function defaultSocketPath(name: string, home: string = os.homedir()): string {
  return path.join(home, ".wolfpack", "run", `${name}.sock`);
}

function expand(p: string, base: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return path.resolve(base, p);
}

/**
 * `sandbox: true` -> <dir>/sandbox; `{root}` -> that path; false/null/absent -> undefined.
 * Anything else throws: a malformed value must never silently run live.
 */
export function normalizeSandbox(raw: unknown, dir: string, home: string = os.homedir()): { root: string } | undefined {
  if (raw === undefined || raw === null || raw === false) return undefined;
  if (raw === true) return { root: path.join(dir, "sandbox") };
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const root = (raw as { root?: unknown }).root;
    if (typeof root === "string" && root.length > 0) return { root: expand(root, dir, home) };
  }
  throw new Error(`invalid sandbox value ${JSON.stringify(raw)}: expected true, false or { root: <path> }`);
}

/** Load and normalize one wolf.yaml. Throws WolfConfigError on unreadable/invalid files. */
export function loadWolfConfig(file: string, opts: { home?: string } = {}): LoadedWolfConfig {
  const home = opts.home ?? os.homedir();
  const abs = path.resolve(file);
  let raw: string;
  try {
    raw = fs.readFileSync(abs, "utf8");
  } catch (e) {
    throw new WolfConfigError(`cannot read: ${(e as Error).message}`, abs);
  }
  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (e) {
    throw new WolfConfigError(`invalid YAML: ${(e as Error).message.split("\n")[0]}`, abs);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new WolfConfigError("expected a mapping at the top level", abs);
  }

  const parsed = WolfFileSchema.safeParse(doc);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new WolfConfigError(`invalid wolf.yaml: ${issues}`, abs);
  }

  const warnings: string[] = [];
  for (const key of Object.keys(doc)) {
    if (!KNOWN_TOP_LEVEL_KEYS.includes(key)) {
      warnings.push(
        key === "runtime"
          ? `${abs}: "runtime" is ignored in wolf.yaml v2 (durable is the engine)`
          : `${abs}: unknown field "${key}" ignored`,
      );
    }
  }

  const v = parsed.data;
  const badDefault = defaultDomainProblem(v.memory.defaultDomain, v.domains);
  if (badDefault) throw new WolfConfigError(`invalid wolf.yaml: ${badDefault}`, abs);
  const dir = path.dirname(abs);
  const sandbox = normalizeSandbox(v.sandbox, dir, home);
  // Memory settings without the extension that acts on them: nothing would ever say why memory does nothing.
  const memoryConfigured = (doc as Record<string, unknown>).memory !== undefined || !!sandbox;
  if (memoryConfigured && !v.extensions.some((n) => n === "memory" || n === "wolfpack-memory")) {
    warnings.push(`${abs}: memory configured but not in extensions: memory is off (add \`memory\` to extensions)`);
  }
  const config: WolfConfig = {
    identity: { id: v.id ?? v.name, name: v.name, domains: v.domains },
    capability: {
      tools: v.tools,
      ...(v.tiers ? { tiers: v.tiers as WolfConfig["capability"]["tiers"] } : {}),
      workspace: v.workspace ? expand(v.workspace, dir, home) : dir,
    },
    serve: {
      socket: v.serve.socket ? expand(v.serve.socket, dir, home) : defaultSocketPath(v.name, home),
      ...(v.serve.port !== undefined ? { port: v.serve.port } : {}),
    },
    ...(sandbox ? { sandbox } : {}),
    memory: {
      live: v.memory.live === true,
      librarian: v.memory.librarian === true,
      ...(v.memory.defaultDomain ? { defaultDomain: v.memory.defaultDomain } : {}),
      ...(v.memory.sweepInterval ? { sweepInterval: v.memory.sweepInterval } : {}),
      consolidation: { ...DEFAULT_CONSOLIDATION, ...definedOnly(v.memory.consolidation) } as WolfConfig["memory"]["consolidation"],
    },
    extensions: v.extensions,
    extensionConfig: Object.fromEntries(
      v.extensions.flatMap((n) => {
        const block = (doc as Record<string, unknown>)[n];
        return block && typeof block === "object" && !Array.isArray(block) ? [[n, block as Record<string, unknown>]] : [];
      }),
    ),
    den: path.join(dir, "den"),
    dir,
    file: abs,
  };
  return { config, warnings };
}

/** Drop undefined keys so an omitted yaml field never overrides a default. */
function definedOnly<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export interface DiscoveredWolves {
  wolves: LoadedWolfConfig[];
  /** Files that exist but failed to load (reported, not fatal). */
  errors: WolfConfigError[];
}

/** Default discovery root: ~/wolves/local */
export function defaultWolvesRoot(home: string = os.homedir()): string {
  return path.join(home, "wolves", "local");
}

/** Find `<rootDir>/*\/wolf.yaml`. Broken files land in `errors`; a missing root yields nothing. */
export function discoverWolves(rootDir: string = defaultWolvesRoot()): DiscoveredWolves {
  const out: DiscoveredWolves = { wolves: [], errors: [] };
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const file = path.join(rootDir, entry.name, "wolf.yaml");
    if (!fs.existsSync(file)) continue;
    try {
      out.wolves.push(loadWolfConfig(file));
    } catch (e) {
      out.errors.push(e instanceof WolfConfigError ? e : new WolfConfigError(String(e), file));
    }
  }
  return out;
}
