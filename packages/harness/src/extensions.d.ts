import type { Extension } from "@earendil-works/pi-durable";
/**
 * Load extensions by name from wolf.yaml extensions array.
 *
 * Resolution order:
 * 1. Bundled extensions (BUNDLED map)
 * 2. Dynamic import from WOLF_DEN/extensions/<name>/index.js
 *
 * Missing extensions are logged as warnings and skipped.
 */
export declare function loadExtensions(names: string[] | undefined, wolfDen: string): Promise<Extension[]>;
/**
 * List available bundled extensions.
 */
export declare function listBundledExtensions(): string[];
//# sourceMappingURL=extensions.d.ts.map