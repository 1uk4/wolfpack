import type { KbRoots } from "@wolfpack/kb/shared";
export interface MemoryExtensionConfig {
    /** Path to wolf den */
    wolfDen: string;
    /** Wolf name for display */
    wolfName: string;
    /** KB base path (optional, enables KB access section) */
    kbBase?: string;
    /** Domains the wolf is subscribed to */
    subscribedDomains?: string[];
    /** Model for observation extraction (default: claude-haiku-4-5) */
    fastModel?: string;
    /** Model for consolidation (default: claude-sonnet-4-6) */
    model?: string;
    /** Provider (default: anthropic) */
    provider?: "anthropic" | "claude-agent-sdk";
    /** Minimum text length to trigger observation (default: 100) */
    minTextLength?: number;
    /** Token threshold for auto-consolidation (default: 15000) */
    consolidationThreshold?: number;
    /** KB roots for emitting deltas to Dewey */
    kbRoots?: KbRoots;
    /** Default domain for KB emissions */
    defaultDomain?: string;
}
/**
 * Create the unified wolfpack memory extension.
 */
export declare function createMemoryExtension(config: MemoryExtensionConfig): import("@earendil-works/pi-durable").Extension<import("@earendil-works/pi-durable").ToolRegistration>;
//# sourceMappingURL=extension.d.ts.map