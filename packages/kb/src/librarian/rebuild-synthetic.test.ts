/**
 * A synthetic 93-entry domain with 8 well-separated clusters in two super-groups: the case the frozen real
 * fixtures cannot cover (they mostly refuse to split). Exercises accepted splits, the branching-cap wrappers,
 * refinement moves, id/label reuse, the wrapper restate check, and inserts-vs-rebuild.
 */
import { describe, it, expect } from "vitest";
import { planRebuild, insertEntry, repairPath, type RebuildEntry, type RebuildState, type Namer } from "./rebuild.js";
import { rng, ari } from "./tree-rules.js";

const DIM = 32;
export function clustersFixture(): RebuildEntry[] {
  const r = rng(7);
  const out: RebuildEntry[] = [];
  let i = 0;
  for (let c = 0; c < 8; c++) {
    const n = 10 + (c % 5); // 10..14
    for (let k = 0; k < n; k++, i++) {
      const v = Array.from({ length: DIM }, (_, d) => (d === 0 ? 3 : 0) + (d === (c < 4 ? 1 : 2) ? 1.5 : 0) + (d === 3 + c ? 1.6 : 0) + (r() + r() + r() - 1.5) * 0.1);
      const norm = Math.hypot(...v); // the embedder returns unit vectors, and placement (embed.cosine) assumes them
      out.push({ id: `c${c}-${String(i).padStart(3, "0")}`, title: `cluster ${c} entry ${i}`, summary: `topic ${c}`, vector: v.map((x) => x / norm) });
    }
  }
  return out;
}
const clusterOf = (id: string) => Number(id[1]);
let n = 0;
const unique: Namer = async () => ({ title: `Name ${++n}`, summary: `s${n}` });
const yieldLoop = () => new Promise<void>((r) => setImmediate(r));

