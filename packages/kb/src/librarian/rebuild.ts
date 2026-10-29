/**
 * rebuild — the development-baseline rebuild of one domain's section tree,
 * done entirely in memory on a RebuildState {sections, assignment}. No phase
 * reads or writes entry frontmatter; the one write is commitRebuild at the
 * end (journalled: entries then sections, recoverable after a crash).
 *
 * Flow (top-down, the same gated rule the insert path uses): the CURRENT tree (`start`, the
 * default: top sections hardly ever change) or ONE root holding every entry (from scratch) → level by level, misplacement refinement among the sections that exist
 * (anywhere in the domain, every move listed), then each section above splitAbove is judged once by
 * judgeSplit (llm-split.ts: an LLM proposes 2-5 categories plus "doesn't fit", the vectors validate
 * them and may drop members or categories; k-means only when the LLM call fails; leftovers stay in the
 * parent; no coherent grouping → the section stays whole, even above the soft range) → seeded branching cap
 * (its wrappers are labelled and judged like split children) →
 * id continuity with the old tree → ONE top-down, sibling-aware label pass that re-asks, then
 * folds back, a split child whose label restates the parent. Grouped (`group:`) entries take no part:
 * they are added at their holder's section once the tree is final.
 *
 * It is a baseline tool: inserts must keep the tree right on their own, so
 * nothing here runs from the sweep.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SECTION_TREE, parseFrontmatter } from "@wolfpack/engine";
import type { Engine } from "@wolfpack/engine";
import type { KbRoots } from "../shared/index.js";
import type { Section, SectionId, DomainId } from "../schema/knowledge.js";
import { enforceBranchingFactor, placeEntry } from "./section-tree.js";
import type { EntryVector } from "./embed.js";
import { collapseGuardFires } from "./rebuild-commit.js";
import { judgeSplit, memorySplitCache, type Partitioner, type SplitCache, type SplitVerdict } from "./llm-split.js";
import { anchorOf, groupOf } from "./anchors.js";
import { labelSection, sectionSummary, type SectionMember } from "./summarize.js";
import {
  DEFAULT_RULES, cosine, findMisplaced, hashSectionId, restatesParent, unit, meanVec,
  type TreeRules,
} from "./tree-rules.js";

// ── types ────────────────────────────────────────────────────────────────────

export interface RebuildEntry {
  id: string;
  title: string;
  summary?: string;
  kind?: string;
  maturity?: string;
  vector: number[];
  /** The section the entry file points at now (for the diff in the proposal). */
  section?: string;
}

export interface RebuildState {
  sections: Section[];
  /** entryId → the section that holds it directly. */
  assignment: Map<string, string>;
}

export interface RebuildMove {
  id: string; title: string; from: string; to: string; own: number; better: number;
  /** The destination then judged the entry a leftover: it stays a direct entry of `to` (listed here, not under leftovers). */
  staysInParent?: boolean;
}
/** A misplacement whose best target sits under a different top-level section: proposed, not applied (needs approval). */
export type CrossMove = RebuildMove
export interface RejectedSplit { sectionId: string; n: number; reason: string; detail?: Record<string, unknown> }

export interface NamerContext {
  members: SectionMember[];
  depth: number;
  maxDepth: number;
  domain: string;
  parentTitle?: string;
  siblingSummaries: string[];
  /** Titles the answer must not restate (set when re-asking after a restating label). */
  forbidden?: string[];
  /** The title is already chosen (the LLM's split category name): only the summary is asked for. */
  fixedTitle?: string;
}
export type Namer = (ctx: NamerContext) => Promise<{ title: string; summary: string }>;

export interface RebuildPlan {
  domain: string;
  entries: RebuildEntry[];
  state: RebuildState;
  moves: RebuildMove[];
  /** Proposed moves into another top-level section; applied only with applyCrossMoves. */
  crossMoves: CrossMove[];
  rejected: RejectedSplit[];
  /** Sections that split: entries that fit no group and stayed in the parent. */
  leftovers: Map<string, string[]>;
  /** child id → parent id for every section a gated split created (and kept). */
  splitChildren: Map<string, string>;
  unnamed: string[];
  /** Grouped (`group:`) entries → the holder entry whose section they follow. */
  grouped: Map<string, string>;
  /** Final ids of sections that kept an old section's id (by member overlap). */
  reused: Set<string>;
  /** Subset of `reused` that also kept the old title and summary (overlap >= reuseKeepLabelJaccard). */
  labelKept: Set<string>;
  /** Sections the branching cap created to group siblings. */
  capWrappers: Set<string>;
  /** Every section the split rule looked at, in order, with the outcome. */
  judged: Array<{
    id: string; n: number; outcome: "split" | "kept" | "below-threshold";
    /** Who proposed the grouping: the LLM (vectors validated it), k-means (fallback), or nobody. */
    source?: "llm" | "kmeans" | "none";
    /** Per-category coherence, doesn't-fit and k-means diagnostics, as proposal lines. */
    notes?: string[];
  }>;
  /** Initial titles from the LLM's category names (new split children). */
  initialTitles: Map<string, string>;
  /** How the plan started. */
  from: "current" | "scratch";
  /** Section count of the tree being replaced (for the collapse guard). */
  oldSectionCount?: number;
  /** Entry files present when the plan was made; the commit aborts if the directory differs. */
  fileIds?: string[];
}

/** The default namer: summary then title from the engine (confined calls). */
export function engineNamer(engine: Engine): Namer {
  return async (c) => {
    const summary = await sectionSummary(engine, c.members, { depth: c.depth, maxDepth: c.maxDepth });
    if (c.fixedTitle) return { title: c.fixedTitle, summary };
    const title = await labelSection(engine, summary, {
      sampleTitles: c.members.map((m) => m.title),
      depth: c.depth,
      maxDepth: c.maxDepth,
      parentTitle: c.parentTitle,
      siblingSummaries: c.siblingSummaries,
      domain: c.domain,
      forbiddenTitles: c.forbidden,
    });
    return { title, summary };
  };
}

