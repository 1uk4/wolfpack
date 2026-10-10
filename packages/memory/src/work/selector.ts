/**
 * selector — the /task workspace browser, as pure state + a key reducer.
 *
 *   left pane   workspaces: the Inbox, initiatives (collapsed by default) with
 *               their features, and standalone features
 *   right pane  the open feature's tasks (task · issue · spike)
 *
 *   j/k  move within the focused pane     l/Enter  expand / open / go right
 *   h    collapse / go left               Space    bind the focused task
 *
 * Opening a feature auto-binds its first open, unblocked task only when NO
 * task is bound and the feature is already in_build — just looking at a
 * feature never changes state. The extension renders this and applies effects.
 */
import { isBindable, isComplete, type WorkItem } from "@wolfpack/kb/client";

export type Pane = "left" | "right";

export interface SelectorState {
  pane: Pane;
  leftIdx: number;
  rightIdx: number;
  /** Initiative ids whose features are shown. */
  expanded: string[];
  /** Feature whose tasks fill the right pane. */
  openId: string | null;
}

export interface LeftRow {
  item: WorkItem;
  depth: 0 | 1;
}

export type SelectorKey = "up" | "down" | "left" | "right" | "enter" | "space";

export type SelectorEffect =
  | { type: "bind"; id: string }
  | { type: "unbind" }
  | { type: "open"; id: string }; // Enter on a task (opens it for iteration)

const STAGE_RANK = ["in_build", "approved", "feasibility", "plan", "idea", "shipped", "live", "archived"];
const byStage = (a: WorkItem, b: WorkItem) => STAGE_RANK.indexOf(a.stage) - STAGE_RANK.indexOf(b.stage);

const isWorkspace = (i: WorkItem) => i.kind === "feature" || i.kind === "initiative";

/** True when a dependency of `item` is not complete yet. */
export function isBlocked(item: WorkItem, all: WorkItem[]): boolean {
  const deps = item.dependsOn ?? [];
  if (deps.length === 0) return false;
  const byId = new Map(all.map((i) => [i.id as string, i]));
  return deps.some((d) => {
    const dep = byId.get(d as string);
    return !dep || !isComplete(dep);
  });
}

/** Left pane rows: the Inbox, then top-level items by stage — initiatives (with
 *  their features when expanded), standalone features, and ideas. */
export function leftRows(all: WorkItem[], expanded: string[]): LeftRow[] {
  const live = all.filter((i) => i.stage !== "archived");
  const rows: LeftRow[] = [];
  for (const inbox of live.filter((i) => i.container)) rows.push({ item: inbox, depth: 0 });
  const tops = live
    .filter((i) => !i.container && !i.partOf && (isWorkspace(i) || i.kind === "idea"))
    .sort(byStage);
  for (const top of tops) {
    rows.push({ item: top, depth: 0 });
    if (top.kind === "initiative" && expanded.includes(top.id as string)) {
      for (const f of live.filter((i) => i.partOf === top.id && i.kind === "feature").sort(byStage)) {
        rows.push({ item: f, depth: 1 });
      }
    }
  }
  return rows;
}

/** Right pane rows: the open feature's work units, open ones first. */
export function rightRows(all: WorkItem[], openId: string | null): WorkItem[] {
  if (!openId) return [];
  const units = all.filter((i) => i.partOf === openId && isBindable(i) && i.stage !== "archived");
  return [...units.filter((i) => !isComplete(i)).sort(byStage), ...units.filter(isComplete)];
}

/** First open, unblocked task (fallback: first open task), or undefined. */
export function firstTask(tasks: WorkItem[], all: WorkItem[]): WorkItem | undefined {
  const open = tasks.filter((t) => !isComplete(t));
  return open.find((t) => !isBlocked(t, all)) ?? open[0];
}

/** Done/total work units under a workspace (initiatives count their features' tasks). */
export function progress(ws: WorkItem, all: WorkItem[]): { done: number; total: number } {
  const featureIds =
    ws.kind === "initiative"
      ? new Set(all.filter((i) => i.partOf === ws.id).map((i) => i.id as string))
      : new Set([ws.id as string]);
  const units = all.filter((i) => i.partOf && featureIds.has(i.partOf as string) && isBindable(i));
  return { done: units.filter(isComplete).length, total: units.length };
}

