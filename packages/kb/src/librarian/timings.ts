/**
 * Per-tick step timings for the sweep tick: where the synchronous time goes (the hub's event loop must not block).
 * `add` accumulates milliseconds per step name; `line` renders one log line; the longest event-loop stall during the
 * tick is measured with a perf_hooks histogram started/stopped around it.
 */
import { performance, monitorEventLoopDelay } from "node:perf_hooks";

export interface Timings {
  /** Run `fn`, add its elapsed time to `step`, return its result (also when it throws). */
  time<T>(step: string, fn: () => T): T;
  add(step: string, ms: number): void;
  /** Stop the loop monitor and render `tick timings: ledger 12ms · scan 140ms · … · loopMax 95ms`. */
  line(steps: readonly string[]): string;
}

export function createTimings(): Timings {
  const ms = new Map<string, number>();
  const hist = monitorEventLoopDelay({ resolution: 5 });
  hist.enable();
  const add = (step: string, d: number) => void ms.set(step, (ms.get(step) ?? 0) + d);
  return {
    add,
    time(step, fn) {
      const t0 = performance.now();
      try {
        return fn();
      } finally {
        add(step, performance.now() - t0);
      }
    },
    line(steps) {
      hist.disable();
      const loopMax = Number.isFinite(hist.max) ? hist.max / 1e6 : 0;
      const parts = steps.map((s) => `${s} ${Math.round(ms.get(s) ?? 0)}ms`);
      parts.push(`loopMax ${Math.round(loopMax)}ms`);
      return `tick timings: ${parts.join(" · ")}`;
    },
  };
}

export const TICK_STEPS = ["ledger", "scan", "sections", "oversized", "writeSections", "render", "compact", "commit"] as const;
