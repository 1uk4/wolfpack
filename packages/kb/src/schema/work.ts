/**
 * work.ts — the TYPED CONTRACT for a Factory WorkItem (the KB's live-work layer).
 *
 * Sibling of knowledge.ts (the Library/Entry contract). Same philosophy:
 *   • Make illegal states unrepresentable — branded ids, enum stages, a
 *     discriminated event union. The compiler owns a WorkItem's shape.
 *   • Determinism at the core — stage transitions, links, and timestamps are
 *     code. Unlike an Entry, a WorkItem needs NO LLM to exist; it is
 *     human/agent-authored prose + typed state.
 *   • Event-sourced — a WorkItem's state is a pure `fold` over an append-only
 *     event log (work-events.jsonl, read and written by client/work-store.ts).
 *
 *   events (append-only JSONL)                 foldWork → live state
 *     work.created ─┐
 *     work.staged  ─┼──▶  reduce ───────────▶  Map<WorkId, WorkItem>
 *     work.noted   ─┘
 *
 * Two orthogonal axes (see docs/factory-design.md):
 *   • work tree  — `partOf` (initiative → feature → task)   [vertical decomposition]
 *   • area       — `area` field (marketing, analysis, …)    [horizontal grouping]
 * Both live inside one `domain` (the hard boundary + the KB propagation unit).
 */
import { z } from "zod";
import { Stage, WorkKind } from "@wolfpack/engine";
import { DomainId, EntryId, IsoDate, Slug } from "./knowledge.js";

// ════════════════════════════════════════════════════════════════════════════
// 1 · BRANDED PRIMITIVES
// ════════════════════════════════════════════════════════════════════════════

/** work-<domain>-<7 alphanumerics>. Mirrors EntryId; a plain string can never be
 *  used where a WorkId is required without going through the parser. */
export const WorkId = z
  .string()
  .regex(/^work-[a-z0-9]+-[0-9A-Za-z]{7}$/, "must be work-<domain>-<7id>")
  .brand<"WorkId">();
export type WorkId = z.infer<typeof WorkId>;

/** A wolf identity used as an assignee: 1uk4 | hal | dewey | <autonomous wolf>.
 *  Lower-kebab-ish; may start with a digit (e.g. "1uk4"). */
export const WolfId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, "must be a wolf id (lower-alnum, hyphens)")
  .brand<"WolfId">();
export type WolfId = z.infer<typeof WolfId>;

// ════════════════════════════════════════════════════════════════════════════
// 2 · THE WORKITEM  — projected (materialized) structured state
// ════════════════════════════════════════════════════════════════════════════

/** One activity-log entry (appended by work.noted events). */
export const WorkLogEntry = z.object({
  at: z.string(), // "YYYY-MM-DD HH:MM"
  text: z.string().min(1),
});
export type WorkLogEntry = z.infer<typeof WorkLogEntry>;

export const WorkItem = z.object({
  id: WorkId,
  nodeType: z.literal("work"),
  kind: WorkKind, // idea | initiative | feature | task | issue | spike
  domain: DomainId, // personal | snapjack | wolfpack …   (hard boundary)
  /** Horizontal grouping within the domain (marketing, analysis…). Inherits from
   *  the partOf parent at creation time; null for personal/light work. Becomes the
   *  entry's `subsystem` facet on graduation. */
  area: Slug.nullable().default(null),
  title: z.string().min(1).max(200),
  /** One-line summary (≤140 chars) for registry/index display. Auto-generated
   *  on graduation if not set. */
  summary: z.string().max(140).nullable().default(null),
  stage: Stage, // event-sourced lifecycle
  assignee: WolfId,
  /** The done-condition. Required for kind:"task" before it may leave `plan`
   *  (enforced in the ops layer, not the schema — see assertAdvanceable). */
  successCriteria: z.string().nullable().default(null),
  partOf: WorkId.nullable().default(null), // the work tree (null = root)
  references: z.array(EntryId).default([]), // work → Library context it used
  dependsOn: z.array(WorkId).default([]), // work → work
  blocks: z.array(WorkId).default([]), // work → work
  graduatedTo: z.array(EntryId).default([]), // entries born from this work
  /** A holding container (the per-domain Inbox): never ships or graduates. */
  container: z.boolean().default(false),
  log: z.array(WorkLogEntry).default([]),
  created: IsoDate,
  updated: IsoDate,
});
export type WorkItem = z.infer<typeof WorkItem>;

