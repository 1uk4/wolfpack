export interface SweepStatus {
    state: "idle" | "running" | "completed" | "failed";
    startedAt?: string;
    completedAt?: string;
    progress?: string;
    result?: SweepResultSummary;
    error?: string;
}
export interface SweepResultSummary {
    processed: number;
    created: number;
    merged: number;
    rejected: number;
    parked: number;
    remaining: number;
    duration: number;
}
export interface SweepWorkerConfig {
    kbBase: string;
    kbOps: string;
    denLocal: string;
    embedUrl?: string;
    embedModel?: string;
    provider?: "anthropic" | "claude-agent-sdk";
    model?: string;
    fastModel?: string;
}
export declare class SweepManager {
    private status;
    private config;
    private abortController;
    constructor(config: SweepWorkerConfig);
    getStatus(): SweepStatus;
    isRunning(): boolean;
    start(opts?: {
        dryRun?: boolean;
    }): Promise<{
        started: boolean;
        reason?: string;
    }>;
    stop(): Promise<void>;
    private runSweep;
    private updateProgress;
}
export declare function getSweepManager(): SweepManager | null;
export declare function initSweepManager(config: SweepWorkerConfig): SweepManager;
//# sourceMappingURL=sweep-worker.d.ts.map