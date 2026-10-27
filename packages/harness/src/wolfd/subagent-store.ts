/**
 * Subagents on disk: the child registry (`<den>/wolfd/subagents.json`, so wolfd re-attaches running children after a
 * restart and they still report to their parent) and each child's ledger (`<den>/wolfd/ledgers/<child>.jsonl`, one
 * entry per line, appended).
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LedgerEntrySchema, SubagentStateSchema, type LedgerEntry, type SubagentState } from "@wolfpack/protocol";
import type { Workspace } from "@wolfpack/workspaces";
import { quarantine } from "./threads.js";

/** A message waiting to reach the parent thread (a result, a question, a failure). Kept until the parent took it. */
export interface Delivery {
  /** Orders deliveries across children of one parent. */
  n: number;
  /** Embedded in the steer text, so the parent side can tell it already took this one (exactly-once across a crash). */
  id: string;
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
  /** The child's own worktree (isolation worktree): its branch is what ticket 8 merges. */
  workspace?: Workspace;
  /** The git working dir this writer holds in the writer guard until it is done; re-acquired after a restart. */
  guardDir?: string;
  state: SubagentState;
  startedAt: string;
  /** Start of the current run (the spawn, or the latest resume): the elapsed time a result reports. */
  runStartedAt: string;
  finishedAt?: string;
  step?: string;
  tokens: number;
  /** The work item this child serves. */
  taskId?: string;
  /** Set and persisted before a resume is submitted: the parent's message count then. Tells recover() whether the submit landed. */
  resuming?: { at: number };
  /** Set while `queued`: orders the queue (FIFO) across spawns and queued resumes. */
  queuedSeq?: number;
  /** Messages for a queued child, submitted when its slot comes (after the brief for a child that never ran). */
  pending?: string[];
  /** The commit a worktree was cut from (unmerged commits of a home child are counted against it). */
  base?: string;
  /** A merge into the feature branch has been tried since the child last ran: a restart or a late finish does not repeat it. */
  mergeTried?: true;
  /** A conflict-resolving worker: the child (record id) whose branch it rebases; when it finishes that branch is merged again. */
  resolves?: string;
  /** Who is stopping it, set while the abort is in flight. */
  stopping?: "parent" | "owner";
  outbox: Delivery[];
}

const registryFile = (den: string) => join(den, "wolfd", "subagents.json");
const ledgerDir = (den: string) => join(den, "wolfd", "ledgers");
const ledgerFile = (den: string, id: string) => join(ledgerDir(den), `${id.replace(/[^A-Za-z0-9_-]/g, "_")}.jsonl`);

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** A record from disk made safe to use, or the reason it is not. */
function checkRecord(raw: unknown): ChildRecord | string {
  if (!raw || typeof raw !== "object") return "not an object";
  const r = raw as Record<string, unknown>;
  for (const k of ["id", "conversationId", "parentThreadId", "agent", "name", "startedAt"]) if (!str(r[k])) return `missing ${k}`;
  if (!SubagentStateSchema.safeParse(r.state).success) return `bad state ${JSON.stringify(r.state)}`;
  const tokens = typeof r.tokens === "number" && Number.isFinite(r.tokens) && r.tokens >= 0 ? Math.floor(r.tokens) : 0;
  const outbox = Array.isArray(r.outbox)
    ? (r.outbox as unknown[]).filter((d): d is Delivery => !!d && typeof d === "object" && typeof (d as Delivery).n === "number" && typeof (d as Delivery).text === "string").map((d) => ({ ...d, id: str(d.id) ? d.id : `${String(r.id).split("/").pop()}.${d.n}` }))
    : [];
  return {
    ...(r as unknown as ChildRecord),
    brief: typeof r.brief === "string" ? r.brief : "",
    tier: typeof r.tier === "string" ? r.tier : "smart",
    cwd: typeof r.cwd === "string" ? r.cwd : "",
    isolation: r.isolation === "worktree" ? "worktree" : "none",
    ownerTaskId: typeof r.ownerTaskId === "string" ? r.ownerTaskId : "",
    runStartedAt: str(r.runStartedAt) ? r.runStartedAt : (r.startedAt as string),
    tokens,
    outbox,
  };
}

/** The saved children. Bad records are skipped and reported; an unreadable file is quarantined (see threads.ts). */
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
    const parsed = JSON.parse(raw) as { children?: unknown[] };
    if (!parsed || !Array.isArray(parsed.children)) throw new Error("subagents.json has no children array");
    const out: ChildRecord[] = [];
    for (const c of parsed.children) {
      const r = checkRecord(c);
      if (typeof r === "string") onError?.(new Error(`subagents.json: skipped a child record (${r})`));
      else out.push(r);
    }
    return out;
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

/**
 * A child's ledger. A torn LAST line (a crash mid-append) is dropped; any other bad line, or an unreadable file, moves the
 * file aside (`.corrupt-<ts>`, reported through `onError`) and the ledger starts empty. Never throws.
 */
export function readLedger(den: string, id: string, onError?: (e: unknown) => void): LedgerEntry[] {
  const file = ledgerFile(den, id);
  const aside = (cause: string): LedgerEntry[] => {
    const to = `${file}.corrupt-${Date.now()}`;
    try {
      renameSync(file, to);
      onError?.(new Error(`ledger ${file} was unreadable (${cause}); moved to ${to}`));
    } catch (e) {
      onError?.(new Error(`ledger ${file} is unreadable (${cause}) and cannot be moved aside: ${e instanceof Error ? e.message : String(e)}`));
    }
    return [];
  };
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    return aside(e instanceof Error ? e.message : String(e));
  }
  const lines = raw.split("\n").filter((l) => l.trim());
  const out: LedgerEntry[] = [];
  for (const [i, line] of lines.entries()) {
    let entry: LedgerEntry | undefined;
    try {
      const r = LedgerEntrySchema.safeParse(JSON.parse(line));
      if (r.success) entry = r.data;
    } catch {
      /* bad line */
    }
    if (entry) out.push(entry);
    else if (i === lines.length - 1) break;
    else return aside(`line ${i + 1} is not a ledger entry`);
  }
  return out;
}

export function appendLedger(den: string, id: string, entry: LedgerEntry): void {
  mkdirSync(ledgerDir(den), { recursive: true });
  appendFileSync(ledgerFile(den, id), `${JSON.stringify(entry)}\n`);
}
