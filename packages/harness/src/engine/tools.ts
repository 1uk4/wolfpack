/** Tool registry: wolf.yaml `tools:` names -> engine extensions + the tool names they provide. */
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { Extension } from "@earendil-works/pi-durable";

interface RegistryEntry {
  extension: Extension<never>;
  /** Tool names the extension registers (what `configure({tools})` selects). */
  tools: readonly string[];
}

const REGISTRY: Record<string, RegistryEntry> = {
  coding: { extension: CodingTools as unknown as Extension<never>, tools: ["read", "write", "edit", "bash"] },
};

export const TOOL_REGISTRY_NAMES: readonly string[] = Object.keys(REGISTRY);

export interface ResolvedTools {
  /** Pass as `openWolfEngine({ extensions })`. */
  extensions: Extension[];
  /** Pass as `configure({ tools })`. */
  tools: string[];
}

/** Resolve registry names; throws on an unknown name. Grows by demand (ADR 003 buckets apply). */
export function resolveToolNames(names: readonly string[]): ResolvedTools {
  const extensions: Extension[] = [];
  const tools: string[] = [];
  for (const n of names) {
    const entry = REGISTRY[n];
    if (!entry) throw new Error(`unknown tool registry name "${n}" (known: ${TOOL_REGISTRY_NAMES.join(", ")})`);
    extensions.push(entry.extension as unknown as Extension);
    tools.push(...entry.tools);
  }
  return { extensions, tools };
}
