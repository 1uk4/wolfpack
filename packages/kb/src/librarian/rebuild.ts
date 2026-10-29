/**
 * rebuild — the development-baseline rebuild of one domain's section tree,
 * done entirely in memory on a RebuildState {sections, assignment}. No phase
 * reads or writes entry frontmatter; the one write is commitRebuild at the
 * end (temp files + renames, entries then sections, journalled for recovery).
 *
 * Flow: bottom-up agglomerative build (deterministic) → structural cleanup
 * (absorb small roots, merge near-identical roots, collapse/promote wrappers)
 * → misplacement refinement (anywhere in the domain, every move listed) →
 * recursive gated split (tree-rules.chooseSplit; leftovers stay in the parent)
 * → seeded branching cap → ONE top-down, sibling-aware label pass that rejects
 * a split whose child label restates the parent.
 *
 * It is a baseline tool: inserts must keep the tree right on their own, so
 * nothing here runs from the sweep.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SECTION_TREE, atomicWrite, parseFrontmatter } from "@wolfpack/engine";
import type { Engine } from "@wolfpack/engine";
import type { KbRoots } from "../shared/index.js";
import type { Section, SectionId, DomainId } from "../schema/knowledge.js";
import { buildTreeBottomUp, enforceBranchingFactor, placeEntry } from "./section-tree.js";
import { computeCentroid, type EntryWithVector } from "./hierarchy.js";
import { cosine, type EntryVector } from "./embed.js";
import { readSections, sectionsFile } from "./sections.js";
import { labelSection, sectionSummary, type SectionMember } from "./summarize.js";
import {
  DEFAULT_RULES, chooseSplit, findMisplaced, hashSectionId, isSplit, restatesParent, unit, meanVec,
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

export interface RebuildMove { id: string; title: string; from: string; to: string; own: number; better: number }
export interface RejectedSplit { sectionId: string; n: number; reason: string; detail?: Record<string, unknown> }

export interface NamerContext {
  members: SectionMember[];
  depth: number;
  maxDepth: number;
  domain: string;
  parentTitle?: string;
  siblingSummaries: string[];
}
export type Namer = (ctx: NamerContext) => Promise<{ title: string; summary: string }>;

export interface RebuildPlan {
  domain: string;
  entries: RebuildEntry[];
  state: RebuildState;
  moves: RebuildMove[];
  rejected: RejectedSplit[];
  /** Sections that split: entries that fit no group and stayed in the parent. */
  leftovers: Map<string, string[]>;
  /** child id → parent id for every section a gated split created (and kept). */
  splitChildren: Map<string, string>;
  unnamed: string[];
}

/** The default namer: summary then title from the engine (confined calls). */
export function engineNamer(engine: Engine): Namer {
  return async (c) => {
    const summary = await sectionSummary(engine, c.members, { depth: c.depth, maxDepth: c.maxDepth });
    const title = await labelSection(engine, summary, {
      sampleTitles: c.members.map((m) => m.title),
      depth: c.depth,
      maxDepth: c.maxDepth,
      parentTitle: c.parentTitle,
      siblingSummaries: c.siblingSummaries,
      domain: c.domain,
    });
    return { title, summary };
  };
}

// ── tree helpers (state only) ────────────────────────────────────────────────

const today = () => new Date().toISOString().split("T")[0];

class Tree {
  byId = new Map<string, Section>();
  constructor(public st: RebuildState, public vec: Map<string, number[]>, public domain: string) {}

