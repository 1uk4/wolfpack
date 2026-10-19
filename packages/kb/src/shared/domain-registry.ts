/**
 * Read the declared-domain registry (`<kbBase>/domains.yaml`): each domain's
 * label and description, as written by `wolfpack domain`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";

export interface DomainRegistryEntry {
  label?: string;
  description?: string;
}

/** Domain name → label/description. Empty when the registry is missing or unreadable. */
export function readDomainRegistry(kbBase: string): Record<string, DomainRegistryEntry> {
  const file = join(kbBase, "domains.yaml");
  if (!existsSync(file)) return {};
  try {
    const parsed = (yamlParse(readFileSync(file, "utf-8")) ?? {}) as {
      domains?: Record<string, DomainRegistryEntry | null>;
    };
    const out: Record<string, DomainRegistryEntry> = {};
    for (const [name, v] of Object.entries(parsed.domains ?? {})) {
      out[name] = {
        label: v?.label ? String(v.label) : undefined,
        description: v?.description ? String(v.description).trim() : undefined,
      };
    }
    return out;
  } catch {
    return {};
  }
}
