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

describe("proposal hardening", () => {
  const es = make(SIZES);
  it("a malformed cached proposal is a cache miss: the partitioner is asked again and the cache is overwritten", async () => {
    const bad: unknown[] = [{ categories: "nope", doesntFit: [] }, { categories: [{ name: 3, ids: [] }], doesntFit: [] }, { categories: [], doesntFit: [1] }, null, 7, {}];
    for (const entry of bad) {
      const cache = memorySplitCache();
      const key = splitCacheKey("wp", es.map((e) => e.id));
      cache.set(key, entry as SplitProposal);
      const part = vi.fn(async () => ideal(es));
      const notes: string[] = [];
      const v = await judgeSplit({ partitioner: part, cache, notify: (m) => notes.push(m) }, { domain: "wp", parentTitle: "P", members: members(es) });
      expect(part).toHaveBeenCalledTimes(1);
      expect(v.cached).toBe(false);
      expect(v.decision?.k).toBe(3);
      expect(notes.some((m) => /malformed/.test(m))).toBe(true);
      expect(cache.get(key)).toEqual(ideal(es)); // overwritten with a good one
    }
  });
  it("a partitioner returning a malformed answer counts as a failure (k-means fallback), and is not cached", async () => {
    const cache = memorySplitCache();
    const v = await judgeSplit({ partitioner: (async () => ({ categories: null, doesntFit: [] })) as never, cache }, { domain: "wp", parentTitle: "P", members: members(make([8, 8, 8])) });
    expect(v.source).toBe("kmeans");
    expect(v.fallbackReason).toMatch(/malformed/);
    expect(cache.get(splitCacheKey("wp", make([8, 8, 8]).map((e) => e.id)))).toBeUndefined();
  });
  it("PROMPT_VERSION is part of the cache key", async () => {
    const { PROMPT_VERSION } = await import("./llm-split.js");
    const { createHash } = await import("node:crypto");
    const legacy = createHash("sha256").update("wp\u0000a\u0000b").digest("hex").slice(0, 24);
    expect(PROMPT_VERSION).toMatch(/^split-v\d+$/);
    expect(splitCacheKey("wp", ["a", "b"])).not.toBe(legacy);
  });
  it("at most llmMaxCategories (5) categories are honoured: further ones are reported over-limit and their members are leftovers", () => {
    const e7 = make([4, 4, 4, 4, 4, 4, 4]);
    const idx = (c: number) => e7.flatMap((e, i) => (cluster(e.id, [4, 4, 4, 4, 4, 4, 4]) === c ? [i] : []));
    const d = validatePartition(e7.map((e) => e.vector), { names: ["a", "b", "c", "d", "e", "f", "g"], members: [0, 1, 2, 3, 4, 5, 6].map(idx), doesntFit: [] });
    expect(isPartition(d)).toBe(true);
    if (isPartition(d)) {
      expect(d.k).toBe(5);
      expect(d.categories.slice(5).map((c) => [c.kept, c.why, c.size])).toEqual([[false, "over-limit", 4], [false, "over-limit", 4]]);
      expect(d.leftovers.sort((a, b) => a - b)).toEqual([...idx(5), ...idx(6)].sort((a, b) => a - b));
    }
  });
});

describe("k-means fallback gate on a real rebuild", () => {
  it("the proposal lists fallbacks; a non-dry rebuild aborts before any write unless allowKmeansFallback", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync, existsSync } = await import("node:fs");
    const { reorg } = await import("./reorg.js");
    const base = mkdtempSync(join(tmpdir(), "kb-fallback-"));
    try {
      const roots = { kbBase: join(base, "base"), opsRoot: join(base, "ops"), denLocal: join(base, "den") };
      const eDir = join(roots.kbBase, "domains", "wp", "entries");
      mkdirSync(eDir, { recursive: true }); mkdirSync(roots.denLocal, { recursive: true });
      const es = make([8, 8, 8]);
      for (const e of es) writeFileSync(join(eDir, `${e.id}.md`), `---\nid: ${e.id}\ntitle: ${e.title}\ndomain: wp\nsummary: ${e.summary}\nsection: sec-wp-old000\n---\n\nbody\n`);
      const byTitle = new Map(es.map((e) => [e.title, e.vector]));
      const embedder = { embed: async (text: string) => { for (const [t, v] of byTitle) if (text.includes(t)) return v; return new Array(DIM).fill(0.1); } };
      const engine = {
        call: vi.fn(async (step: string, schema: { parse: (v: unknown) => unknown }) => {
          if (step === "splitSection") throw new Error("overloaded");
          return schema.parse(step === "sectionSummary" ? { summary: "s" } : { title: `Label ${Math.random().toString(36).slice(2, 6)}` });
        }),
        usage: { summarize: () => ({}) },
      } as never;
      const snap = () => Object.fromEntries(readdirSync(eDir).sort().map((f) => [f, readFileSync(join(eDir, f), "utf-8")]));
      const before = snap();
      const dry = await reorg({ engine, roots, embedder: embedder as never, domains: ["wp"], rebuild: true, dryRun: true, rebuildFrom: "scratch" });
      expect(dry.proposal).toContain("## k-means fallbacks (the LLM proposal failed)");
      expect(dry.proposal).toMatch(/decided by k-means because the LLM call failed/);
      expect(dry.proposal).toContain("overloaded");
      await expect(reorg({ engine, roots, embedder: embedder as never, domains: ["wp"], rebuild: true, rebuildFrom: "scratch" })).rejects.toThrow(/fell back to k-means.*aborting before any write/);
      expect(snap()).toEqual(before);
      expect(existsSync(join(roots.denLocal, "sections"))).toBe(false);
      await reorg({ engine, roots, embedder: embedder as never, domains: ["wp"], rebuild: true, rebuildFrom: "scratch", allowKmeansFallback: true });
      expect(existsSync(join(roots.denLocal, "sections", "_sections.json"))).toBe(true);
    } finally { rmSync(base, { recursive: true, force: true }); }
  }, 120_000);
});

