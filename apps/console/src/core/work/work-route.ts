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
 * How the hierarchy joins a route (experiment switch).
 * - "entry": a route node with no in-route prerequisite enters from its
 *   PARENT (Factory -> initiative -> feature -> entry tasks), and a feature
 *   dependency G -> F runs G's terminal tasks -> F node -> F's entry tasks.
 * - "exit": prerequisite-free tasks enter from the Factory; a feature's
 *   terminal tasks lead INTO the feature node, features lead into their
 *   initiative (the end of the path), and a feature dependency G -> F runs
 *   G node -> F's entry tasks.
 * - "none": the original behaviour (Factory -> first step directly).
 */
export type RouteParentMode = "entry" | "exit" | "none";
export const ROUTE_PARENT_MODE: RouteParentMode = "exit";

export interface RouteOptions {
  /** Overrides ROUTE_PARENT_MODE. */
  parentMode?: RouteParentMode;
  /**
   * Collapse each fully done prerequisite feature (not the target, nor the
   * target's own feature) to its feature node: its tasks leave the route's
   * steps, edges into them redirect to the feature and edges out of them
   * start from it. See `WorkRoute.collapsed`.
   */
  collapseDoneFeatures?: boolean;
  /** Features kept expanded despite `collapseDoneFeatures` (per selection). */
  expanded?: ReadonlySet<string>;
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
  /** Hierarchy exit: terminal task -> feature, or feature -> initiative. */
  exit?: true;
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
  /** Collapsed feature id -> the route task ids it stands in for (sorted). */
  collapsed: Record<string, string[]>;
}

const isDoneStage = (stage: string) => stage === "shipped" || stage === "live" || stage === "archived";

