/**
 * Per-conversation binding files, shared by the memory extension and wolfd:
 *   <den>/factory/conversations/<cid>/active-task.json  {workId, domain, boundAt, featureId?}
 * Pure file access; deciding WHICH conversation holds a binding (lineage, ownership) stays in the extension.
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface StoredBinding {
  workId: string;
  domain: string;
  boundAt: string;
  featureId?: string;
}

const conversationsDir = (den: string) => join(den, "factory", "conversations");
export const bindingFile = (den: string, cid: number) => join(conversationsDir(den), String(cid), "active-task.json");

export function readBindingFile(den: string, cid: number): StoredBinding | null {
  try {
    const parsed = JSON.parse(readFileSync(bindingFile(den, cid), "utf-8")) as StoredBinding | null;
    return parsed?.workId ? parsed : null;
  } catch {
    return null;
  }
}

export function writeBindingFile(den: string, cid: number, b: StoredBinding | null): void {
  const file = bindingFile(den, cid);
  mkdirSync(join(conversationsDir(den), String(cid)), { recursive: true });
  // Temp file + rename: a concurrent reader sees the old or the new binding, never a half-written one.
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, b ? JSON.stringify(b, null, 2) : "null");
    renameSync(tmp, file);
    if (b) clearUnboundNotice(den, cid); // bound again: the "your item is complete" notice is moot
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  }
}

/**
 * Per-conversation composer settings the extension reads on every call (wolfd writes them when the operator flips the
 * thread's auto-ship toggle, and again at boot from its own registry):
 *   <den>/factory/conversations/<cid>/thread-settings.json  {autoShip}
 * A missing or unreadable file means the defaults (auto-ship off).
 */
const threadSettingsFile = (den: string, cid: number) => join(conversationsDir(den), String(cid), "thread-settings.json");

export function readThreadAutoShip(den: string, cid: number): boolean {
  try {
    return (JSON.parse(readFileSync(threadSettingsFile(den, cid), "utf-8")) as { autoShip?: unknown } | null)?.autoShip === true;
  } catch {
    return false;
  }
}

export function writeThreadAutoShip(den: string, cid: number, autoShip: boolean): void {
  const file = threadSettingsFile(den, cid);
  mkdirSync(join(conversationsDir(den), String(cid)), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ autoShip }));
    renameSync(tmp, file);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  }
}

/** Another lineage root on this wolf that holds `workId`, or undefined. Only integer directory names count. */
export function findHolder(den: string, workId: string, exceptRoot?: number): number | undefined {
  let dirs: string[] = [];
  try { dirs = readdirSync(conversationsDir(den)); } catch { return undefined; }
  for (const d of dirs) {
    if (!/^\d+$/.test(d)) continue;
    const cid = Number(d);
    if (!Number.isSafeInteger(cid) || cid === exceptRoot) continue;
    if (readBindingFile(den, cid)?.workId === workId) return cid;
  }
  return undefined;
}

/** Left in the dir of a feature thread whose feature graduated (persistent; wolfd reads it to close the thread). */
const closedFile = (den: string, cid: number) => join(conversationsDir(den), String(cid), "feature-closed.json");
export function readFeatureClosed(den: string, cid: number): { workId: string; title: string; at: string } | null {
  try {
    const c = JSON.parse(readFileSync(closedFile(den, cid), "utf-8"));
    return c?.workId ? c : null;
  } catch {
    return null;
  }
}

/** Left on a conversation that was unbound because its item completed; the next prompt says it once. */
export interface UnboundNotice {
  workId: string;
  title: string;
  at: string;
}

const noticeFile = (den: string, cid: number) => join(conversationsDir(den), String(cid), "unbound-notice.json");

export function writeUnboundNotice(den: string, cid: number, n: UnboundNotice): void {
  mkdirSync(join(conversationsDir(den), String(cid)), { recursive: true });
  writeFileSync(noticeFile(den, cid), JSON.stringify(n));
}

/** The notice without removing it (the render that shows it removes it once it is produced). */
export function peekUnboundNotice(den: string, cid: number): UnboundNotice | null {
  try {
    const n = JSON.parse(readFileSync(noticeFile(den, cid), "utf-8")) as UnboundNotice;
    return n?.workId ? n : null;
  } catch {
    return null;
  }
}

export function clearUnboundNotice(den: string, cid: number): void {
  try { unlinkSync(noticeFile(den, cid)); } catch { /* none */ }
}

/** Read and remove the notice: it is shown once. */
export function takeUnboundNotice(den: string, cid: number): UnboundNotice | null {
  try {
    const n = JSON.parse(readFileSync(noticeFile(den, cid), "utf-8")) as UnboundNotice;
    clearUnboundNotice(den, cid);
    return n?.workId ? n : null;
  } catch {
    return null;
  }
}

/** A feature graduated: unbind every conversation bound to it or to one of its archived tasks (the caller included unless excepted). */
export function unbindOnGraduation(den: string, g: { id: string; title: string; archived: string[]; exceptRoot?: number }): number[] {
  return unbindCompleted(den, { workIds: g.archived, viaFeature: true, title: g.title, id: g.id, exceptRoot: g.exceptRoot });
}

/**
 * Unbind every conversation whose binding matches (`workIds` against its workId, and with `viaFeature` against its
 * featureId too), except `exceptRoot`, and leave each a notice. Returns the conversations unbound.
 */
export function unbindCompleted(
  den: string,
  done: { workIds: Iterable<string>; viaFeature?: boolean; title: string; id: string; exceptRoot?: number },
): number[] {
  const ids = new Set(done.workIds);
  const out: number[] = [];
  let dirs: string[] = [];
  try { dirs = readdirSync(conversationsDir(den)); } catch { return out; }
  for (const d of dirs) {
    if (!/^\d+$/.test(d)) continue;
    const cid = Number(d);
    if (!Number.isSafeInteger(cid) || cid === done.exceptRoot) continue;
    const b = readBindingFile(den, cid);
    if (!b || !(ids.has(b.workId) || (done.viaFeature && b.featureId && ids.has(b.featureId)))) continue;
    writeBindingFile(den, cid, null);
    writeUnboundNotice(den, cid, { workId: done.id, title: done.title, at: new Date().toISOString() });
    if (done.viaFeature && b.workId === done.id) writeFileSync(closedFile(den, cid), JSON.stringify({ workId: done.id, title: done.title, at: new Date().toISOString() }));
    out.push(cid);
  }
  return out;
}
