/**
 * KB Sweep Manager — runs the shared sweep tick (runSweepTick, the same one the
 * kb CLI runs) asynchronously in the background. "Running" covers the whole
 * tick, post-sweep reorg included.
 *
 * The tick runs on the main event loop but is fully async/await,
 * so it doesn't block Telegram responses (which are I/O-bound).
 * Status can be queried at any time while sweep is running.
 */
import type { ModelTable } from "@wolfpack/engine";

// ─── Types ─────────────────────────────────────────────────────────────────

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
  /** The wolf's resolved model table (shipped models.json). */
  models: ModelTable;
  /** Required by the api transport; unused on subscription. */
  apiKey?: string;
}

// ─── Sweep Manager ─────────────────────────────────────────────────────────

export class SweepManager {
  private status: SweepStatus = { state: "idle" };
  private config: SweepWorkerConfig;
  private onComplete?: (message: string) => void;
  /** Last unexpected-failure text alerted, so a persistent one alerts once. */
  private lastFailureAlert?: string;

  constructor(config: SweepWorkerConfig, onComplete?: (message: string) => void) {
    this.config = config;
    this.onComplete = onComplete;
  }

  setOnComplete(fn: (message: string) => void): void {
    this.onComplete = fn;
  }

  getStatus(): SweepStatus {
    return { ...this.status };
  }

  /** True for the whole tick: the sweep AND the post-sweep reorg. */
  isRunning(): boolean {
    return this.status.state === "running";
  }

  async start(): Promise<{ started: boolean; reason?: string }> {
    if (this.isRunning()) {
      return { started: false, reason: "Sweep already running" };
    }

    this.status = {
      state: "running",
      startedAt: new Date().toISOString(),
      progress: "Starting...",
    };

    // Run the tick asynchronously (fire-and-forget, but tracked via status)
    this.runTick().catch((err) => {
      this.status = {
        state: "failed",
        startedAt: this.status.startedAt,
        completedAt: new Date().toISOString(),
        error: err instanceof Error ? err.message : String(err),
      };
    });

    return { started: true };
  }

  private async runTick(): Promise<void> {
    const startTime = Date.now();

    try {
      // Dynamic import to keep startup fast
      const { runSweepTick, createLibrarianEngine } = await import("@wolfpack/kb/librarian");

      // Set up embedder environment
      if (this.config.embedUrl) {
        process.env.WOLFPACK_EMBED_URL = this.config.embedUrl;
      }
      if (this.config.embedModel) {
        process.env.WOLFPACK_EMBED_MODEL = this.config.embedModel;
      }

      const roots = {
        kbBase: this.config.kbBase,
        opsRoot: this.config.kbOps,
        denLocal: this.config.denLocal,
      };

      // The timer fires every minute: an idle or backed-off tick is a silent no-op.
      const tick = await runSweepTick({
        roots,
        createEngine: () => createLibrarianEngine(this.config.models, this.config.apiKey),
        notify: (msg: string) => this.updateProgress(msg),
        alert: (msg: string) => this.onComplete?.(msg),
      });
      if (tick.outcome !== "ran") {
        this.status = { state: "idle" };
        return;
      }

      const result = tick.sweep;
      this.status = {
        state: "completed",
        startedAt: this.status.startedAt,
        completedAt: new Date().toISOString(),
        result: {
          processed: result.processed,
          created: result.created,
          merged: result.merged,
          rejected: result.rejected,
          parked: result.parked.length,
          remaining: result.remaining,
          duration: Date.now() - startTime,
        },
      };

      this.lastFailureAlert = undefined;
      console.log(`[librarian] Sweep completed: ${result.processed} processed, ${result.created} created, ${result.merged} merged`);
    } catch (err) {
      console.error("[librarian] Sweep failed:", err instanceof Error ? err.message : err);
      const text = err instanceof Error ? err.message : String(err);
      // Unexpected failure: alert once per distinct message, not every tick.
      // (Outages never get here: the tick turns them into backoff.)
      if (text !== this.lastFailureAlert) {
        this.lastFailureAlert = text;
        this.onComplete?.(`❌ Sweep failed: ${text}`);
      }

      this.status = {
        state: "failed",
        startedAt: this.status.startedAt,
        completedAt: new Date().toISOString(),
        error: text,
      };
    }
  }

  private updateProgress(message: string): void {
    if (this.status.state === "running") {
      this.status.progress = message;
      console.log(`[librarian] ${message}`);
    }
  }
}

// ─── Singleton for harness ─────────────────────────────────────────────────

let sweepManager: SweepManager | null = null;

export function getSweepManager(): SweepManager | null {
  return sweepManager;
}

export function initSweepManager(config: SweepWorkerConfig, onComplete?: (message: string) => void): SweepManager {
  sweepManager = new SweepManager(config, onComplete);
  return sweepManager;
}
