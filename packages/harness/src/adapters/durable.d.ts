/**
 * Pi-Durable Adapter
 *
 * Converts unified Extension interface to @earendil-works/pi-durable format.
 */
import { type Extension as PiDurableExtension } from "@earendil-works/pi-durable";
import type { Extension } from "../extension-api.js";
interface AdapterConfig {
    wolfDen: string;
    wolfName: string;
}
/**
 * Adapt a unified Extension to pi-durable format.
 */
export declare function adaptToDurable(ext: Extension, config: AdapterConfig): PiDurableExtension;
export {};
//# sourceMappingURL=durable.d.ts.map