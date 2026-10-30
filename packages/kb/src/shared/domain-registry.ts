/**
 * Read the declared-domain registry (`<kbBase>/domains.yaml`): each domain's
 * label and description, as written by `wolfpack domain`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";

export interface DomainRegistryEntry {
  label?: string;
  description?: string;
  /** Optional display colour override for the graph (any CSS colour string). */
  color?: string;
}

/**
 * The ONE resolver for the declared-domain registry file. Order:
 *   1. `WOLFPACK_DOMAINS_FILE` (explicit override; returned even if missing)
 *   2. `<kbBase>/domains.yaml` when it exists
 *   3. `~/.wolfpack/domains.yaml` (the CLI's own registry, same format) when it exists;
 *      `WOLFPACK_REGISTRY_DIR` relocates that directory (tests)
 * Returns null when none applies. A hub mirror carries no top-level domains.yaml, hence the fallback.
 */
export function resolveDomainsFile(kbBase?: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.WOLFPACK_DOMAINS_FILE?.trim();
  if (explicit) return explicit;
  if (kbBase) {
    const inBase = join(kbBase, "domains.yaml");
    if (existsSync(inBase)) return inBase;
  }
  const cli = join(env.WOLFPACK_REGISTRY_DIR || join(homedir(), ".wolfpack"), "domains.yaml");
  return existsSync(cli) ? cli : null;
}

/** Domain name → label/description. Empty when the registry is missing or unreadable. */
export function readDomainRegistry(kbBase: string, env: NodeJS.ProcessEnv = process.env): Record<string, DomainRegistryEntry> {
  const file = resolveDomainsFile(kbBase, env);
  if (!file || !existsSync(file)) return {};
  try {
    const parsed = (yamlParse(readFileSync(file, "utf-8")) ?? {}) as {
      domains?: Record<string, DomainRegistryEntry | null>;
    };
    const out: Record<string, DomainRegistryEntry> = {};
    for (const [name, v] of Object.entries(parsed.domains ?? {})) {
      out[name] = {
        label: v?.label ? String(v.label) : undefined,
        description: v?.description ? String(v.description).trim() : undefined,
        ...(v?.color ? { color: String(v.color).trim() } : {}),
      };
    }
    return out;
  } catch {
    return {};
  }
}

export interface SubscribedDomain {
  name: string;
  label?: string;
  description?: string;
}

/**
 * The domains THIS wolf can see — i.e. the ones it is subscribed to.
 *
 * Source of truth, in order:
 *   1. `WOLF_DOMAINS` (comma-separated; exported from wolf.yaml `domains:`)
 *   2. the folders present under `<kbBase>/domains/` (Syncthing only mirrors
 *      subscribed domains to a wolf)
 * Labels/descriptions are enriched from `<kbBase>/domains.yaml` when present.
 * Returns [] when nothing is configured — callers must stay generic then.
 */
export function listSubscribedDomains(
  kbBaseArg?: string,
  env: NodeJS.ProcessEnv = process.env,
): SubscribedDomain[] {
  const kbBase = kbBaseArg ?? env.KB_BASE;
  const registry = kbBase ? readDomainRegistry(kbBase, env) : {};
  let names = (env.WOLF_DOMAINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length === 0 && kbBase) {
    try {
      names = readdirSync(join(kbBase, "domains"), { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith("_") && !d.name.startsWith("."))
        .map((d) => d.name)
        .sort();
    } catch {
      names = [];
    }
  }
  return names.map((name) => ({ name, ...registry[name] }));
}

/** "a | b | c", or a generic hint when no domains are known. */
export function formatDomainChoices(domains: SubscribedDomain[]): string {
  return domains.length ? domains.map((d) => d.name).join(" | ") : "one of your subscribed domains";
}
