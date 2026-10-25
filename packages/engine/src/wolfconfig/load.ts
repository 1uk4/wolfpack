import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { KNOWN_TOP_LEVEL_KEYS, WolfFileSchema, type WolfConfig } from "./schema.js";

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

/** Default socket: ~/.wolfpack/run/<name>.sock */
export function defaultSocketPath(name: string, home: string = os.homedir()): string {
  return path.join(home, ".wolfpack", "run", `${name}.sock`);
}

function expand(p: string, base: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return path.resolve(base, p);
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
  const dir = path.dirname(abs);
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
    den: path.join(dir, "den"),
    dir,
    file: abs,
  };
  return { config, warnings };
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