// ── tree helpers (state only) ────────────────────────────────────────────────

const today = () => new Date().toISOString().split("T")[0];

class Tree {
  byId = new Map<string, Section>();
  constructor(public st: RebuildState, public vec: Map<string, number[]>, public domain: string, public grouped: Set<string> = new Set()) {}

  private counts(): Map<string, number> {
    const c = new Map<string, number>();
    for (const [e, s] of this.st.assignment) if (!this.grouped.has(e)) c.set(s, (c.get(s) ?? 0) + 1);
    return c;
  }

  kids(id: string): Section[] { return this.st.sections.filter((s) => String(s.parent) === id); }
  direct(id: string): string[] {
    const out: string[] = [];
    for (const [e, s] of this.st.assignment) if (s === id && !this.grouped.has(e)) out.push(e);
    return out.sort();
  }
  subtree(id: string): string[] {
    const out = this.direct(id);
    for (const k of this.kids(id)) out.push(...this.subtree(String(k.id)));
    return out;
  }
  descendantIds(id: string): string[] {
    const out = [id];
    for (const k of this.kids(id)) out.push(...this.descendantIds(String(k.id)));
    return out;
  }
  /** The top-level section above (or equal to) a section. */
  rootOf(id: string): string {
    let cur = this.st.sections.find((s) => String(s.id) === id);
    for (let g = 0; cur && cur.parent && g < 64; g++) cur = this.st.sections.find((s) => String(s.id) === String(cur!.parent));
    return cur ? String(cur.id) : id;
  }
  remove(id: string): void { this.st.sections = this.st.sections.filter((s) => String(s.id) !== id); }

  /** Re-derive childIds, depth, counts and centroids from parent pointers + assignment; drop empty leaves. */
  normalize(): void {
    let changed = true;
    while (changed) {
      changed = false;
      const counts = this.counts();
      const parents = new Set(this.st.sections.map((s) => String(s.parent)));
      const before = this.st.sections.length;
      this.st.sections = this.st.sections.filter((s) => (counts.get(String(s.id)) ?? 0) > 0 || parents.has(String(s.id)));
      if (this.st.sections.length !== before) changed = true;
    }
    const ids = new Set(this.st.sections.map((s) => String(s.id)));
    for (const s of this.st.sections) if (s.parent && !ids.has(String(s.parent))) s.parent = null; // orphaned by a removal
    const order = new Map(this.st.sections.map((s, i) => [String(s.id), i]));
    for (const s of this.st.sections) {
      const prev = s.childIds.map(String);
      const now = this.kids(String(s.id)).map((k) => String(k.id));
      s.childIds = [...prev.filter((c) => now.includes(c)), ...now.filter((c) => !prev.includes(c)).sort((a, b) => (order.get(a)! - order.get(b)!))] as SectionId[];
    }
    const setDepth = (id: string | null, d: number) => {
      for (const s of this.st.sections.filter((x) => (x.parent ? String(x.parent) : null) === id)) {
        s.depth = d;
        setDepth(String(s.id), d + 1);
      }
    };
    setDepth(null, 0);
    const counts = this.counts();
    for (const s of this.st.sections) {
      s.memberCount = counts.get(String(s.id)) ?? 0;
      const vs = this.subtree(String(s.id)).map((e) => this.vec.get(e)).filter(Boolean) as number[][];
      if (vs.length) s.centroid = unit(meanVec(vs));
    }
  }

  newSection(parent: Section | null, memberIds: string[], extraSalt = ""): Section {
    let id = hashSectionId(this.domain, memberIds.length ? memberIds : [extraSalt]);
    for (let i = 0; this.st.sections.some((s) => String(s.id) === id); i++) id = hashSectionId(this.domain, [...memberIds, `~${i}`]);
    const d = today();
    const sec = {
      id: id as unknown as SectionId, domain: this.domain as unknown as DomainId,
      parent: parent ? parent.id : null, depth: parent ? parent.depth + 1 : 0,
      label: id.slice(-7), title: "", centroid: [], memberCount: 0, childIds: [],
      summary: "", summaryHash: "", dirty: true, memberCountAtLastLabel: 0, created: d, updated: d,
    } as unknown as Section;
    this.st.sections.push(sec);
    return sec;
  }
}

// ── the plan ─────────────────────────────────────────────────────────────────

export interface PlanOptions {
  domain: string;
  entries: RebuildEntry[];
  namer: Namer;
  rules?: TreeRules;
  notify?: (msg: string) => void;
  /**
   * Start from this tree (its sections stay; only sections above splitAbove are judged) instead of one root
   * holding every entry. The kb rebuild default is the current tree. Entries missing from `assignment` go to
   * the nearest leaf.
   */
  start?: RebuildState;
  /** Grouped entry → holder entry. They take no part in clustering; they are pinned to the holder's section. */
  grouped?: Map<string, string>;
  /** Apply refinement moves into another top-level section too (default: list them for approval). */
  applyCrossMoves?: boolean;
  /** Proposes a split for an oversized section (an LLM); vectors validate it. Without one, or if it fails, k-means decides. */
  partitioner?: Partitioner;
  /** Caches proposals by member set (default: in memory for this plan). */
  splitCache?: SplitCache;
  /** Also run k-means beside the LLM partition, for the proposal. */
  diagnostics?: boolean;
  /** The domain's current sections: new sections matching one by member overlap keep its id, title and summary. */
  oldSections?: Section[];
}

/**
 * Misplacement refinement on the sections that exist now (may move an entry anywhere in the domain; every
 * move is listed). A move may not leave a leaf below minGroup; leftovers are never moved. A split parent
 * left with a single split child by moves folds that child back into it.
 */
