/**
 * The task-update notice: the bound work item's volatile state (stage, its feature's child counts/stages, the working
 * document and the feature Record) is NOT in the system prompt, which stays byte-stable for prompt caching. Instead the
 * thread prepends ONE short line to the next user message that starts a turn ("Task update: stage in_build → shipped;
 * 2/3 tasks shipped; Record updated"). Several changes since the last notice coalesce into one line; nothing is sent
 * when nothing changed. The last-seen snapshot is kept per conversation on disk, so a restart does not repeat a notice.
 * Provider-agnostic: it is plain user text.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fetchWorkItem } from "./memory-read.js";

export interface TaskSnapshot {
  workId: string;
  stage: string;
  /** The feature's children: how many, how many shipped, and a fingerprint of every child's stage. */
  children?: { total: number; shipped: number; stages: string };
  /** Fingerprint of the item's working document and its feature's Record. */
  record: string;
}

export interface WorkItemLite {
  id: string;
  stage: string;
  kind?: string;
  domain?: string;
  partOf?: string | null;
  container?: boolean;
}

/** What the notice needs from the Work API (injectable for tests). */
export interface TaskNoticeReader {
  get(id: string): Promise<{ item: WorkItemLite; body: string } | undefined>;
  children(domain: string, featureId: string): Promise<WorkItemLite[]>;
}

export function workApiReader(work: { endpoint?: string; token?: string }): TaskNoticeReader {
  return {
    async get(id) {
      const r = await fetchWorkItem(id, work);
      if (r.kind !== "ok") return undefined;
      return { item: { id, stage: r.item.stage ?? "", kind: r.item.kind, domain: r.item.domain, partOf: r.item.partOf, container: r.item.container }, body: r.body };
    },
    async children(domain, featureId) {
      const endpoint = (work.endpoint ?? "").replace(/\/$/, "");
      if (!endpoint || !work.token) return [];
      const res = await fetch(`${endpoint}/work?domain=${encodeURIComponent(domain)}&partOf=${encodeURIComponent(featureId)}`, { headers: { "X-API-Key": work.token }, signal: AbortSignal.timeout(3000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { items?: WorkItemLite[] };
      return (data.items ?? []).filter((i) => typeof i.id === "string" && i.partOf === featureId);
    },
  };
}

const hash = (s: string): string => createHash("sha1").update(s).digest("hex").slice(0, 16);
const isShipped = (stage: string): boolean => stage === "shipped" || stage === "archived";

const bindingPath = (den: string, conversationId: string): string => join(den, "factory", "conversations", conversationId, "active-task.json");
const statePath = (den: string, conversationId: string): string => join(den, "factory", "task-notice", `${conversationId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

/** The bound item's current snapshot; undefined when unbound or the Work API cannot be read (then nothing is said). */
export async function takeSnapshot(den: string, conversationId: string, reader: TaskNoticeReader): Promise<TaskSnapshot | undefined> {
  const workId = readJson<{ workId?: string }>(bindingPath(den, conversationId))?.workId;
  if (!workId) return undefined;
  const got = await reader.get(workId);
  if (!got) return undefined;
  const { item, body } = got;
  let featureId: string | undefined;
  let featureBody = "";
  if (item.kind === "feature") featureId = item.id;
  else if (item.partOf) {
    const parent = await reader.get(item.partOf).catch(() => undefined);
    if (parent && parent.item.kind === "feature" && !parent.item.container) {
      featureId = parent.item.id;
      featureBody = parent.body;
    }
  }
  const snap: TaskSnapshot = { workId, stage: item.stage, record: hash(`${body}\u0000${featureBody}`) };
  if (featureId && item.domain) {
    try {
      const kids = await reader.children(item.domain, featureId);
      snap.children = { total: kids.length, shipped: kids.filter((k) => isShipped(k.stage)).length, stages: hash(kids.map((k) => `${k.id}:${k.stage}`).sort().join("\n")) };
    } catch { /* counts are advisory */ }
  }
  return snap;
}

/** The one-line notice for the change from `prev` to `next` ("" when nothing changed). */
export function describeChange(prev: TaskSnapshot, next: TaskSnapshot): string {
  const parts: string[] = [];
  if (prev.stage !== next.stage) parts.push(`stage ${prev.stage} → ${next.stage}`);
  if (next.children && prev.children && prev.children.stages !== next.children.stages) {
    const countsMoved = prev.children.shipped !== next.children.shipped || prev.children.total !== next.children.total;
    // Counts when they moved; otherwise a stage move of the bound item itself is already said above.
    if (countsMoved) parts.push(`${next.children.shipped}/${next.children.total} tasks shipped`);
    else if (prev.stage === next.stage) parts.push("feature tasks changed");
  }
  if (prev.record !== next.record) parts.push("Record updated");
  return parts.length ? `Task update: ${parts.join("; ")}` : "";
}

export interface PendingNotice {
  /** The line to prepend ("" when nothing changed). */
  text: string;
  /** Mark the snapshot as delivered; call after the message carrying the notice was accepted. */
  commit(): void;
}

/**
 * The notice due for this conversation. A first look, a bind/unbind/rebind (a different item: the system-prompt header
 * changes) or an unreadable Work API records the baseline without a notice.
 */
export async function pendingTaskNotice(den: string, conversationId: string, reader: TaskNoticeReader): Promise<PendingNotice> {
  const none: PendingNotice = { text: "", commit() {} };
  let next: TaskSnapshot | undefined;
  try {
    next = await takeSnapshot(den, conversationId, reader);
  } catch {
    return none;
  }
  const path = statePath(den, conversationId);
  const write = (s: TaskSnapshot | undefined) => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      if (!s) writeFileSync(path, "null");
      else {
        const tmp = `${path}.tmp`;
        writeFileSync(tmp, JSON.stringify(s));
        renameSync(tmp, path);
      }
    } catch { /* best effort: the worst case is one repeated notice */ }
  };
  const prev = readJson<TaskSnapshot | null>(path) ?? undefined;
  if (!next) {
    // Unbound (or unreadable binding file): forget the baseline so a later bind starts fresh. An unreadable API keeps it.
    if (prev && !readJson<{ workId?: string }>(bindingPath(den, conversationId))?.workId) write(undefined);
    return none;
  }
  if (!prev || prev.workId !== next.workId) {
    write(next);
    return none;
  }
  const text = describeChange(prev, next);
  if (!text) return none;
  return { text, commit: () => write(next) };
}

/** The notice as it is put at the head of a user message. */
export const NOTICE_LINE = /^Task update: [^\n]*\n\n/;
export const withTaskNotice = (notice: string, text: string): string => (notice ? `${notice}\n\n${text}` : text);
export const stripTaskNotice = (text: string): string => text.replace(NOTICE_LINE, "");
