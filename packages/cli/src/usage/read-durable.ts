/**
 * Usage from a pi-durable store (<den>/session.sqlite). Mirrored stores are
 * live Syncthing files, so this reads a temp copy (with its -wal/-shm), never
 * the mirror itself. Each assistant message with usage in an entry's `model`
 * is one call.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { UsageEvent } from "@wolfpack/engine";
import { eventFromMessage, type PiAssistantMessage } from "./message.js";

type Sqlite = typeof import("node:sqlite");

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

/**
 * Read every call in a durable store. Ids are `durable:<host>/<wolf>:<entry id>:<index
 * of the message in the entry>`. Throws if the store can't be opened.
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
      const out: UsageEvent[] = [];
      const rows = db.prepare("SELECT id, conversation_id, record FROM entries ORDER BY id").all() as {
        id: number;
        conversation_id: number;
        record: string;
      }[];
      for (const row of rows) {
        if (!row.record.includes('"usage"')) continue;
        let rec: { model?: PiAssistantMessage[] };
        try {
          rec = JSON.parse(row.record);
        } catch {
          continue;
        }
        if (!Array.isArray(rec.model)) continue;
        for (const [i, m] of rec.model.entries()) {
          const e = eventFromMessage(m, {
            id: `durable:${host}/${wolf}:${row.id}:${i}`,
            wolf,
            source: "durable",
            session: `conv-${row.conversation_id}`,
            use: "main",
          });
          if (e) out.push(e);
        }
      }
      return out;
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