export function computeWorkRoute(
  nodes: readonly WorkNode[], targetId: string, opts: RouteOptions = {},
): WorkRoute {
  const mode = opts.parentMode ?? ROUTE_PARENT_MODE;
  const viaParent = mode === "entry";
  const exitMode = mode === "exit";
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const empty = (): WorkRoute => ({
    target: targetId, root: ROUTE_ROOT, steps: [], edges: [], parallelGroups: [],
    done: {}, blocked: {}, firstUnfinished: null, warnings: [], collapsed: {},
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

  const exitKeys = new Set<string>();
  for (const n of nodes) {
    if (exitMode) {
      // A feature dependency G -> F leaves from the G node (or a task) into F's entry tasks.
      for (const d of n.dependsOn ?? []) {
        if (!byId.has(d)) continue;
        const implicit = isFeatureWithTasks(d) || isFeatureWithTasks(n.id);
        for (const to of entrances(n.id)) addEdge(d, to, implicit);
      }
      continue;
    }
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
  if (exitMode) {
    for (const n of nodes) {
      if (!isFeatureWithTasks(n.id)) continue;
      for (const t of terminals(n.id)) { addEdge(t, n.id, false); exitKeys.add(`${t}\0${n.id}`); }
    }
  }
  // A selected task's tail goes straight to its feature, not via the feature's other terminals.
  const tailFeature = exitMode && target.kind !== "feature" && target.kind !== "initiative" && target.parent && isFeatureWithTasks(target.parent)
    ? target.parent : null;
  if (tailFeature) {
    for (const key of [...edgeMap.keys()]) if (key.endsWith(`\0${tailFeature}`) && !key.startsWith(`${targetId}\0`)) edgeMap.delete(key);
    addEdge(targetId, tailFeature, false);
    exitKeys.add(`${targetId}\0${tailFeature}`);
  }

  const preds = new Map<string, string[]>();
  for (const e of edgeMap.values()) {
    if (!preds.has(e.to)) preds.set(e.to, []);
    preds.get(e.to)!.push(e.from);
  }

  // Ancestor closure.
  let seeds = targetIsFeatureNode ? [targetId] : exits(targetId);
  // An initiative is the natural end of all its features' paths.
  if (exitMode && target.kind === "initiative") {
    seeds = nodes.filter((n) => n.kind === "feature" && n.parent === targetId).map((n) => n.id).sort();
  }
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

  if (exitMode) {
    inRoute.add(targetId);
    if (tailFeature) inRoute.add(tailFeature);
    // A feature with no in-route dependent ends at its initiative.
    const ends: string[] = [];
    for (const id of [...inRoute].sort()) {
      const n = byId.get(id);
      if (n?.kind !== "feature" || !n.parent || !byId.has(n.parent)) continue;
      const leads = [...edgeMap.values()].some((e) => e.from === id && inRoute.has(e.to) && e.to !== n.parent);
      if (!leads) ends.push(id);
    }
    for (const id of ends) {
      const parent = byId.get(id)!.parent!;
      inRoute.add(parent);
      addEdge(id, parent, false);
      exitKeys.add(`${id}\0${parent}`);
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
  const edges = sub.filter((e) => !dropped.has(e)).map((e) => (exitKeys.has(`${e.from}\0${e.to}`) ? { ...e, exit: true as const } : e));

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

  // Collapse fully done prerequisite features to their feature node.
  const collapsed: Record<string, string[]> = {};
  if (opts.collapseDoneFeatures) {
    const ownFeature = targetIsFeatureNode ? targetId : target.parent;
    const taskDone = (id: string) => isDoneStage(byId.get(id)!.stage);
    const acyclic = (list: readonly RouteEdge[], ids: Iterable<string>): boolean => {
      const indeg = new Map<string, number>();
      for (const id of ids) indeg.set(id, 0);
      for (const e of list) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
      const ready = [...indeg].filter(([, d]) => d === 0).map(([id]) => id);
      let seen = 0;
      while (ready.length) {
        const id = ready.pop()!;
        seen++;
        for (const e of list) if (e.from === id && indeg.set(e.to, indeg.get(e.to)! - 1).get(e.to) === 0) ready.push(e.to);
      }
      return seen === indeg.size;
    };
    for (const f of [...inRoute].sort()) {
      if (f === targetId || f === ownFeature || opts.expanded?.has(f) || !isFeatureWithTasks(f)) continue;
      if (!tasksIn(f).every(taskDone)) continue;
      const hide = new Set(tasksIn(f).filter((t) => inRoute.has(t)));
      if (!hide.size) continue;
      const merged = new Map<string, RouteEdge>();
      for (const e of edges) {
        const from = hide.has(e.from) ? f : e.from;
        const to = hide.has(e.to) ? f : e.to;
        if (from === to) continue;
        const key = `${from}\0${to}`;
        const prev = merged.get(key);
        if (!prev) merged.set(key, { ...e, from, to });
        else {
          prev.implicit = prev.implicit && e.implicit;
          if (!e.entry) delete prev.entry;
          if (!e.exit) delete prev.exit;
        }
      }
      let next = [...merged.values()];
      const gated = new Set(next.filter((e) => !e.entry).map((e) => e.to));
      next = next.filter((e) => !e.entry || !gated.has(e.to));
      const remaining = [...inRoute].filter((id) => !hide.has(id));
      if (!acyclic(next, remaining)) continue;
      edges.splice(0, edges.length, ...next);
      for (const t of hide) inRoute.delete(t);
      collapsed[f] = [...hide].sort();
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
  // A feature is done when shipped, or ready to graduate (all its tasks done).
  for (const id of inRoute) {
    const tasks = tasksIn(id);
    done[id] = isDoneStage(byId.get(id)!.stage) || (isFeatureWithTasks(id) && tasks.every((t) => isDoneStage(byId.get(t)!.stage)));
  }
  for (const id of inRoute) blocked[id] = blockers.get(id)!.some((p) => !done[p]);

  // Exit mode: feature (with tasks) and initiative nodes are containers, not work to do.
  const container = (id: string) =>
    exitMode && (byId.get(id)?.kind === "initiative" || (isFeatureWithTasks(id) && !(id in collapsed)));
  const first = steps.findIndex((s) => s.nodes.some((id) => !done[id] && !ancestorOnly.has(id) && !container(id)));
  return {
    target: targetId, root: ROUTE_ROOT, steps, edges: routeEdges,
    parallelGroups: steps.filter((s) => s.parallel).map((s) => s.nodes),
    done, blocked, firstUnfinished: first < 0 ? null : first, warnings, collapsed,
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
