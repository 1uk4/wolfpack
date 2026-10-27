/**
 * Feature threads on disk: the thread registry (`<den>/wolfd/threads.json`, so wolfd re-attaches them after a restart)
 * and the binding of a feature thread's conversation to its feature. The binding is the memory extension's own file
 * (`<den>/factory/conversations/<cid>/active-task.json`, same shape as its bindToFeature: workId = featureId), written
 * here because the thread is created by the server, not by a model's task_bind.
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchWorkItem } from "./memory-read.js";

export interface SavedThread {
  id: string;
  conversationId: string;
  kind: "feature";
  workItemId: string;
  title: string;
}

const registryFile = (den: string) => join(den, "wolfd", "threads.json");

export const featureThreadId = (wolf: string, workItemId: string): string => `${wolf}/feature-${workItemId}`;

export function loadThreads(den: string): SavedThread[] {
  try {
    const parsed = JSON.parse(readFileSync(registryFile(den), "utf8")) as { threads?: SavedThread[] };
    return (parsed.threads ?? []).filter((t) => t && t.kind === "feature" && typeof t.id === "string" && typeof t.conversationId === "string" && typeof t.workItemId === "string");
  } catch {
    return [];
  }
}

export function saveThread(den: string, thread: SavedThread): void {
  const threads = loadThreads(den).filter((t) => t.id !== thread.id);
  threads.push(thread);
  mkdirSync(join(den, "wolfd"), { recursive: true });
  const tmp = `${registryFile(den)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ threads }, null, 2));
  renameSync(tmp, registryFile(den));
}

const bindingFile = (den: string, cid: string) => join(den, "factory", "conversations", cid, "active-task.json");

/** Bind a conversation to a feature the way the memory extension's bindToFeature does. */
export function bindFeature(den: string, conversationId: string, b: { workId: string; domain: string }): void {
  mkdirSync(join(den, "factory", "conversations", conversationId), { recursive: true });
  const file = bindingFile(den, conversationId);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ workId: b.workId, domain: b.domain, boundAt: new Date().toISOString(), featureId: b.workId }, null, 2));
  renameSync(tmp, file);
}

/** Another conversation on this den that is bound to `workId`, or undefined. */
export function findBindingHolder(den: string, workId: string): string | undefined {
  let dirs: string[] = [];
  try {
    dirs = readdirSync(join(den, "factory", "conversations"));
  } catch {
    return undefined;
  }
  for (const cid of dirs) {
    try {
      if ((JSON.parse(readFileSync(bindingFile(den, cid), "utf8")) as { workId?: string } | null)?.workId === workId) return cid;
    } catch {
      /* no binding there */
    }
  }
  return undefined;
}

/** The feature's title and domain: from the Work API when configured, else from the id (`work-<domain>-<hash>`). */
export async function featureInfo(workItemId: string, work: { endpoint?: string; token?: string }): Promise<{ title: string; domain: string }> {
  const r = await fetchWorkItem(workItemId, work);
  const fromId = /^work-([^-]+)-/.exec(workItemId)?.[1] ?? "";
  if (r.kind === "ok") return { title: r.item.title || workItemId, domain: r.item.domain || fromId };
  return { title: workItemId, domain: fromId };
}
