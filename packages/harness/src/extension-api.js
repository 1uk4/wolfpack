/**
 * Unified Extension API for Wolfpack.
 *
 * Extensions implement this interface once, and the harness adapts it
 * to the appropriate runtime (pi or pi-durable).
 *
 * This provides:
 * - Single source of truth per extension
 * - Runtime-agnostic extension development
 * - Consistent tooling and bundling
 */
import { Type } from "@earendil-works/pi-ai";
// Re-export Type for extension authors
export { Type };
// ─── Builder Functions ─────────────────────────────────────────────────────
/**
 * Define an extension using the unified interface.
 */
export function defineExtension(ext) {
    return ext;
}
/**
 * Define a tool with type-safe parameters.
 */
export function defineTool(tool) {
    return tool;
}
/**
 * Define a system prompt section.
 */
export function section(name, render) {
    return { name, render };
}
/**
 * Check if an extension supports a given runtime.
 */
export function supportsRuntime(ext, runtime) {
    if (!ext.runtimes || ext.runtimes.length === 0) {
        // No runtimes specified = supports all
        return true;
    }
    return ext.runtimes.includes(runtime);
}
//# sourceMappingURL=extension-api.js.map