/** The freeform plan/notes prose lives in the markdown file body, NOT in the
 *  event-sourced projection above. The storage layer composes the two. */

// ════════════════════════════════════════════════════════════════════════════
// 3 · EVENT UNION  — the source of truth; state is a fold over these
// ════════════════════════════════════════════════════════════════════════════

export const LinkRel = z.enum(["references", "depends_on", "blocks", "graduated_to"]);
export type LinkRel = z.infer<typeof LinkRel>;

export const WorkEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("work.created"),
    id: WorkId,
    at: z.string(),
    kind: WorkKind,
    domain: DomainId,
    title: z.string().min(1).max(200),
    assignee: WolfId,
    area: Slug.nullable().default(null),
    partOf: WorkId.nullable().default(null),
    successCriteria: z.string().nullable().default(null),
    stage: Stage.default("plan"),
    container: z.boolean().default(false),
  }),
  /** Re-parent an item (validated against the hierarchy by moveWork). */
  z.object({ type: z.literal("work.moved"), id: WorkId, at: z.string(), partOf: WorkId.nullable() }),
  z.object({ type: z.literal("work.staged"), id: WorkId, at: z.string(), to: Stage }),
  z.object({ type: z.literal("work.assigned"), id: WorkId, at: z.string(), assignee: WolfId }),
  z.object({
    type: z.literal("work.criteria"),
    id: WorkId,
    at: z.string(),
    successCriteria: z.string().nullable(),
  }),
  z.object({ type: z.literal("work.area"), id: WorkId, at: z.string(), area: Slug.nullable() }),
  z.object({ type: z.literal("work.retitled"), id: WorkId, at: z.string(), title: z.string().min(1).max(200) }),
  z.object({ type: z.literal("work.deleted"), id: WorkId, at: z.string() }),
  z.object({ type: z.literal("work.noted"), id: WorkId, at: z.string(), text: z.string().min(1) }),
  z.object({ type: z.literal("work.linked"), id: WorkId, at: z.string(), rel: LinkRel, target: z.string() }),
  /** Remove a link added by work.linked. */
  z.object({ type: z.literal("work.unlinked"), id: WorkId, at: z.string(), rel: LinkRel, target: z.string() }),
  /** Wolf binds to this work item (starts active work session) */
  z.object({ type: z.literal("work.bound"), id: WorkId, at: z.string(), wolf: WolfId }),
  /** Wolf unbinds from this work item (ends active work session) */
  z.object({ type: z.literal("work.unbound"), id: WorkId, at: z.string(), wolf: WolfId }),
  /** Summary generated (typically on completion or graduation) */
  z.object({ type: z.literal("work.summarized"), id: WorkId, at: z.string(), summary: z.string().max(140) }),
]);
export type WorkEvent = z.infer<typeof WorkEvent>;

/** Parse one raw ledger line into a WorkEvent, or null to skip (forward-compat).
 *  Used by readWorkLedger. */
export function parseWorkEvent(raw: unknown): WorkEvent | null {
  const r = WorkEvent.safeParse(raw);
  return r.success ? r.data : null;
}

// ════════════════════════════════════════════════════════════════════════════
// 4 · THE FOLD  — pure projection: events → live WorkItems
// ════════════════════════════════════════════════════════════════════════════

/** Date (YYYY-MM-DD) from an event timestamp ("YYYY-MM-DD HH:MM"). */
const dateOf = (at: string): IsoDate => IsoDate.parse(at.slice(0, 10));

const pushUnique = <T>(arr: readonly T[], v: T): T[] => [...new Set([...arr, v])];

/**
 * Fold a full event sequence into the current state of every WorkItem it
 * describes. Pure: same events → same map. Events for an unknown id (no prior
 * work.created) are skipped, so a truncated/foreign log never throws.
 */