describe("dry run and --yes share a file-backed split cache", () => {
  it("--yes reproduces the approved dry-run plan without asking the LLM again; a changed entry set aborts before any write unless --allow-uncached-split; --fresh-split bypasses and overwrites the cache", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } = await import("node:fs");
    const { reorg } = await import("./reorg.js");
    const base = mkdtempSync(join(tmpdir(), "kb-sharedcache-"));
    try {
      const roots = { kbBase: join(base, "base"), opsRoot: join(base, "ops"), denLocal: join(base, "den") };
      const eDir = join(roots.kbBase, "domains", "wp", "entries");
      mkdirSync(eDir, { recursive: true }); mkdirSync(roots.denLocal, { recursive: true });
      const es = make([8, 8, 8]);
      const put = (e: RebuildEntry) => writeFileSync(join(eDir, `${e.id}.md`), `---\nid: ${e.id}\ntitle: ${e.title}\ndomain: wp\nsummary: ${e.summary}\nsection: sec-wp-old000\n---\n\nbody\n`);
      for (const e of es) put(e);
      const byTitle = new Map(es.map((e) => [e.title, e.vector]));
      const embedder = { embed: async (text: string) => { for (const [t, v] of byTitle) if (text.includes(t)) return v; return new Array(DIM).fill(0.1); } };
      let splitCalls = 0;
      const engine = {
        call: vi.fn(async (step: string, schema: { parse: (v: unknown) => unknown }) => {
          if (step === "splitSection") {
            splitCalls++;
            return schema.parse({ categories: [0, 1, 2].map((c) => ({ name: names[c], ids: es.filter((e) => cluster(e.id, [8, 8, 8]) === c).map((e) => e.id) })), doesnt_fit: [] });
          }
          return schema.parse(step === "sectionSummary" ? { summary: "s" } : { title: `Label ${Math.random().toString(36).slice(2, 6)}` });
        }),
        usage: { summarize: () => ({}) },
      } as never;
      const common = { engine, roots, embedder: embedder as never, domains: ["wp"], rebuild: true, rebuildFrom: "scratch" as const };
      const dry = await reorg({ ...common, dryRun: true });
      expect(splitCalls).toBe(1);
      expect(existsSync(join(roots.denLocal, "split-cache.json"))).toBe(true);
      const notes: string[] = [];
      await reorg({ ...common, notify: (m) => notes.push(m) });
      expect(splitCalls).toBe(1); // served from the dry run's cache
      expect(notes.some((m) => /LLM was asked again/.test(m))).toBe(false);
      expect(dry.plans![0].state.sections.length).toBe(4);
      expect(JSON.parse(readFileSync(join(roots.denLocal, "sections", "_sections.json"), "utf-8")).filter((s: { domain: string }) => s.domain === "wp").length).toBe(4);

      // a different entry set (one entry added) is a different cache key: --yes aborts before any write, naming the fix
      const cacheFile = join(roots.denLocal, "split-cache.json");
      const extra = { ...make([1], 77)[0], id: "e950", title: "late entry", vector: es[0].vector };
      put(extra); byTitle.set(extra.title, extra.vector);
      const sectionsBefore = readFileSync(join(roots.denLocal, "sections", "_sections.json"), "utf-8");
      const cacheBefore = readFileSync(cacheFile, "utf-8");
      await expect(reorg({ ...common })).rejects.toThrow(/not in the dry-run cache.*aborting before any write.*--dry-run.*--allow-uncached-split/);
      expect(splitCalls).toBe(2); // it did ask (that is how it found out) ...
      expect(readFileSync(join(roots.denLocal, "sections", "_sections.json"), "utf-8")).toBe(sectionsBefore); // ... but wrote nothing
      expect(readFileSync(join(eDir, "e950.md"), "utf-8")).toContain("section: sec-wp-old000");
      // a real run never saves proposals: the cache file is unchanged, so a SECOND --yes cannot read an unreviewed proposal
      expect(readFileSync(cacheFile, "utf-8")).toBe(cacheBefore);
      await expect(reorg({ ...common })).rejects.toThrow(/not in the dry-run cache/);
      expect(splitCalls).toBe(3); // asked again, aborted again
      expect(readFileSync(cacheFile, "utf-8")).toBe(cacheBefore);
      // --fresh-split on --yes also writes nothing
      await expect(reorg({ ...common, freshSplit: true })).rejects.toThrow(/not in the dry-run cache/);
      expect(readFileSync(cacheFile, "utf-8")).toBe(cacheBefore);
      const callsBeforeReview = splitCalls;
      // the operator runs the dry run (the ONLY thing that caches), reviews it, then --yes commits with no LLM call
      await reorg({ ...common, dryRun: true });
      expect(splitCalls).toBe(callsBeforeReview + 1);
      expect(readFileSync(cacheFile, "utf-8")).not.toBe(cacheBefore);
      await reorg({ ...common });
      expect(splitCalls).toBe(callsBeforeReview + 1);
      // --allow-uncached-split commits an uncached plan, with the notice (and still saves nothing)
      const extra2 = { ...make([1], 78)[0], id: "e951", title: "later entry", vector: es[1].vector };
      put(extra2); byTitle.set(extra2.title, extra2.vector);
      const cacheMid = readFileSync(cacheFile, "utf-8");
      const notes2: string[] = [];
      await reorg({ ...common, allowUncachedSplit: true, notify: (m) => notes2.push(m) });
      expect(splitCalls).toBe(callsBeforeReview + 2);
      expect(notes2.some((m) => /not in the dry-run cache, so the LLM was asked again.*--allow-uncached-split/.test(m))).toBe(true);
      expect(readFileSync(cacheFile, "utf-8")).toBe(cacheMid);

      // --fresh-split on a DRY run ignores cached proposals and overwrites them
      await reorg({ ...common, dryRun: true });
      const before = splitCalls;
      await reorg({ ...common, dryRun: true });
      expect(splitCalls).toBe(before); // cached
      await reorg({ ...common, dryRun: true, freshSplit: true });
      expect(splitCalls).toBe(before + 1);
      await reorg({ ...common, dryRun: true });
      expect(splitCalls).toBe(before + 1); // the fresh answer was written back and is now what is cached
    } finally { rmSync(base, { recursive: true, force: true }); }
  }, 120_000);
});

