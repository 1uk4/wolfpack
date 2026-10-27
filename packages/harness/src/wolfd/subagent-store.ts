/**
 * Subagents on disk: the child registry (`<den>/wolfd/subagents.json`, so wolfd re-attaches running children after a
 * restart and they still report to their parent) and each child's ledger (`<den>/wolfd/ledgers/<child>.jsonl`, one
 * entry per line, appended).
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LedgerEntry, SubagentState } from "@wolfpack/protocol";
import { quarantine } from "./threads.js";

/** A message waiting to reach the parent thread (a result, a question, a failure). Kept until the parent took it. */
export interface Delivery {
  /** Orders deliveries across children of one parent. */
  n: number;
  text: string;
}

export interface ChildRecord {
  /** Thread id. */
  id: string;
  conversationId: string;
  /** The parked task that owns the child's conversation. */
  ownerTaskId: string;
  parentThreadId: string;
  agent: string;
  /** The child's name (thread title): unique among its parent's children, the handle `subagent_message` uses. */
  name: string;
  brief: string;
  tier: string;
  cwd: string;
  isolation: "worktree" | "none";
  state: SubagentState;
  startedAt: string;
  /** Start of the current run (the spawn, or the latest resume): the elapsed time a result reports. */
  runStartedAt: string;
  finishedAt?: string;
  step?: string;
  tokens: number;
  /** The work item this child serves. */
  taskId?: string;
  /** Who is stopping it, set while the abort is in flight. */
  stopping?: "parent" | "owner";
  outbox: Delivery[];
}

const registryFile = (den: string) => join(den, "wolfd", "subagents.json");
const ledgerDir = (den: string) => join(den, "wolfd", "ledgers");
const ledgerFile = (den: string, id: string) => join(ledgerDir(den), `${id.replace(/[^A-Za-z0-9_-]/g, "_")}.jsonl`);

export function loadChildren(den: string, onError?: (e: unknown) => void): ChildRecord[] {
  const file = registryFile(den);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    quarantine(file, e, onError);
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as { children?: ChildRecord[] };
    if (!parsed || !Array.isArray(parsed.children)) throw new Error("subagents.json has no children array");
    return parsed.children.filter((c) => c && typeof c.id === "string" && typeof c.conversationId === "string" && typeof c.parentThreadId === "string");
  } catch (e) {
    quarantine(file, e, onError);
    return [];
  }
}

export function saveChildren(den: string, children: readonly ChildRecord[]): void {
  mkdirSync(join(den, "wolfd"), { recursive: true });
  const tmp = `${registryFile(den)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ children }, null, 2));
  renameSync(tmp, registryFile(den));
}

export function readLedger(den: string, id: string): LedgerEntry[] {
  let raw: string;
  try {
    raw = readFileSync(ledgerFile(den, id), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: LedgerEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as LedgerEntry);
    } catch {
      /* a torn last line from a crash: skip it */
    }
  }
  return out;
}

export function appendLedger(den: string, id: string, entry: LedgerEntry): void {
  mkdirSync(ledgerDir(den), { recursive: true });
  appendFileSync(ledgerFile(den, id), `${JSON.stringify(entry)}\n`);
}
