/**
 * Structured-object payloads, dependency-free on purpose: browser code imports this subpath
 * (`@wolfpack/protocol/objects`) without pulling in zod or the rest of the protocol. The wolf side validates a tool
 * call with the zod schemas in schemas.ts AND this parser; every consumer (wolfd history/events, the console) gates
 * `data` through `parseObjectData`, so they cannot disagree about what a valid object is.
 *
 * REV RULE (one definition, used by wolfd's live events and its history fold): rev = the number of successful,
 * completed calls of the object's tool with that objectId so far in the thread (1 for the first). A call that is
 * aborted, faulted, errored or fails validation counts for nothing.
 */

/** Object types this version knows. A new type adds its name here, a parser below and a schemas.ts entry. */
export const OBJECT_TYPES = [
  "decision",
  "checklist",
  "graph",
] as const;
export type KnownObjectType = (typeof OBJECT_TYPES)[number];

/** Tool name -> the object type it shows. */
export const OBJECT_TOOL_TYPES = {
  show_decision: "decision",
  show_checklist: "checklist",
  show_graph: "graph",
} as const satisfies Record<string, KnownObjectType>;
export type ObjectToolName = keyof typeof OBJECT_TOOL_TYPES;

export interface DecisionOption {
  id: string;
  label: string;
  detail?: string;
}
export interface DecisionData {
  title?: string;
  options: DecisionOption[];
  chosen: string;
  rationale: string;
}

export const CHECKLIST_STATES = ["todo", "doing", "done", "skipped"] as const;
export type ChecklistState = (typeof CHECKLIST_STATES)[number];
export interface ChecklistItem {
  id: string;
  label: string;
  state: ChecklistState;
  note?: string;
}
export interface ChecklistData {
  title?: string;
  items: ChecklistItem[];
}

const isStr = (v: unknown): v is string => typeof v === "string";

/** `data` of a decision, or undefined when it does not fit (also when `chosen` names no option). */
export function parseDecisionData(data: unknown): DecisionData | undefined {
  const d = data as Partial<DecisionData> | null | undefined;
  if (!d || typeof d !== "object" || !isStr(d.chosen) || !isStr(d.rationale) || !Array.isArray(d.options) || d.options.length === 0) return undefined;
  const options: DecisionOption[] = [];
  for (const o of d.options as Array<Partial<DecisionOption> | null>) {
    if (!o || !isStr(o.id) || o.id === "" || !isStr(o.label) || o.label === "") return undefined;
    if (o.detail !== undefined && !isStr(o.detail)) return undefined;
    options.push({ id: o.id, label: o.label, ...(isStr(o.detail) ? { detail: o.detail } : {}) });
  }
  if (d.title !== undefined && !isStr(d.title)) return undefined;
  if (!options.some((o) => o.id === d.chosen)) return undefined;
  return { ...(isStr(d.title) ? { title: d.title } : {}), options, chosen: d.chosen, rationale: d.rationale };
}

/** Node kinds the prompt names; the enum is open (any non-empty string is a kind). */
export const GRAPH_NODE_KINDS = ["step", "task", "milestone"] as const;
export const GRAPH_NODE_STATUSES = ["todo", "doing", "done", "blocked", "skipped"] as const;
/** Size caps, enforced by BOTH the tool's zod schema and parseGraphData (a chat card, not a diagramming tool). */
export const GRAPH_LIMITS = { nodes: 100, edges: 300, id: 64, label: 120, kind: 32, detail: 500 } as const;
export type GraphNodeStatus = (typeof GRAPH_NODE_STATUSES)[number];

export interface GraphNode {
  id: string;
  label: string;
  kind: string;
  status: GraphNodeStatus;
  detail?: string;
}
/** `from` depends on `to` (an edge means depends-on). */
export interface GraphEdge {
  from: string;
  to: string;
}
export interface GraphData {
  title?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Why a graph is invalid, or undefined when it is sound: size caps, unique ids, edges between known nodes, no self-loop, no duplicate edge, acyclic. */
export function graphProblem(nodes: ReadonlyArray<{ id: string }>, edges: ReadonlyArray<GraphEdge>): string | undefined {
  if (nodes.length > GRAPH_LIMITS.nodes) return `too many nodes (${nodes.length}; max ${GRAPH_LIMITS.nodes})`;
  if (edges.length > GRAPH_LIMITS.edges) return `too many edges (${edges.length}; max ${GRAPH_LIMITS.edges})`;
  const ids = new Set<string>();
  for (const n of nodes) {
    if (ids.has(n.id)) return `duplicate node id "${n.id}"`;
    ids.add(n.id);
  }
  const out = new Map<string, string[]>();
  const seenEdges = new Set<string>();
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) return `edge ${e.from} -> ${e.to} references an unknown node id`;
    if (e.from === e.to) return `edge ${e.from} -> ${e.to} is a self-loop`;
    const key = JSON.stringify([e.from, e.to]);
    if (seenEdges.has(key)) return `duplicate edge ${e.from} -> ${e.to}`;
    seenEdges.add(key);
    const l = out.get(e.from);
    if (l) l.push(e.to);
    else out.set(e.from, [e.to]);
  }
  // Kahn: whatever cannot be peeled off is on (or behind) a cycle.
  const indeg = new Map<string, number>([...ids].map((id) => [id, 0]));
  for (const e of edges) indeg.set(e.to, indeg.get(e.to)! + 1);
  const queue = [...ids].filter((id) => indeg.get(id) === 0);
  let seen = 0;
  while (queue.length) {
    const id = queue.pop()!;
    seen++;
    for (const t of out.get(id) ?? []) {
      const d = indeg.get(t)! - 1;
      indeg.set(t, d);
      if (d === 0) queue.push(t);
    }
  }
  if (seen === ids.size) return undefined;
  const stuck = [...ids].filter((id) => indeg.get(id)! > 0);
  const shown = stuck.slice(0, 8).join(", ") + (stuck.length > 8 ? ", …" : "");
  return `edges form a cycle (edges mean depends-on, so the graph must be acyclic); nodes on or behind the cycle: ${shown}`;
}

