/**
 * Read-only memory resources served by wolfd (`GET .../memory`, `.../memory/topics/:id`, `.../work/:id/record`).
 * Pure reads of the wolf's own den (and its Work API client); nothing here writes. The topic lookup matches ids
 * against what the readers found on disk, so a request id is never joined into a path.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RECORD_HEADING, extractRecord, withoutRecord, readDenTopics, readTopics } from "@wolfpack/memory";
import type { BoundWork, LastPromote, MemoryState, MemoryStatus, MemoryTopic, MemoryTopicRef, WorkChild, WorkRecordResponse } from "@wolfpack/protocol";
import { DURABLE_SESSION_ID, getPoolStats } from "../memory/consolidation.js";

/** What wolfd knows of this wolf's memory configuration (wolf.yaml, after the sandbox redirect). */
export interface MemoryReadConfig {
  /** wolf.yaml `sandbox` is on: a running memory is in `sandbox` mode, otherwise `live`. */
  sandbox: boolean;
  /** `memory.enabled: false`: the extension is gated off by the owner. */
  disabled?: boolean;
  consolidation: { threshold: number; poolTarget: number; trigger: "threshold" | "timer" | "hybrid" | "manual" };
}

/** Cheap sanity check on a topic id; acceptance is an exact match against the topics listed on disk. */
export const isTopicId = (id: string): boolean => id !== "" && id.length <= 512 && !id.includes("/") && !id.includes("\0");
/** Work item ids (`work-<domain>-<hash>`). */
const WORK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export const isWorkId = (id: string): boolean => WORK_ID.test(id);

export function sessionTopicsRoot(den: string): string {
  return join(den, ".memory", "sessions", DURABLE_SESSION_ID);
}

const ref = (t: { id: string; title: string; summary: string; updated: string }, domain?: string): MemoryTopicRef => ({
  id: t.id,
  title: t.title,
  summary: t.summary,
  updated: t.updated,
  ...(domain ? { domain } : {}),
});

/** Newest first; topics without an `updated` sort last. */
const byUpdated = (a: MemoryTopicRef, b: MemoryTopicRef) => b.updated.localeCompare(a.updated) || a.id.localeCompare(b.id);

export interface MemoryStateInput {
  den: string | undefined;
  /** Is the memory extension installed on this wolf? undefined: not known. */
  extensionInstalled: boolean | undefined;
  /** The memory extension registered its actions on this den: it passed its gate and is running. */
  running: boolean;
  config: MemoryReadConfig;
}

/** live | sandbox | inert | off, with one line saying why. */
export function memoryState(i: MemoryStateInput): { state: MemoryState; reason: string } {
  if (!i.den || i.extensionInstalled === false) return { state: "off", reason: "memory is off: the memory extension is not loaded (add `memory` to extensions in wolf.yaml)" };
  if (i.running) {
    return i.config.sandbox
      ? { state: "sandbox", reason: "running against the sandbox dev root (wolf.yaml sandbox)" }
      : { state: "live", reason: "running against the live roots (memory.live: true)" };
  }
  if (i.config.disabled) return { state: "off", reason: "memory is off: disabled by memory.enabled: false" };
  return { state: "inert", reason: "memory is inert: the extension is loaded but gated off (set `sandbox` or `memory.live` in wolf.yaml)" };
}

export async function readMemoryStatus(i: MemoryStateInput, lastPromote: LastPromote | null, bound: BoundWork | null): Promise<MemoryStatus> {
  const { state, reason } = memoryState(i);
  if (!i.den || (state !== "live" && state !== "sandbox")) {
    return { state, reason, pool: null, sessionTopics: [], denTopics: [], lastPromote, bound };
  }
  const stats = await getPoolStats(i.den);
  const c = i.config.consolidation;
  return {
    state,
    reason,
    pool: { count: stats.count, tokens: stats.tokens, consolidateAtTokens: c.threshold, poolTarget: c.poolTarget, trigger: c.trigger },
    sessionTopics: readTopics(sessionTopicsRoot(i.den)).map((t) => ref(t, t.domain)).sort(byUpdated),
    denTopics: readDenTopics(i.den).map((t) => ref(t)).sort(byUpdated),
    lastPromote,
    bound,
  };
}

/** One topic by id. `scope` restricts the store; otherwise den first, then session. Undefined: no such topic. */
export function readMemoryTopic(den: string, id: string, scope?: "den" | "session"): MemoryTopic | undefined {
  if (scope !== "session") {
    const t = readDenTopics(den).find((x) => x.id === id);
    if (t) return { ...ref(t), scope: "den", body: t.body, related: t.related, promotable: t.promotable };
  }
  if (scope !== "den") {
    const t = readTopics(sessionTopicsRoot(den)).find((x) => x.id === id);
    if (t) return { ...ref(t, t.domain), scope: "session", body: t.body };
  }
  return undefined;
}

/** The Work API item as far as the page data needs it (fields the server may omit are optional). */
interface ApiWorkItem {
  id: string;
  title?: string;
  kind?: string;
  stage?: string;
  domain?: string;
  partOf?: string | null;
  dependsOn?: string[];
  container?: boolean;
  successCriteria?: string;
  updated?: string;
}

type WorkFetch = { kind: "ok"; item: ApiWorkItem; body: string } | { kind: "not_found" } | { kind: "unconfigured" } | { kind: "error"; message: string };

const WORK_TIMEOUT_MS = 3000;