/** Where to start: the bound task's feature open and focused, else the first workspace. */
export function initialState(all: WorkItem[], boundId: string | null): SelectorState {
  const bound = boundId ? all.find((i) => i.id === boundId) : undefined;
  const feature = bound?.partOf ? all.find((i) => i.id === bound.partOf) : undefined;
  const expanded = feature?.partOf ? [feature.partOf as string] : [];
  if (!bound || !feature) return { pane: "left", leftIdx: 0, rightIdx: 0, expanded, openId: null };
  const leftIdx = Math.max(0, leftRows(all, expanded).findIndex((r) => r.item.id === feature.id));
  const rightIdx = Math.max(0, rightRows(all, feature.id as string).findIndex((t) => t.id === bound.id));
  return { pane: "right", leftIdx, rightIdx, expanded, openId: feature.id as string };
}

const clamp = (n: number, len: number) => Math.max(0, Math.min(n, Math.max(0, len - 1)));

/** Apply one key. Pure: returns the next state and an optional effect to perform. */
export function reduce(
  s: SelectorState,
  key: SelectorKey,
  all: WorkItem[],
  boundId: string | null
): { state: SelectorState; effect?: SelectorEffect } {
  const left = leftRows(all, s.expanded);
  const right = rightRows(all, s.openId);

  if (s.pane === "right") {
    const task = right[s.rightIdx];
    switch (key) {
      case "up":
        return { state: { ...s, rightIdx: clamp(s.rightIdx - 1, right.length) } };
      case "down":
        return { state: { ...s, rightIdx: clamp(s.rightIdx + 1, right.length) } };
      case "left":
        return { state: { ...s, pane: "left" } };
      case "space":
        if (!task) return { state: s };
        if (task.id === boundId) return { state: s, effect: { type: "unbind" } };
        if (isComplete(task) || isBlocked(task, all)) return { state: s };
        return { state: s, effect: { type: "bind", id: task.id as string } };
      case "enter":
      case "right":
        return task && !isComplete(task) && !isBlocked(task, all)
          ? { state: s, effect: { type: "open", id: task.id as string } }
          : { state: s };
    }
  }

  const row = left[s.leftIdx];
  switch (key) {
    case "up":
      return { state: { ...s, leftIdx: clamp(s.leftIdx - 1, left.length) } };
    case "down":
      return { state: { ...s, leftIdx: clamp(s.leftIdx + 1, left.length) } };
    case "space":
      return { state: s }; // workspaces are never bound
    case "left": {
      if (!row) return { state: s };
      const initiativeId =
        row.item.kind === "initiative" ? (row.item.id as string) : row.depth === 1 ? (row.item.partOf as string) : null;
      if (!initiativeId || !s.expanded.includes(initiativeId)) return { state: s };
      const expanded = s.expanded.filter((e) => e !== initiativeId);
      const leftIdx = Math.max(0, leftRows(all, expanded).findIndex((r) => r.item.id === initiativeId));
      return { state: { ...s, expanded, leftIdx } };
    }
    case "right":
    case "enter": {
      if (!row) return { state: s };
      const id = row.item.id as string;
      if (row.item.kind === "initiative") {
        return s.expanded.includes(id)
          ? { state: { ...s, leftIdx: clamp(s.leftIdx + 1, leftRows(all, s.expanded).length) } }
          : { state: { ...s, expanded: [...s.expanded, id] } };
      }
      if (row.item.kind !== "feature") return { state: s };
      const tasks = rightRows(all, id);
      const boundHere = tasks.findIndex((t) => t.id === boundId);
      const first = firstTask(tasks, all);
      const autoBind = !boundId && row.item.stage === "in_build" && !!first;
      const rightIdx = boundHere >= 0 ? boundHere : first ? tasks.indexOf(first) : 0;
      const state: SelectorState = { ...s, openId: id, pane: tasks.length ? "right" : "left", rightIdx };
      return autoBind ? { state, effect: { type: "bind", id: first!.id as string } } : { state };
    }
  }
}
