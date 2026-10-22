/**
 * binding — how an agent is bound to the work item it is working on.
 *
 * The bound item decides where what the session learns goes: tagged
 * observations feed the item's Record (the feature's, when it has one), and
 * unbound ones go to den topics. These helpers are the pure part of that
 * contract, shared by both runtimes: the rules text, the unbound notice, the
 * auto-bind decision, the status label and the heads-up on a mismatch.
 */
import type { WorkItem } from "@wolfpack/kb/client";

/** Added to the context when nothing is bound. */
export const UNBOUND_CONTEXT =
  "No work item bound: what you learn now goes to den topics, not to a work item. Bind the item you're working on (task_bind).";

/** The binding rules, for the orchestrator's rules text. */
export const BINDING_RULES = [
  "Work item binding:",
  "- Bind (task_bind) the item you are working on BEFORE you start: it decides where what you learn is kept.",
  "- One bound item per session. Rebind (task_bind) when you switch to another item.",
  "- When you delegate work on an item to a subagent, pass workItem: its report is then kept in that item's Record.",
].join("\n");

/** An item that can be worked on directly (a workspace such as a feature cannot be bound). */
const BINDABLE = ["task", "issue", "spike"];

export interface AutoBindInput {
  kind: string;
  assignee?: string;
  wolf: string;
  /** Something is bound right now. */
  bound: boolean;
  /** The caller's explicit choice, when given. */
  bind?: boolean;
}

/**
 * Whether a freshly created item gets bound. Explicit `bind` wins (for items
 * that can be bound). Default: only a task/issue/spike assigned to this wolf,
 * and only when nothing is bound yet.
 */
export function shouldBindOnCreate(i: AutoBindInput): boolean {
  if (!BINDABLE.includes(i.kind)) return false;
  if (i.bind !== undefined) return i.bind;
  return !i.bound && i.assignee === i.wolf;
}

/** Why a created item was not bound, for the tool reply. */
export function notBoundReason(i: AutoBindInput): string {
  if (!BINDABLE.includes(i.kind)) return `${i.kind}s are workspaces and cannot be bound`;
  if (i.bind === false) return "bind was false";
  if (i.bound) return "another item is already bound (task_bind it if you are switching)";
  if (i.assignee !== i.wolf) return `it is assigned to ${i.assignee}, not to you`;
  return "not requested";
}

/** The status-bar label: `⛓ <short title>` or `⛓ unbound`. */
export function bindingLabel(title: string | null | undefined, max = 28): string {
  const t = title?.trim();
  if (!t) return "⛓ unbound";
  return `⛓ ${t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t}`;
}

interface Ref {
  id: string;
  title?: string;
}

const show = (r: Ref) => (r.title ? `"${r.title}" (${r.id})` : r.id);

/**
 * The line to end a tool reply with when the agent acted on an item that is
 * not the bound one; "" when it is the bound one.
 */
export function headsUp(working: Ref, bound: Ref | null | undefined): string {
  if (bound && bound.id === working.id) return "";
  return `Heads-up: you're working on ${show(working)} but the bound item is ${bound ? show(bound) : "nothing"}. Call task_bind ${working.id} if you're switching.`;
}

/** Append the heads-up to a reply (when there is one). */
export function withHeadsUp(text: string, working: Ref, bound: Ref | null | undefined): string {
  const h = headsUp(working, bound);
  return h ? `${text}\n${h}` : text;
}

/**
 * The feature id to bind with: the item's parent when it is a real feature
 * (not the Inbox container); undefined otherwise. Observations carry it so
 * the Record is kept per feature.
 */
export async function recordFeatureId(
  client: { get(id: string): Promise<Pick<WorkItem, "kind" | "container" | "id">> },
  item: { partOf?: string | null },
): Promise<string | undefined> {
  if (!item.partOf) return undefined;
  try {
    const parent = await client.get(item.partOf);
    return parent.kind === "feature" && !parent.container ? (parent.id as string) : undefined;
  } catch {
    return undefined;
  }
}
