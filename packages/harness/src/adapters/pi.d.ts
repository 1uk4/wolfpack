/**
 * Pi Adapter
 *
 * Converts unified Extension interface to @earendil-works/pi-coding-agent format.
 *
 * Note: Pi extensions are loaded by the pi CLI via .pi/settings.json.
 * This adapter is used by the CLI bundler to generate pi-compatible code.
 */
import type { Extension } from "../extension-api.js";
/**
 * Generate pi-coding-agent compatible extension code.
 *
 * This returns a string of code that can be written to a file and loaded by pi.
 * The generated code uses @earendil-works/pi-coding-agent APIs.
 */
export declare function generatePiExtensionCode(ext: Extension): string;
/**
 * Placeholder for direct adaptation (if we ever run pi extensions in-process).
 */
export declare function adaptToPi(ext: Extension, config: {
    wolfDen: string;
    wolfName: string;
}): unknown;
//# sourceMappingURL=pi.d.ts.map