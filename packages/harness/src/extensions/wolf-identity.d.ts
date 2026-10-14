import type { WolfConfig } from "../config.js";
export interface WolfIdentityOptions {
    config: WolfConfig;
    wolfDen: string;
    agentDir?: string;
}
/**
 * Create the wolf identity extension with the given config.
 */
export declare function createWolfIdentityExtension(options: WolfIdentityOptions): import("@earendil-works/pi-durable").Extension<import("@earendil-works/pi-durable").ToolRegistration>;
//# sourceMappingURL=wolf-identity.d.ts.map