function refine(plan: RebuildPlan, t: Tree, byEntry: Map<string, RebuildEntry>, exempt: Set<string>, rules: TreeRules, applyCross: boolean): void {
  const st = plan.state;
  if (st.sections.length < 2) return;
  const items = [...byEntry.values()].map((e) => ({ id: e.id, vec: e.vector, section: st.assignment.get(e.id)! }));
  const size = new Map<string, number>();
  for (const i of items) size.set(i.section, (size.get(i.section) ?? 0) + 1);
  // Moves apply only inside the same top-level section (top sections hardly ever change). A better target under
  // another top-level section is listed for approval instead (unless applyCross).
  const sameRoot = (from: string, to: string) => applyCross || t.rootOf(from) === t.rootOf(to);
  if (!applyCross) {
    const inside = new Set(findMisplaced(items, rules, sameRoot).map((m) => m.id));
    for (const m of findMisplaced(items, rules)) {
      if (exempt.has(m.id) || inside.has(m.id) || t.rootOf(m.from) === t.rootOf(m.to)) continue;
      if (!plan.crossMoves.some((c) => c.id === m.id)) plan.crossMoves.push({ ...m, title: byEntry.get(m.id)!.title });
    }
  }
  for (const m of findMisplaced(items, rules, sameRoot)) {
    if (exempt.has(m.id)) continue;
    const isLeaf = !t.kids(m.from).length;
    if (isLeaf && (size.get(m.from) ?? 0) - 1 < rules.minGroup) continue;
    st.assignment.set(m.id, m.to);
    size.set(m.from, (size.get(m.from) ?? 0) - 1);
    size.set(m.to, (size.get(m.to) ?? 0) + 1);
    plan.moves.push({ ...m, title: byEntry.get(m.id)!.title });
  }
  t.normalize();
  // fold a lone split child back into its parent
  for (const parent of st.sections.map((x) => String(x.id))) {
    const kids = [...plan.splitChildren].filter(([, p]) => p === parent).map(([c]) => c).filter((c) => st.sections.some((x) => String(x.id) === c));
    if (kids.length === 1) {
      for (const id of t.descendantIds(kids[0])) {
        for (const [e, sid] of st.assignment) if (sid === id) st.assignment.set(e, parent);
        t.remove(id);
        plan.splitChildren.delete(id);
      }
      t.normalize();
    }
  }
}

/** Proposal lines for one judged section: who proposed the grouping, per-category coherence, doesn't-fit, k-means. */
function verdictNotes(v: SplitVerdict, byEntry: Map<string, RebuildEntry>): string[] {
  const out: string[] = [];
  if (v.source === "llm") {
    out.push(`grouping proposed by the LLM${v.cached ? " (cached)" : ""}; vectors validated it`);
    for (const c of v.categories ?? []) {
      out.push(`  - "${c.name}": ${c.size} proposed, ${c.coherent} coherent (${Math.round(c.share * 100)}%) → ${c.kept ? "kept" : `dropped (${c.why})`}`);
    }
    if (v.doesntFit?.length) out.push(`  - doesn't fit: ${v.doesntFit.map((i) => byEntry.get(i)?.title ?? i).join("; ")}`);
    if (!v.decision && v.reason) out.push(`  → no split: ${v.reason}`);
  } else if (v.source === "kmeans") {
    out.push(`grouping from k-means${v.fallbackReason ? ` (the LLM proposal failed: ${v.fallbackReason})` : ""}`);
  }
  if (v.kmeans && v.source === "llm") {
    out.push("k-means diagnostic: " + ("split" in v.kmeans ? `no split (${v.kmeans.reason})` : `k=${v.kmeans.k}, p=${v.kmeans.p.toFixed(3)}, stability=${v.kmeans.stability.toFixed(2)}, ${v.kmeans.leftovers.length} leftover`));
  }
  return out;
}

