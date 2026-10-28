/**
 * Work dependency routes: a pure model over a minimal work-node shape.
 *
 * `computeWorkRoute` builds the completion route for a target (task or
 * feature) from the dependsOn graph, layers it into ordered steps, and
 * `RouteCursor` walks those steps.
 */

export interface WorkNode {
  id: string;
  kind: string;
  stage: string;
  parent?: string | null;
  dependsOn?: readonly string[];
}

/** Synthetic id of the Factory root every route starts from. */
export const ROUTE_ROOT = "factory";

/**
 * Experiment switch. On: a route node with no in-route prerequisite enters
 * from its PARENT (task -> feature -> initiative -> Factory), and a feature
 * dependency G -> F runs G's terminal tasks -> F node -> F's entry tasks.
 * Off: the original behaviour (Factory -> first step directly).
 */
export const ROUTE_ENTRY_VIA_PARENT = true;

export interface RouteOptions {
  entryViaParent?: boolean;
}

export interface RouteEdge {
  from: string;
  to: string;
  /** Derived from a feature-level dependency (terminal task -> entry task). */
  implicit: boolean;
  /** Edge from the Factory root to a route entry. */
  root: boolean;
  /** Hierarchy entry: parent -> child that has no in-route prerequisite. */
  entry?: true;
}

export interface RouteStep {
  index: number;
  nodes: string[];
  parallel: boolean;
}

export interface WorkRoute {
  target: string;
  root: string;
  steps: RouteStep[];
  edges: RouteEdge[];
  /** Steps with more than one node, as node-id groups. */
  parallelGroups: string[][];
  done: Record<string, boolean>;
  blocked: Record<string, boolean>;
  /** Index of the first step with an unfinished node, or null when all are done. */
  firstUnfinished: number | null;
  warnings: string[];
}

const isDoneStage = (stage: string) => stage === "shipped" || stage === "archived";

