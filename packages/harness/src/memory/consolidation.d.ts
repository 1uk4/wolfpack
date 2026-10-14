import type { KbRoots } from "@wolfpack/kb/shared";
/** Observation stored in pool JSONL */
export interface PoolObservation {
    timestamp: string;
    content: string;
    recordedAt: string;
}
export interface ConsolidationConfig {
    wolfDen: string;
    wolfName: string;
    /** Model for consolidation (default: claude-sonnet-4-6) */
    model?: string;
    /** Provider (default: anthropic) */
    provider?: "anthropic" | "claude-agent-sdk";
    /** KB roots for emitting deltas to Dewey (optional) */
    kbRoots?: KbRoots;
    /** Default domain hint for KB emissions (default: wolfpack) */
    defaultDomain?: string;
    /** Skip emitting to KB (default: false) */
    skipClaims?: boolean;
    /** Minimum observations to consolidate (default: 5) */
    minObservations?: number;
    /** Minimum tokens to consolidate (default: 1000) */
    minTokens?: number;
    /** Optional progress callback */
    onProgress?: (msg: string) => void;
}
export interface ConsolidationResult {
    observationsProcessed: number;
    topicsCreated: number;
    topicsMerged: number;
    topicsSkipped: number;
    claimsSubmitted: number;
}
/**
 * Read observations from the pool file.
 */
export declare function readPool(wolfDen: string): Promise<PoolObservation[]>;
/**
 * Get pool stats without reading all content.
 */
export declare function getPoolStats(wolfDen: string): Promise<{
    count: number;
    tokens: number;
}>;
/**
 * Consolidate pool observations directly to den topics.
 *
 * Mirrors Pi-CLI's consolidateSession but operates on the pool directly
 * instead of session topics. After writing to den, emits deltas to KB
 * (same as /wolf:promote).
 */
export declare function consolidatePool(config: ConsolidationConfig): Promise<ConsolidationResult>;
//# sourceMappingURL=consolidation.d.ts.map