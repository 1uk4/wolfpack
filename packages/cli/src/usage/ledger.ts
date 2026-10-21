/**
 * The usage ledger: an append-only record of every model call ever ingested,
 * at ~/.wolfpack/usage/<YYYY-MM>.jsonl. It outlives the sources — deleting a
 * pi session or a durable store never shrinks history. Every event has an id;
 * ingest appends only ids the ledger doesn't hold yet.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UsageEvent } from "@wolfpack/engine";

export function defaultLedgerDir(): string {
  return path.join(os.homedir(), ".wolfpack", "usage");
}

function ledgerFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f))
      .sort();
  } catch {
    return [];
  }
}

/** Read the ledger. With `since`, months wholly before it are skipped. */
export function readLedger(dir: string, since?: Date): UsageEvent[] {
  const fromMonth = since ? since.toISOString().slice(0, 7) : undefined;
  const out: UsageEvent[] = [];
  for (const f of ledgerFiles(dir)) {
    if (fromMonth && f.slice(0, 7) < fromMonth) continue;
    for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as UsageEvent);
      } catch {
        /* a torn line */
      }
    }
  }
  return out;
}

/** Every id in the ledger. */
export function ledgerIds(dir: string): Set<string> {
  const ids = new Set<string>();
  for (const e of readLedger(dir)) if (e.id) ids.add(e.id);
  return ids;
}

/** Append events to their month files (by ts, UTC — the engine log's convention). */
export function appendLedger(dir: string, events: UsageEvent[]): void {
  const byMonth = new Map<string, string[]>();
  for (const e of events) {
    const month = e.ts.slice(0, 7);
    const lines = byMonth.get(month) ?? [];
    lines.push(JSON.stringify(e));
    byMonth.set(month, lines);
  }
  if (byMonth.size === 0) return;
  fs.mkdirSync(dir, { recursive: true });
  for (const [month, lines] of byMonth) {
    fs.appendFileSync(path.join(dir, `${month}.jsonl`), lines.join("\n") + "\n");
  }
}
