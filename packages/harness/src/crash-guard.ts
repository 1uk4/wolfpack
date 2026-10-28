/**
 * Process-level error handlers for the VPS harness. A crash during startup exits 1 (systemd restarts, the sync
 * watcher sees it). Once startup has completed, an unhandled REJECTION is logged with its stack and the process stays
 * up: a stray rejection from a dependency (e.g. a detached promise chain in the bridge) must not crash-loop a wolf
 * that is serving its conversations. An uncaught EXCEPTION always exits (state may be corrupt).
 */
export interface CrashGuard {
  /** Call once createWolfHarness has resolved. */
  markStarted(): void;
}

export function installCrashGuard(proc: Pick<NodeJS.Process, "on">, opts: { exit?: (code: number) => void; log?: (...a: unknown[]) => void } = {}): CrashGuard {
  const exit = opts.exit ?? ((c) => process.exit(c));
  const log = opts.log ?? ((...a) => console.error(...a));
  let started = false;
  proc.on("uncaughtException", (err) => {
    log("[harness] Uncaught exception:", err);
    exit(1);
  });
  proc.on("unhandledRejection", (reason) => {
    const detail = reason instanceof Error ? reason.stack ?? reason.message : reason;
    if (started) {
      log("[harness] Unhandled rejection (startup complete, staying up):", detail);
      return;
    }
    log("[harness] Unhandled rejection during startup:", detail);
    exit(1);
  });
  return { markStarted: () => { started = true; } };
}
