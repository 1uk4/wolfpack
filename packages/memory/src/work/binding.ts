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
  "- You unbind (task_unbind) when you stop working on the item. Completing it (shipping a task, graduating a feature) unbinds you automatically and says so; after that, new work needs a new or different item (task_create or task_bind), never the completed one.",
  "- When a subagent finishes, relay the decisions and findings that matter to the user in your own words; the raw report is not kept in memory.",
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

/**
 * A queue that runs async jobs one at a time. The create-then-bind decision
 * must not interleave: tool calls issued together would each see "nothing
 * bound" and each bind.
 */
export function createSerial(): <T>(job: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (job) => {
    const run = tail.then(job, job);
    tail = run.catch(() => {});
    return run;
  };
}

/** Why a created item was not bound, for the tool reply. */
export function notBoundReason(i: AutoBindInput): string {
  if (!BINDABLE.includes(i.kind)) return `${i.kind}s are workspaces and cannot be bound`;
  if (i.bind === false) return "bind was false";
  if (i.bound) return "another item is already bound (task_bind it if you are switching)";
  if (i.assignee !== i.wolf) return `it is assigned to ${i.assignee}, not to you`;
  return "not requested";
}

/**
 * The status-bar label: `⛓ <short title>` or `⛓ unbound`; `⛓ <title> · ready to
 * graduate` when the bound item is a finished feature (or a finished loose task).
 */
export function bindingLabel(title: string | null | undefined, max = 28, ready = false): string {
  const t = title?.trim();
  if (!t) return "⛓ unbound";
  return `⛓ ${t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t}${ready ? " · ready to graduate" : ""}`;
}

/**
 * What is said while the session stays bound to a FINISHED feature (its last
 * task shipped) or a finished loose task: it is ready to graduate, and talk
 * about it still goes to its Record. Shared by both runtimes' context.
 */
export function readyBoundContext(item: { title: string; kind: string }): string {
  const done = item.kind === "feature" ? "all tasks done" : "shipped";
  return `Bound to ${item.title} — ${done}, ready to graduate (press g / task_graduate). Follow-up discussion goes to its Record.`;
}

/** The line a task_done reply ends with when it leaves the session bound to the finished item. */
export function readyBoundReply(item: { title: string; kind: string }): string {
  return `Bound to ${item.title} (${item.kind === "feature" ? "all tasks done" : "shipped"} — ready to graduate)`;
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

/** The tool result line for a completed item. */
export const completeLine = (title: string, id: string) => `${title} (${id}) is complete; you are no longer bound to it.`;

/** Shown once in the next prompt of a conversation unbound because its item completed. */
export const unboundCompleteNotice = (title: string) =>
  `Your previous work item ${title} is complete and you are unbound. Don't add work to it; new work needs a new or different item (task_create or task_bind).`;
