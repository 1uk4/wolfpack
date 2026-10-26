/**
 * Per-conversation binding. Pi's layout and shape, in the den's factory area:
 *   <den>/factory/conversations/<cid>/active-task.json  {workId, domain, boundAt, featureId?}
 *
 * A binding is stored at the LINEAGE ROOT. A user fork resolves through its lineageRoot, so it shares its lineage's
 * binding. A task-owned conversation (subagent) resolves through its owner's lineage and is read-only: it sees the
 * binding but never writes it. Always read from disk, never cached.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConversationClass, ConversationReads } from "@wolfpack/harness/extension";

export interface StoredBinding {
  workId: string;
  domain: string;
  boundAt: string;
  featureId?: string;
}

/** What binding code needs from a tool / hook / section context. */
export interface BindingScope {
  wolfDen: string;
  conversationId: number;
  conversation?: Pick<ConversationReads, "classify" | "classifyOther">;
}

const conversationsDir = (den: string) => join(den, "factory", "conversations");
export const bindingFile = (den: string, cid: number) => join(conversationsDir(den), String(cid), "active-task.json");

/** Where this conversation's binding lives, and whether it may write it. */
export async function resolveBindingRoot(scope: BindingScope): Promise<{ root: number; readOnly: boolean }> {
  let cls: ConversationClass | undefined;
  try {
    cls = await scope.conversation?.classify();
  } catch { /* unknown: treat as a root */ }
  if (!cls || cls.kind === "root") return { root: scope.conversationId, readOnly: false };
  if (cls.kind === "fork") return { root: cls.lineageRoot, readOnly: false };
  // Task-owned: the owner's lineage, read-only.
  let owner = cls.ownerConversationId;
  for (let hops = 0; hops < 8; hops++) {
    const oc = await scope.conversation?.classifyOther?.(owner);
    if (!oc || oc.kind === "root") break;
    if (oc.kind === "fork") { owner = oc.lineageRoot; break; }
    owner = oc.ownerConversationId;
  }
  return { root: owner, readOnly: true };
}

export function readBindingFile(den: string, cid: number): StoredBinding | null {
  try {
    const parsed = JSON.parse(readFileSync(bindingFile(den, cid), "utf-8")) as StoredBinding | null;
    return parsed?.workId ? parsed : null;
  } catch {
    return null;
  }
}

/** The binding for this conversation (through its lineage), read fresh. Null when unbound. */
export async function readConversationBinding(scope: BindingScope): Promise<{ binding: StoredBinding | null; root: number; readOnly: boolean }> {
  migrateLegacyBinding(scope.wolfDen);
  const { root, readOnly } = await resolveBindingRoot(scope);
  return { binding: readBindingFile(scope.wolfDen, root), root, readOnly };
}

export function writeBindingFile(den: string, cid: number, b: StoredBinding | null): void {
  const file = bindingFile(den, cid);
  mkdirSync(join(conversationsDir(den), String(cid)), { recursive: true });
  writeFileSync(file, b ? JSON.stringify(b, null, 2) : "null");
}

/** Another lineage root on this wolf that holds `workId`, or undefined. */
export function findHolder(den: string, workId: string, exceptRoot: number): number | undefined {
  let dirs: string[] = [];
  try { dirs = readdirSync(conversationsDir(den)); } catch { return undefined; }
  for (const d of dirs) {
    const cid = Number(d);
    if (!Number.isInteger(cid) || cid === exceptRoot) continue;
    if (readBindingFile(den, cid)?.workId === workId) return cid;
  }
  return undefined;
}

export const heldMessage = (holder: number) => `bound in thread ${holder}`;

/**
 * The durable runtime used to keep one per-wolf `<den>/tasks/active.json` ({taskId,...}). Migrate it once to the root
 * conversation (cid 1) in the new shape, then rename it to `active.json.migrated` (kept, never re-read).
 */
export function migrateLegacyBinding(den: string): void {
  const legacy = join(den, "tasks", "active.json");
  if (!existsSync(legacy)) return;
  try {
    const old = JSON.parse(readFileSync(legacy, "utf-8")) as { taskId?: string; domain?: string; boundAt?: string; featureId?: string } | null;
    if (old?.taskId && !readBindingFile(den, 1)) {
      writeBindingFile(den, 1, {
        workId: old.taskId,
        domain: old.domain ?? "",
        boundAt: old.boundAt ?? new Date().toISOString(),
        ...(old.featureId ? { featureId: old.featureId } : {}),
      });
    }
    renameSync(legacy, `${legacy}.migrated`);
  } catch { /* unreadable legacy file: leave it */ }
}
