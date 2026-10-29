/**
 * Feature threads on disk: the thread registry (`<den>/wolfd/threads.json`, so wolfd re-attaches them after a restart)
 * and the binding of a feature thread's conversation to its feature. The binding is the memory extension's own file
 * (`<den>/factory/conversations/<cid>/active-task.json`, same shape as its bindToFeature: workId = featureId), written
 * here because the thread is created by the server, not by a model's task_bind.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findHolder, writeBindingFile } from "@wolfpack/memory";
import { DEFAULT_THREAD_SETTINGS, ThreadSettingsSchema, type ThreadSettings } from "@wolfpack/protocol";
import type { Workspace } from "@wolfpack/workspaces";
import { fetchWorkItem } from "./memory-read.js";

export interface SavedThread {
  id: string;
  conversationId: string;
  kind: "feature";
  workItemId: string;
  title: string;
  /** Set once the feature graduated: the thread is read-only history. */
  closedReason?: string;
  /** The feature branch's worktree, set on the first worktree spawn; the thread's cwd lives there from then on. */
  workspace?: Workspace;
  /** Header git tree: the branch the feature branch was cut from, recorded when the workspace was created. */
  workspaceBase?: string;
  /** Composer settings (model tier, auto-ship). Absent = the defaults (main, off). */
  tier?: ThreadSettings["tier"];
  autoShip?: boolean;
}

/** A saved thread's settings, defaults filled in (an invalid stored tier reads as main). */
export function settingsOfSaved(t: Pick<SavedThread, "tier" | "autoShip">): ThreadSettings {
  const r = ThreadSettingsSchema.safeParse({ tier: t.tier ?? DEFAULT_THREAD_SETTINGS.tier, autoShip: t.autoShip === true });
  return r.success ? r.data : { ...DEFAULT_THREAD_SETTINGS, autoShip: t.autoShip === true };
}

/** The home thread has no registry entry: its settings live in `<den>/wolfd/home-settings.json`. */
const homeSettingsFile = (den: string) => join(den, "wolfd", "home-settings.json");

export function loadHomeSettings(den: string): ThreadSettings {
  try {
    const raw = JSON.parse(readFileSync(homeSettingsFile(den), "utf8")) as { tier?: unknown; autoShip?: unknown } | null;
    return settingsOfSaved({ tier: raw?.tier as ThreadSettings["tier"], autoShip: raw?.autoShip === true });
  } catch {
    return { ...DEFAULT_THREAD_SETTINGS };
  }
}

export function saveHomeSettings(den: string, settings: ThreadSettings): void {
  mkdirSync(join(den, "wolfd"), { recursive: true });
  const file = homeSettingsFile(den);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2));
  renameSync(tmp, file);
}

/** Record a saved feature thread's settings (no-op when the thread is not saved). Returns whether it was saved. */
export function setThreadSettings(den: string, id: string, settings: ThreadSettings, onError?: (e: unknown) => void): boolean {
  const threads = loadThreads(den, onError);
  if (!threads.some((t) => t.id === id)) return false;
  writeThreads(den, threads.map((t) => (t.id === id ? { ...t, tier: settings.tier, autoShip: settings.autoShip } : t)));
  return true;
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

export function quarantine(file: string, cause: unknown, onError?: (e: unknown) => void): void {
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

/** Record (or, with undefined, drop) the feature workspace of a saved thread (no-op when the thread is not saved). */
export function setThreadWorkspace(den: string, id: string, workspace: Workspace | undefined, onError?: (e: unknown) => void, base?: string): void {
  const threads = loadThreads(den, onError);
  if (!threads.some((t) => t.id === id)) return;
  writeThreads(den, threads.map((t) => {
    if (t.id !== id) return t;
    const { workspace: _drop, workspaceBase: _dropBase, ...rest } = t;
    return workspace ? { ...rest, workspace, ...(base ? { workspaceBase: base } : {}) } : rest;
  }));
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
export function findBindingHolder(den: string, workId: string, exceptRoot?: number): number | undefined {
  return findHolder(den, workId, exceptRoot);
}

/** The feature's title and domain: from the Work API when configured, else from the id (`work-<domain>-<hash>`). */
export async function featureInfo(workItemId: string, work: { endpoint?: string; token?: string }): Promise<{ title: string; domain: string }> {
  const r = await fetchWorkItem(workItemId, work);
  const fromId = /^work-([^-]+)-/.exec(workItemId)?.[1] ?? "";
  if (r.kind === "ok") return { title: r.item.title || workItemId, domain: r.item.domain || fromId };
  return { title: workItemId, domain: fromId };
}
