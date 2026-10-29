import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { judgeSplit, memorySplitCache, fileSplitCache, splitCacheKey, type Partitioner, type SplitProposal, type JudgeMember } from "./llm-split.js";
import { planRebuild, insertEntry, repairPath, type RebuildEntry, type Namer, type RebuildState } from "./rebuild.js";
import { validatePartition, isPartition, rng } from "./tree-rules.js";

const DIM = 24;
/** n entries per cluster `axes[c]`, unit length (like the embedder's). */
function make(sizes: number[], seed = 3): RebuildEntry[] {
  const r = rng(seed);
  const out: RebuildEntry[] = [];
  let i = 0;
  sizes.forEach((n, c) => {
    for (let k = 0; k < n; k++, i++) {
      const v = Array.from({ length: DIM }, (_, d) => (d === 0 ? 3 : 0) + (d === c + 1 ? 1.6 : 0) + (r() + r() + r() - 1.5) * 0.12);
      const norm = Math.hypot(...v);
      out.push({ id: `e${String(i).padStart(3, "0")}`, title: `entry ${i} of topic ${c}`, summary: `topic ${c}`, vector: v.map((x) => x / norm) });
    }
  });
  return out;
}
const cluster = (id: string, sizes: number[]) => { let n = Number(id.slice(1)); for (let c = 0; c < sizes.length; c++) { if (n < sizes[c]) return c; n -= sizes[c]; } return -1; };
const members = (es: RebuildEntry[]): JudgeMember[] => es.map((e) => ({ id: e.id, title: e.title, summary: e.summary, vector: e.vector }));
const SIZES = [6, 6, 6];
const names = ["Alpha Handling", "Beta Routing", "Gamma Storage"];
/** The perfect proposal for `es`: one category per cluster. */
function ideal(es: RebuildEntry[], sizes = SIZES, stray: string[] = []): SplitProposal {
  return { categories: sizes.map((_, c) => ({ name: names[c], ids: es.filter((e) => cluster(e.id, sizes) === c && !stray.includes(e.id)).map((e) => e.id) })), doesntFit: stray };
}

describe("validatePartition (vectors validate, never assign)", () => {
  it("keeps coherent categories whole", () => {
    const es = make(SIZES);
    const d = validatePartition(es.map((e) => e.vector), { names, members: [0, 1, 2].map((c) => es.flatMap((e, i) => (cluster(e.id, SIZES) === c ? [i] : []))), doesntFit: [] });
    expect(isPartition(d)).toBe(true);
    if (isPartition(d)) { expect(d.k).toBe(3); expect(d.leftovers).toEqual([]); expect(d.names).toEqual(names); }
  });
  it("a member that sits with the wrong category becomes a leftover; the category survives at >= 70% coherence", () => {
    const es = make([8, 8, 6]);
    const idx = (c: number) => es.flatMap((e, i) => (cluster(e.id, [8, 8, 6]) === c ? [i] : []));
    // put one cluster-1 entry into category 0
    const members = [[...idx(0), idx(1)[0]], idx(1).slice(1), idx(2)];
    const d = validatePartition(es.map((e) => e.vector), { names, members, doesntFit: [] });
    expect(isPartition(d)).toBe(true);
    if (isPartition(d)) { expect(d.leftovers).toEqual([idx(1)[0]]); expect(d.k).toBe(3); }
  });
  it("a category mixing two clusters is dropped and its members become leftovers", () => {
    const es = make([6, 6, 6, 6]);
    const idx = (c: number) => es.flatMap((e, i) => (cluster(e.id, [6, 6, 6, 6]) === c ? [i] : []));
    // two "categories" that both mix clusters 2 and 3: neither is coherent against the other
    const mixA = [...idx(2).slice(0, 3), ...idx(3).slice(0, 3)], mixB = [...idx(2).slice(3), ...idx(3).slice(3)];
    const d = validatePartition(es.map((e) => e.vector), { names: ["A", "B", "Mix 1", "Mix 2"], members: [idx(0), idx(1), mixA, mixB], doesntFit: [] });
    expect(isPartition(d)).toBe(true);
    if (isPartition(d)) {
      expect(d.k).toBe(2);
      expect(d.categories.map((c) => c.kept)).toEqual([true, true, false, false]);
      expect(d.categories[2].why === "low-share" || d.categories[2].why === "too-few-coherent").toBe(true);
      expect(d.leftovers.sort((a, b) => a - b)).toEqual([...mixA, ...mixB].sort((a, b) => a - b));
    }
  });
  it("the bar is .7: a category with 7 of 10 coherent members survives, 6 of 10 does not", () => {
    const es = make([10, 10, 6]);
    const idx = (c: number) => es.flatMap((e, i) => (cluster(e.id, [10, 10, 6]) === c ? [i] : []));
    const run = (strays: number) => {
      // `strays` members of cluster 0 are filed under category 1 (so cluster 0 keeps 10 - strays coherent ones)
      const c0 = idx(0), c1 = idx(1);
      const cat0 = [...c0.slice(strays), ...c1.slice(0, 0)];
      const cat1 = [...c1, ...c0.slice(0, strays)];
      // category 0 is 10 - strays long; build the "10 with N wrong" case on category 1 instead
      return validatePartition(es.map((e) => e.vector), { names: ["A", "B", "C"], members: [cat0, cat1, idx(2)], doesntFit: [] });
    };
    const d3 = run(3), d4 = run(4);
    expect(isPartition(d3) && d3.categories.map((c) => c.kept)).toEqual([true, true, true]);
    expect(isPartition(d4) && d4.categories.map((c) => c.kept)).toEqual([true, true, true]);
    // 13 proposed in B, 10 coherent = 77%: kept at .7 (it would be dropped at .8)
    expect(isPartition(d3) && d3.categories[1].share).toBeCloseTo(10 / 13, 5);
    expect(isPartition(d3) && d3.categories[1].share).toBeGreaterThanOrEqual(0.7);
    expect(isPartition(d3) && d3.categories[1].share).toBeLessThan(0.8);
  });
  it("fewer than two surviving categories: no split", () => {
    const es = make(SIZES);
    const r = validatePartition(es.map((e) => e.vector), { names: ["All"], members: [es.map((_, i) => i)], doesntFit: [] });
    expect(isPartition(r)).toBe(false);
  });
});