/** `data` of a graph, or undefined when it does not fit (also dangling edges, self-loops, cycles, duplicate ids). */
export function parseGraphData(data: unknown): GraphData | undefined {
  const d = data as Partial<GraphData> | null | undefined;
  if (!d || typeof d !== "object" || !Array.isArray(d.nodes) || d.nodes.length === 0 || !Array.isArray(d.edges)) return undefined;
  if (d.nodes.length > GRAPH_LIMITS.nodes || d.edges.length > GRAPH_LIMITS.edges) return undefined;
  if (d.title !== undefined && !isStr(d.title)) return undefined;
  const text = (v: unknown, max: number): v is string => isStr(v) && v.length >= 1 && v.length <= max;
  const nodes: GraphNode[] = [];
  for (const n of d.nodes as Array<Partial<GraphNode> | null>) {
    if (!n || typeof n !== "object" || !text(n.id, GRAPH_LIMITS.id) || !text(n.label, GRAPH_LIMITS.label) || !text(n.kind, GRAPH_LIMITS.kind)) return undefined;
    if (!isStr(n.status) || !(GRAPH_NODE_STATUSES as readonly string[]).includes(n.status)) return undefined;
    if (n.detail !== undefined && (!isStr(n.detail) || n.detail.length > GRAPH_LIMITS.detail)) return undefined;
    nodes.push({ id: n.id, label: n.label, kind: n.kind, status: n.status as GraphNodeStatus, ...(n.detail !== undefined ? { detail: n.detail } : {}) });
  }
  const edges: GraphEdge[] = [];
  for (const e of d.edges as Array<Partial<GraphEdge> | null>) {
    if (!e || typeof e !== "object" || !text(e.from, GRAPH_LIMITS.id) || !text(e.to, GRAPH_LIMITS.id)) return undefined;
    edges.push({ from: e.from, to: e.to });
  }
  if (graphProblem(nodes, edges) !== undefined) return undefined;
  return { ...(d.title !== undefined ? { title: d.title } : {}), nodes, edges };
}

/** `data` of a checklist, or undefined when it does not fit (no items, an empty/duplicate id, an unknown state). */
export function parseChecklistData(data: unknown): ChecklistData | undefined {
  const d = data as { title?: unknown; items?: unknown } | null | undefined;
  if (!d || typeof d !== "object" || !Array.isArray(d.items) || d.items.length === 0) return undefined;
  if (d.title !== undefined && !isStr(d.title)) return undefined;
  const items: ChecklistItem[] = [];
  const seen = new Set<string>();
  for (const i of d.items as Array<Partial<ChecklistItem> | null>) {
    if (!i || !isStr(i.id) || i.id === "" || seen.has(i.id) || !isStr(i.label) || i.label === "") return undefined;
    if (!(CHECKLIST_STATES as readonly unknown[]).includes(i.state)) return undefined;
    if (i.note !== undefined && !isStr(i.note)) return undefined;
    seen.add(i.id);
    items.push({ id: i.id, label: i.label, state: i.state as ChecklistState, ...(isStr(i.note) ? { note: i.note } : {}) });
  }
  return { ...(isStr(d.title) ? { title: d.title } : {}), items };
}

/**
 * Derived on render, never sent. Skipped items leave the total: done / (items - skipped), so a fully resolved list
 * reaches 100%. `total` is 0 when every item is skipped (callers must not divide by it).
 */
export function checklistProgress(data: ChecklistData): { done: number; total: number; skipped: number } {
  const skipped = data.items.filter((i) => i.state === "skipped").length;
  return { done: data.items.filter((i) => i.state === "done").length, total: data.items.length - skipped, skipped };
}

const PARSERS: Record<KnownObjectType, (data: unknown) => unknown> = {
  decision: parseDecisionData,
  checklist: parseChecklistData,
  graph: parseGraphData,
};

/** Validate `data` for a known type; undefined for an unknown type or invalid data (consumers skip the object). */
export function parseObjectData(type: "decision", data: unknown): DecisionData | undefined;
export function parseObjectData(type: "checklist", data: unknown): ChecklistData | undefined;
export function parseObjectData(type: "graph", data: unknown): GraphData | undefined;
export function parseObjectData(type: string, data: unknown): unknown;
export function parseObjectData(type: string, data: unknown): unknown {
  return Object.hasOwn(PARSERS, type) ? PARSERS[type as KnownObjectType](data) : undefined;
}