export async function planRebuild(opts: PlanOptions): Promise<RebuildPlan> {
  const { domain, namer, notify } = opts;
  const rules = opts.rules ?? DEFAULT_RULES;
  // Grouped entries (with a holder in the plan) are not clustered, counted or judged; they are pinned at the end.
  const holderIds = new Set(opts.entries.map((e) => e.id));
  const grouped = new Map([...(opts.grouped ?? new Map())].filter(([g, h]) => holderIds.has(h) && !(opts.grouped ?? new Map()).has(h) && g !== h));
  const entries = opts.entries.filter((e) => !grouped.has(e.id)).sort((a, b) => (a.id < b.id ? -1 : 1));
  const oldDomain = (opts.oldSections ?? []).filter((s) => String(s.domain) === domain);
  const plan: RebuildPlan = {
    domain, entries, state: { sections: [], assignment: new Map() },
    moves: [], crossMoves: [], rejected: [], leftovers: new Map(), splitChildren: new Map(), unnamed: [],
    grouped, reused: new Set(), labelKept: new Set(), capWrappers: new Set(), judged: [], initialTitles: new Map(),
    from: opts.start ? "current" : "scratch",
    oldSectionCount: opts.oldSections ? oldDomain.length : undefined,
  };
  if (entries.length === 0) return plan;
  const byEntry = new Map(entries.map((e) => [e.id, e]));
  const vec = new Map(entries.map((e) => [e.id, e.vector]));

  // 1. Start: the given tree (`start`, e.g. the current roots) or ONE root holding every entry.
  //    There is no bottom-up clustering: structure only ever comes from the gated split below,
  //    the same rule the insert path (repairPath) applies.
  let state: RebuildState;
  if (opts.start) {
    state = { sections: structuredClone(opts.start.sections), assignment: new Map(opts.start.assignment) };
  } else {
    state = { sections: [], assignment: new Map() };
  }
  plan.state = state;
  const t = new Tree(state, vec, domain, new Set(grouped.keys()));
  if (state.sections.length === 0) {
    plan.from = "scratch";
    const root = t.newSection(null, entries.map((e) => e.id));
    for (const e of entries) state.assignment.set(e.id, String(root.id));
  }
  t.normalize(); // centroids from the members that are assigned (drops sections left empty)
  for (const e of entries) if (!state.assignment.has(e.id)) {
    const rs = state.sections.filter((s) => !s.childIds.length);
    state.assignment.set(e.id, String(rs.reduce((b, l) => (cosine(e.vector, l.centroid) > cosine(e.vector, b.centroid) ? l : b)).id));
  }
  t.normalize();

  // 2. Level by level: refine placement among the sections that exist, then judge each
  //    not-yet-judged section once. Sections with no stable substructure stay whole.
  const judgeDeps = { partitioner: opts.partitioner, cache: opts.splitCache ?? memorySplitCache(), rules, diagnostics: opts.diagnostics, notify };
  const judged = new Set<string>();
  const exempt = new Set<string>(); // leftovers: flagged as fitting nowhere, never "moved" by refinement
  for (let level = 0; level < 32; level++) {
    refine(plan, t, byEntry, exempt, rules, !!opts.applyCrossMoves);
    const todo = state.sections.filter((s) => !judged.has(String(s.id))).sort((a, b) => a.depth - b.depth || (String(a.id) < String(b.id) ? -1 : 1));
    if (!todo.length) break;
    for (const sec of todo) {
      const id = String(sec.id);
      judged.add(id);
      const members = t.direct(id);
      if (members.length <= rules.splitAbove) { plan.judged.push({ id, n: members.length, outcome: "below-threshold" }); continue; }
      const verdict = await judgeSplit(judgeDeps, {
        domain, parentTitle: sec.title,
        members: members.map((m) => ({ id: m, title: byEntry.get(m)!.title, summary: byEntry.get(m)!.summary, vector: vec.get(m)! })),
      });
      const notes = verdictNotes(verdict, byEntry);
      if (!verdict.decision) {
        plan.rejected.push({ sectionId: id, n: members.length, reason: verdict.reason ?? "no-split", detail: verdict.kmeans && "detail" in verdict.kmeans ? verdict.kmeans.detail : undefined });
        plan.judged.push({ id, n: members.length, outcome: "kept", source: verdict.source, notes });
        continue;
      }
      const d = verdict.decision;
      plan.judged.push({ id, n: members.length, outcome: "split", source: verdict.source, notes });
      for (let g = 0; g < d.k; g++) {
        const ids = members.filter((_, i) => d.labels[i] === g);
        const child = t.newSection(sec, ids);
        for (const e of ids) state.assignment.set(e, String(child.id));
        plan.splitChildren.set(String(child.id), id);
        if (d.names?.[g]) plan.initialTitles.set(String(child.id), d.names[g]);
      }
      const left = members.filter((_, i) => d.labels[i] < 0);
      if (left.length) { plan.leftovers.set(id, [...(plan.leftovers.get(id) ?? []), ...left]); for (const e of left) exempt.add(e); }
      t.normalize();
      notify?.(`split ${id} (${members.length}) into ${d.k} groups, ${left.length} leftover`);
    }
  }
  // One line per moved entry (first section it left → section it ended in). Refinement runs BEFORE the split judgement, so a
  // moved entry can then be judged a leftover of its new section: it is listed once, under moves (staysInParent), and is
  // removed from that section's leftover list. An entry is never in both lists.
  const firstFrom = new Map<string, RebuildMove>();
  for (const m of plan.moves) { const f = firstFrom.get(m.id); if (!f) firstFrom.set(m.id, { ...m }); else { f.to = m.to; f.better = m.better; } }
  plan.moves = [...firstFrom.values()].filter((m) => m.from !== m.to);
  for (const m of plan.moves) {
    const dest = state.assignment.get(m.id);
    if (dest) m.to = dest;
    if (dest && plan.leftovers.get(dest)?.includes(m.id)) m.staysInParent = true;
  }
  for (const [sid, ids] of [...plan.leftovers]) {
    const rest = ids.filter((id) => !firstFrom.has(id));
    if (rest.length) plan.leftovers.set(sid, rest); else plan.leftovers.delete(sid);
  }
  plan.moves.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  plan.crossMoves.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  notify?.(`top-down build: ${state.sections.length} sections, refinement moved ${plan.moves.length} entries`);

  // 3. the seeded branching cap is the only other structural rule
  const beforeCap = new Set(state.sections.map((s) => String(s.id)));
  enforceBranchingFactor(state.sections, domain, SECTION_TREE);
  t.normalize();
  for (const s of state.sections) if (!beforeCap.has(String(s.id))) plan.capWrappers.add(String(s.id));

  // 4. id continuity: sections matching an old one by member overlap keep its id, title and summary
  if (opts.oldSections) reuseOldSections(plan, t, opts.oldSections, entries, rules);

  // 5. one top-down, sibling-aware label pass (new sections only; may reject splits)
  await labelTree(plan, t, byEntry, namer, rules, notify);

  // 6. grouped entries follow their holder (not counted, not clustered)
  for (const [g, h] of plan.grouped) {
    const sec = state.assignment.get(h);
    if (sec) state.assignment.set(g, sec);
  }
  t.normalize();
  return plan;
}

function autoTitle(m: SectionMember[]): string {
  return m.slice(0, 3).map((x) => {
    const s = x.title.split(":")[0].split("—")[0].trim();
    return s.length > 40 ? s.slice(0, 37) + "..." : s;
  }).join(", ");
}

