/**
 * Extension loader — loads pi-durable extensions by name from wolf.yaml.
 *
 * Extensions can be:
 * 1. Bundled — compiled into the harness package (fastest, no runtime resolution)
 * 2. Dynamic — loaded from WOLF_DEN/extensions/<name>/index.js at runtime
 *
 * The CLI bundles extensions via esbuild when building the wolf identity.
 * Dynamic loading is the fallback for development or unbundled deploys.
 */
import { join } from "node:path";
import type { Extension } from "@earendil-works/pi-durable";

// ── Bundled extensions ──────────────────────────────────────────────────────
// These are statically imported and included in the harness bundle.
// Add new bundled extensions here as they're converted to pi-durable format.
//
// import { WolfpackMemory } from "./extensions/wolfpack-memory.js";
// import { WolfpackTasks } from "./extensions/wolfpack-tasks.js";
// import { WolfpackTelegram } from "./extensions/wolfpack-telegram.js";

const BUNDLED: Record<string, Extension> = {
  // "wolfpack-memory": WolfpackMemory,
  // "wolfpack-tasks": WolfpackTasks,
  // "wolfpack-telegram": WolfpackTelegram,
};

// Name aliases — wolf.yaml uses short names, extensions have full names
const ALIASES: Record<string, string> = {
  memory: "wolfpack-memory",
  subagents: "wolfpack-subagents",
  telegram: "wolfpack-telegram",
  tasks: "wolfpack-tasks",
  ask: "ask-user-question",
  "visual-tools": "wolfpack-visual-tools",
};

function resolveName(name: string): string {
  return ALIASES[name] ?? name;
}

/**
 * Load extensions by name from wolf.yaml extensions array.
 *
 * Resolution order:
 * 1. Bundled extensions (BUNDLED map)
 * 2. Dynamic import from WOLF_DEN/extensions/<name>/index.js
 *
 * Missing extensions are logged as warnings and skipped.
 */
export async function loadExtensions(
  names: string[] | undefined,
  wolfDen: string
): Promise<Extension[]> {
  if (!names || names.length === 0) {
    return [];
  }

  const extensions: Extension[] = [];

  for (const shortName of names) {
    const name = resolveName(shortName);

    // 1. Check bundled extensions first
    const bundled = BUNDLED[name];
    if (bundled) {
      extensions.push(bundled);
      continue;
    }

    // 2. Try dynamic import from wolf den
    const extPath = join(wolfDen, "extensions", name, "index.js");
    try {
      const mod = await import(extPath);
      const ext = mod.default ?? mod.extension;
      if (ext) {
        extensions.push(ext as Extension);
      } else {
        console.warn(`Extension ${name}: no default export at ${extPath}`);
      }
    } catch (err) {
      // Extension not found or failed to load — warn and continue
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`Extension ${name}: failed to load (${msg})`);
    }
  }

  return extensions;
}

/**
 * List available bundled extensions.
 */
export function listBundledExtensions(): string[] {
  return Object.keys(BUNDLED);
}
