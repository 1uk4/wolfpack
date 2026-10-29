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
      const sec = insertEntry(st, e, vec, "wp");
      const mates = [...st.assignment].filter(([id, x]) => x === sec && id !== e.id).map(([id]) => clusterOf(id));
      expect(mates.length).toBeGreaterThan(0);
      expect(mates.every((c) => c === clusterOf(e.id)), `${e.id} landed among clusters ${[...new Set(mates)]}`).toBe(true);
      await yieldLoop();
    }
    expect(st.sections.map((s) => String(s.id)).sort()).toEqual(before); // nothing crossed the split threshold
    const snap = () => JSON.stringify({ s: st.sections.map((s) => [s.id, s.parent, s.memberCount]), a: [...st.assignment].sort() });
    const snapshot = snap();
    for (const s of [...st.sections]) { expect(repairPath(st, String(s.id), vec, "wp")).toEqual([]); await yieldLoop(); }
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
    for (const e of es) { insertEntry(st, e, vec, "wp"); await yieldLoop(); }
    const lab = (x: RebuildState) => { const m = new Map<string, number>(); return ids.map((i) => { const y = x.assignment.get(i)!; if (!m.has(y)) m.set(y, m.size); return m.get(y)!; }); };
    expect(ari(lab(reb.state), lab(st))).toBeGreaterThanOrEqual(0.7);
  }, 1_200_000);
});
