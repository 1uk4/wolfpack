/**
 * Unified Extension Loader
 * 
 * Loads extensions from the wolf's extensions directory and adapts them
 * to the current runtime.
 */
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Extension as PiDurableExtension } from "@earendil-works/pi-durable";
import type { Extension, ExtensionLifecycle, Runtime, ExtensionContext, ExtensionFactory, TelegramSharedState, SweepManager } from "./extension-api.js";
import { supportsRuntime } from "./extension-api.js";
import { adaptToDurable } from "./adapters/durable.js";

// Name aliases — wolf.yaml uses short names
const ALIASES: Record<string, string> = {
  memory: "wolfpack-memory",
  subagents: "wolfpack-subagents",
  telegram: "wolfpack-telegram",
  tasks: "wolfpack-tasks",
  ask: "ask-user-question",
  "visual-tools": "wolfpack-visual-tools",
};

export function resolveName(name: string): string {
  return ALIASES[name] ?? name;
}

export interface LoaderConfig {
  /** Wolf den path (extensions loaded from wolfDen/extensions/) */
  wolfDen: string;
  /** Wolf name for context */
  wolfName: string;
  /** Subscribed domains */
  domains: string[];
  /** Target runtime */
  runtime: Runtime;
  /** Full wolf config (for extension-specific config lookup) */
  wolfConfig: Record<string, unknown>;
  /** Effective env handed to extension factories (sandbox redirect applied). Default: process.env. */
  env?: NodeJS.ProcessEnv;
  /** Shared telegram state (if telegram is enabled) */
  telegram?: TelegramSharedState;
  /** Sweep manager (if librarian mode is enabled) */
  sweep?: SweepManager;
}

/**
 * Drop configured names an explicitly supplied extension already stands for: `provided` (e.g. wolfd's test-seam
 * `extraExtensions`) REPLACES the configured extension of the same name, so nothing is installed or started twice.
 * Matching is by resolved extension name (`memory` and `wolfpack-memory` are the same extension).
 */
export function withoutProvided(names: readonly string[] | undefined, provided: readonly { name: string }[]): string[] {
  const taken = new Set(provided.map((e) => e.name));
  return (names ?? []).filter((n) => !taken.has(resolveName(n)));
}

/** One log line per outcome, shared by every host so they all say the same thing. */
export function reportLoad(result: LoadResult, log: { info(line: string): void; warn(line: string): void }): void {
  for (const ext of result.extensions) log.info(`Extension ${ext.name} loaded`);
  if (result.extensions.length > 0) log.info(`Loaded ${result.extensions.length} extension(s)`);
  for (const f of result.failed) log.warn(`Extension ${f.name}: ${f.error}`);
  if (result.unsupported.length > 0) log.info(`Skipped (no pi-durable support): ${result.unsupported.join(", ")}`);
}

export interface LoadResult {
  /** Successfully loaded extensions (adapted to runtime) */
  extensions: PiDurableExtension[];
  /** Extensions that failed to load */
  failed: Array<{ name: string; error: string }>;
  /** Extensions that don't support the runtime */
  unsupported: string[];
  /** Lifecycle hooks of loaded extensions, in load order */
  lifecycles: LoadedLifecycle[];
}

export interface LoadedLifecycle {
  name: string;
  /** The extension's own wolf.yaml block */
  config: Record<string, unknown>;
  lifecycle: ExtensionLifecycle;
}

/**
 * Load extensions by name and adapt them to the target runtime.
 * 
 * Extensions are loaded from wolfDen/extensions/<name>/index.js
 * Each extension should export a unified Extension object as default.
 */
export async function loadExtensions(
  names: string[] | undefined,
  config: LoaderConfig
): Promise<LoadResult> {
  const result: LoadResult = {
    extensions: [],
    failed: [],
    unsupported: [],
    lifecycles: [],
  };

  if (!names || names.length === 0) {
    return result;
  }

  const { wolfDen, wolfName, domains, runtime, wolfConfig } = config;

  // Build context for extension factories
  const context: ExtensionContext = {
    wolfDen,
    wolfName,
    domains,
    wolfConfig,
    ...(config.env ? { env: config.env } : {}),
    telegram: config.telegram,
    sweep: config.sweep,
  };

  for (const shortName of names) {
    const name = resolveName(shortName);
    const extPath = join(wolfDen, "extensions", name, "index.js");

    if (!existsSync(extPath)) {
      result.failed.push({ name, error: `Not found: ${extPath}` });
      continue;
    }

    try {
      const mod = await import(extPath);
      // Handle CJS default nesting: import() of CJS wraps the module,
      // so if mod.default has its own .default, unwrap it
      let exported = mod.default;
      if (exported && typeof exported === "object" && "default" in exported) {
        exported = exported.default; // CJS default export
      }
      exported = exported ?? mod.extension ?? mod.createExtension;

      if (!exported) {
        result.failed.push({ name, error: "No default export or createExtension" });
        continue;
      }

      // Determine if it's a factory or a static extension
      let ext: Extension;
      if (typeof exported === "function") {
        // Factory pattern: call with config and context
        const extConfig = wolfConfig[shortName] ?? wolfConfig[name] ?? {};
        ext = (exported as ExtensionFactory)(extConfig, context);
      } else {
        // Static extension object
        ext = exported as Extension;
      }

      // Check runtime support
      if (!supportsRuntime(ext, runtime)) {
        result.unsupported.push(name);
        continue;
      }

      // Adapt to runtime
      if (runtime === "pi-durable") {
        const adapted = adaptToDurable(ext, { wolfDen, wolfName });
        result.extensions.push(adapted);
        // Read from the original: the adapter's copy doesn't carry lifecycle
        if (ext.lifecycle) {
          const block = wolfConfig[shortName] ?? wolfConfig[name];
          result.lifecycles.push({
            name,
            config: block && typeof block === "object" ? (block as Record<string, unknown>) : {},
            lifecycle: ext.lifecycle,
          });
        }
      } else {
        // Pi runtime extensions are loaded by pi CLI, not the harness
        result.failed.push({ 
          name, 
          error: "Pi runtime extensions should be loaded by pi CLI" 
        });
      }
    } catch (err) {
      result.failed.push({
        name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}