describe("judgeSplit", () => {
  const es = make(SIZES);
  const stray = make([1], 99).map((e) => ({ ...e, id: "e900", vector: es[0].vector.map((x, i) => (i === 0 ? x : -x)) }));

  it("accepted split: categories become groups, doesn't-fit members are leftovers, names are carried", async () => {
    const withStray = [...es, ...stray, ...make([1], 5).map((e, i) => ({ ...e, id: `e91${i}`, vector: es[7].vector }))];
    const sz = SIZES;
    const proposal = ideal(withStray, sz, ["e900"]);
    const part: Partitioner = async () => proposal;
    const v = await judgeSplit({ partitioner: part, rules: undefined }, { domain: "wp", parentTitle: "Parent", members: members(withStray) });
    expect(v.source).toBe("llm");
    expect(v.decision?.k).toBe(3);
    expect(v.decision?.names).toEqual(names);
    const ids = withStray.map((e) => e.id).sort();
    const left = (v.decision?.leftovers ?? []).map((i) => ids[i]);
    expect(left).toContain("e900");
    expect(v.doesntFit).toEqual(["e900"]);
    expect(v.categories?.every((c) => c.kept)).toBe(true);
  });

  it("a category dropped for incoherence is reported, and its members are leftovers", async () => {
    const e4 = make([6, 6, 6, 6]);
    const c2 = e4.filter((e) => cluster(e.id, [6, 6, 6, 6]) === 2), c3 = e4.filter((e) => cluster(e.id, [6, 6, 6, 6]) === 3);
    const mixed = [...c2.slice(0, 3), ...c3.slice(0, 3)];
    const rest = [...c2.slice(3), ...c3.slice(3)];
    const part: Partitioner = async () => ({
      categories: [
        { name: "A", ids: e4.filter((e) => cluster(e.id, [6, 6, 6, 6]) === 0).map((e) => e.id) },
        { name: "B", ids: e4.filter((e) => cluster(e.id, [6, 6, 6, 6]) === 1).map((e) => e.id) },
        { name: "Mixed bag", ids: mixed.map((e) => e.id) },
        { name: "Other mixed bag", ids: rest.map((e) => e.id) },
      ],
      doesntFit: [],
    });
    const v = await judgeSplit({ partitioner: part }, { domain: "wp", parentTitle: "P", members: members(e4) });
    expect(v.decision?.k).toBe(2);
    expect(v.decision?.names).toEqual(["A", "B"]);
    expect(v.categories?.find((c) => c.name === "Mixed bag")?.kept).toBe(false);
    expect(v.decision?.leftovers).toHaveLength(12);
  });

  it("everything a leftover: no split, with the reason", async () => {
    const part: Partitioner = async () => ({ categories: [], doesntFit: es.map((e) => e.id) });
    const v = await judgeSplit({ partitioner: part }, { domain: "wp", parentTitle: "P", members: members(es) });
    expect(v.decision).toBeUndefined();
    expect(v.reason).toBe("no-coherent-category");
    expect(v.source).toBe("llm"); // the LLM's answer stands; k-means does not override it
  });

  it("LLM failure falls back to k-means and says why", async () => {
    const part: Partitioner = async () => { throw new Error("overloaded"); };
    const notes: string[] = [];
    const v = await judgeSplit({ partitioner: part, notify: (m) => notes.push(m) }, { domain: "wp", parentTitle: "P", members: members(make([8, 8, 8])) });
    expect(v.source).toBe("kmeans");
    expect(v.fallbackReason).toBe("overloaded");
    expect(v.kmeans).toBeDefined();
    expect(notes[0]).toMatch(/falling back to k-means/);
    expect(v.decision?.k).toBe(3); // clear clusters: the fallback still finds them
  });

  it("no partitioner at all uses k-means; at or below splitAbove nothing is judged", async () => {
    expect((await judgeSplit({}, { domain: "wp", parentTitle: "P", members: members(make([8, 8, 8])) })).source).toBe("kmeans");
    const small = await judgeSplit({ partitioner: vi.fn() }, { domain: "wp", parentTitle: "P", members: members(make([5, 5])) });
    expect(small).toMatchObject({ source: "none", reason: "below-threshold" });
  });

  it("cache hit: the same member set (in any order) is asked once; a different set asks again", async () => {
    const part = vi.fn(async () => ideal(es));
    const cache = memorySplitCache();
    const a = await judgeSplit({ partitioner: part, cache }, { domain: "wp", parentTitle: "P", members: members(es) });
    const b = await judgeSplit({ partitioner: part, cache }, { domain: "wp", parentTitle: "P", members: members([...es].reverse()) });
    expect(part).toHaveBeenCalledTimes(1);
    expect(b.cached).toBe(true);
    expect(b.decision).toEqual(a.decision);
    await judgeSplit({ partitioner: part, cache }, { domain: "wp", parentTitle: "P", members: members(es.slice(0, 15)) });
    expect(part).toHaveBeenCalledTimes(2);
    expect(splitCacheKey("wp", ["b", "a"])).toBe(splitCacheKey("wp", ["a", "b"]));
    expect(splitCacheKey("wp", ["a"])).not.toBe(splitCacheKey("sj", ["a"]));
  });

  it("the file cache survives a new process (a second cache object reads it)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kb-splitcache-"));
    try {
      const file = join(dir, "sub", "split-cache.json");
      const part = vi.fn(async () => ideal(es));
      await judgeSplit({ partitioner: part, cache: fileSplitCache(file) }, { domain: "wp", parentTitle: "P", members: members(es) });
      const v = await judgeSplit({ partitioner: part, cache: fileSplitCache(file) }, { domain: "wp", parentTitle: "P", members: members(es) });
      expect(part).toHaveBeenCalledTimes(1);
      expect(v.cached).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("deterministic: the same inputs give the same verdict, and members reach the proposer in id order", async () => {
    const seen: string[][] = [];
    const part: Partitioner = async ({ members: m }) => { seen.push(m.map((x) => x.id)); return ideal(es); };
    const a = await judgeSplit({ partitioner: part }, { domain: "wp", parentTitle: "P", members: members(es) });
    const b = await judgeSplit({ partitioner: part }, { domain: "wp", parentTitle: "P", members: members([...es].reverse()) });
    expect(b).toEqual(a);
    expect(seen[0]).toEqual([...seen[0]].sort());
    expect(seen[1]).toEqual(seen[0]);
  });
});

