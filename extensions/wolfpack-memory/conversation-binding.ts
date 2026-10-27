/**
 * Per-conversation binding. Pi's layout and shape, in the den's factory area:
 *   <den>/factory/conversations/<cid>/active-task.json  {workId, domain, boundAt, featureId?}
 *
 * A binding is stored at the LINEAGE ROOT. A user fork resolves through its lineageRoot, so it shares its lineage's
 * binding. A task-owned conversation (subagent) resolves through its owner's lineage and is read-only: it sees the
 * binding but never writes it. Always read from disk, never cached.
 */
import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { bindingFile, findHolder, readBindingFile, writeBindingFile, type StoredBinding } from "@wolfpack/memory";
export { bindingFile, findHolder, readBindingFile, writeBindingFile, type StoredBinding };
import type { ConversationClass, ConversationReads } from "@wolfpack/harness/extension";

/** What binding code needs from a tool / hook / section context. */
export interface BindingScope {
  wolfDen: string;
  conversationId: number;
  conversation?: Pick<ConversationReads, "classify" | "classifyOther">;
}

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

/** The binding for this conversation (through its lineage), read fresh. Null when unbound. */
export async function readConversationBinding(scope: BindingScope): Promise<{ binding: StoredBinding | null; root: number; readOnly: boolean }> {
  const { root, readOnly } = await resolveBindingRoot(scope);
  migrateLegacyBinding(scope.wolfDen, root);
  return { binding: readBindingFile(scope.wolfDen, root), root, readOnly };
}

export const heldMessage = (holder: number) => `bound in thread ${holder} (release it there with task_unbind)`;

/** The store's reserved root conversation: wolfd's home thread. */
export const HOME_CONVERSATION_ID = 1;

/**
 * The durable runtime used to keep one per-wolf `<den>/tasks/active.json` ({taskId,...}). Migrate it once to the root
 * lineage root of the first conversation that looks (`root`) in the new shape, then rename it to
 * `active.json.migrated` (kept, never re-read). If that root already has a binding the legacy one is dropped, logged.
 */
export function migrateLegacyBinding(den: string, root: number): void {
  // Only the home conversation (the store's reserved root): a feature thread is also a root, but never inherits it.
  if (root !== HOME_CONVERSATION_ID) return;
  const legacy = join(den, "tasks", "active.json");
  if (!existsSync(legacy)) return;
  try {
    const old = JSON.parse(readFileSync(legacy, "utf-8")) as { taskId?: string; domain?: string; boundAt?: string; featureId?: string } | null;
    if (old?.taskId && readBindingFile(den, root)) {
      console.warn(`[memory] legacy binding ${old.taskId} dropped: conversation ${root} already has a binding (kept in ${legacy}.migrated)`);
    } else if (old?.taskId) {
      writeBindingFile(den, root, {
        workId: old.taskId,
        domain: old.domain ?? "",
        boundAt: old.boundAt ?? new Date().toISOString(),
        ...(old.featureId ? { featureId: old.featureId } : {}),
      });
    }
    renameSync(legacy, `${legacy}.migrated`);
  } catch { /* unreadable legacy file: leave it */ }
}