export function computeWorkRoute(
  nodes: readonly WorkNode[], targetId: string, opts: RouteOptions = {},
): WorkRoute {
  const viaParent = opts.entryViaParent ?? ROUTE_ENTRY_VIA_PARENT;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const empty = (): WorkRoute => ({
    target: targetId, root: ROUTE_ROOT, steps: [], edges: [], parallelGroups: [],
    done: {}, blocked: {}, firstUnfinished: null, warnings: [],
  });
  const target = byId.get(targetId);
  if (!target) return empty();

  const tasksOf = new Map<string, string[]>();
  for (const n of nodes) {
    if (n.kind === "feature") tasksOf.set(n.id, []);
  }
  for (const n of nodes) {
    if (n.kind !== "feature" && n.parent && tasksOf.has(n.parent)) tasksOf.get(n.parent)!.push(n.id);
  }
  for (const list of tasksOf.values()) list.sort();

  // Edges keyed "from\0to"; explicit task edges win over implicit ones.
  const edgeMap = new Map<string, RouteEdge>();
  const addEdge = (from: string, to: string, implicit: boolean) => {
    if (from === to) return;
    const key = `${from}\0${to}`;
    const prev = edgeMap.get(key);
    if (!prev) edgeMap.set(key, { from, to, implicit, root: false });
    else if (!implicit) prev.implicit = false;
  };

  const tasksIn = (f: string) => tasksOf.get(f) ?? [];
  const innerDeps = (t: string) => (byId.get(t)?.dependsOn ?? []).filter((d) => byId.get(d)?.parent === byId.get(t)?.parent && byId.has(d));
  // Entry tasks have no prerequisites inside the feature; terminals have no dependents inside it.
  const entries = (x: string): string[] => {
    const tasks = tasksIn(x);
    if (!tasks.length) return [x];
    return tasks.filter((t) => !innerDeps(t).some((d) => tasks.includes(d)));
  };
  const terminals = (x: string): string[] => {
    const tasks = tasksIn(x);
    if (!tasks.length) return [x];
    return tasks.filter((t) => !tasks.some((o) => o !== t && innerDeps(o).includes(t)));
  };
  const isFeatureWithTasks = (x: string) => byId.get(x)?.kind === "feature" && tasksIn(x).length > 0;
  const exits = (x: string) => (isFeatureWithTasks(x) ? terminals(x) : [x]);
  const entrances = (x: string) => (isFeatureWithTasks(x) ? entries(x) : [x]);

  // A feature target ends at the feature node after all its own tasks.
  const targetIsFeatureNode = isFeatureWithTasks(targetId);

  for (const n of nodes) {
    // The target feature node ends the route, so it cannot also gate its own tasks.
    const viaNode = viaParent && isFeatureWithTasks(n.id) && n.id !== targetId;
    let gated = false;
    for (const d of n.dependsOn ?? []) {
      if (!byId.has(d)) continue;
      const implicit = isFeatureWithTasks(d) || isFeatureWithTasks(n.id);
      if (viaNode) {
        for (const from of exits(d)) addEdge(from, n.id, true);
        gated = true;
      } else {
        for (const from of exits(d)) for (const to of entrances(n.id)) addEdge(from, to, implicit);
      }
    }
    if (gated) for (const to of entries(n.id)) addEdge(n.id, to, true);
  }
  if (targetIsFeatureNode) for (const t of terminals(targetId)) addEdge(t, targetId, false);

  const preds = new Map<string, string[]>();
  for (const e of edgeMap.values()) {
    if (!preds.has(e.to)) preds.set(e.to, []);
    preds.get(e.to)!.push(e.from);
  }

  // Ancestor closure.
  const seeds = targetIsFeatureNode ? [targetId] : exits(targetId);
  const inRoute = new Set<string>(seeds);
  const stack = [...seeds];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const p of preds.get(cur) ?? []) if (!inRoute.has(p)) { inRoute.add(p); stack.push(p); }
  }
  // A feature-with-tasks target pulls in all its tasks (and their prerequisites) via its terminals.
  if (!targetIsFeatureNode && target.kind === "feature") for (const s of seeds) inRoute.add(s);
  if (targetIsFeatureNode) {
    for (const t of tasksIn(targetId)) {
      if (inRoute.has(t)) continue;
      inRoute.add(t);
      const st = [t];
      while (st.length) for (const p of preds.get(st.pop()!) ?? []) if (!inRoute.has(p)) { inRoute.add(p); st.push(p); }
    }
  }

  const sub = [...edgeMap.values()]
    .filter((e) => inRoute.has(e.from) && inRoute.has(e.to))
    .sort((a, b) => (a.from + "\0" + a.to).localeCompare(b.from + "\0" + b.to));

  // Break cycles: DFS in sorted id order; a back edge is dropped with a warning.
  const warnings: string[] = [];
  const out = new Map<string, RouteEdge[]>();
  for (const e of sub) {
    if (!out.has(e.from)) out.set(e.from, []);
    out.get(e.from)!.push(e);
  }
  const dropped = new Set<RouteEdge>();
  const state = new Map<string, 1 | 2>();
  const visit = (id: string) => {
    state.set(id, 1);
    for (const e of out.get(id) ?? []) {
      const s = state.get(e.to);
      if (s === 1) {
        dropped.add(e);
        warnings.push(`dependency cycle: ignored edge ${e.from} -> ${e.to}`);
      } else if (!s) visit(e.to);
    }
    state.set(id, 2);
  };
  for (const id of [...inRoute].sort()) if (!state.has(id)) visit(id);
  const edges = sub.filter((e) => !dropped.has(e));

  // Hierarchy entry: a node with no in-route prerequisite enters from its parent
  // (task -> feature -> initiative -> Factory). Parents join the route as nodes;
  // a parent with no parent of its own enters from the Factory like any step 0.
  const ancestorOnly = new Set<string>();
  if (viaParent) {
    const hasIn = new Set(edges.map((e) => e.to));
    const queue = [...inRoute].sort();
    const seen = new Set<string>();
    while (queue.length) {
      const id = queue.shift()!;
      if (seen.has(id) || hasIn.has(id)) continue;
      seen.add(id);
      let parent = byId.get(id)?.parent ?? null;
      // The target feature ends the route; its tasks enter from the level above it.
      if (parent && parent === targetId && targetIsFeatureNode) parent = byId.get(parent)?.parent ?? null;
      if (!parent || !byId.has(parent)) continue;
      edges.push({ from: parent, to: id, implicit: false, root: false, entry: true });
      if (!inRoute.has(parent)) { inRoute.add(parent); ancestorOnly.add(parent); }
      queue.push(parent);
    }
  }

  // Longest-path layering.
  const incoming = new Map<string, string[]>();
  for (const id of inRoute) incoming.set(id, []);
  const blockers = new Map<string, string[]>();
  for (const id of inRoute) blockers.set(id, []);
  for (const e of edges) {
    incoming.get(e.to)!.push(e.from);
    if (!e.entry) blockers.get(e.to)!.push(e.from);
  }
  const level = new Map<string, number>();
  const levelOf = (id: string): number => {
    const known = level.get(id);
    if (known !== undefined) return known;
    const l = Math.max(-1, ...incoming.get(id)!.map(levelOf)) + 1;
    level.set(id, l);
    return l;
  };
  const layers: string[][] = [];
  for (const id of [...inRoute].sort()) (layers[levelOf(id)] ??= []).push(id);
  const steps: RouteStep[] = layers.map((ns, index) => ({ index, nodes: ns, parallel: ns.length > 1 }));

  const routeEdges: RouteEdge[] = [];
  for (const id of steps[0]?.nodes ?? []) routeEdges.push({ from: ROUTE_ROOT, to: id, implicit: false, root: true });
  routeEdges.push(...edges);

  const done: Record<string, boolean> = {};
  const blocked: Record<string, boolean> = {};
  for (const id of inRoute) done[id] = isDoneStage(byId.get(id)!.stage);
  for (const id of inRoute) blocked[id] = blockers.get(id)!.some((p) => !done[p]);

  const first = steps.findIndex((s) => s.nodes.some((id) => !done[id] && !ancestorOnly.has(id)));
  return {
    target: targetId, root: ROUTE_ROOT, steps, edges: routeEdges,
    parallelGroups: steps.filter((s) => s.parallel).map((s) => s.nodes),
    done, blocked, firstUnfinished: first < 0 ? null : first, warnings,
  };
}