describe("rebuild and insert path with an LLM partitioner", () => {
  const one = (es: RebuildEntry[]): RebuildState => ({
    sections: [{ id: "sec-wp-root00", domain: "wp", parent: null, depth: 0, label: "r", title: "Platform Services", centroid: [], memberCount: es.length, childIds: [], summary: "", summaryHash: "", dirty: true, memberCountAtLastLabel: 0, created: "x", updated: "x" } as any],
    assignment: new Map(es.map((e) => [e.id, "sec-wp-root00"])),
  });
  const es = make([6, 6, 6, 1]);
  const SZ = [6, 6, 6, 1];

  it("rebuild: the children's initial titles are the LLM's category names (only a summary is asked), and the proposal shows the coherence", async () => {
    const part = vi.fn(async () => ideal(es, SZ.slice(0, 3), ["e018"]));
    const asked: Array<{ fixed?: string }> = [];
    const namer: Namer = async (c) => { asked.push({ fixed: c.fixedTitle }); return { title: c.fixedTitle ?? "Platform Services", summary: "s" }; };
    const plan = await planRebuild({ domain: "wp", entries: es, namer, start: one(es), partitioner: part, diagnostics: true });
    expect(part).toHaveBeenCalledTimes(1);
    expect(plan.state.sections.filter((s) => s.parent).map((s) => s.title).sort()).toEqual([...names].sort());
    expect(asked.filter((a) => a.fixed).length).toBe(3);
    expect(plan.leftovers.get("sec-wp-root00")).toEqual(["e018"]);
    expect(plan.judged[0]).toMatchObject({ outcome: "split", source: "llm" });
    const { renderProposal } = await import("./rebuild.js");
    const md = renderProposal(plan);
    expect(md).toContain("proposed by the LLM");
    expect(md).toContain('"Alpha Handling": 6 proposed, 6 coherent (100%) → kept');
    expect(md).toContain("k-means diagnostic");
  });

  it("rebuild: a category name that restates the parent is re-asked with the parent forbidden", async () => {
    const part: Partitioner = async () => ({ categories: ideal(es, SZ.slice(0, 3)).categories.map((c, i) => ({ ...c, name: i === 0 ? "Platform Services Core" : c.name })), doesntFit: ["e018"] });
    const forbiddenSeen: string[][] = [];
    const namer: Namer = async (c) => {
      if (c.forbidden) { forbiddenSeen.push(c.forbidden); return { title: "Handler Pipeline", summary: "s" }; }
      return { title: c.fixedTitle ?? "Platform Services", summary: "s" };
    };
    const plan = await planRebuild({ domain: "wp", entries: es, namer, start: one(es), partitioner: part });
    expect(forbiddenSeen).toHaveLength(1);
    expect(plan.state.sections.map((s) => s.title)).toContain("Handler Pipeline");
    expect(plan.splitChildren.size).toBe(3);
  });

  it("insert path: the LLM is asked at most once per distinct member set, and a second pass asks nothing", async () => {
    const part = vi.fn(async ({ members: m }: { members: Array<{ id: string }> }) => {
      const ids = m.map((x) => x.id);
      return { categories: [0, 1, 2].map((c) => ({ name: names[c], ids: ids.filter((i) => cluster(i, SZ) === c) })), doesntFit: ids.filter((i) => cluster(i, SZ) === 3) };
    });
    const cache = memorySplitCache();
    const info = new Map<string, { title: string; summary?: string }>();
    const st: RebuildState = { sections: [], assignment: new Map() };
    const vec = new Map<string, number[]>();
    // clusters arrive in order, so the first 11+ members are two clusters and later ones keep landing in leaves
    for (const e of es) await insertEntry(st, e, vec, "wp", undefined, { partitioner: part, cache, info });
    const calls = part.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    const distinct = new Set(part.mock.calls.map((c) => c[0].members.map((x) => x.id).sort().join(",")));
    expect(distinct.size).toBe(calls); // never twice for the same set
    for (const s of [...st.sections]) expect(await repairPath(st, String(s.id), vec, "wp", undefined, { partitioner: part, cache, info })).toEqual([]);
    expect(part.mock.calls.length).toBe(calls); // second pass: all cache hits (or nothing above threshold)
  });
});
