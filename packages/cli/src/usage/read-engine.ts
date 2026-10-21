/**
 * Usage from an engine usage log (<den>/usage/<YYYY-MM>.jsonl, written by
 * @wolfpack/engine's appendUsageEvent). Engine events carry no id, so the
 * ledger id is `engine:<wolf>:<sha256 of the raw line>`.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { UsageEvent } from "@wolfpack/engine";
import { priceLoggedEvent } from "./pricing.js";

/** The usage log files in a den, oldest month first. */
export function engineLogFiles(den: string): string[] {
  const dir = path.join(den, "usage");
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

export function engineEventId(wolf: string, line: string): string {
  return `engine:${wolf}:${createHash("sha256").update(line).digest("hex")}`;
}

/** Read one log file; `wolf` names events that don't name themselves. */
export function readEngineLog(file: string, wolf: string): UsageEvent[] {
  const out: UsageEvent[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let e: UsageEvent;
    try {
      e = JSON.parse(line) as UsageEvent;
    } catch {
      continue; // a torn line
    }
    const owner = e.wolf || wolf;
    out.push(priceLoggedEvent({ ...e, id: engineEventId(owner, line), wolf: owner }));
  }
  return out;
}
