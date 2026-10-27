/**
 * Feature threads on disk: the thread registry (`<den>/wolfd/threads.json`, so wolfd re-attaches them after a restart)
 * and the binding of a feature thread's conversation to its feature. The binding is the memory extension's own file
 * (`<den>/factory/conversations/<cid>/active-task.json`, same shape as its bindToFeature: workId = featureId), written
 * here because the thread is created by the server, not by a model's task_bind.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findHolder, writeBindingFile } from "@wolfpack/memory";
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

/**
 * The saved threads. A missing file is an empty registry; one that cannot be read or parsed is moved aside to
 * `threads.json.corrupt-<ts>` (reported through `onError`) so a later save cannot overwrite what it held.
 */
export function loadThreads(den: string, onError?: (e: unknown) => void): SavedThread[] {
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
    const parsed = JSON.parse(raw) as { threads?: SavedThread[] };
    if (!parsed || !Array.isArray(parsed.threads)) throw new Error("threads.json has no threads array");
    return parsed.threads.filter((t) => t && t.kind === "feature" && typeof t.id === "string" && typeof t.conversationId === "string" && typeof t.workItemId === "string");
  } catch (e) {
    quarantine(file, e, onError);
    return [];
  }
}

function quarantine(file: string, cause: unknown, onError?: (e: unknown) => void): void {
  const aside = `${file}.corrupt-${Date.now()}`;
  try {
    renameSync(file, aside);
  } catch {
    // Cannot move it: refuse to carry on and overwrite it later.
    throw new Error(`thread registry ${file} is unreadable and cannot be moved aside: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  onError?.(new Error(`thread registry ${file} was unreadable (${cause instanceof Error ? cause.message : String(cause)}); moved to ${aside}`));
}

function writeThreads(den: string, threads: SavedThread[]): void {
  mkdirSync(join(den, "wolfd"), { recursive: true });
  const tmp = `${registryFile(den)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ threads }, null, 2));
  renameSync(tmp, registryFile(den));
}

export function saveThread(den: string, thread: SavedThread, onError?: (e: unknown) => void): void {
  writeThreads(den, [...loadThreads(den, onError).filter((t) => t.id !== thread.id), thread]);
}

export function removeThread(den: string, id: string, onError?: (e: unknown) => void): void {
  writeThreads(den, loadThreads(den, onError).filter((t) => t.id !== id));
}

/** Bind a conversation to a feature the way the memory extension's bindToFeature does (workId = featureId). */
export function bindFeature(den: string, conversationId: string, b: { workId: string; domain: string }): void {
  writeBindingFile(den, Number(conversationId), { workId: b.workId, domain: b.domain, boundAt: new Date().toISOString(), featureId: b.workId });
}

/** Release a conversation's binding (rollback, or a stale holder's takeover). */
export function unbindConversation(den: string, conversationId: number): void {
  writeBindingFile(den, conversationId, null);
}

/** Another conversation on this den that is bound to `workId`, or undefined. */
export function findBindingHolder(den: string, workId: string): number | undefined {
  return findHolder(den, workId);
}

/** The feature's title and domain: from the Work API when configured, else from the id (`work-<domain>-<hash>`). */
export async function featureInfo(workItemId: string, work: { endpoint?: string; token?: string }): Promise<{ title: string; domain: string }> {
  const r = await fetchWorkItem(workItemId, work);
  const fromId = /^work-([^-]+)-/.exec(workItemId)?.[1] ?? "";
  if (r.kind === "ok") return { title: r.item.title || workItemId, domain: r.item.domain || fromId };
  return { title: workItemId, domain: fromId };
}
