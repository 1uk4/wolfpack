export { loadExtensions, listBundledExtensions } from "./extensions.js";
export interface WolfConfig {
    id?: string;
    name: string;
    model: string;
    provider?: "anthropic" | "openai";
    role?: string;
    specialty?: string;
    domains?: string[];
    extensions?: string[];
    telegram?: {
        tokenEnv?: string;
        ownerId: number;
    };
    memory?: {
        enabled?: boolean;
        fastModel?: string;
        model?: string;
        consolidation?: {
            trigger?: "timer" | "threshold" | "hybrid" | "manual";
            interval?: string;
            threshold?: number;
        };
        /** Librarian mode - enables KB inbox tools and optional sweep */
        librarian?: boolean | {
            enabled: boolean;
            /** Sweep interval (e.g., "15m", "1h") - triggers systemd service */
            sweepInterval?: string;
        };
    };
    harness?: {
        storage?: string;
        compaction?: {
            reserveTokens?: number;
            backgroundTokens?: number;
        };
    };
}
export declare function loadWolfConfig(): Promise<WolfConfig>;
//# sourceMappingURL=config.d.ts.map