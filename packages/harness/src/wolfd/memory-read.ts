/**
 * Read-only memory resources served by wolfd (`GET .../memory`, `.../memory/topics/:id`, `.../work/:id/record`).
 * Pure reads of the wolf's own den (and its Work API client); nothing here writes. The topic lookup matches ids
 * against what the readers found on disk, so a request id is never joined into a path.
 */
import { readFileSync, readdirSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { readDenTopics, readTopics, readPendingSummary, observationIds, shapeWorkList, shapeWorkRecord, toWorkChild, CHILDREN_CAP, LOG_TAIL, type ShapeWorkItem } from "@wolfpack/memory";
import type { MemoryTree, MemoryNodeObservations, WorkListItem, BoundWork, LastPromote, MemoryObservation, MemoryObservations, MemoryState, MemoryStatus, MemoryTopic, MemoryTopicRef, WorkChild, WorkRecordResponse } from "@wolfpack/protocol";
import type { KbWorkSource } from "@wolfpack/kb/graph";
import { DURABLE_SESSION_ID, getPoolStats, readPool } from "../memory/consolidation.js";

/** What wolfd knows of this wolf's memory configuration (wolf.yaml, after the sandbox redirect). */
export interface MemoryReadConfig {
  /** wolf.yaml `sandbox` is on: a running memory is in `sandbox` mode, otherwise `live`. */
  sandbox: boolean;
  /** `memory.enabled: false`: the extension is gated off by the owner. */
  disabled?: boolean;
  consolidation: { threshold: number; poolTarget: number; trigger: "threshold" | "timer" | "hybrid" | "manual"; interval?: string };
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

export async function readMemoryStatus(i: MemoryStateInput, lastPromote: LastPromote | null, bound: BoundWork | null, promotingJobId: string | null = null): Promise<MemoryStatus> {
  const { state, reason } = memoryState(i);
  const promoting = promotingJobId ? { promoting: { jobId: promotingJobId } } : {};
  if (!i.den || (state !== "live" && state !== "sandbox")) {
    return { state, reason, pool: null, sessionTopics: [], denTopics: [], lastPromote, ...promoting, bound };
  }
  const stats = await getPoolStats(i.den);
  const c = i.config.consolidation;
  return {
    state,
    reason,
    pool: { count: stats.count, tokens: stats.tokens, consolidateAtTokens: c.threshold, poolTarget: c.poolTarget, trigger: c.trigger, ...(c.interval ? { interval: c.interval } : {}) },
    sessionTopics: readTopics(sessionTopicsRoot(i.den)).map((t) => ref(t, t.domain)).sort(byUpdated),
    denTopics: readDenTopics(i.den).map((t) => ref(t)).sort(byUpdated),
    lastPromote,
    ...promoting,
    bound,
  };
}

const PROBE_TTL_MS = 30_000;
const probeCache = new Map<string, { at: number; unavailable: boolean }>();

/** Whether tagged observations are waiting on the Work API; probed at most once per 30 s per den. */
async function workApiUnavailable(den: string, probeId: string, api: { endpoint?: string; token?: string }, now: number): Promise<boolean> {
  const hit = probeCache.get(den);
  if (hit && now - hit.at < PROBE_TTL_MS) return hit.unavailable;
  const r = await fetchWorkItem(probeId, api);
  const unavailable = r.kind === "unconfigured" || r.kind === "error";
  probeCache.set(den, { at: now, unavailable });
  return unavailable;
}

/** Test hook: forget cached probes. */
export const resetObservationProbeCache = (): void => probeCache.clear();

/**
 * The wolf's observation pool (`<den>/.memory/pool/observations.jsonl`), newest first: by recordedAt, ties by
 * the later append. Ids hash the entry (an ordinal tells identical entries apart), so the same entry keeps its id
 * from read to read until consolidation archives it.
 */
export async function readMemoryObservations(den: string, limit?: number, work?: { endpoint?: string; token?: string }, now: number = Date.now()): Promise<MemoryObservations> {
  const pool = await readPool(den);
  const tagged = pool.filter((o) => o.work || o.feature);
  // Same resolution as consolidation: the configured Work API, else WORK_ENDPOINT / WORK_TOKEN.
  const api = { endpoint: work?.endpoint || process.env.WORK_ENDPOINT, token: work?.token || process.env.WORK_TOKEN };
  const unavailable = tagged.length > 0 && (await workApiUnavailable(den, tagged[0]!.work || tagged[0]!.feature!, api, now));
  const waiting = readPendingSummary(den, now);
  // A state entry blocks an observation only if it is not an orphan: it must be under a key the observation
  // is grouped under (feature or work) and started after the observation was recorded. An entry older than the
  // observation was left by an earlier grouping and is ignored (consolidation clears it on the next success).
  // An entry is live when some observation grouped under its key was recorded at or before it first went
  // pending (that one could have caused it): then every observation under the key waits, including later ones.
  // An entry older than all of its key's observations was left by an earlier grouping: an orphan.
  const oldestRec = new Map<string, number>();
  for (const p of pool) {
    const r = p.recordedAt ? Date.parse(p.recordedAt) : NaN;
    for (const k of [p.feature, p.work]) if (k) oldestRec.set(k, Math.min(oldestRec.get(k) ?? Infinity, Number.isNaN(r) ? -Infinity : r));
  }
  const waitOf = (o: { work?: string; feature?: string; recordedAt?: string }): { cause: "work-api-unavailable" | "consolidation-failed" | "forbidden"; since: number; key?: string; assignee?: string; message?: string } | undefined => {
    const rec = o.recordedAt ? Date.parse(o.recordedAt) : NaN;
    for (const k of [o.feature, o.work]) {
      const t = k ? waiting.firstPendingAt[k] : undefined;
      if (k && t !== undefined && t >= (oldestRec.get(k) ?? -Infinity)) return { cause: waiting.keys[k]!, since: t, key: k, ...(waiting.assignees[k] ? { assignee: waiting.assignees[k] } : {}), ...(waiting.messages[k] ? { message: waiting.messages[k] } : {}) };
    }
    return unavailable && (o.work || o.feature) ? { cause: "work-api-unavailable", since: Number.isNaN(rec) ? now : rec } : undefined;
  };
  let oldestWait: number | undefined;
  const blocked = unavailable;
  // The same ids the Records and the archive use (observationIds, in @wolfpack/memory).
  const poolIds = observationIds(pool);
  const all = pool.map((o, i): MemoryObservation & { _i: number } => {
    const w = waitOf(o);
    if (w) oldestWait = Math.max(oldestWait ?? 0, now - w.since);
    return {
      id: poolIds[i]!,
      timestamp: o.timestamp ?? "",
      ...(o.recordedAt ? { recordedAt: o.recordedAt } : {}),
      content: o.content ?? "",
      tokenCount: Math.ceil((o.content ?? "").length / 4),
      ...(o.domain ? { domain: o.domain } : {}),
      ...(o.work ? { work: o.work } : {}),
      ...(o.feature ? { feature: o.feature } : {}),
      ...(w ? { blocked: w.cause, ...(w.key ? { blockedKey: w.key } : {}), ...(w.assignee ? { assignee: w.assignee } : {}), ...(w.message ? { blockedMessage: w.message } : {}) } : {}),
      _i: i,
    };
  });
  const pendingCount = all.filter((o) => o.blocked).length;
  all.sort((a, b) => (b.recordedAt ?? b.timestamp).localeCompare(a.recordedAt ?? a.timestamp) || b._i - a._i);
  const kept = limit === undefined ? all : all.slice(0, limit);
  return { observations: kept.map(({ _i, ...o }) => o), total: all.length, ...(blocked ? { blocked: "work-api-unavailable" as const } : {}), ...(pendingCount > 0 ? { pending: { count: pendingCount, ...(oldestWait !== undefined ? { oldestAgeMs: oldestWait } : {}) } } : {}) };
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
type ApiWorkItem = ShapeWorkItem;

type WorkFetch = { kind: "ok"; item: ApiWorkItem; body: string } | { kind: "not_found" } | { kind: "unconfigured" } | { kind: "error"; message: string };

const WORK_TIMEOUT_MS = 3000;

/** GET <endpoint>/work/:id (the same call the memory extension's Work clients make). */
export async function fetchWorkItem(id: string, work: { endpoint?: string; token?: string }): Promise<WorkFetch> {
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

/**
 * GET <endpoint>/work?domain=<d>, one request per domain in parallel, concatenated (archived included; the graph builder
 * filters). Never the whole list: that is ~1.6 MB / ~4 s, over the 3 s limit, and grows with every item. Scoped reads stay small.
 * Undefined when the API is unconfigured or unreachable, so the caller falls back to the KB work files.
 */
export async function fetchWorkSources(endpoint: string | undefined, token: string | undefined, domains: string[]): Promise<KbWorkSource[] | undefined> {
  const base = (endpoint ?? "").replace(/\/$/, "");
  if (!base || !token) return undefined;
  try {
    const pages = await Promise.all(domains.map(async (d) => {
      const res = await fetch(`${base}/work?domain=${encodeURIComponent(d)}`, { headers: { "X-API-Key": token }, signal: AbortSignal.timeout(WORK_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { items?: Array<ApiWorkItem & { assignee?: string }> };
      if (!Array.isArray(data.items)) throw new Error("no items");
      return data.items;
    }));
    return pages.flat()
      .filter((w) => typeof w.id === "string" && typeof w.domain === "string")
      .map((w) => ({
        id: w.id,
        domain: w.domain,
        ...(w.title ? { title: w.title } : {}),
        ...(w.kind ? { kind: w.kind } : {}),
        ...(w.stage ? { stage: w.stage } : {}),
        ...(w.graduated ? { graduated: w.graduated } : {}),
        ...(w.container ? { container: true } : {}),
        ...(w.partOf ? { partOf: w.partOf } : {}),
        ...(Array.isArray(w.dependsOn) ? { dependsOn: w.dependsOn } : {}),
        ...(w.assignee ? { assignee: w.assignee } : {}),
        ...(w.updated ? { updated: w.updated } : {}),
      }));
  } catch {
    return undefined;
  }
}

/** Re-exported: the shaping constants live in @wolfpack/memory (shared with hubd). */
export { CHILDREN_CAP, LOG_TAIL };

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
      .map(toWorkChild);
  } catch {
    return undefined;
  }
}

export type WorkRecordResult = { kind: "ok"; value: WorkRecordResponse } | { kind: "not_found" } | { kind: "unconfigured" } | { kind: "error"; message: string };

export type WorkListResult = { kind: "ok"; items: WorkListItem[] } | { kind: "unconfigured" } | { kind: "error"; message: string };

/**
 * GET <endpoint>/work?domain=: the domain's items for the console's Work view. Graduated and archived items are left out
 * unless `includeGraduated`. Unlike the best-effort readers this reports failures, so the view can say why it is empty.
 */
export async function readWorkList(domain: string, includeGraduated: boolean, work: { endpoint?: string; token?: string }): Promise<WorkListResult> {
  const endpoint = (work.endpoint ?? "").replace(/\/$/, "");
  if (!endpoint || !work.token) return { kind: "unconfigured" };
  try {
    const res = await fetch(`${endpoint}/work?domain=${encodeURIComponent(domain)}`, { headers: { "X-API-Key": work.token }, signal: AbortSignal.timeout(WORK_TIMEOUT_MS) });
    if (!res.ok) return { kind: "error", message: `HTTP ${res.status}` };
    const data = (await res.json()) as { items?: ApiWorkItem[] };
    if (!Array.isArray(data.items)) return { kind: "error", message: "unexpected response" };
    const items: WorkListItem[] = shapeWorkList(data.items, domain, includeGraduated);
    return { kind: "ok", items };
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

/** The item's page data (plan, Record, links) through the Work API client. */
export async function readWorkRecord(id: string, work: { endpoint?: string; token?: string }): Promise<WorkRecordResult> {
  const r = await fetchWorkItem(id, work);
  if (r.kind !== "ok") return r;
  const { item, body } = r;
  const listed = item.kind === "feature" ? await fetchChildren(item.id, work) : undefined;
  return { kind: "ok", value: shapeWorkRecord(item, body, listed) };
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

// ---------------------------------------------------------------- memory tree (feature → task observation counts)

const TREE_WINDOW_MS = 7 * 24 * 3600_000;
/** Bytes read from the end of each archive file (it rotates at 20 MB; the 7-day window sits at the tail). */
const ARCHIVE_TAIL_BYTES = 4 * 1024 * 1024;
const LOOKUP_TTL_MS = 30_000;
export const NODE_ARCHIVED_DEFAULT_LIMIT = 100;

interface LookedUp { title: string; stage?: string; partOf?: string }
const lookupCache = new Map<string, { at: number; value: LookedUp | null }>();
/** Test hook: forget cached work lookups. */
export const resetWorkLookupCache = (): void => lookupCache.clear();

async function lookupWork(id: string, api: { endpoint?: string; token?: string }, now: number): Promise<LookedUp | null> {
  const hit = lookupCache.get(id);
  if (hit && now - hit.at < LOOKUP_TTL_MS) return hit.value;
  const r = await fetchWorkItem(id, api);
  // Only a real answer is cached; a transient error is retried next time.
  const value: LookedUp | null = r.kind === "ok" ? { title: r.item.title ?? id, ...(r.item.stage ? { stage: r.item.stage } : {}), ...(r.item.partOf ? { partOf: r.item.partOf } : {}) } : null;
  if (r.kind === "ok" || r.kind === "not_found") lookupCache.set(id, { at: now, value });
  return value;
}

/** The last bytes of a JSONL file as parsed lines (a cut first line is dropped). Missing file: none. */
async function readJsonlTail(file: string, maxBytes: number): Promise<Array<Record<string, unknown>>> {
  let fh;
  try {
    fh = await open(file, "r");
    const { size } = await fh.stat();
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const lines = buf.toString("utf-8").split("\n");
    if (start > 0) lines.shift();
    const out: Array<Record<string, unknown>> = [];
    for (const l of lines) {
      if (!l.trim()) continue;
      try { out.push(JSON.parse(l) as Record<string, unknown>); } catch { /* torn or foreign line */ }
    }
    return out;
  } catch {
    return [];
  } finally {
    await fh?.close();
  }
}

interface TreeEntry { work?: string; feature?: string; content: string }
interface PendingEntry extends TreeEntry { id: string; recordedAt?: string }
interface ArchivedEntry extends TreeEntry { id: string; at: string; atMs: number; outcome: string; target: string }
type Bucket = { t: "den" } | { t: "own"; f: string } | { t: "task"; f: string; w: string } | { t: "other"; w: string };

async function readTreeSources(den: string, now: number): Promise<{ pending: PendingEntry[]; archived: ArchivedEntry[] }> {
  const pool = await readPool(den);
  const ids = observationIds(pool);
  const pending = pool.map((o, i): PendingEntry => ({ id: ids[i]!, content: o.content ?? "", ...(o.recordedAt ? { recordedAt: o.recordedAt } : {}), ...(o.work ? { work: o.work } : {}), ...(o.feature ? { feature: o.feature } : {}) }));
  const dir = join(den, ".memory", "pool");
  let names: string[] = [];
  try { names = readdirSync(dir).filter((n) => /^archive(-\d+)?\.jsonl$/.test(n)); } catch { /* no archive yet */ }
  const cutoff = now - TREE_WINDOW_MS;
  const archived: ArchivedEntry[] = [];
  for (const lines of await Promise.all(names.map((n) => readJsonlTail(join(dir, n), ARCHIVE_TAIL_BYTES)))) {
    for (const l of lines) {
      const at = typeof l.at === "string" ? l.at : "";
      const atMs = Date.parse(at);
      if (Number.isNaN(atMs) || atMs < cutoff) continue;
      archived.push({
        id: typeof l.id === "string" ? l.id : "", content: typeof l.content === "string" ? l.content : "", at, atMs,
        outcome: typeof l.outcome === "string" ? l.outcome : "", target: typeof l.target === "string" ? l.target : "",
        ...(typeof l.work === "string" && l.work ? { work: l.work } : {}), ...(typeof l.feature === "string" && l.feature ? { feature: l.feature } : {}),
      });
    }
  }
  return { pending, archived };
}

/** Where each entry funnels: its feature (own), a task under a feature, `other` (item unknown), or the den. */
async function bucketize(entries: TreeEntry[], api: { endpoint?: string; token?: string }, now: number): Promise<{ buckets: Bucket[]; info: Map<string, LookedUp | null> }> {
  const needed = new Set<string>();
  for (const e of entries) {
    if (e.work && e.work !== e.feature) needed.add(e.work);
    if (e.feature) needed.add(e.feature);
  }
  const info = new Map(await Promise.all([...needed].map(async (id) => [id, await lookupWork(id, api, now)] as const)));
  const buckets = entries.map((e): Bucket => {
    if (e.feature) {
      if (!e.work || e.work === e.feature) return { t: "own", f: e.feature };
      return info.get(e.work) ? { t: "task", f: e.feature, w: e.work } : { t: "other", w: e.work };
    }
    if (!e.work) return { t: "den" };
    const item = info.get(e.work);
    if (!item) return { t: "other", w: e.work };
    return item.partOf ? { t: "task", f: item.partOf, w: e.work } : { t: "own", f: e.work };
  });
  // A feature reached only through a task's partOf still needs its title.
  const missing = [...new Set(buckets.flatMap((b) => (b.t === "task" && !info.has(b.f) ? [b.f] : [])))];
  for (const [id, v] of await Promise.all(missing.map(async (id) => [id, await lookupWork(id, api, now)] as const))) info.set(id, v);
  return { buckets, info };
}

const treeApi = (work?: { endpoint?: string; token?: string }) => ({ endpoint: work?.endpoint || process.env.WORK_ENDPOINT, token: work?.token || process.env.WORK_TOKEN });

/** Observation counts per feature → task: pool entries are pending, archive entries of the last 7 days archived. */
export async function readMemoryTree(den: string, work?: { endpoint?: string; token?: string }, now: number = Date.now()): Promise<MemoryTree> {
  const { pending, archived } = await readTreeSources(den, now);
  const { buckets, info } = await bucketize([...pending, ...archived], treeApi(work), now);
  const features = new Map<string, MemoryTree["features"][number]>();
  const other = new Map<string, { id: string; pending: number; archived: number }>();
  let denPending = 0;
  const feature = (id: string) => {
    let f = features.get(id);
    if (!f) {
      const it = info.get(id);
      f = { id, title: it?.title ?? id, ...(it?.stage ? { stage: it.stage } : {}), own: { pending: 0, archived: 0 }, tasks: [] };
      features.set(id, f);
    }
    return f;
  };
  buckets.forEach((b, i) => {
    const key = i < pending.length ? "pending" : "archived";
    if (b.t === "den") denPending++;
    else if (b.t === "own") feature(b.f).own[key]++;
    else if (b.t === "other") {
      const o = other.get(b.w) ?? { id: b.w, pending: 0, archived: 0 };
      o[key]++;
      other.set(b.w, o);
    } else {
      const f = feature(b.f);
      let t = f.tasks.find((x) => x.id === b.w);
      if (!t) {
        const it = info.get(b.w);
        t = { id: b.w, title: it?.title ?? b.w, ...(it?.stage ? { stage: it.stage } : {}), pending: 0, archived: 0 };
        f.tasks.push(t);
      }
      t[key]++;
    }
  });
  return { features: [...features.values()], other: [...other.values()], den: { pending: denPending } };
}

/**
 * The observations funnelling into one node: `den` (untagged pool), a feature (its own, not its tasks'), a task,
 * or an unresolved item. Archived: last 7 days, newest first, at most `limit`.
 */
export async function readMemoryNode(den: string, id: string, work?: { endpoint?: string; token?: string }, limit: number = NODE_ARCHIVED_DEFAULT_LIMIT, now: number = Date.now()): Promise<MemoryNodeObservations> {
  const { pending, archived } = await readTreeSources(den, now);
  const { buckets } = await bucketize([...pending, ...archived], treeApi(work), now);
  const mine = (b: Bucket) => (id === "den" ? b.t === "den" : b.t === "own" ? b.f === id : b.t === "task" ? b.w === id : b.t === "other" && b.w === id);
  const p = pending.filter((_, i) => mine(buckets[i]!));
  const a = archived.filter((_, i) => mine(buckets[pending.length + i]!)).sort((x, y) => y.atMs - x.atMs);
  return {
    id,
    pending: p.map((o) => ({ id: o.id, content: o.content, ...(o.recordedAt ? { recordedAt: o.recordedAt } : {}) })),
    archived: a.slice(0, limit).map((o) => ({ id: o.id, content: o.content, at: o.at, outcome: o.outcome, target: o.target })),
    truncated: a.length > limit,
  };
}