export interface RouteCursor {
  step: number;
  node: string | null;
}

const clampStep = (route: WorkRoute, step: number) => Math.max(0, Math.min(route.steps.length - 1, step));

function landOn(route: WorkRoute, step: number, prefer: string | null): RouteCursor {
  const s = clampStep(route, step);
  const nodes = route.steps[s]?.nodes ?? [];
  if (!nodes.length) return { step: 0, node: null };
  const node = prefer && nodes.includes(prefer) ? prefer : (nodes.find((n) => !route.done[n]) ?? nodes[0] ?? null);
  return { step: s, node };
}

/** Starts at the first unfinished step (the last step when everything is done). */
export function startCursor(route: WorkRoute): RouteCursor {
  return landOn(route, route.firstUnfinished ?? route.steps.length - 1, null);
}

export function cursorNext(route: WorkRoute, c: RouteCursor): RouteCursor {
  return landOn(route, c.step + 1, null);
}

export function cursorPrev(route: WorkRoute, c: RouteCursor): RouteCursor {
  return landOn(route, c.step - 1, null);
}

/** Picks a node within the current step; ignored when it isn't in that step. */
export function cursorChoose(route: WorkRoute, c: RouteCursor, node: string): RouteCursor {
  return route.steps[c.step]?.nodes.includes(node) ? { step: c.step, node } : c;
}
