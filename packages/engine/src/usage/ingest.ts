/**
 * Ingest: read every usage source and append the events the ledger doesn't
 * hold yet. Idempotent — ids dedupe. A state file (<ledger>/.ingest-state.json)
 * records each source file's size + mtime, so unchanged files (most of the
 * pi sessions, between runs) aren't reread; a changed one is rescanned whole.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UsageEvent, UsageSource } from "../usage-log.js";
import { listSources, readSource, reportSources, type CollectOptions, type SourceReport } from "./collect.js";
import { readLiveDurableStore, type DurableMark } from "./read-durable.js";
import { appendLedger, readLedger } from "./ledger.js";

interface FileStamp {
  size: number;
  mtimeMs: number;
}

export interface IngestState {
  version: 1;
  /** Every watched source file at its last successful read. */
  files: Record<string, FileStamp>;
  /** Live durable stores: how far each was read, and which store that was. */
  marks: Record<string, DurableMark>;
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

/** Append one timestamped line to <logDir>/usage-ingest.log (default ~/.wolfpack/logs). Never throws. */
export function appendIngestLog(line: string, logDir: string = path.join(os.homedir(), ".wolfpack", "logs")): void {
  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, "usage-ingest.log"), `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* logging must never fail the caller */
  }
}

export function statePath(ledgerDir: string): string {
  return path.join(ledgerDir, STATE_FILE);
}

export function readState(ledgerDir: string): IngestState {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(ledgerDir), "utf8")) as IngestState;
    if (s.version === 1 && s.files && typeof s.files === "object") {
      const marks: Record<string, DurableMark> = {};
      for (const [f, m] of Object.entries(s.marks ?? {})) if (m && typeof m === "object") marks[f] = m;
      return { version: 1, files: s.files, marks };
    }
  } catch {
    /* none yet */
  }
  return { version: 1, files: {}, marks: {} };
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

/**
 * Drop durable events that a `pi` ledger row already covers: the same call logged by the pi launcher
 * (before wolfd) and by the store (claude-bridge rows overlap the old pi/main rows around 2026-10-28).
 * Same wolf, same four token counts, timestamps within 5 s. The two ids differ, so ids alone can't dedupe.
 */
function withoutPiTwins(fresh: UsageEvent[], pi: UsageEvent[]): UsageEvent[] {
  const key = (e: UsageEvent): string => `${e.wolf}|${e.input}|${e.output}|${e.cacheRead}|${e.cacheWrite}`;
  const seen = new Map<string, number[]>();
  for (const e of [...pi, ...fresh.filter((f) => f.source === "pi")]) {
    const k = key(e);
    seen.set(k, [...(seen.get(k) ?? []), Date.parse(e.ts)]);
  }
  return fresh.filter((e) => e.source !== "durable" || !seen.get(key(e))?.some((t) => Math.abs(t - Date.parse(e.ts)) <= 5000));
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
    const existing = readLedger(opts.ledgerDir);
    const ids = new Set(existing.flatMap((e) => (e.id ? [e.id] : [])));
    // A wiped ledger with a surviving state file would otherwise never refill.
    const prev: IngestState = ids.size > 0 ? readState(opts.ledgerDir) : { version: 1, files: {}, marks: {} };
    const next: IngestState = { version: 1, files: { ...prev.files }, marks: { ...prev.marks } };
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
      let complete = true;
      try {
        if (src.live && src.kind === "durable") {
          const r = readLiveDurableStore(src.file, src.host, src.wolf, prev.marks[src.file]);
          events = r.events;
          next.marks[src.file] = r.mark;
          complete = r.complete;
        } else {
          events = await readSource(src);
        }
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
      // A scan a lock cut short keeps its old stamp, so the next turn picks up from the mark.
      if (!complete) continue;
      for (const [f, s] of stamps) {
        if (s) next.files[f] = s;
        else delete next.files[f];
      }
    }

    const kept = fresh.some((e) => e.source === "durable")
      ? withoutPiTwins(fresh, existing.filter((e) => e.source === "pi"))
      : fresh;
    for (const e of fresh) if (!kept.includes(e)) added[e.source]--;
    appendLedger(opts.ledgerDir, kept);
    if (!opts.wolf && !opts.dens) {
      // Forget files that no longer exist (only a full run sees them all; a
      // den-scoped run lists just its own files and would wipe the rest).
      const watched = new Set(sources.flatMap((s) => s.watch));
      for (const f of Object.keys(next.files)) if (!watched.has(f)) delete next.files[f];
      for (const f of Object.keys(next.marks)) if (!watched.has(f)) delete next.marks[f];
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
