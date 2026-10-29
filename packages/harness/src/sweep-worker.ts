/**
 * KB Sweep Manager — runs the shared sweep tick (runSweepTick, the same one the
 * kb CLI runs) asynchronously in the background. "Running" covers the whole
 * tick (the post-sweep reorg is off by default).
 *
 * The tick runs on the main event loop but is fully async/await,
 * so it doesn't block Telegram responses (which are I/O-bound).
 * Status can be queried at any time while sweep is running.
 */
import type { ModelTable } from "@wolfpack/engine";
import type { runSweepTick, SweepEvent } from "@wolfpack/kb/librarian";
import { readLastSweep, writeLastSweep } from "@wolfpack/kb/shared";
import type { MemoryEventDraft } from "./memory/events.js";
import { oneLine } from "./memory/events.js";

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
  /** Work API the sweep posts link-back notes to (the host's effective env, never read ambiently from here). */
  workEndpoint?: string;
  workToken?: string;
  /** Receives the sweep's MemoryEvents (sweep_started / sweep_item / sweep_finished). The host looks the bus up on each call. */
  emit?: (draft: MemoryEventDraft) => void;
  /** Test seam: replaces the shared sweep tick (default: runSweepTick from @wolfpack/kb/librarian). */
  sweepTick?: typeof runSweepTick;
}

/** MemoryEvents about the KB carry this domain and the den target (the envelope needs both; the payload is what matters). */
const KB_DOMAIN = "kb";

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

  /** The live status; an idle manager (a tick that found nothing wipes `status`) still reports the last real run from disk. */
  getStatus(): SweepStatus {
    if (this.status.state !== "idle" || this.status.result || this.status.error) return { ...this.status };
    const last = readLastSweep(this.roots());
    if (!last) return { ...this.status };
    return {
      state: "idle",
      startedAt: last.startedAt,
      completedAt: last.finishedAt,
      ...(last.error
        ? { error: last.error }
        : { result: { processed: last.processed, created: last.created, merged: last.merged, rejected: last.rejected, parked: last.parked, remaining: last.remaining, duration: last.durationMs } }),
    };
  }

  private roots() {
    return { kbBase: this.config.kbBase, opsRoot: this.config.kbOps, denLocal: this.config.denLocal };
  }

  /** True for the whole tick (the sweep, plus the post-sweep reorg when enabled). */
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
    const roots = this.roots();
    const emit = (draft: MemoryEventDraft) => {
      try {
        this.config.emit?.(draft);
      } catch {
        /* a bad subscriber never breaks the sweep */
      }
    };
    // sweep_started goes out lazily, when the sweep reports real work (the one-minute timer would flood the stream
    // otherwise); once out, a sweep_finished always follows, also when the run throws.
    let started: { at: string; ms: number } | undefined;
    let finished = false;
    const finish = (r: { processed: number; created: number; merged: number; rejected: number; parked: number; remaining: number }, error?: string) => {
      if (!started || finished) return;
      finished = true;
      const durationMs = Date.now() - started.ms;
      const msg = error ? oneLine(error) : undefined;
      try {
        writeLastSweep(roots, { startedAt: started.at, finishedAt: new Date().toISOString(), ...r, durationMs, ...(msg ? { error: msg } : {}) });
      } catch (err) {
        console.error("[librarian] could not persist the last sweep:", err instanceof Error ? err.message : err);
      }
      emit({ type: "sweep_finished", domain: KB_DOMAIN, target: { kind: "den" }, ...r, durationMs, ...(msg ? { error: msg } : {}) });
    };
    // Counts from item events, so a tick that throws or times out still reports what it got done.
    const tally = { processed: 0, created: 0, merged: 0, rejected: 0, parked: 0, remaining: 0 };
    let pendingAtStart = 0;
    const onEvent = (e: SweepEvent) => {
      // After sweep_finished (a timed-out tick still running in the background) nothing more goes out.
      if (finished) return;
      if (e.type === "started") {
        if (started) return;
        pendingAtStart = e.pending;
        started = { at: new Date().toISOString(), ms: Date.now() };
        emit({ type: "sweep_started", domain: KB_DOMAIN, target: { kind: "den" }, pending: e.pending });
      } else {
        if (!started) return;
        tally.processed++;
        if (e.outcome === "create") tally.created++;
        else if (e.outcome === "merge") tally.merged++;
        else if (e.outcome === "reject") tally.rejected++;
        else tally.parked++;
        emit({ type: "sweep_item", domain: KB_DOMAIN, target: { kind: "den" }, from: e.from, denTopicId: e.denTopicId, outcome: e.outcome, ...(e.entryId ? { entryId: e.entryId } : {}) });
      }
    };

    try {
      // Dynamic import to keep startup fast
      const { runSweepTick, createLibrarianEngine, httpNotePoster } = await import("@wolfpack/kb/librarian");

      // Set up embedder environment
      if (this.config.embedUrl) {
        process.env.WOLFPACK_EMBED_URL = this.config.embedUrl;
      }
      if (this.config.embedModel) {
        process.env.WOLFPACK_EMBED_MODEL = this.config.embedModel;
      }

      // The timer fires every minute: an idle or backed-off tick is a silent no-op.
      const tick = await (this.config.sweepTick ?? runSweepTick)({
        roots,
        createEngine: () => createLibrarianEngine(this.config.models, this.config.apiKey),
        notify: (msg: string) => this.updateProgress(msg),
        alert: (msg: string) => this.onComplete?.(msg),
        notePoster: httpNotePoster(this.config.workEndpoint, this.config.workToken),
        onEvent,
      });
      const result = tick.sweep;
      finish({ processed: result.processed, created: result.created, merged: result.merged, rejected: result.rejected, parked: result.parked.length, remaining: result.remaining });
      if (tick.outcome !== "ran") {
        this.status = { state: "idle" };
        return;
      }

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
      finish({ ...tally, remaining: Math.max(0, pendingAtStart - tally.processed) }, text);
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
