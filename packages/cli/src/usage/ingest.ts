/**
 * Ingest: read every usage source and append the events the ledger doesn't
 * hold yet. Idempotent — ids dedupe. A state file (<ledger>/.ingest-state.json)
 * records each source file's size + mtime, so unchanged files (most of the
 * pi sessions, between runs) aren't reread; a changed one is rescanned whole.
 */
import fs from "node:fs";
import path from "node:path";
import type { UsageEvent, UsageSource } from "@wolfpack/engine";
import { listSources, readSource, reportSources, type CollectOptions, type SourceReport } from "./collect.js";
import { appendLedger, ledgerIds } from "./ledger.js";

interface FileStamp {
  size: number;
  mtimeMs: number;
}

export interface IngestState {
  version: 1;
  /** Every watched source file at its last successful read. */
  files: Record<string, FileStamp>;
}

export interface IngestOptions extends CollectOptions {
  ledgerDir: string;
}

export interface IngestResult {
  /** New events appended, per source kind. */
  added: Record<UsageSource, number>;
  scanned: number;
  unchanged: number;
  ms: number;
  sources: SourceReport;
  /** Another ingest held the lock; nothing was done. */
  locked?: boolean;
}

const STATE_FILE = ".ingest-state.json";
const LOCK_FILE = ".ingest.lock";
const STALE_LOCK_MS = 10 * 60_000;

export function statePath(ledgerDir: string): string {
  return path.join(ledgerDir, STATE_FILE);
}

export function readState(ledgerDir: string): IngestState {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(ledgerDir), "utf8")) as IngestState;
    if (s.version === 1 && s.files && typeof s.files === "object") return s;
  } catch {
    /* none yet */
  }
  return { version: 1, files: {} };
}

function writeState(ledgerDir: string, state: IngestState): void {
  const file = statePath(ledgerDir);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 1) + "\n");
  fs.renameSync(`${file}.tmp`, file);
}

function stamp(file: string): FileStamp | undefined {
  try {
    const st = fs.statSync(file);
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return undefined;
  }
}

/** Take the ingest lock; false if a live ingest holds it. */
function lock(ledgerDir: string): boolean {
  const file = path.join(ledgerDir, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: "wx" });
      return true;
    } catch {
      const age = Date.now() - (stamp(file)?.mtimeMs ?? Date.now());
      if (age < STALE_LOCK_MS) return false;
      fs.rmSync(file, { force: true });
    }
  }
  return false;
}

export async function ingestUsage(opts: IngestOptions): Promise<IngestResult> {
  const started = Date.now();
  const added: Record<UsageSource, number> = { pi: 0, durable: 0, engine: 0 };
  fs.mkdirSync(opts.ledgerDir, { recursive: true });
  const { sources, skipped } = listSources(opts);
  if (!lock(opts.ledgerDir)) {
    return { added, scanned: 0, unchanged: 0, ms: Date.now() - started, sources: reportSources(sources, skipped), locked: true };
  }
  try {
    const ids = ledgerIds(opts.ledgerDir);
    // A wiped ledger with a surviving state file would otherwise never refill.
    const prev = ids.size > 0 ? readState(opts.ledgerDir) : { version: 1 as const, files: {} };
    const next: IngestState = { version: 1, files: { ...prev.files } };
    const fresh: UsageEvent[] = [];
    const failed: string[] = [];
    let scanned = 0;
    let unchanged = 0;

    for (const src of sources) {
      const stamps = src.watch.map((f) => [f, stamp(f)] as const);
      const same = stamps.every(([f, s]) => {
        const p = prev.files[f];
        return s ? p?.size === s.size && p.mtimeMs === s.mtimeMs : !p;
      });
      if (same) {
        unchanged++;
        continue;
      }
      scanned++;
      let events: UsageEvent[];
      try {
        events = await readSource(src);
      } catch (err) {
        failed.push(`${src.host}/${src.wolf} ${src.kind} unreadable: ${(err as Error).message}`);
        continue;
      }
      for (const e of events) {
        if (!e.id || ids.has(e.id)) continue;
        ids.add(e.id);
        fresh.push(e);
        added[e.source]++;
      }
      for (const [f, s] of stamps) {
        if (s) next.files[f] = s;
        else delete next.files[f];
      }
    }

    appendLedger(opts.ledgerDir, fresh);
    if (!opts.wolf) {
      // Forget files that no longer exist (only a full run sees them all).
      const live = new Set(sources.flatMap((s) => s.watch));
      for (const f of Object.keys(next.files)) if (!live.has(f)) delete next.files[f];
    }
    writeState(opts.ledgerDir, next);
    return { added, scanned, unchanged, ms: Date.now() - started, sources: reportSources(sources, [...skipped, ...failed]) };
  } finally {
    fs.rmSync(path.join(opts.ledgerDir, LOCK_FILE), { force: true });
  }
}

/** "usage ingest: +12 pi, +0 durable, +0 engine · 3 scanned, 99 unchanged · 0.4s" */
export function formatIngest(r: IngestResult): string {
  if (r.locked) return "usage ingest: another ingest is running; skipped";
  const added = (Object.keys(r.added) as UsageSource[]).map((k) => `+${r.added[k]} ${k}`).join(", ");
  return `usage ingest: ${added} · ${r.scanned} scanned, ${r.unchanged} unchanged · ${(r.ms / 1000).toFixed(1)}s`;
}