/** GET <endpoint>/work/:id (the same call the memory extension's Work clients make). */
async function fetchWorkItem(id: string, work: { endpoint?: string; token?: string }): Promise<WorkFetch> {
  const endpoint = (work.endpoint ?? "").replace(/\/$/, "");
  if (!endpoint || !work.token) return { kind: "unconfigured" };
  try {
    const res = await fetch(`${endpoint}/work/${encodeURIComponent(id)}`, { headers: { "X-API-Key": work.token }, signal: AbortSignal.timeout(WORK_TIMEOUT_MS) });
    if (res.status === 404) return { kind: "not_found" };
    if (!res.ok) return { kind: "error", message: `GET ${id}: HTTP ${res.status}` };
    const data = (await res.json()) as { item?: ApiWorkItem; body?: string | null };
    if (!data.item) return { kind: "error", message: `GET ${id}: no item in response` };
    return { kind: "ok", item: data.item, body: data.body ?? "" };
  } catch (e) {
    return { kind: "error", message: (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 200) };
  }
}

/** Children cap: a feature past it gets the first CHILDREN_CAP and `childrenTruncated`. */
export const CHILDREN_CAP = 200;

/** GET <endpoint>/work?partOf=:id: the items directly under a feature. Undefined on any failure (children are best effort). */
async function fetchChildren(id: string, work: { endpoint?: string; token?: string }): Promise<WorkChild[] | undefined> {
  const endpoint = (work.endpoint ?? "").replace(/\/$/, "");
  if (!endpoint || !work.token) return undefined;
  try {
    const res = await fetch(`${endpoint}/work?partOf=${encodeURIComponent(id)}`, { headers: { "X-API-Key": work.token }, signal: AbortSignal.timeout(WORK_TIMEOUT_MS) });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { items?: ApiWorkItem[] };
    if (!Array.isArray(data.items)) return undefined;
    return data.items
      .filter((c) => typeof c.id === "string")
      .map((c) => ({ id: c.id, title: c.title ?? "", kind: c.kind ?? "", stage: c.stage ?? "", dependsOn: Array.isArray(c.dependsOn) ? c.dependsOn : [] }));
  } catch {
    return undefined;
  }
}

/** The document without its generated `## Log` section (the ledger renders it on every read; it is not plan). */
function withoutLog(body: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  let skipping = false;
  for (const line of body.split("\n")) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) fence = fence === null ? f[1][0] : f[1][0] === fence ? null : fence;
    else if (fence === null && /^#{1,2} /.test(line)) skipping = /^## Log\s*$/.test(line);
    if (!skipping) out.push(line);
  }
  return out.join("\n").trim();
}

export type WorkRecordResult = { kind: "ok"; value: WorkRecordResponse } | { kind: "not_found" } | { kind: "unconfigured" } | { kind: "error"; message: string };

/** The item's page data (plan, Record, links) through the Work API client. */
export async function readWorkRecord(id: string, work: { endpoint?: string; token?: string }): Promise<WorkRecordResult> {
  const r = await fetchWorkItem(id, work);
  if (r.kind !== "ok") return r;
  const { item, body } = r;
  const section = extractRecord(body);
  const listed = item.kind === "feature" ? await fetchChildren(item.id, work) : undefined;
  // a container (Inbox) can be huge: only its count goes out; a feature's list is capped
  const childCount = item.container && listed ? listed.length : undefined;
  const truncated = !item.container && listed !== undefined && listed.length > CHILDREN_CAP;
  const children = item.container ? undefined : truncated ? listed!.slice(0, CHILDREN_CAP) : listed;
  return {
    kind: "ok",
    value: {
      id: item.id,
      title: item.title ?? "",
      kind: item.kind ?? "",
      stage: item.stage ?? "",
      ...(item.domain !== undefined ? { domain: item.domain } : {}),
      ...(item.partOf !== undefined ? { partOf: item.partOf } : {}),
      ...(item.dependsOn !== undefined ? { dependsOn: item.dependsOn } : {}),
      ...(item.container ? { container: true } : {}),
      ...(children ? { children } : {}),
      ...(truncated ? { childrenTruncated: true } : {}),
      ...(childCount !== undefined ? { childCount } : {}),
      ...(item.successCriteria?.trim() ? { successCriteria: item.successCriteria } : {}),
      plan: withoutLog(withoutRecord(body)),
      record: section ? section.slice(RECORD_HEADING.length).trim() : "",
      ...(item.updated !== undefined ? { updated: item.updated } : {}),
    },
  };
}

/**
 * The work item a conversation lineage root is bound to: `<den>/factory/conversations/<cid>/active-task.json`
 * (the memory extension's binding file; read fresh, never cached). Title and kind are best effort via the Work API.
 */
export async function readBound(den: string, conversationId: string, work: { endpoint?: string; token?: string }): Promise<BoundWork | null> {
  if (!/^\d+$/.test(conversationId)) return null;
  let workId: string | undefined;
  try {
    workId = (JSON.parse(readFileSync(join(den, "factory", "conversations", conversationId, "active-task.json"), "utf-8")) as { workId?: string } | null)?.workId;
  } catch {
    return null;
  }
  if (!workId) return null;
  const r = await fetchWorkItem(workId, work);
  return r.kind === "ok" ? { workId, ...(r.item.title ? { title: r.item.title } : {}), ...(r.item.kind ? { kind: r.item.kind } : {}) } : { workId };
}
