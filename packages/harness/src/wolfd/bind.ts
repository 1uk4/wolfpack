/**
 * Bind a thread's conversation to a work item (POST /v1/threads/:id/bind): the console's counterpart of the agent's
 * `task_bind`. It writes the same per-conversation binding file (the memory extension reads it fresh on its next prompt,
 * so the agent learns of the change from the bound-item section), with the same shape: workId, domain, and the real
 * feature as `featureId` when the item has one. Pure of HTTP: it throws HttpError, the server maps it.
 */
import { readBindingFile, writeBindingFile } from "@wolfpack/memory";
import { HttpError } from "./http-error.js";
import { fetchWorkItem, isWorkId } from "./memory-read.js";
import { findBindingHolder, unbindConversation } from "./threads.js";

/** Items a conversation can work on directly (a feature is a workspace: only a feature thread may rebind to its own). */
const BINDABLE = ["task", "issue", "spike"];

export interface BindInput {
  den: string;
  work: { endpoint?: string; token?: string };
  /** The thread's conversation id (the binding directory). */
  conversationId: string;
  /** The feature a feature thread was opened for; its tasks are the only items it accepts. */
  threadFeature?: string;
  /** Conversation ids wolfd knows as live (home and the registered feature threads), to tell a holder from an orphan. */
  knownConversations: ReadonlySet<string>;
  workItemId: string;
}

export async function bindConversation(i: BindInput): Promise<{ previous?: string }> {
  if (!isWorkId(i.workItemId)) throw new HttpError("invalid_request", "malformed work item id");
  const r = await fetchWorkItem(i.workItemId, i.work);
  if (r.kind === "unconfigured") throw new HttpError("memory_unavailable", "this wolf has no Work API configured");
  if (r.kind === "not_found") throw new HttpError("not_found", `work item ${i.workItemId}`);
  if (r.kind === "error") throw new HttpError("engine_error", r.message);
  const item = r.item;
  const own = i.threadFeature === i.workItemId;
  if (!own && !BINDABLE.includes(item.kind ?? "")) throw new HttpError("invalid_request", `${i.workItemId} is ${item.kind ? `a ${item.kind}, a workspace` : "not bindable"}: bind one of its tasks`);
  if (item.stage === "archived" || item.graduated) throw new HttpError("invalid_request", `${i.workItemId} is archived or graduated and cannot be bound`);
  if (i.threadFeature && !own && item.partOf !== i.threadFeature) throw new HttpError("invalid_request", `${i.workItemId} is not a task of this thread's feature (${i.threadFeature})`);

  const cid = Number(i.conversationId);
  const holder = findBindingHolder(i.den, i.workItemId, cid);
  if (holder !== undefined) {
    if (i.knownConversations.has(String(holder))) throw new HttpError("invalid_request", `${i.workItemId} is already bound in conversation ${holder}; release it there first`);
    unbindConversation(i.den, holder); // an orphan (a crash mid-create): take over, as opening a feature thread does
  }

  // The Record lives on the parent when that is a real feature (not the Inbox container).
  let featureId: string | undefined = own ? i.workItemId : undefined;
  if (!own && item.partOf) {
    const parent = await fetchWorkItem(item.partOf, i.work);
    if (parent.kind === "ok" && parent.item.kind === "feature" && !parent.item.container) featureId = parent.item.id;
  }
  const previous = readBindingFile(i.den, cid)?.workId;
  writeBindingFile(i.den, cid, { workId: i.workItemId, domain: item.domain ?? "", boundAt: new Date().toISOString(), ...(featureId ? { featureId } : {}) });
  return previous && previous !== i.workItemId ? { previous } : {};
}