export function foldWork(events: WorkEvent[]): Map<WorkId, WorkItem> {
  const items = new Map<WorkId, WorkItem>();

  for (const e of events) {
    if (e.type === "work.created") {
      items.set(
        e.id,
        WorkItem.parse({
          id: e.id,
          nodeType: "work",
          kind: e.kind,
          domain: e.domain,
          area: e.area ?? null,
          title: e.title,
          summary: null,
          stage: e.stage ?? "plan",
          assignee: e.assignee,
          successCriteria: e.successCriteria ?? null,
          partOf: e.partOf ?? null,
          references: [],
          dependsOn: [],
          blocks: [],
          graduatedTo: [],
          container: e.container ?? false,
          log: [],
          created: dateOf(e.at),
          updated: dateOf(e.at),
        })
      );
      continue;
    }

    const cur = items.get(e.id);
    if (!cur) continue; // event for an unknown item — skip

    const next: WorkItem = { ...cur, updated: dateOf(e.at) };
    switch (e.type) {
      case "work.staged":
        next.stage = e.to;
        break;
      case "work.assigned":
        next.assignee = e.assignee;
        break;
      case "work.criteria":
        next.successCriteria = e.successCriteria;
        break;
      case "work.area":
        next.area = e.area;
        break;
      case "work.retitled":
        next.title = e.title;
        break;
      case "work.deleted":
        items.delete(e.id);
        continue;
      case "work.noted":
        next.log = [...cur.log, { at: e.at, text: e.text }];
        break;
      case "work.linked":
        switch (e.rel) {
          case "references":
            next.references = pushUnique(cur.references, EntryId.parse(e.target));
            break;
          case "graduated_to":
            next.graduatedTo = pushUnique(cur.graduatedTo, EntryId.parse(e.target));
            break;
          case "depends_on":
            next.dependsOn = pushUnique(cur.dependsOn, WorkId.parse(e.target));
            break;
          case "blocks":
            next.blocks = pushUnique(cur.blocks, WorkId.parse(e.target));
            break;
        }
        break;
      case "work.bound":
      case "work.unbound":
        // Informational events for work memory - no state change needed
        // The work memory system listens for these to track active sessions
        break;
      case "work.summarized":
        next.summary = e.summary;
        break;
      case "work.moved":
        next.partOf = e.partOf;
        break;
      case "work.unlinked": {
        const drop = <T>(arr: readonly T[]) => arr.filter((x) => (x as unknown as string) !== e.target);
        if (e.rel === "references") next.references = drop(cur.references);
        if (e.rel === "graduated_to") next.graduatedTo = drop(cur.graduatedTo);
        if (e.rel === "depends_on") next.dependsOn = drop(cur.dependsOn);
        if (e.rel === "blocks") next.blocks = drop(cur.blocks);
        break;
      }
    }
    items.set(e.id, next);
  }

  return items;
}

/** Project a single WorkItem from a full event sequence (null if never created). */
export function projectWork(events: WorkEvent[], id: WorkId): WorkItem | null {
  return foldWork(events).get(id) ?? null;
}

// ════════════════════════════════════════════════════════════════════════════
// 5 · RULES  — enforced in the ops layer, kept pure here
// ════════════════════════════════════════════════════════════════════════════

/** Stage order for linear advancement (dev path). Personal/light items simply
 *  use a subset; the machine is a superset. */
export const STAGE_ORDER = [
  "idea",
  "plan",
  "feasibility",
  "approved",
  "in_build",
  "shipped",
  "live",
  "archived",
] as const;

/** Stages at which a work item counts as done. */
export const COMPLETE_STAGES: readonly Stage[] = ["shipped", "live", "archived"];

/** True once a work item has shipped (or gone further). */
export function isComplete(item: Pick<WorkItem, "stage">): boolean {
  return COMPLETE_STAGES.includes(item.stage);
}

/**
 * Guard a stage transition. A `task` may not advance past `plan` without a
 * success criterion — every job must declare its done-condition. Returns an
 * error string, or null when the transition is allowed.
 */
