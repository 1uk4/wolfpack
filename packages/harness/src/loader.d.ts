import type { Extension as PiDurableExtension } from "@earendil-works/pi-durable";
import type { Runtime, TelegramSharedState, SweepManager } from "./extension-api.js";
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
    /** Shared telegram state (if telegram is enabled) */
    telegram?: TelegramSharedState;
    /** Sweep manager (if librarian mode is enabled) */
    sweep?: SweepManager;
}
export interface LoadResult {
    /** Successfully loaded extensions (adapted to runtime) */
    extensions: PiDurableExtension[];
    /** Extensions that failed to load */
    failed: Array<{
        name: string;
        error: string;
    }>;
    /** Extensions that don't support the runtime */
    unsupported: string[];
}
/**
 * Load extensions by name and adapt them to the target runtime.
 *
 * Extensions are loaded from wolfDen/extensions/<name>/index.js
 * Each extension should export a unified Extension object as default.
 */
export declare function loadExtensions(names: string[] | undefined, config: LoaderConfig): Promise<LoadResult>;
//# sourceMappingURL=loader.d.ts.map