// Measures max event-loop lag while readLedgerAsync reads a synthetic ~4,200-event / ~4 MB ledger.
// Not part of the test suite. Run after `pnpm --filter @wolfpack/kb build`:
//   node --experimental-strip-types packages/kb/scripts/ledger-lag.mts   (or: pnpm dlx tsx packages/kb/scripts/ledger-lag.mts)
// Prints max lag (ms) for the cold read and for an incremental read after one more append.
// For a "before" number, run the same script on a checkout of the pre-chunking code.
import { mkdtempSync, rmSync, mkdirSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { readLedgerAsync, appendLedger } from "../dist/librarian/ledger.js";
import { ev, ledgerFile } from "../dist/shared/index.js";

const base = mkdtempSync(join(tmpdir(), "ledger-lag-"));
const roots = { kbBase: join(base, "base"), opsRoot: join(base, "ops"), denLocal: join(base, "den") };
try {
  const N = 4200;
  mkdirSync(dirname(ledgerFile(roots)), { recursive: true });
  const pad = "x".repeat(900); // ~1 KB per line => ~4 MB
  for (let i = 0; i < N; i += 200) {
    const lines = [];
    for (let j = i; j < i + 200 && j < N; j++) {
      lines.push(JSON.stringify({ ...ev.entryWritten(`kb-wp-E${j}`, `kb-wp-T${j % 50}`, "create"), pad }));
    }
    appendFileSync(ledgerFile(roots), lines.join("\n") + "\n");
  }

  const measure = async (label: string, fn: () => Promise<unknown>) => {
    const h = monitorEventLoopDelay({ resolution: 1 });
    h.enable();
    await new Promise((r) => setTimeout(r, 20));
    h.reset();
    const t0 = performance.now();
    const out = (await fn()) as unknown[];
    const total = performance.now() - t0;
    h.disable();
    console.log(`${label}: events=${out.length} max lag ${(h.max / 1e6).toFixed(1)} ms, total ${total.toFixed(0)} ms`);
  };

  await measure("cold read", () => readLedgerAsync(roots));
  appendLedger(roots, [ev.entryWritten("kb-wp-Extra01", "kb-wp-T1", "create")]);
  await measure("incremental read", () => readLedgerAsync(roots));
} finally {
  rmSync(base, { recursive: true, force: true });
}