/** Id continuity: match new sections to old ones by member overlap (Jaccard >= reuseJaccard), one to one, greedily by best overlap. */
function reuseOldSections(plan: RebuildPlan, t: Tree, oldSections: Section[], entries: RebuildEntry[], rules: TreeRules): void {
  const old = oldSections.filter((s) => String(s.domain) === plan.domain);
  if (!old.length) return;
  const direct = new Map<string, string[]>();
  for (const e of entries) if (e.section) direct.set(e.section, [...(direct.get(e.section) ?? []), e.id]);
  const oldSub = (id: string): string[] => [...(direct.get(id) ?? []), ...old.filter((s) => String(s.parent) === id).flatMap((c) => oldSub(String(c.id)))];
  const oldSets = new Map(old.map((s) => [String(s.id), new Set(oldSub(String(s.id)))]));
  const ownIds = new Set(plan.state.sections.map((s) => String(s.id)));
  const pairs: Array<{ j: number; n: string; o: string }> = [];
  for (const n of plan.state.sections) {
    const ns = new Set(t.subtree(String(n.id)));
    for (const [oid, os] of oldSets) {
      if (!os.size) continue;
      if (oid !== String(n.id) && ownIds.has(oid)) continue; // a live section's id is never handed to another section
      let inter = 0;
      for (const e of ns) if (os.has(e)) inter++;
      const j = inter / (ns.size + os.size - inter);
      if (j >= rules.reuseJaccard) pairs.push({ j: String(n.id) === oid ? j + 10 : j, n: String(n.id), o: oid }); // a section that already has this id keeps it first
    }
  }
  pairs.sort((a, b) => b.j - a.j || (a.n < b.n ? -1 : 1) || (a.o < b.o ? -1 : 1));
  const usedN = new Set<string>(), usedO = new Set<string>(), map = new Map<string, string>();
  for (const p of pairs) {
    if (usedN.has(p.n) || usedO.has(p.o)) continue;
    usedN.add(p.n); usedO.add(p.o); map.set(p.n, p.o);
  }
  const R = (id: string) => map.get(id) ?? id;
  for (const s of plan.state.sections) {
    s.id = R(String(s.id)) as unknown as SectionId;
    if (s.parent) s.parent = R(String(s.parent)) as unknown as SectionId;
    s.childIds = s.childIds.map((c) => R(String(c)) as unknown as SectionId);
  }
  for (const [e, sec] of plan.state.assignment) plan.state.assignment.set(e, R(sec));
  plan.leftovers = new Map([...plan.leftovers].map(([k, v]) => [R(k), v]));
  plan.splitChildren = new Map([...plan.splitChildren].map(([k, v]) => [R(k), R(v)]));
  for (const r of plan.rejected) r.sectionId = R(r.sectionId);
  for (const j of plan.judged) j.id = R(j.id);
  plan.initialTitles = new Map([...plan.initialTitles].map(([k, v]) => [R(k), v]));
  plan.capWrappers = new Set([...plan.capWrappers].map(R));
  for (const m of [...plan.moves, ...plan.crossMoves]) { m.from = R(m.from); m.to = R(m.to); }
  for (const oid of map.values()) {
    const sec = plan.state.sections.find((s) => String(s.id) === oid)!;
    const o = old.find((x) => String(x.id) === oid)!;
    const ns = new Set(t.subtree(oid));
    const os = oldSets.get(oid)!;
    let inter = 0;
    for (const e of ns) if (os.has(e)) inter++;
    const jac = inter / (ns.size + os.size - inter);
    sec.created = o.created;
    sec.label = o.label;
    plan.reused.add(oid);
    if (jac >= rules.reuseKeepLabelJaccard) {
      // same section, same name
      sec.title = o.title; sec.summary = o.summary; sec.summaryHash = o.summaryHash;
      sec.memberCountAtLastLabel = o.memberCountAtLastLabel;
      sec.dirty = false;
      plan.labelKept.add(oid);
    } else {
      sec.dirty = true; // id kept, membership moved enough that the name is asked again
    }
  }
}

