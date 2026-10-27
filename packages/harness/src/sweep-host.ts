/**
 * The librarian's sweep, shared by both hosts (createWolfHarness on the VPS, wolfd under workerd): one place builds the
 * SweepManager from the wolf's KB roots and model table, and one place runs its timer. Extracted from
 * createWolfHarness with no behaviour change: same options, same log lines, same skip-if-running timer.
 */
import type { ModelTable } from "@wolfpack/engine";
import type { KbRoots } from "@wolfpack/kb/shared";
import { memoryEventsFor } from "./memory/events.js";
import { initSweepManager, type SweepManager, type SweepWorkerConfig } from "./sweep-worker.js";

/** Parse interval string (e.g., "4h", "30m", "1d") to milliseconds */
export function parseInterval(interval: string): number {
  const match = interval.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return 4 * 60 * 60 * 1000; // default 4h
  const value = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case "s": return value * 1000;
    case "m": return value * 60 * 1000;
    case "h": return value * 60 * 60 * 1000;
    case "d": return value * 24 * 60 * 60 * 1000;
    default: return 4 * 60 * 60 * 1000;
  }
}

export interface LibrarianSweepOptions {
  roots: KbRoots;
  /** The wolf's resolved model table. */
  table: ModelTable;
  /** Where WOLFPACK_EMBED_URL / WOLFPACK_EMBED_MODEL / ANTHROPIC_API_KEY come from (the host's effective env). */
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  /** The wolf and its den: the sweep's MemoryEvents go on this den's bus (looked up on each emit, so a bus disposed and recreated is still reached). Unset: no events. */
  events?: { den: string; wolf: string };
  /** Test seam: replaces the shared sweep tick. */
  sweepTick?: SweepWorkerConfig["sweepTick"];
}

/** The sweep manager of a librarian wolf (also registered as the process singleton, as before). */
export function startLibrarianSweep(opts: LibrarianSweepOptions): SweepManager {
  const manager = initSweepManager({
    kbBase: opts.roots.kbBase,
    kbOps: opts.roots.opsRoot,
    denLocal: opts.roots.denLocal,
    embedUrl: opts.env.WOLFPACK_EMBED_URL,
    embedModel: opts.env.WOLFPACK_EMBED_MODEL,
    models: opts.table,
    apiKey: opts.env.ANTHROPIC_API_KEY,
    workEndpoint: opts.env.WORK_ENDPOINT,
    workToken: opts.env.WORK_TOKEN,
    ...(opts.events ? { emit: (draft) => memoryEventsFor(opts.events!.den, opts.events!.wolf).emit(draft) } : {}),
    ...(opts.sweepTick ? { sweepTick: opts.sweepTick } : {}),
  });
  opts.log("[librarian] Sweep manager initialized");
  return manager;
}

/** Run a sweep every `interval`, skipping the tick while one is still running. Clear the returned timer to stop. */
export function startSweepTimer(manager: SweepManager, interval: string, log: (line: string) => void): ReturnType<typeof setInterval> {
  log(`[librarian] Sweep timer: every ${interval}`);
  return setInterval(async () => {
    if (manager.isRunning()) {
      log(`[librarian] Sweep already running, skipping timer trigger`);
      return;
    }

    const result = await manager.start();
    if (!result.started) {
      log(`[librarian] Sweep not started: ${result.reason}`);
    }
  }, parseInterval(interval));
}