  kids(id: string): Section[] { return this.st.sections.filter((s) => String(s.parent) === id); }
  direct(id: string): string[] {
    const out: string[] = [];
    for (const [e, s] of this.st.assignment) if (s === id) out.push(e);
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
  remove(id: string): void { this.st.sections = this.st.sections.filter((s) => String(s.id) !== id); }

  /** Re-derive childIds, depth, counts and centroids from parent pointers + assignment; drop empty leaves. */
  normalize(): void {
    let changed = true;
    while (changed) {
      changed = false;
      const counts = new Map<string, number>();
      for (const s of this.st.assignment.values()) counts.set(s, (counts.get(s) ?? 0) + 1);
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
    const counts = new Map<string, number>();
    for (const s of this.st.assignment.values()) counts.set(s, (counts.get(s) ?? 0) + 1);
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

// ── structural cleanup (state-based absorb / merge / collapse / promote) ────

function roots(t: Tree): Section[] { return t.st.sections.filter((s) => s.parent === null); }

function absorbSmallRoots(t: Tree, nEntries: number): void {
  const minEntries = Math.max(2, Math.ceil(nEntries * SECTION_TREE.minRootRatio));
  for (let guard = 0; guard < 1000; guard++) {
    const rs = roots(t);
    if (rs.length <= 2) return;
    const small = rs.find((r) => t.subtree(String(r.id)).length < minEntries);
    if (!small) return;
    const neighbours = rs.filter((r) => r !== small && t.subtree(String(r.id)).length >= minEntries);
    if (!neighbours.length) return;
    const near = neighbours.reduce((b, n) => (cosine(small.centroid, n.centroid) > cosine(small.centroid, b.centroid) ? n : b));
    const leaves = t.descendantIds(String(near.id)).map((i) => t.byId.get(i) ?? t.st.sections.find((s) => String(s.id) === i)!).filter((s) => t.direct(String(s.id)).length > 0 || t.kids(String(s.id)).length === 0);
    for (const e of t.subtree(String(small.id))) {
      const v = t.vec.get(e)!;
      const best = leaves.reduce((b, l) => (cosine(v, l.centroid) > cosine(v, b.centroid) ? l : b));
      t.st.assignment.set(e, String(best.id));
    }
    for (const id of t.descendantIds(String(small.id))) t.remove(id);
    t.normalize();
  }
}

function mergeSimilarRoots(t: Tree, nEntries: number): void {
  const target = Math.max(3, Math.round(Math.sqrt(nEntries) * SECTION_TREE.rootCountFactor));
  for (let guard = 0; guard < 1000; guard++) {
    const rs = roots(t);
    if (rs.length <= target) return;
    let bi = -1, bj = -1, bs: number = SECTION_TREE.rootMergeSimilarity;
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
      const c = cosine(rs[i].centroid, rs[j].centroid);
      if (c > bs) { bs = c; bi = i; bj = j; }
    }
    if (bi < 0) return;
    const [big, small] = t.subtree(String(rs[bi].id)).length >= t.subtree(String(rs[bj].id)).length ? [rs[bi], rs[bj]] : [rs[bj], rs[bi]];
    small.parent = big.id;
    t.normalize();
  }
}

/** A section with no direct entries and one child adds nothing: the child takes its place. */
function collapseSingleChild(t: Tree): void {
  for (let guard = 0; guard < 1000; guard++) {
    const w = t.st.sections.find((s) => t.direct(String(s.id)).length === 0 && t.kids(String(s.id)).length === 1);
    if (!w) return;
    t.kids(String(w.id))[0].parent = w.parent;
    t.remove(String(w.id));
    t.normalize();
  }
}

/** Wrappers (no direct entries) dominated by one child: promote the children. Only used before splitting. */
function promoteDominant(t: Tree): void {
  for (let guard = 0; guard < 1000; guard++) {
    const wrappers = t.st.sections.filter((s) => t.direct(String(s.id)).length === 0 && t.kids(String(s.id)).length >= 2).sort((a, b) => b.depth - a.depth);
    let hit = false;
    for (const w of wrappers) {
      const kids = t.kids(String(w.id));
      const totals = kids.map((k) => t.subtree(String(k.id)).length);
      const grand = totals.reduce((a, b) => a + b, 0);
      if (!grand || Math.max(...totals) / grand < SECTION_TREE.dominantChildThreshold) continue;
      for (const k of kids) k.parent = w.parent;
      t.remove(String(w.id));
      t.normalize();
      hit = true;
      break;
    }
    if (!hit) return;
  }
}

// ── the plan ─────────────────────────────────────────────────────────────────

export interface PlanOptions {
  domain: string;
  entries: RebuildEntry[];
  namer: Namer;
  rules?: TreeRules;
  notify?: (msg: string) => void;
  /** Start from this tree instead of the bottom-up build (tests, and comparing an incremental tree). */
  start?: RebuildState;
}

export async function planRebuild(opts: PlanOptions): Promise<RebuildPlan> {
  const { domain, namer, notify } = opts;
  const rules = opts.rules ?? DEFAULT_RULES;
  const entries = [...opts.entries].sort((a, b) => (a.id < b.id ? -1 : 1));
  const plan: RebuildPlan = {
    domain, entries, state: { sections: [], assignment: new Map() },
    moves: [], rejected: [], leftovers: new Map(), splitChildren: new Map(), unnamed: [],
  };
  if (entries.length === 0) return plan;
  const byEntry = new Map(entries.map((e) => [e.id, e]));
  const vec = new Map(entries.map((e) => [e.id, e.vector]));

  // 1. deterministic bottom-up build
  const ewv: EntryWithVector[] = entries.map((e) => ({ entryId: e.id, sectionId: "" as SectionId, vector: e.vector }));
  const meta = new Map(entries.map((e) => [e.id, { kind: e.kind, maturity: e.maturity }]));
  let state: RebuildState;
  if (opts.start) {
    state = { sections: structuredClone(opts.start.sections), assignment: new Map(opts.start.assignment) };
  } else {
    const built = buildTreeBottomUp(ewv, domain, computeCentroid(entries.map((e) => e.vector)), SECTION_TREE, meta);
    state = { sections: built.sections, assignment: new Map([...built.assignments].map(([e, s]) => [e, String(s)])) };
  }
  plan.state = state;
  const t = new Tree(state, vec, domain);
  for (const e of entries) if (!state.assignment.has(e.id)) {
    const rs = state.sections.filter((s) => !s.childIds.length);
    state.assignment.set(e.id, String(rs.reduce((b, l) => (cosine(e.vector, l.centroid) > cosine(e.vector, b.centroid) ? l : b)).id));
  }
  t.normalize();
  notify?.(`built ${state.sections.length} sections from ${entries.length} entries`);

  // 2. structural cleanup
  absorbSmallRoots(t, entries.length);
  mergeSimilarRoots(t, entries.length);
  collapseSingleChild(t);
  promoteDominant(t);
  t.normalize();

  // 3. misplacement refinement (rebuild only; may move anywhere in the domain)
  const items = entries.map((e) => ({ id: e.id, vec: e.vector, section: state.assignment.get(e.id)! }));
  for (const m of findMisplaced(items, rules)) {
    state.assignment.set(m.id, m.to);
    plan.moves.push({ ...m, title: byEntry.get(m.id)!.title });
  }
  plan.moves.sort((a, b) => (a.id < b.id ? -1 : 1));
  t.normalize();
  notify?.(`refinement moved ${plan.moves.length} entries`);

  // 4. recursive gated split; leftovers stay in the parent
  const queue = state.sections.map((s) => String(s.id));
  while (queue.length) {
    const id = queue.shift()!;
    const sec = state.sections.find((s) => String(s.id) === id);
    if (!sec) continue;
    const members = t.direct(id);
    if (members.length <= rules.splitAbove) continue;
    const d = chooseSplit(members.map((m) => vec.get(m)!), members, rules);
    if (!isSplit(d)) {
      plan.rejected.push({ sectionId: id, n: members.length, reason: d.reason, detail: d.detail });
      continue;
    }
    for (let g = 0; g < d.k; g++) {
      const ids = members.filter((_, i) => d.labels[i] === g);
      const child = t.newSection(sec, ids);
      for (const e of ids) state.assignment.set(e, String(child.id));
      plan.splitChildren.set(String(child.id), id);
      queue.push(String(child.id));
    }
    const left = members.filter((_, i) => d.labels[i] < 0);
    if (left.length) plan.leftovers.set(id, left);
    t.normalize();
    notify?.(`split ${id} (${members.length}) into ${d.k} groups, ${left.length} leftover`);
  }

  // 5. seeded branching cap, then drop pass-through wrappers
  enforceBranchingFactor(state.sections, domain, SECTION_TREE);
  t.normalize();
  collapseSingleChild(t);
  t.normalize();

  // 6. one top-down, sibling-aware label pass (may reject splits)
  await labelTree(plan, t, byEntry, namer, rules, notify);
  t.normalize();
  return plan;
}

function autoTitle(m: SectionMember[]): string {
  return m.slice(0, 3).map((x) => {
    const s = x.title.split(":")[0].split("—")[0].trim();
    return s.length > 40 ? s.slice(0, 37) + "..." : s;
  }).join(", ");
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
    for (const sec of sibs) {
      const members = sample(sec);
      try {
        if (sec.depth > SECTION_TREE.llmNamingMaxDepth) throw new Error("auto");
        const r = await namer({ members, depth: sec.depth, maxDepth, domain: plan.domain, parentTitle: parent?.title, siblingSummaries: done.slice() });
        sec.title = r.title.trim() || autoTitle(members);
        sec.summary = r.summary;
      } catch (err) {
        sec.title = autoTitle(members);
        if ((err as Error).message !== "auto") { plan.unnamed.push(String(sec.id)); notify?.(`label failed for ${sec.id}: ${(err as Error).message}`); }
      }
      done.push(sec.summary || sec.title);
      sec.dirty = false;
      sec.memberCountAtLastLabel = sec.memberCount;
    }
    // A split whose child label restates the parent is rejected: the children fold back.
    if (parent) {
      const splitKids = sibs.filter((s) => plan.splitChildren.get(String(s.id)) === String(parent.id));
      const restating = splitKids.filter((s) => restatesParent(s.title, parent.title, rules));
      if (restating.length) {
        for (const k of splitKids) {
          for (const id of t.descendantIds(String(k.id))) {
            for (const [e, s] of plan.state.assignment) if (s === id) plan.state.assignment.set(e, String(parent.id));
            t.remove(id);
            plan.splitChildren.delete(id);
          }
        }
        plan.leftovers.delete(String(parent.id));
        plan.rejected.push({
          sectionId: String(parent.id), n: t.direct(String(parent.id)).length, reason: "child-label-restates-parent",
          detail: { parent: parent.title, children: splitKids.map((k) => k.title) },
        });
        t.normalize();
        // the parent's remaining (non-split) children still need names
        sibs = sibs.filter((s) => !splitKids.includes(s));
      }
    }
    for (const sec of sibs) {
      const kids = t.kids(String(sec.id));
      if (kids.length) await labelGroup(kids, sec);
    }
  }
  await labelGroup(t.st.sections.filter((s) => s.parent === null), null);
}

// ── proposal ─────────────────────────────────────────────────────────────────

export function renderProposal(plan: RebuildPlan): string {
  const t = new Tree(plan.state, new Map(), plan.domain);
  const title = new Map(plan.entries.map((e) => [e.id, e.title]));
  const secTitle = (id: string) => plan.state.sections.find((s) => String(s.id) === id)?.title || id;
  const lines: string[] = [];
  lines.push(`# KB rebuild proposal: ${plan.domain}`, "");
  lines.push(`${plan.entries.length} entries, ${plan.state.sections.length} sections. Nothing was written to the KB.`, "");
  lines.push("## Tree", "");
  const walk = (s: Section, indent: string) => {
    const direct = t.direct(String(s.id));
    const total = t.subtree(String(s.id)).length;
    const left = plan.leftovers.get(String(s.id));
    lines.push(`${indent}- **${s.title || s.id}** \`${s.id}\` — ${total} entries${t.kids(String(s.id)).length ? ` (${direct.length} direct${left ? `, ${left.length} leftover` : ""})` : ""}`);
    for (const k of t.kids(String(s.id))) walk(k, indent + "  ");
  };
  for (const r of plan.state.sections.filter((s) => s.parent === null)) walk(r, "");
  lines.push("", "## Leftovers (fit no group, stay direct entries of the parent)", "");
  if (!plan.leftovers.size) lines.push("none");
  for (const [sid, es] of plan.leftovers) {
    lines.push(`- ${secTitle(sid)} \`${sid}\``);
    for (const e of es) lines.push(`  - ${title.get(e)} (${e})`);
  }
  lines.push("", "## Moves (refinement)", "");
  if (!plan.moves.length) lines.push("none");
  for (const m of plan.moves) lines.push(`- ${m.title} (${m.id}): ${secTitle(m.from)} → ${secTitle(m.to)} (own ${m.own.toFixed(2)}, other ${m.better.toFixed(2)})`);
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

// ── commit ───────────────────────────────────────────────────────────────────

/** Pure: the entry file text with its `section:` line set. */
export function withSectionLine(raw: string, sectionId: string): string {
  if (/^section: .+$/m.test(raw)) return raw.replace(/^section: .+$/m, `section: ${sectionId}`);
  if (/^domain: .+$/m.test(raw)) return raw.replace(/^(domain: .+)$/m, `$1\nsection: ${sectionId}`);
  throw new Error(`entry has neither a 'section:' nor a 'domain:' line; cannot assign ${sectionId}`);
}

export const rebuildJournalFile = (r: KbRoots) => join(r.denLocal, ".rebuild-journal.json");
const TMP = ".rebuild-tmp";

interface Journal { version: 1; domain: string; at: string; renames: Array<{ tmp: string; final: string }> }

/** Finish a commit that was interrupted after its journal was written. Returns the renames completed. */
export function recoverRebuild(roots: KbRoots): number {
  const jf = rebuildJournalFile(roots);
  if (!existsSync(jf)) return 0;
  const j = JSON.parse(readFileSync(jf, "utf-8")) as Journal;
  let n = 0;
  for (const r of j.renames) if (existsSync(r.tmp)) { renameSync(r.tmp, r.final); n++; }
  rmSync(jf, { force: true });
  return n;
}

/**
 * ONE commit: every changed entry file and the sections snapshot are written
 * to temp files first, a journal listing the renames is written, then the
 * renames run (entries first, sections last) and the journal is removed. A
 * crash before the journal leaves only temp files (removed here on failure);
 * a crash after it is finished by recoverRebuild. Caller holds the KB lock.
 */
export function commitRebuild(roots: KbRoots, plan: RebuildPlan): { entriesWritten: number } {
  recoverRebuild(roots);
  const eDir = join(roots.kbBase, "domains", plan.domain, "entries");
  const renames: Journal["renames"] = [];
  try {
    for (const [entryId, sec] of [...plan.state.assignment].sort()) {
      const file = join(eDir, `${entryId}.md`);
      if (!existsSync(file)) continue;
      const raw = readFileSync(file, "utf-8");
      const next = withSectionLine(raw, sec);
      if (next === raw) continue;
      writeFileSync(file + TMP, next);
      renames.push({ tmp: file + TMP, final: file });
    }
    const entriesWritten = renames.length;
    const others = readSections(roots).filter((s) => String(s.domain) !== plan.domain);
    const sf = sectionsFile(roots);
    mkdirSync(dirname(sf), { recursive: true });
    writeFileSync(sf + TMP, JSON.stringify([...others, ...plan.state.sections], null, 2));
    renames.push({ tmp: sf + TMP, final: sf });
    const jf = rebuildJournalFile(roots);
    mkdirSync(dirname(jf), { recursive: true });
    atomicWrite(jf, JSON.stringify({ version: 1, domain: plan.domain, at: new Date().toISOString(), renames } satisfies Journal));
    for (const r of renames) renameSync(r.tmp, r.final);
    rmSync(jf, { force: true });
    return { entriesWritten };
  } catch (err) {
    if (!existsSync(rebuildJournalFile(roots))) for (const r of renames) rmSync(r.tmp, { force: true });
    throw err;
  }
}

/** Remove stray temp files left by a commit that failed before its journal (test/ops helper). */
export function listRebuildTemps(roots: KbRoots, domain: string): string[] {
  const eDir = join(roots.kbBase, "domains", domain, "entries");
  return existsSync(eDir) ? readdirSync(eDir).filter((f) => f.endsWith(TMP)) : [];
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
export function repairPath(
  state: RebuildState, leafId: string, vec: Map<string, number[]>, domain: string,
  rules: TreeRules = DEFAULT_RULES,
): string[] {
  const t = new Tree(state, vec, domain);
  const created: string[] = [];
  const queue = [leafId];
  while (queue.length) {
    const id = queue.shift()!;
    const sec = state.sections.find((s) => String(s.id) === id);
    if (!sec) continue;
    const members = t.direct(id);
    if (members.length <= rules.splitAbove) continue;
    const d = chooseSplit(members.map((m) => vec.get(m)!), members, rules);
    if (!isSplit(d)) continue;
    for (let g = 0; g < d.k; g++) {
      const ids = members.filter((_, i) => d.labels[i] === g);
      const child = t.newSection(sec, ids);
      child.centroid = unit(meanVec(ids.map((e) => vec.get(e)!)));
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
export function insertEntry(
  state: RebuildState, entry: RebuildEntry, vec: Map<string, number[]>, domain: string,
  rules: TreeRules = DEFAULT_RULES,
): string {
  vec.set(entry.id, entry.vector);
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
  repairPath(state, target, vec, domain, rules);
  refreshPath(state, target, vec);
  return target;
}