async function labelTree(
  plan: RebuildPlan, t: Tree, byEntry: Map<string, RebuildEntry>, namer: Namer, rules: TreeRules,
  notify?: (m: string) => void,
): Promise<void> {
  const maxDepth = Math.max(0, ...plan.state.sections.map((s) => s.depth));
  const info = (e: string): SectionMember => ({ title: byEntry.get(e)!.title, summary: byEntry.get(e)!.summary });
  const sample = (sec: Section): SectionMember[] => {
    const id = String(sec.id);
    const own = t.direct(id);
    const kids = t.kids(id);
    if (!kids.length) return own.slice(0, 12).map(info);
    const out = own.slice(0, 3).map(info);
    const weights = kids.map((k) => Math.max(1, t.subtree(String(k.id)).length));
    const total = weights.reduce((a, b) => a + b, 0);
    kids.forEach((k, i) => {
      const quota = Math.max(1, Math.round((weights[i] / total) * 10));
      out.push(...t.subtree(String(k.id)).slice(0, quota).map(info));
    });
    return out;
  };

  async function labelGroup(sibs: Section[], parent: Section | null): Promise<void> {
    const done: string[] = [];
    const ask = async (sec: Section, forbidden?: string[]) => {
      const members = sample(sec);
      try {
        if (sec.depth > SECTION_TREE.llmNamingMaxDepth) throw new Error("auto");
        const r = await namer({ members, depth: sec.depth, maxDepth, domain: plan.domain, parentTitle: parent?.title, siblingSummaries: done.slice(), forbidden, fixedTitle: forbidden ? undefined : plan.initialTitles.get(String(sec.id)) });
        sec.title = r.title.trim() || autoTitle(members);
        sec.summary = r.summary;
      } catch (err) {
        sec.title = autoTitle(members);
        if ((err as Error).message !== "auto") { plan.unnamed.push(String(sec.id)); notify?.(`label failed for ${sec.id}: ${(err as Error).message}`); }
      }
      sec.dirty = false;
      sec.memberCountAtLastLabel = sec.memberCount;
    };
    for (const sec of sibs) {
      if (!plan.labelKept.has(String(sec.id))) await ask(sec);
      done.push(sec.summary || sec.title);
    }
    // A split child whose label restates the parent is re-asked once with the parent's title forbidden;
    // if it still restates, only that child folds back (all of them if fewer than two would remain).
    if (parent) {
      const splitKids = sibs.filter((s) => plan.splitChildren.get(String(s.id)) === String(parent.id));
      const bad: Section[] = [];
      for (const k of splitKids) {
        if (!restatesParent(k.title, parent.title, rules)) continue;
        notify?.(`label "${k.title}" restates parent "${parent.title}"; asking again`);
        const first = k.title;
        plan.labelKept.delete(String(k.id));
        await ask(k, [parent.title, first]);
        if (restatesParent(k.title, parent.title, rules)) {
          notify?.(`split rejected for ${k.id}: "${k.title}" still restates "${parent.title}"`);
          bad.push(k);
        }
      }
      if (bad.length) {
        const fold = splitKids.length - bad.length >= 2 ? bad : splitKids;
        for (const k of fold) {
          for (const id of t.descendantIds(String(k.id))) {
            for (const [e, s] of plan.state.assignment) if (s === id) plan.state.assignment.set(e, String(parent.id));
            t.remove(id);
            plan.splitChildren.delete(id);
            plan.reused.delete(id);
            plan.labelKept.delete(id);
          }
          plan.rejected.push({
            sectionId: String(parent.id), n: t.subtree(String(parent.id)).length, reason: "child-label-restates-parent",
            detail: { parent: parent.title, child: k.title },
          });
        }
        if (fold === splitKids) plan.leftovers.delete(String(parent.id));
        t.normalize();
        sibs = sibs.filter((s) => !fold.includes(s));
      }
    }
    // A branching-cap wrapper is judged like a split child: re-ask once, and if its title still restates the
    // parent the wrapper is dissolved (its children go back up to the parent) and the adopted children are named.
    if (parent) {
      const adopted: Section[] = [];
      for (const w of sibs.filter((x) => plan.capWrappers.has(String(x.id)))) {
        if (!restatesParent(w.title, parent.title, rules)) continue;
        notify?.(`wrapper "${w.title}" restates parent "${parent.title}"; asking again`);
        const first = w.title;
        plan.labelKept.delete(String(w.id));
        await ask(w, [parent.title, first]);
        if (!restatesParent(w.title, parent.title, rules)) continue;
        notify?.(`wrapper ${w.id} dissolved: "${w.title}" still restates "${parent.title}"`);
        for (const k of t.kids(String(w.id))) { k.parent = parent.id; adopted.push(k); }
        t.remove(String(w.id));
        plan.capWrappers.delete(String(w.id));
        plan.reused.delete(String(w.id));
        plan.rejected.push({ sectionId: String(parent.id), n: adopted.length, reason: "wrapper-label-restates-parent", detail: { parent: parent.title, wrapper: w.title } });
        t.normalize();
        sibs = sibs.filter((x) => x !== w);
      }
      for (const k of adopted) {
        if (!plan.labelKept.has(String(k.id))) await ask(k);
        sibs.push(k);
      }
    }
    for (const sec of sibs) {
      const kids = t.kids(String(sec.id));
      if (kids.length) await labelGroup(kids, sec);
    }
  }
  await labelGroup(t.st.sections.filter((s) => s.parent === null), null);
}

function rootTitleId(plan: RebuildPlan, id: string): string {
  let cur = plan.state.sections.find((s) => String(s.id) === id);
  for (let g = 0; cur && cur.parent && g < 64; g++) cur = plan.state.sections.find((s) => String(s.id) === String(cur!.parent));
  return cur ? String(cur.id) : id;
}

// ── proposal ─────────────────────────────────────────────────────────────────

export function renderProposal(plan: RebuildPlan): string {
  const t = new Tree(plan.state, new Map(), plan.domain, new Set(plan.grouped.keys()));
  const title = new Map(plan.entries.map((e) => [e.id, e.title]));
  const secTitle = (id: string) => plan.state.sections.find((s) => String(s.id) === id)?.title || id;
  const lines: string[] = [];
  lines.push(`# KB rebuild proposal: ${plan.domain}`, "");
  const kept = plan.labelKept.size, relabel = plan.reused.size - kept;
  lines.push(`${plan.entries.length} entries${plan.grouped.size ? ` (+${plan.grouped.size} grouped, pinned to their holders)` : ""}, ${plan.state.sections.length} sections, built ${plan.from === "current" ? "from the current tree" : "from scratch (one root)"}: ${kept} keep id and name, ${relabel} keep the id but are re-named, ${plan.state.sections.length - plan.reused.size} are new. Nothing was written to the KB.`, "");
  if (plan.oldSectionCount !== undefined && collapseGuardFires(plan.oldSectionCount, plan.state.sections.length)) {
    lines.push(`> **Collapse guard would fire:** the new tree has ${plan.state.sections.length} sections, fewer than half of the current ${plan.oldSectionCount}. \`rebuild --yes\` aborts unless \`--allow-collapse\` is given.`, "");
  } else if (plan.oldSectionCount !== undefined) {
    lines.push(`Collapse guard: not triggered (${plan.oldSectionCount} sections now, ${plan.state.sections.length} proposed).`, "");
  }
  lines.push("A dry run still makes LLM label calls and may add vectors to the embedding cache; it changes no entry file, no sections file and no ledger.", "");
  lines.push("## Tree", "");
  const walk = (s: Section, indent: string) => {
    const direct = t.direct(String(s.id));
    const total = t.subtree(String(s.id)).length;
    const left = plan.leftovers.get(String(s.id));
    lines.push(`${indent}- **${s.title || s.id}** \`${s.id}\` ${plan.labelKept.has(String(s.id)) ? "[reused]" : plan.reused.has(String(s.id)) ? "[id reused, re-named]" : "[new]"}${plan.capWrappers.has(String(s.id)) ? " [cap wrapper]" : ""} — ${total} entries${t.kids(String(s.id)).length ? ` (${direct.length} direct${left ? `, ${left.length} leftover` : ""})` : ""}`);
    for (const k of t.kids(String(s.id))) walk(k, indent + "  ");
  };
  for (const r of plan.state.sections.filter((s) => s.parent === null)) walk(r, "");
  const rootsTotal = plan.state.sections.filter((s) => s.parent === null).reduce((n, r) => n + t.subtree(String(r.id)).length, 0);
  lines.push("", `Totals: the top-level sections hold ${rootsTotal} of ${plan.entries.length} entries${rootsTotal === plan.entries.length ? "" : " — MISMATCH, do not commit"}.`);
  lines.push("", "## Leftovers (fit no group, stay direct entries of the parent)", "");
  if (!plan.leftovers.size) lines.push("none");
  for (const [sid, es] of plan.leftovers) {
    lines.push(`- ${secTitle(sid)} \`${sid}\``);
    for (const e of es) lines.push(`  - ${title.get(e)} (${e})`);
  }
  lines.push("", "## Moves (refinement)", "");
  if (!plan.moves.length) lines.push("none");
  for (const m of plan.moves) lines.push(`- ${m.title} (${m.id}): ${secTitle(m.from)} → ${secTitle(m.to)} (own ${m.own.toFixed(2)}, other ${m.better.toFixed(2)})${m.staysInParent ? " — then fits none of its children: stays a direct entry there" : ""}`);
  lines.push("", "## Proposed cross-section moves (needs approval)", "");
  if (!plan.crossMoves.length) lines.push("none");
  else lines.push("Not applied: the better target is under a different top-level section. Re-run with `--apply-cross-moves` to apply.", "");
  for (const m of plan.crossMoves) lines.push(`- ${m.title} (${m.id}): ${secTitle(m.from)} → ${secTitle(m.to)} (similarity to own section ${m.own.toFixed(2)}, to the target ${m.better.toFixed(2)}; top level: ${secTitle(rootTitleId(plan, m.from))} → ${secTitle(rootTitleId(plan, m.to))})`);
  lines.push("", "## Judged by the split rule", "");
  const judgedNow = plan.judged.filter((j) => j.outcome !== "below-threshold");
  if (!judgedNow.length) lines.push("none");
  for (const j of judgedNow) {
    lines.push(`- ${secTitle(j.id)} \`${j.id}\` (${j.n} direct): ${j.outcome === "split" ? "split" : "kept whole"}`);
    for (const n of j.notes ?? []) lines.push(`  ${n}`);
  }
  const below = plan.judged.length - judgedNow.length;
  if (below) lines.push(`- ${below} section(s) at or below the split threshold were not judged`);
  lines.push("", "## Rejected / not split", "");
  if (!plan.rejected.length) lines.push("none");
  for (const r of plan.rejected) lines.push(`- ${secTitle(r.sectionId)} \`${r.sectionId}\` (${r.n}): ${r.reason}${r.detail ? " " + JSON.stringify(r.detail) : ""}`);
  if (plan.unnamed.length) lines.push("", "## Label failures (auto-titled)", "", ...plan.unnamed.map((i) => `- ${i}`));
  return lines.join("\n") + "\n";
}

