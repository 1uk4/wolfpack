/**
 * Unified Extension Loader
 *
 * Loads extensions from the wolf's extensions directory and adapts them
 * to the current runtime.
 */
import { join } from "node:path";
import { existsSync } from "node:fs";
import { supportsRuntime } from "./extension-api.js";
import { adaptToDurable } from "./adapters/durable.js";
// Name aliases — wolf.yaml uses short names
const ALIASES = {
    memory: "wolfpack-memory",
    subagents: "wolfpack-subagents",
    telegram: "wolfpack-telegram",
    tasks: "wolfpack-tasks",
    ask: "ask-user-question",
    "visual-tools": "wolfpack-visual-tools",
};
function resolveName(name) {
    return ALIASES[name] ?? name;
}
/**
 * Load extensions by name and adapt them to the target runtime.
 *
 * Extensions are loaded from wolfDen/extensions/<name>/index.js
 * Each extension should export a unified Extension object as default.
 */
export async function loadExtensions(names, config) {
    const result = {
        extensions: [],
        failed: [],
        unsupported: [],
    };
    if (!names || names.length === 0) {
        return result;
    }
    const { wolfDen, wolfName, domains, runtime, wolfConfig } = config;
    // Build context for extension factories
    const context = {
        wolfDen,
        wolfName,
        domains,
        wolfConfig,
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
            let ext;
            if (typeof exported === "function") {
                // Factory pattern: call with config and context
                const extConfig = wolfConfig[shortName] ?? wolfConfig[name] ?? {};
                ext = exported(extConfig, context);
            }
            else {
                // Static extension object
                ext = exported;
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
            }
            else {
                // Pi runtime extensions are loaded by pi CLI, not the harness
                result.failed.push({
                    name,
                    error: "Pi runtime extensions should be loaded by pi CLI"
                });
            }
        }
        catch (err) {
            result.failed.push({
                name,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    return result;
}
//# sourceMappingURL=loader.js.map