/**
 * Feeds the usage ledger (~/.wolfpack/usage) from the running wolf. Since wolfd replaced the pi launcher
 * nothing else did, so the ledger stopped growing (work-wolfpack-2lGbN3k). `trigger()` is called after every
 * finished turn; it debounces (trailing) and runs one fire-and-forget ingest of this wolf's den.
 * The ingest honours the ledger's .ingest.lock, so a concurrent `wolfpack usage` is safe.
 */
import { defaultLedgerDir, ingestUsage } from "@wolfpack/engine";

export interface UsageIngestCall {
  den: string;
  wolf: string;
  ledgerDir: string;
}

export interface UsageIngesterOptions {
  den: string;
  wolf: string;
  host?: string;
  /** Default 5000. */
  debounceMs?: number;
  ledgerDir?: string;
  /** Default: the engine's ingestUsage scoped to this den. */
  ingest?: (call: UsageIngestCall) => Promise<unknown>;
  log: (line: string) => void;
}

export interface UsageIngester {
  trigger(): void;
  stop(): void;
}

export function createUsageIngester(o: UsageIngesterOptions): UsageIngester {
  const ledgerDir = o.ledgerDir ?? defaultLedgerDir();
  const run =
    o.ingest ??
    ((c: UsageIngestCall) =>
      ingestUsage({ ledgerDir: c.ledgerDir, wolvesRoot: "", hosts: [], dens: [{ den: c.den, wolf: c.wolf, host: o.host ?? "local" }] }));
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let again = false;
  let stopped = false;
  let lastError: string | undefined;

  const fire = async (): Promise<void> => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      await run({ den: o.den, wolf: o.wolf, ledgerDir });
      lastError = undefined;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg !== lastError) o.log(`usage ingest failed: ${msg}`); // once per distinct error, never into the turn
      lastError = msg;
    } finally {
      running = false;
      if (again && !stopped) {
        again = false;
        void fire();
      }
    }
  };

  return {
    trigger() {
      if (stopped) return;
      clearTimeout(timer);
      timer = setTimeout(() => void fire(), o.debounceMs ?? 5000);
      timer.unref?.();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