// ── loading entries ──────────────────────────────────────────────────────────

export function loadRebuildEntries(domainsRoot: string, domain: string, vectors: EntryVector[]): RebuildEntry[] {
  const eDir = join(domainsRoot, domain, "entries");
  const out: RebuildEntry[] = [];
  for (const v of vectors.filter((x) => x.domain === domain)) {
    const file = join(eDir, `${v.entryId}.md`);
    if (!existsSync(file)) continue;
    const { fields } = parseFrontmatter(readFileSync(file, "utf-8"));
    out.push({
      id: v.entryId, title: String(fields.title ?? v.entryId),
      summary: fields.summary ? String(fields.summary) : undefined,
      kind: fields.kind ? String(fields.kind) : undefined,
      maturity: fields.maturity ? String(fields.maturity) : undefined,
      vector: v.vector, section: fields.section ? String(fields.section) : undefined,
    });
  }
  return out;
}

export { commitRebuild, recoverRebuild, withSectionLine, rebuildJournalFile, rebuildOldValuesFile, sectionsBackupFile, listRebuildTemps, listRebuildBackups, restoreRebuild, collapseGuardFires, type CommitHooks } from "./rebuild-commit.js";

/** Grouped entries (`group: <anchor>`) → the entry holding that anchor. A grouped entry with no holder is left out (the commit then keeps or aborts on it). */
export function loadGrouped(domainsRoot: string, domain: string): Map<string, string> {
  const eDir = join(domainsRoot, domain, "entries");
  const out = new Map<string, string>();
  if (!existsSync(eDir)) return out;
  const holders = new Map<string, string>();
  const groups: Array<[string, string]> = [];
  for (const f of readdirSync(eDir).filter((x) => x.endsWith(".md") && !x.startsWith(".")).sort()) {
    const raw = readFileSync(join(eDir, f), "utf-8");
    const id = f.slice(0, -3);
    const a = anchorOf(raw);
    if (a) holders.set(a, id);
    const g = groupOf(raw);
    if (g) groups.push([id, g]);
  }
  for (const [id, g] of groups) { const h = holders.get(g); if (h) out.set(id, h); }
  return out;
}

// ── insert path: top-down placement + the local split rule ──────────────────

/**
 * The minimal insert-path repair: after an entry lands in `leafId`, apply the
 * SAME split rule the rebuild uses (tree-rules.chooseSplit) to that leaf, then
 * recursively to any section the split creates. Only the leaf, its new
 * children and the centroids on the path to the root change; every other
 * section is untouched. Returns the ids of sections created.
 *
 * Not yet done (deferred, see work-wolfpack-t800z3L): depth-weighted stability
 * (ancestors never restructure here), labelling the new children, absorb /
 * promote / collapse / branching cap on the path, and persistence.
 */