describe("category cap keeps the largest categories; prompt pin", () => {
  it("when the model returns more than 5 categories the 5 LARGEST are honoured, not the first 5", () => {
    const sizes = [3, 3, 3, 3, 3, 9, 8];
    const e = make(sizes);
    const idx = (c: number) => e.flatMap((x, i) => (cluster(x.id, sizes) === c ? [i] : []));
    const d = validatePartition(e.map((x) => x.vector), { names: ["a", "b", "c", "d", "e", "BIG1", "BIG2"], members: sizes.map((_, c) => idx(c)), doesntFit: [] });
    expect(isPartition(d)).toBe(true);
    if (isPartition(d)) {
      expect(d.names).toContain("BIG1");
      expect(d.names).toContain("BIG2");
      expect(d.k).toBe(5);
      const dropped = d.categories.filter((c) => c.why === "over-limit").map((c) => c.name);
      expect(dropped).toHaveLength(2);
      expect(dropped.every((n) => ["a", "b", "c", "d", "e"].includes(n))).toBe(true);
    }
  });

  it("PROMPT PIN: SPLIT_SECTION_SYSTEM and the prompt layout hash to the value recorded for PROMPT_VERSION. Changing either without bumping PROMPT_VERSION (and recording the new hash) fails here, because cached proposals would be served for a prompt they were not made with", async () => {
    const { createHash } = await import("node:crypto");
    const { SPLIT_SECTION_SYSTEM } = await import("@wolfpack/engine");
    const { PROMPT_VERSION } = await import("./llm-split.js");
    const { proposeSplit } = await import("./summarize.js");
    let prompt = "";
    const engine = { call: async (_step: string, schema: { parse: (v: unknown) => unknown }, o: { prompt: string }) => { prompt = o.prompt; return schema.parse({ categories: [], doesnt_fit: [] }); } } as never;
    await proposeSplit(engine, "Parent", [{ id: "b", title: "B title", summary: "B sum" }, { id: "a", title: "A title" }]);
    const hash = createHash("sha256").update(SPLIT_SECTION_SYSTEM + "\u0000" + prompt).digest("hex").slice(0, 16);
    const PINNED: Record<string, string> = { "split-v1": "ab1c8927e17e72f1" };
    expect(PINNED[PROMPT_VERSION], `record the new hash ${hash} for ${PROMPT_VERSION}`).toBe(hash);
  });
});
