/**
 * Retries stuck work saves by time. A group that failed to save waits out a backoff (5 min, doubling to 6 h), but the
 * retry only ran inside a consolidation, which a small pool rarely triggers: entries sat "retry due" for days. This
 * timer sweeps the pending state (drops keys nothing in the pool references, or whose item is archived) and, when a
 * retry is due, runs one consolidation. The failed attempt moves the key's backoff on, so an unreachable hub is asked
 * at the backoff rhythm, never every tick. Nothing here throws: the hub being down is a quiet retry.
 */
import { dueKeys, sweepPending } from "@wolfpack/memory";

export const PENDING_RETRY_TICK_MS = 60_000;

export interface PendingRetryDeps {
  den: string;
  /** Work/feature keys of the tagged observations in the pool. */
  readLive: () => Promise<Set<string>>;
  /** True when the item is archived; throws when the hub cannot be reached (the key stays). */
  isArchived?: (key: string) => Promise<boolean>;
  /** Run one consolidation (due groups are retried inside it). */
  retry: () => Promise<unknown>;
  isBusy?: () => boolean;
  log: (line: string) => void;
  now?: () => number;
  tickMs?: number;
}

export function startPendingRetry(d: PendingRetryDeps): { stop(): void; tick(): Promise<void> } {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running || d.isBusy?.()) return; // a consolidation in flight owns the pending state: leave the whole tick for the next one
    running = true;
    try {
      const now = d.now?.() ?? Date.now();
      const dropped = await sweepPending(d.den, { live: await d.readLive(), ...(d.isArchived ? { isArchived: d.isArchived } : {}), now });
      for (const x of dropped) d.log(`memory: dropped pending save for ${x.key} (${x.reason})`);
      if (dueKeys(d.den, now).length === 0) return;
      await d.retry();
    } catch (e) {
      d.log(`memory: pending save retry failed: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), d.tickMs ?? PENDING_RETRY_TICK_MS);
  timer.unref();
  return { stop: () => clearInterval(timer), tick };
}