export async function repairPath(
  state: RebuildState, leafId: string, vec: Map<string, number[]>, domain: string,
  rules: TreeRules = DEFAULT_RULES, ctx: RepairContext = {},
): Promise<string[]> {
  const t = new Tree(state, vec, domain);
  const created: string[] = [];
  const queue = [leafId];
  const deps = { partitioner: ctx.partitioner, cache: ctx.cache, rules, notify: ctx.notify };
  while (queue.length) {
    const id = queue.shift()!;
    const sec = state.sections.find((s) => String(s.id) === id);
    if (!sec) continue;
    const members = t.direct(id);
    if (members.length <= rules.splitAbove) continue;
    const v = await judgeSplit(deps, {
      domain, parentTitle: sec.title,
      members: members.map((m) => ({ id: m, title: ctx.info?.get(m)?.title ?? m, summary: ctx.info?.get(m)?.summary, vector: vec.get(m)! })),
    });
    if (!v.decision) continue;
    const d = v.decision;
    for (let g = 0; g < d.k; g++) {
      const ids = members.filter((_, i) => d.labels[i] === g);
      const child = t.newSection(sec, ids);
      child.centroid = unit(meanVec(ids.map((e) => vec.get(e)!)));
      if (d.names?.[g]) child.title = d.names[g]; // initial title; the real label pass is deferred
      for (const e of ids) state.assignment.set(e, String(child.id));
      child.memberCount = ids.length;
      child.depth = sec.depth + 1;
      sec.childIds.push(child.id);
      created.push(String(child.id));
      queue.push(String(child.id));
    }
    sec.memberCount = members.filter((_, i) => d.labels[i] < 0).length;
  }
  return created;
}

/** What the insert path needs besides vectors: a partitioner and cache (else k-means), and titles for the proposer. */
export interface RepairContext {
  partitioner?: Partitioner;
  cache?: SplitCache;
  info?: Map<string, { title: string; summary?: string }>;
  notify?: (msg: string) => void;
}

/** Recompute centroid and counts for a section and its ancestors only. */
function refreshPath(state: RebuildState, fromId: string, vec: Map<string, number[]>): void {
  const t = new Tree(state, vec, "");
  let cur: Section | undefined = state.sections.find((s) => String(s.id) === fromId);
  while (cur) {
    const vs = t.subtree(String(cur.id)).map((e) => vec.get(e)!).filter(Boolean);
    if (vs.length) cur.centroid = unit(meanVec(vs));
    cur.memberCount = t.direct(String(cur.id)).length;
    const pid: string | null = cur.parent ? String(cur.parent) : null;
    cur = pid ? state.sections.find((s) => String(s.id) === pid) : undefined;
  }
}

/**
 * Insert one entry the way a sweep does: descend from the roots by centroid
 * (placeEntry), land in a section, then apply repairPath to that section.
 * With no sections yet the entry founds the first root; an entry nothing is
 * close to (placeEntry "_unplaced") goes to the nearest root, as the sweep
 * would otherwise open a new section for it.
 */
export async function insertEntry(
  state: RebuildState, entry: RebuildEntry, vec: Map<string, number[]>, domain: string,
  rules: TreeRules = DEFAULT_RULES, ctx: RepairContext = {},
): Promise<string> {
  vec.set(entry.id, entry.vector);
  ctx.info?.set(entry.id, { title: entry.title, summary: entry.summary });
  const t = new Tree(state, vec, domain);
  let target: string;
  if (state.sections.length === 0) {
    const root = t.newSection(null, [entry.id]);
    target = String(root.id);
  } else {
    const placed = placeEntry(entry.vector, { kind: entry.kind ?? "fact", maturity: entry.maturity }, state.sections, entry.vector, new Map());
    if (placed.sectionId === "_unplaced") {
      const rs = state.sections.filter((s) => s.parent === null);
      target = String(rs.reduce((b, r) => (cosine(entry.vector, r.centroid) > cosine(entry.vector, b.centroid) ? r : b)).id);
    } else target = String(placed.sectionId);
  }
  state.assignment.set(entry.id, target);
  refreshPath(state, target, vec);
  await repairPath(state, target, vec, domain, rules, ctx);
  refreshPath(state, target, vec);
  return target;
}

// ── starting from the current tree ───────────────────────────────────────────

/** The domain's current tree as a start state: its sections, and each entry at the section its file names (if that section exists). */
export function currentTreeStart(oldSections: Section[], entries: RebuildEntry[], domain: string): RebuildState | undefined {
  const sections = oldSections.filter((s) => String(s.domain) === domain);
  if (!sections.length) return undefined;
  const ids = new Set(sections.map((s) => String(s.id)));
  const assignment = new Map<string, string>();
  for (const e of entries) if (e.section && ids.has(e.section)) assignment.set(e.id, e.section);
  return { sections: structuredClone(sections), assignment };
}

/** Entry file ids in a domain (what a plan was made from; the commit re-checks it under the lock). */
export function listEntryIds(domainsRoot: string, domain: string): string[] {
  const eDir = join(domainsRoot, domain, "entries");
  return existsSync(eDir) ? readdirSync(eDir).filter((f) => f.endsWith(".md") && !f.startsWith(".")).map((f) => f.slice(0, -3)).sort() : [];
}

/**
 * Bootstrap helper: sections folded from the ledger have no centroids (the sections_replaced event
 * does not carry them). Recompute any empty or all-zero centroid from the subtree's entry vectors.
 */
export function fillMissingCentroids(sections: Section[], domainsRoot: string, vectors: EntryVector[]): number {
  let filled = 0;
  const missing = (c: number[] | undefined) => !c || c.length === 0 || c.every((x) => x === 0);
  for (const domain of new Set(sections.map((s) => String(s.domain)))) {
    const mine = sections.filter((s) => String(s.domain) === domain);
    if (!mine.some((s) => missing(s.centroid))) continue;
    const entries = loadRebuildEntries(domainsRoot, domain, vectors);
    const vecs = new Map<string, number[][]>();
    for (const e of entries) if (e.section) vecs.set(e.section, [...(vecs.get(e.section) ?? []), e.vector]);
    const sub = (id: string): number[][] => [...(vecs.get(id) ?? []), ...mine.filter((c) => String(c.parent) === id).flatMap((c) => sub(String(c.id)))];
    for (const s of mine) {
      if (!missing(s.centroid)) continue;
      const vs = sub(String(s.id));
      if (vs.length) { s.centroid = unit(meanVec(vs)); filled++; }
    }
  }
  return filled;
}
