/**
 * Usage from a pi-durable store (<den>/session.sqlite). Mirrored stores are
 * live Syncthing files, so those are read from a temp copy (with -wal/-shm),
 * never the mirror itself. The wolf's own store is opened in place, read-only,
 * in short id-ordered pages. Each assistant message with usage in an entry's
 * `model` is one call.
 *
 * Append-only invariant: pi-durable's sqlite storage writes `entries` only with a plain
 * `INSERT INTO entries (id, conversation_id, head, commit_seq, record)` (storage/sqlite/storage.js,
 * applyTableWrite case "entry"; no ON CONFLICT, no UPDATE or DELETE anywhere on that table). An entry's
 * record never gains a message after insert, and ids only grow, so "entries with id above the mark"
 * is complete. A store that was replaced or rebuilt is detected separately (see the mark).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { UsageEvent } from "../usage-log.js";
import { eventFromMessage, type PiAssistantMessage } from "./message.js";

type Sqlite = typeof import("node:sqlite");
type Db = import("node:sqlite").DatabaseSync;

let sqlite: Sqlite | undefined;

/** node:sqlite, without its one-time ExperimentalWarning on stderr. */
function loadSqlite(): Sqlite {
  if (sqlite) return sqlite;
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const msg = typeof warning === "string" ? warning : warning.message;
    if (msg.includes("SQLite")) return;
    return (emit as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    sqlite = createRequire(import.meta.url)("node:sqlite") as Sqlite;
  } finally {
    process.emitWarning = emit;
  }
  return sqlite;
}

const PAGE = 2000;
/** How long a read waits on wolfd's write lock before giving up on this ingest. */
const BUSY_MS = 1000;

/** Where a live scan stopped, plus what identifies the store it read. */
export interface DurableMark {
  /** Highest entry id read. */
  id: number;
  /** Lowest entry id in the store when read (a rebuilt store starts elsewhere). */
  first: number;
  /** The store file's inode (a replaced file gets a new one). */
  ino: number;
}

function isBusy(err: unknown): boolean {
  const e = err as { errcode?: number; message?: string };
  return e.errcode === 5 || e.errcode === 6 || /database is (locked|busy)/i.test(e.message ?? "");
}

/** conversation id -> agent, from the wolf's subagent registry (<den>/wolfd/subagents.json), when there is one. */
function subagentConversations(file: string): Map<number, string> {
  const out = new Map<number, string>();
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(path.dirname(file), "wolfd", "subagents.json"), "utf8")) as {
      children?: { conversationId?: string | number; agent?: string }[];
    };
    for (const c of reg.children ?? []) {
      const id = Number(c.conversationId);
      if (c.agent && Number.isFinite(id)) out.set(id, c.agent);
    }
  } catch {
    /* no registry: the conversations table still says who is a child */
  }
  return out;
}

/** Conversations owned by another conversation (subagent children). */
function childConversations(db: Db): Set<number> {
  try {
    const rows = db.prepare("SELECT id FROM conversations WHERE owner_conversation_id IS NOT NULL").all() as { id: number }[];
    return new Set(rows.map((r) => r.id));
  } catch {
    return new Set();
  }
}

interface Scan {
  events: UsageEvent[];
  /** Highest id read (`after` if none). */
  id: number;
  /** False when a lock ended the scan early; `id` is the last completed page. */
  complete: boolean;
}

/** Read entries past `after` in id-ordered pages, each its own short read. */
function scan(db: Db, after: number, file: string, host: string, wolf: string): Scan {
  const agents = subagentConversations(file);
  const events: UsageEvent[] = [];
  const page = db.prepare("SELECT id, conversation_id, record FROM entries WHERE id > ? ORDER BY id LIMIT ?");
  let id = after;
  for (;;) {
    let rows: { id: number; conversation_id: number; record: string }[];
    let children: Set<number>;
    try {
      rows = page.all(id, PAGE) as typeof rows;
      children = childConversations(db);
    } catch (err) {
      if (isBusy(err)) return { events, id, complete: false };
      throw err;
    }
    for (const row of rows) {
      id = row.id;
      if (!row.record.includes('"usage"')) continue;
      let rec: { model?: PiAssistantMessage[] };
      try {
        rec = JSON.parse(row.record);
      } catch {
        continue;
      }
      if (!Array.isArray(rec.model)) continue;
      const agent = agents.get(row.conversation_id);
      const use = agent ? `subagent:${agent}` : children.has(row.conversation_id) ? "subagent:unknown" : "main";
      for (const [i, m] of rec.model.entries()) {
        const e = eventFromMessage(m, {
          id: `durable:${host}/${wolf}:${row.id}:${i}`,
          wolf,
          source: "durable",
          session: `conv-${row.conversation_id}`,
          use,
        });
        if (e) events.push(e);
      }
    }
    if (rows.length < PAGE) return { events, id, complete: true };
  }
}

/**
 * Read every call in a durable store (a mirror: reads a temp copy). Ids are
 * `durable:<host>/<wolf>:<entry id>:<index of the message in the entry>`.
 * Throws if the store can't be opened.
 */
export function readDurableStore(file: string, host: string, wolf: string): UsageEvent[] {
  const { DatabaseSync } = loadSqlite();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wolfpack-usage-"));
  try {
    const copy = path.join(tmp, "session.sqlite");
    fs.copyFileSync(file, copy);
    for (const ext of ["-wal", "-shm"]) {
      if (fs.existsSync(file + ext)) fs.copyFileSync(file + ext, copy + ext);
    }
    const db = new DatabaseSync(copy, { readOnly: true });
    try {
      return scan(db, 0, file, host, wolf).events;
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Read the entries past `mark` from the wolf's own live store, in place and read-only
 * (a read-only WAL connection never writes or checkpoints; wolfd keeps writing), a page at
 * a time so no read snapshot is held across a long scan. If the store looks rebuilt (its
 * newest id is below the mark, its oldest id or its inode changed) it is read from the start.
 * A lock from wolfd ends the scan early (`complete: false`) at the last finished page.
 */
export function readLiveDurableStore(
  file: string,
  host: string,
  wolf: string,
  mark: DurableMark | undefined,
): { events: UsageEvent[]; mark: DurableMark; complete: boolean } {
  const { DatabaseSync } = loadSqlite();
  const ino = fs.statSync(file).ino;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_MS}`);
    let range: { lo: number | null; hi: number | null };
    try {
      range = db.prepare("SELECT MIN(id) AS lo, MAX(id) AS hi FROM entries").get() as typeof range;
    } catch (err) {
      if (isBusy(err) && mark) return { events: [], mark, complete: false };
      throw err;
    }
    const first = range.lo ?? 0;
    const rebuilt = !!mark && ((range.hi ?? 0) < mark.id || first !== mark.first || ino !== mark.ino);
    const after = mark && !rebuilt ? mark.id : 0;
    const r = scan(db, after, file, host, wolf);
    return { events: r.events, mark: { id: r.id, first, ino }, complete: r.complete };
  } finally {
    db.close();
  }
}
