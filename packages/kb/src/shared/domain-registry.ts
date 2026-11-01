/**
 * Declared-domain registry resolution and reading: each domain's label and
 * description, as written by `wolfpack domain`. The file comes from
 * `WOLFPACK_DOMAINS_FILE`, `<kbBase>/domains.yaml`, or (label readers only) the
 * CLI's own registry; see resolveDomainsFile / resolveGateDomainsFile.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { cliDomainsFile } from "@wolfpack/engine";
import { parse as yamlParse } from "yaml";

export interface DomainRegistryEntry {
  label?: string;
  description?: string;
  /** Optional display colour override for the graph (any CSS colour string). */
  color?: string;
}

/** Thrown by the sweep-gate resolver when `WOLFPACK_DOMAINS_FILE` is set but unusable: the gate must not fail open. */
export class DomainsFileError extends Error {}

/**
 * `WOLFPACK_DOMAINS_FILE` when set. It must be an absolute path: a relative one is warned about and ignored
 * (it would resolve against whatever cwd the process happens to have).
 */
export function domainsFileOverride(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = env.WOLFPACK_DOMAINS_FILE?.trim();
  if (!v) return undefined;
  if (!isAbsolute(v)) {
    console.warn(`wolfpack: ignoring WOLFPACK_DOMAINS_FILE=${v} (must be an absolute path)`);
    return undefined;
  }
  return v;
}

/**
 * Resolver for LABEL / SUBSCRIPTION readers (readDomainRegistry, listSubscribedDomains, dashboard). Order:
 *   1. `WOLFPACK_DOMAINS_FILE` (absolute; if missing: warn and return null, no fall-through)
 *   2. `<kbBase>/domains.yaml` when it exists
 *   3. `<registry dir>/domains.yaml` (the CLI's own registry, same format; see wolfpackRegistryDir) when it exists
 * Returns null when none applies. A hub mirror carries no top-level domains.yaml, hence the fallback.
 * The sweep gate must NOT use this: see resolveGateDomainsFile.
 */
export function resolveDomainsFile(kbBase?: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = domainsFileOverride(env);
  if (explicit) {
    if (existsSync(explicit)) return explicit;
    console.warn(`wolfpack: WOLFPACK_DOMAINS_FILE=${explicit} not found; no domain labels`);
    return null; // an explicit choice never falls through to another registry
  }
  if (kbBase) {
    const inBase = join(kbBase, "domains.yaml");
    if (existsSync(inBase)) return inBase;
  }
  const cli = cliDomainsFile(env);
  return existsSync(cli) ? cli : null;
}

/**
 * Resolver for the SWEEP GATE (readDeclaredDomains): `WOLFPACK_DOMAINS_FILE`, else `<kbBase>/domains.yaml`, else null
 * (unconstrained, as before). Never the ~/.wolfpack fallback. An override that is missing, empty or unparseable throws
 * DomainsFileError: an explicit choice that cannot be honoured must not silently open the gate.
 */
export function resolveGateDomainsFile(kbBase: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = domainsFileOverride(env);
  if (explicit) {
    if (!existsSync(explicit)) throw new DomainsFileError(`WOLFPACK_DOMAINS_FILE=${explicit} does not exist`);
    let names: string[];
    try {
      const parsed = (yamlParse(readFileSync(explicit, "utf-8")) ?? {}) as { domains?: Record<string, unknown> };
      names = Object.keys(parsed.domains ?? {});
    } catch (e) {
      throw new DomainsFileError(`WOLFPACK_DOMAINS_FILE=${explicit} is unreadable: ${(e as Error).message.split("\n")[0]}`);
    }
    if (names.length === 0) throw new DomainsFileError(`WOLFPACK_DOMAINS_FILE=${explicit} declares no domains`);
    return explicit;
  }
  const inBase = join(kbBase, "domains.yaml");
  return existsSync(inBase) ? inBase : null;
}

/** Domain name → label/description. Empty when the registry is missing or unreadable. */
export function readDomainRegistry(kbBase: string, env: NodeJS.ProcessEnv = process.env): Record<string, DomainRegistryEntry> {
  const file = resolveDomainsFile(kbBase, env);
  if (!file) return {};
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
 *   2. the folders present under `<kbBase>/domains/` (the hub link only mirrors
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
