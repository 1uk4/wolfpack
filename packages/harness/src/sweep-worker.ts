/**
 * KB Sweep Manager — runs sweep asynchronously in the background.
 * 
 * The sweep runs on the main event loop but is fully async/await,
 * so it doesn't block Telegram responses (which are I/O-bound).
 * Status can be queried at any time while sweep is running.
 */
import { join } from "node:path";
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
  private abortController: AbortController | null = null;
  private onComplete?: (message: string) => void;

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

  isRunning(): boolean {
    return this.status.state === "running";
  }

  async start(opts?: { dryRun?: boolean }): Promise<{ started: boolean; reason?: string }> {
    if (this.isRunning()) {
      return { started: false, reason: "Sweep already running" };
    }

    const dryRun = opts?.dryRun ?? false;
    
    this.status = {
      state: "running",
      startedAt: new Date().toISOString(),
      progress: dryRun ? "Starting (dry run)..." : "Starting...",
    };

    this.abortController = new AbortController();

    // Run sweep asynchronously (fire-and-forget, but tracked via status)
    this.runSweep(dryRun).catch((err) => {
      this.status = {
        state: "failed",
        startedAt: this.status.startedAt,
        completedAt: new Date().toISOString(),
        error: err instanceof Error ? err.message : String(err),
      };
    });

    return { started: true };
  }

  async stop(): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
      this.status = {
        state: "idle",
        progress: "Stopped by user",
      };
    }
  }

  private async runSweep(dryRun: boolean = false): Promise<void> {
    const startTime = Date.now();

    try {
      if (dryRun) {
        // Dry run: test the machinery without processing
        this.updateProgress("[DRY RUN] Loading KB engine...");
        await new Promise(r => setTimeout(r, 500));
        
        this.updateProgress("[DRY RUN] Checking inbox...");
        const { drainInbox } = await import("@wolfpack/kb/librarian");
        const roots = {
          kbBase: this.config.kbBase,
          opsRoot: this.config.kbOps,
          denLocal: this.config.denLocal,
        };
        const inbox = drainInbox(roots);
        await new Promise(r => setTimeout(r, 500));
        
        this.updateProgress(`[DRY RUN] Found ${inbox.length} items in inbox`);
        await new Promise(r => setTimeout(r, 500));
        
        this.updateProgress("[DRY RUN] Simulating sweep...");
        await new Promise(r => setTimeout(r, 1000));
        
        const duration = Date.now() - startTime;
        
        this.status = {
          state: "completed",
          startedAt: this.status.startedAt,
          completedAt: new Date().toISOString(),
          progress: "Dry run completed (no changes made)",
          result: {
            processed: 0,
            created: 0,
            merged: 0,
            rejected: 0,
            parked: 0,
            remaining: inbox.length,
            duration,
          },
        };
        
        console.log(`[librarian] Dry run completed: ${inbox.length} items in inbox (no changes made)`);
        this.onComplete?.(`📚 Dry run complete: ${inbox.length} items in inbox (no changes made)`);
        return;
      }
      
      this.updateProgress("Loading KB engine...");

      // Dynamic imports to keep startup fast
      const { createEngine, engineSteps } = await import("@wolfpack/engine");
      const { sweep } = await import("@wolfpack/kb/librarian");

      const roots = {
        kbBase: this.config.kbBase,
        opsRoot: this.config.kbOps,
        denLocal: this.config.denLocal,
      };

      // Set up embedder environment
      if (this.config.embedUrl) {
        process.env.WOLFPACK_EMBED_URL = this.config.embedUrl;
      }
      if (this.config.embedModel) {
        process.env.WOLFPACK_EMBED_MODEL = this.config.embedModel;
      }

      this.updateProgress("Creating engine...");
      // produce: large merge outputs can run 10–20k chars. The adapter's 4096
      // default truncates them mid-JSON, which then can't be parsed and parks
      // the item. Keep this in sync with packages/kb/src/cli.ts makeEngine().
      const table = this.config.models;
      const steps = engineSteps(table);
      const engine = createEngine({
        provider: table.tiers.smart.provider,
        apiKey: this.config.apiKey,
        defaultModel: table.tiers.smart.model,
        steps: { ...steps, produce: { ...steps.produce, maxTokens: 16000 } },
      });

      this.updateProgress("Loading entry vectors...");
      const { readLedger, foldRegistry, createEmbedder, buildEntryVectors } = await import("@wolfpack/kb/librarian");
      const embedder = createEmbedder(roots);
      const registry = foldRegistry(readLedger(roots));
      const loadEntryVectors = () => buildEntryVectors(roots, registry, embedder);

      this.updateProgress("Running sweep...");
      const result = await sweep({
        engine,
        roots,
        loadEntryVectors,
        notify: (msg: string) => this.updateProgress(msg),
      });

      const duration = Date.now() - startTime;

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
          duration,
        },
      };

      console.log(`[librarian] Sweep completed: ${result.processed} processed, ${result.created} created, ${result.merged} merged`);
      if (result.processed > 0) {
        this.onComplete?.(`📚 Sweep complete: ${result.processed} processed, ${result.created} created, ${result.merged} merged${result.remaining > 0 ? `, ${result.remaining} remaining` : ""}`);
      }

      // Post-sweep reorg: check if any touched sections need splitting
      if (result.processed > 0) {
        try {
          this.updateProgress("Running post-sweep reorg check...");
          const { reorg } = await import("@wolfpack/kb/librarian");
          const reorgResult = await reorg({
            engine,
            roots,
            notify: (msg: string) => this.updateProgress(msg),
          });
          if (reorgResult.splits > 0 || reorgResult.merges > 0 || reorgResult.crystallized > 0) {
            console.log(`[librarian] Reorg: ${reorgResult.splits} splits, ${reorgResult.merges} merges, ${reorgResult.crystallized} crystallized`);
            this.onComplete?.(`📐 Post-sweep reorg: ${reorgResult.splits} splits, ${reorgResult.merges} merges, ${reorgResult.crystallized} crystallized`);
          }
        } catch (reorgErr) {
          console.error("[librarian] Post-sweep reorg failed:", reorgErr instanceof Error ? reorgErr.message : reorgErr);
        }
      }

    } catch (err) {
      console.error("[librarian] Sweep failed:", err instanceof Error ? err.message : err);
      this.onComplete?.(`❌ Sweep failed: ${err instanceof Error ? err.message : String(err)}`);
      
      this.status = {
        state: "failed",
        startedAt: this.status.startedAt,
        completedAt: new Date().toISOString(),
        error: err instanceof Error ? err.message : String(err),
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
