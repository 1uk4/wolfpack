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