export function assertAdvanceable(item: WorkItem, to: Stage): string | null {
  if (item.container && COMPLETE_STAGES.includes(to)) {
    return `${item.title} is a holding container and never ships`;
  }
  const past = (s: Stage) => STAGE_ORDER.indexOf(to) > STAGE_ORDER.indexOf(s);
  if (item.kind === "task" && past("plan") && !item.successCriteria?.trim()) {
    return `task ${item.id} needs a success_criteria before advancing past "plan"`;
  }
  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// 6 · HIERARCHY  — what may contain what, and what an agent may bind to
// ════════════════════════════════════════════════════════════════════════════
//
//   initiative            → contains only features         (parent: none)
//   feature               → contains task / issue / spike   (parent: initiative or none)
//   task · issue · spike  → bindable work units             (parent: a feature)
//   idea                  → standalone, not bindable

/** Kinds an agent session can bind to. Features and initiatives are workspaces. */
export const BINDABLE_KINDS: readonly WorkItem["kind"][] = ["task", "issue", "spike"];

export function isBindable(item: Pick<WorkItem, "kind">): boolean {
  return BINDABLE_KINDS.includes(item.kind);
}

/** Title of the per-domain holding container for strays. */
export const INBOX_TITLE = "Inbox";

type ParentLike = Pick<WorkItem, "id" | "kind" | "domain" | "title" | "container">;

/** "a task", "an initiative". */
const an = (word: string) => (/^[aeiou]/.test(word) ? `an ${word}` : `a ${word}`);

/**
 * Why `kind` may not sit under `parent` (null = no parent), or null if it may.
 * Pure: the ops layer enforces it on create and move.
 */
export function placementError(
  child: Pick<WorkItem, "kind" | "domain"> & { container?: boolean },
  parent: ParentLike | null
): string | null {
  if (parent && parent.domain !== child.domain) {
    return `${parent.title} is in domain ${parent.domain}, not ${child.domain}`;
  }
  switch (child.kind) {
    case "initiative":
    case "idea":
      return parent ? `${an(child.kind)} cannot have a parent` : null;
    case "feature":
      if (child.container && parent) return "the Inbox cannot have a parent";
      if (!parent || parent.kind === "initiative") return null;
      return `a feature can only sit under an initiative (not ${an(parent.kind)})`;
    case "task":
    case "issue":
    case "spike":
      if (!parent) return `${an(child.kind)} needs a feature (or the Inbox) as its parent`;
      if (parent.kind === "feature") return null;
      return `${an(child.kind)} can only sit under a feature (not ${an(parent.kind)})`;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 7 · DEPENDENCIES  — same-scope only, acyclic
// ════════════════════════════════════════════════════════════════════════════
//
//   task · issue · spike → a work unit in the SAME feature
//   feature              → a feature under the SAME initiative (standalone: none)
//   initiative · idea    → none          never across initiatives, never cyclic

type DepNode = Pick<WorkItem, "id" | "kind" | "partOf" | "title" | "dependsOn">;

/** Why `item` may not depend on `target`, or null if it may. */
export function dependencyError(item: DepNode, target: DepNode, all: DepNode[]): string | null {
  if (item.id === target.id) return "an item cannot depend on itself";
  if (isBindable(item)) {
    if (!isBindable(target)) return `a ${item.kind} can only depend on a task, issue or spike`;
    if (!item.partOf || item.partOf !== target.partOf) return "tasks can only depend on tasks in the same feature";
  } else if (item.kind === "feature") {
    if (target.kind !== "feature") return "a feature can only depend on another feature";
    if (!item.partOf || item.partOf !== target.partOf) return "features can only depend on features under the same initiative";
  } else {
    return `${an(item.kind)} cannot have dependencies`;
  }
  // Cycle: does target already (transitively) depend on item?
  const byId = new Map(all.map((n) => [n.id as string, n]));
  const seen = new Set<string>();
  const stack = [target.id as string];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === item.id) return `"${target.title}" already depends on "${item.title}" (that would be a cycle)`;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const d of byId.get(cur)?.dependsOn ?? []) stack.push(d as string);
  }
  return null;
}
