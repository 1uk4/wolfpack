/**
 * event-log.ts — the generic append-only EVENT STORE (the shared "database").
 *
 * Both the memory package (foldLedger over observations) and the kb package
 * (readLedger/appendLedger + foldRegistry) already implement this exact pattern.
 * This extracts it once so every layer — memory, kb, and the new factory
 * (WorkItem stage machine) — builds on the same proven primitive.
 *
 * Model: append-only JSONL on disk; current state is a PURE fold (projection)
 * over the event sequence. Replayable, auditable, time-travelable. Nothing
 * mutates in place — state transitions are new events.
 *
 *   events (append-only)                     fold(reducer) → live state
 *     created ─┐
 *     changed ─┼──▶  reduce ──────────────▶  { ...projection... }
 *     shipped ─┘
 */
import { existsSync, readFileSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";

/** Minimal shape every event carries. Extend per domain. */
export interface BaseEvent {
  /** Event type discriminator. */
  type: string;
}

export interface EventLog<E extends BaseEvent> {
  /** Append events to the log (atomic per call; skips empty). */
  append(events: E[]): void;
  /** Read the full event sequence in order. */
  read(): E[];
  /** Fold the sequence into a projection (the live state). */
  fold<S>(reducer: (state: S, event: E) => S, initial: S): S;
}

export interface EventLogOptions<E> {
  /**
   * Validate/parse a raw JSON object into an event. Return null to skip a
   * malformed/foreign line (forward-compatible logs). Defaults to pass-through.
   */
  parse?: (raw: unknown) => E | null;
}

/**
 * Create a JSONL-backed event log at `file`. The file is created lazily on first
 * append; reads of a missing file return []. Lines that fail `parse` are skipped
 * (so an older reader tolerates newer event types).
 */
export function createEventLog<E extends BaseEvent>(
  file: string,
  opts: EventLogOptions<E> = {}
): EventLog<E> {
  const parse = opts.parse ?? ((raw: unknown) => raw as E);

  function read(): E[] {
    if (!existsSync(file)) return [];
    const out: E[] = [];
    for (const line of readFileSync(file, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = parse(JSON.parse(line));
        if (parsed !== null && parsed !== undefined) out.push(parsed);
      } catch {
        /* skip unparseable line */
      }
    }
    return out;
  }

  function append(events: E[]): void {
    if (events.length === 0) return;
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }

  function fold<S>(reducer: (state: S, event: E) => S, initial: S): S {
    let state = initial;
    for (const e of read()) state = reducer(state, e);
    return state;
  }

  return { append, read, fold };
}

/** Fold an in-memory event array (when you already have the sequence). */
export function foldEvents<E extends BaseEvent, S>(
  events: E[],
  reducer: (state: S, event: E) => S,
  initial: S
): S {
  let state = initial;
  for (const e of events) state = reducer(state, e);
  return state;
}