describe("synthetic 93-entry domain, 8 clusters", () => {
  it("splits the root into the 8 clusters, with the branching cap grouping them into two wrappers", async () => {
    const es = clustersFixture();
    const plan = await planRebuild({ domain: "wp", entries: es, namer: unique });
    const leaves = plan.state.sections.filter((s) => !plan.state.sections.some((c) => c.parent === s.id));
    expect(leaves).toHaveLength(8);
    for (const l of leaves) {
      const members = [...plan.state.assignment].filter(([, s]) => s === String(l.id)).map(([e]) => e);
      expect(new Set(members.map(clusterOf)).size).toBe(1); // every leaf is exactly one cluster
    }
    expect(plan.leftovers.size).toBe(0);
    // 8 children of the root exceed maxChildrenPerSection (6): the cap groups them under wrappers
    expect(plan.capWrappers.size).toBe(2);
    for (const w of plan.capWrappers) {
      const kids = plan.state.sections.filter((s) => String(s.parent) === w);
      expect(kids.length).toBeGreaterThanOrEqual(3);
      expect(plan.state.assignment.size).toBe(es.length);
    }
    // the clusters of one super-group sit under the same wrapper
    const wrapperOf = (cl: number) => String(plan.state.sections.find((s) => String(s.id) === plan.state.assignment.get(es.find((e) => clusterOf(e.id) === cl)!.id))!.parent);
    expect(new Set([0, 1, 2, 3].map(wrapperOf)).size).toBe(1);
    expect(new Set([4, 5, 6, 7].map(wrapperOf)).size).toBe(1);
    expect(wrapperOf(0)).not.toBe(wrapperOf(4));
    // sections below the threshold or without substructure are judged and kept whole
    expect(plan.judged.filter((j) => j.outcome === "split")).toHaveLength(1);
    expect(plan.judged.filter((j) => j.outcome === "kept").length).toBeGreaterThanOrEqual(5);
  }, 600_000);

  it("from the current tree: planted misfilings are moved back (listed), and unchanged sections keep id and name without any LLM call", async () => {
    const es = clustersFixture();
    const first = await planRebuild({ domain: "wp", entries: es, namer: unique });
    const sectionOfCluster = (cl: number) => first.state.assignment.get(es.find((e) => clusterOf(e.id) === cl)!.id)!;
    // plant: two entries of cluster 0 and one of cluster 5 filed in the wrong leaf
    const moved = [es.find((e) => clusterOf(e.id) === 0)!, es.filter((e) => clusterOf(e.id) === 0)[1], es.find((e) => clusterOf(e.id) === 5)!];
    const wrong = new Map(first.state.assignment);
    wrong.set(moved[0].id, sectionOfCluster(1)); wrong.set(moved[1].id, sectionOfCluster(1)); wrong.set(moved[2].id, sectionOfCluster(6));
    const onDisk = es.map((e) => ({ ...e, section: wrong.get(e.id)! }));
    let asked = 0;
    const counting: Namer = async () => { asked++; return { title: "New Name", summary: "x" }; };
    const second = await planRebuild({
      domain: "wp", entries: onDisk, namer: counting,
      start: { sections: first.state.sections, assignment: wrong },
      oldSections: first.state.sections,
    });
    expect(second.from).toBe("current");
    expect(second.moves.map((m) => m.id).sort()).toEqual(moved.map((m) => m.id).sort());
    for (const m of second.moves) expect(m.to).toBe(sectionOfCluster(clusterOf(m.id)));
    for (const e of es) expect(second.state.assignment.get(e.id)).toBe(first.state.assignment.get(e.id));
    // same tree, same ids, same names; nobody was re-asked
    expect(asked).toBe(0);
    expect(second.state.sections.map((s) => [s.id, s.title]).sort()).toEqual(first.state.sections.map((s) => [s.id, s.title]).sort());
    expect(second.reused.size).toBe(first.state.sections.length);
    expect(second.labelKept.size).toBe(first.state.sections.length);
    expect(second.judged.filter((j) => j.outcome === "split")).toHaveLength(0); // nothing oversized and substructured is left
  }, 600_000);

  it("a section that changed membership by less than .7 keeps its id but is re-named", async () => {
    const es = clustersFixture();
    const first = await planRebuild({ domain: "wp", entries: es, namer: unique });
    const leafOfCluster = first.state.assignment.get(es.find((e) => clusterOf(e.id) === 0)!.id)!;
    // the old file says that leaf also held 8 entries of other clusters: overlap = 10/(10+18-10) ~ .55
    const onDisk = es.map((e) => ({ ...e, section: first.state.assignment.get(e.id)! }));
    const others = onDisk.filter((e) => clusterOf(e.id) === 1).slice(0, 8);
    for (const e of others) e.section = leafOfCluster;
    const asked: string[] = [];
    const namer: Namer = async (c) => { asked.push(c.members[0].title); return { title: `Renamed ${asked.length}`, summary: "r" }; };
    const plan = await planRebuild({ domain: "wp", entries: onDisk, namer, oldSections: first.state.sections });
    expect(plan.reused.has(leafOfCluster)).toBe(true);
    expect(plan.labelKept.has(leafOfCluster)).toBe(false);
    expect(plan.state.sections.find((s) => String(s.id) === leafOfCluster)!.title).toMatch(/^Renamed/);
  }, 600_000);

  it("a cap wrapper whose title restates its parent is re-asked, then dissolved (children go back to the parent)", async () => {
    const es = clustersFixture();
    const namer: Namer = async (c) => {
      if (!c.parentTitle) return { title: "Platform Services", summary: "root" };
      if (c.members.length > 0 && c.depth === 1) return { title: "Platform Services Group", summary: "wrapper" }; // restates the parent
      return { title: `Leaf ${++n}`, summary: "l" };
    };
    const plan = await planRebuild({ domain: "wp", entries: es, namer });
    expect(plan.rejected.some((r) => r.reason === "wrapper-label-restates-parent")).toBe(true);
    expect(plan.capWrappers.size).toBe(0);
    const root = plan.state.sections.filter((s) => s.parent === null);
    expect(root).toHaveLength(1);
    expect(plan.state.sections.filter((s) => String(s.parent) === String(root[0].id))).toHaveLength(8);
    expect(plan.state.sections.every((s) => s.title !== "")).toBe(true);
  }, 600_000);

  it("inserts into a built tree land in their cluster's section, create nothing, and a second pass is a no-op", async () => {
    const es = clustersFixture();
    const held = [0, 1, 2, 3, 4, 5, 6, 7].map((c) => es.filter((e) => clusterOf(e.id) === c).at(-1)!);
    const base = es.filter((e) => !held.includes(e));
    const reb = await planRebuild({ domain: "wp", entries: base, namer: unique });
    const st: RebuildState = { sections: structuredClone(reb.state.sections), assignment: new Map(reb.state.assignment) };
    const vec = new Map(base.map((e) => [e.id, e.vector]));
    const before = st.sections.map((s) => String(s.id)).sort();
    for (const e of held) {
      const sec = await insertEntry(st, e, vec, "wp");
      const mates = [...st.assignment].filter(([id, x]) => x === sec && id !== e.id).map(([id]) => clusterOf(id));
      expect(mates.length).toBeGreaterThan(0);
      expect(mates.every((c) => c === clusterOf(e.id)), `${e.id} landed among clusters ${[...new Set(mates)]}`).toBe(true);
      await yieldLoop();
    }
    expect(st.sections.map((s) => String(s.id)).sort()).toEqual(before); // nothing crossed the split threshold
    const snap = () => JSON.stringify({ s: st.sections.map((s) => [s.id, s.parent, s.memberCount]), a: [...st.assignment].sort() });
    const snapshot = snap();
    for (const s of [...st.sections]) { expect(await repairPath(st, String(s.id), vec, "wp")).toEqual([]); await yieldLoop(); }
    expect(snap()).toBe(snapshot);
  }, 600_000);

  // Interleaved or sorted delivery both converge here because the vectors are unit length, as the embedder's are.
  // (With non-unit vectors embed.cosine clamps every similarity to 1 and placement degenerates; the fixture normalises for that reason.)
  it("growing from empty one by one reproduces the rebuild (ARI >= .7)", async () => {
    const es = clustersFixture();
    const ids = es.map((e) => e.id).sort();
    const reb = await planRebuild({ domain: "wp", entries: es, namer: unique });
    const st: RebuildState = { sections: [], assignment: new Map() };
    const vec = new Map<string, number[]>();
    for (const e of es) { await insertEntry(st, e, vec, "wp"); await yieldLoop(); }
    const lab = (x: RebuildState) => { const m = new Map<string, number>(); return ids.map((i) => { const y = x.assignment.get(i)!; if (!m.has(y)) m.set(y, m.size); return m.get(y)!; }); };
    expect(ari(lab(reb.state), lab(st))).toBeGreaterThanOrEqual(0.7);
  }, 1_200_000);

  describe("refinement stays inside one top-level section", () => {
    // Two top-level sections: A holds clusters 0-3 (one leaf each), B holds clusters 4-7. Plant a cluster-1 entry in B's cluster-4 leaf
    // (cross-section) and a cluster-0 entry in cluster 2's leaf (same section).
    async function setup(applyCrossMoves: boolean) {
      const es = clustersFixture();
      const first = await planRebuild({ domain: "wp", entries: es, namer: unique, start: undefined });
      const leafOf = (cl: number) => first.state.assignment.get(es.find((e) => clusterOf(e.id) === cl)!.id)!;
      const topOf = (id: string) => { let s = first.state.sections.find((x) => String(x.id) === id)!; while (s.parent) s = first.state.sections.find((x) => x.id === s.parent)!; return String(s.id); };
      // flatten into two roots: A = {0..3}, B = {4..7}
      const sections = structuredClone(first.state.sections).filter((s) => !first.capWrappers.has(String(s.id)) && s.parent !== null || false);
      const rootA = { ...structuredClone(first.state.sections.find((s) => s.parent === null)!), id: "sec-wp-rootAA", childIds: [] as any[], parent: null, title: "A" } as any;
      const rootB = { ...structuredClone(rootA), id: "sec-wp-rootBB", title: "B" } as any;
      const leaves = sections.filter((s) => !first.state.sections.some((c) => c.parent === s.id));
      const cl = (leaf: any) => clusterOf([...first.state.assignment].find(([, v]) => v === String(leaf.id))![0]);
      for (const l of leaves) { l.parent = cl(l) < 4 ? rootA.id : rootB.id; l.depth = 1; }
      const all = [rootA, rootB, ...leaves];
      const assignment = new Map(first.state.assignment);
      const crossE = es.filter((e) => clusterOf(e.id) === 1)[0], sameE = es.filter((e) => clusterOf(e.id) === 0)[0];
      assignment.set(crossE.id, leafOf(4)); assignment.set(sameE.id, leafOf(2));
      void topOf;
      const onDisk = es.map((e) => ({ ...e, section: assignment.get(e.id)! }));
      const plan = await planRebuild({ domain: "wp", entries: onDisk, namer: unique, start: { sections: all, assignment }, applyCrossMoves });
      return { plan, leafOf, crossE, sameE, es };
    }
    it("a same-section misfiling is moved; a cross-section one is only proposed (with scores) and its entry stays put", async () => {
      const { plan, leafOf, crossE, sameE } = await setup(false);
      expect(plan.moves.map((m) => m.id)).toEqual([sameE.id]);
      expect(plan.state.assignment.get(sameE.id)).toBe(leafOf(0));
      expect(plan.crossMoves.map((m) => m.id)).toEqual([crossE.id]);
      expect(plan.state.assignment.get(crossE.id)).toBe(leafOf(4));
      expect(plan.crossMoves[0].better).toBeGreaterThan(plan.crossMoves[0].own);
      const { renderProposal } = await import("./rebuild.js");
      const md = renderProposal(plan);
      expect(md).toContain("## Proposed cross-section moves (needs approval)");
      expect(md).toMatch(/similarity to own section \d\.\d\d, to the target \d\.\d\d/);
    }, 600_000);
    it("--apply-cross-moves applies it", async () => {
      const { plan, leafOf, crossE } = await setup(true);
      expect(plan.state.assignment.get(crossE.id)).toBe(leafOf(1));
      expect(plan.crossMoves).toEqual([]);
      expect(plan.moves.map((m) => m.id)).toContain(crossE.id);
    }, 600_000);
  });

  describe("proposal consistency", () => {
    const rootTotals = (md: string) => [...md.matchAll(/^- \*\*.*?— (\d+) entries/gm)].map((m) => Number(m[1]));
    it("the top-level totals in the proposal sum to the entry count, and every line's direct + children = total", async () => {
      const es = clustersFixture();
      const grouped = new Map([[es[0].id, es[1].id]]); // one grouped entry follows its holder
      const plan = await planRebuild({ domain: "wp", entries: es, namer: unique, grouped });
      const { renderProposal } = await import("./rebuild.js");
      const md = renderProposal(plan);
      const topLevel = [...md.matchAll(/^- \*\*.*?— (\d+) entries/gm)].map((m) => Number(m[1]));
      expect(topLevel.reduce((a, b) => a + b, 0)).toBe(plan.entries.length);
      expect(md).toContain(`hold ${plan.entries.length} of ${plan.entries.length} entries.`);
      expect([...md.matchAll(/^ *- \*\*.*?— \d+ entries/gm)].length).toBe(plan.state.sections.length);
      const direct = [...plan.state.assignment].filter(([e]) => !plan.grouped.has(e)).length;
      expect(direct).toBe(plan.entries.length);
    }, 600_000);

    it("moved entries are counted once, and an entry is never both a move and a leftover", async () => {
      const es = clustersFixture();
      const first = await planRebuild({ domain: "wp", entries: es, namer: unique });
      const leafOf = (cl: number) => first.state.assignment.get(es.find((e) => clusterOf(e.id) === cl)!.id)!;
      const wrong = new Map(first.state.assignment);
      const planted = es.filter((e) => clusterOf(e.id) === 0).slice(0, 2);
      for (const e of planted) wrong.set(e.id, leafOf(1));
      const onDisk = es.map((e) => ({ ...e, section: wrong.get(e.id)! }));
      const plan = await planRebuild({ domain: "wp", entries: onDisk, namer: unique, start: { sections: first.state.sections, assignment: wrong }, oldSections: first.state.sections });
      expect(plan.moves.map((m) => m.id).sort()).toEqual(planted.map((e) => e.id).sort());
      const left = new Set([...plan.leftovers.values()].flat());
      for (const m of plan.moves) expect(left.has(m.id)).toBe(false);
      const { renderProposal } = await import("./rebuild.js");
      expect(rootTotals(renderProposal(plan)).reduce((a, b) => a + b, 0)).toBe(plan.entries.length);
      expect(plan.state.sections.reduce((n, s) => n + s.memberCount, 0)).toBe(plan.entries.length);
    }, 600_000);

    it("a moved entry that its new section then judges a leftover is listed once, under moves (staysInParent), not under leftovers", async () => {
      const es = clustersFixture();
      // one section holding everything; an off-topic stray the LLM-less split will not group
      const stray = { ...es[0], id: "c9-stray", title: "stray", vector: es[0].vector.map((x, i) => (i === 7 ? 0.9 : x * 0.1)) };
      const all = [...es, stray];
      const plan = await planRebuild({ domain: "wp", entries: all, namer: unique });
      const left = new Set([...plan.leftovers.values()].flat());
      for (const m of plan.moves) expect(left.has(m.id)).toBe(false);
      const ids = plan.state.sections.map((s) => String(s.id));
      expect(new Set(ids).size).toBe(ids.length);
    }, 600_000);

    it("id reuse never gives a live section's id to another section (no duplicate ids, totals intact)", async () => {
      const es = clustersFixture();
      const first = await planRebuild({ domain: "wp", entries: es, namer: unique });
      // the old tree: a big section X holding clusters 0+1; its id is also what a child of the new tree overlaps >= .5 with
      const x = { ...structuredClone(first.state.sections.find((s) => s.parent === null)!), id: "sec-wp-bigold", parent: null, childIds: [], depth: 0, title: "Big" } as any;
      const assign = new Map(es.map((e) => [e.id, "sec-wp-bigold"] as [string, string]));
      const plan = await planRebuild({ domain: "wp", entries: es.map((e) => ({ ...e, section: "sec-wp-bigold" })), namer: unique, start: { sections: [x], assignment: assign }, oldSections: [x] });
      const ids = plan.state.sections.map((s) => String(s.id));
      expect(new Set(ids).size).toBe(ids.length);
      expect(plan.state.sections.reduce((n, s) => n + s.memberCount, 0)).toBe(es.length);
      const { renderProposal } = await import("./rebuild.js");
      const md = renderProposal(plan);
      expect(md).not.toContain("MISMATCH");
    }, 600_000);
  });
});
