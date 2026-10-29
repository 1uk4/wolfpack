import { describe, it, expect } from "vitest";
import {
  rng, hashSeed, centre, kmeansPP, chooseSplit, isSplit, extractLeftovers, findMisplaced,
  hashSectionId, restatesParent, ari, DEFAULT_RULES, type Vec,
} from "./tree-rules.js";

const DIM = 24;
/** Gaussian-ish noise from the seeded rng. */
function noise(r: () => number, s: number): Vec {
  return Array.from({ length: DIM }, () => (r() + r() + r() - 1.5) * s);
}
/** Clusters sharing a common direction (like entries in one section) plus per-cluster axes. */
function clustered(sizes: number[], seed = 1, sep = 1, s = 0.15): Vec[] {
  const r = rng(seed);
  const common = Array.from({ length: DIM }, (_, i) => (i === 0 ? 3 : 0));
  const out: Vec[] = [];
  sizes.forEach((n, c) => {
    for (let i = 0; i < n; i++) {
      const v = common.map((x, d) => x + (d === c + 1 ? sep : 0) + noise(r, s)[d]);
      out.push(v);
    }
  });
  return out;
}
const ids = (n: number, p = "e") => Array.from({ length: n }, (_, i) => `${p}${i}`);

describe("rng / hashSeed", () => {
  it("is deterministic and in [0,1)", () => {
    const a = rng(5), b = rng(5);
    const xs = Array.from({ length: 50 }, () => a());
    expect(xs).toEqual(Array.from({ length: 50 }, () => b()));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(rng(6)()).not.toBe(rng(5)());
  });
  it("hashSeed is stable and order-sensitive on parts", () => {
    expect(hashSeed("a", "b")).toBe(hashSeed("a", "b"));
    expect(hashSeed("a", "b")).not.toBe(hashSeed("b", "a"));
  });
});

describe("centre / kmeansPP", () => {
  it("centred vectors sum to ~0 direction and are unit length", () => {
    const c = centre(clustered([5, 5]));
    for (const v of c) expect(Math.hypot(...v)).toBeCloseTo(1, 6);
  });
  it("recovers well-separated clusters, identically across calls", () => {
    const X = centre(clustered([6, 6, 6]));
    const a = kmeansPP(X, 3, 9), b = kmeansPP(X, 3, 9);
    expect(a.labels).toEqual(b.labels);
    expect(ari(a.labels, [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2])).toBeCloseTo(1, 6);
  });
});

describe("chooseSplit", () => {
  it("never splits at or below splitAbove", () => {
    const X = clustered([5, 5]);
    const d = chooseSplit(X, ids(10));
    expect(isSplit(d)).toBe(false);
  });
  it("splits a section with real substructure, deterministically", () => {
    const X = clustered([7, 7, 6]);
    const d = chooseSplit(X, ids(20));
    expect(isSplit(d)).toBe(true);
    if (!isSplit(d)) return;
    expect(d.k).toBe(3);
    expect(d.p).toBeLessThan(DEFAULT_RULES.nullAlpha);
    expect(d.stability).toBeGreaterThanOrEqual(DEFAULT_RULES.minAri);
    expect(d.leftovers).toEqual([]);
    expect(chooseSplit(X, ids(20))).toEqual(d);
    // same partition whatever the order the members arrive in
    const perm = X.map((_, i) => (i * 7) % 20);
    const d2 = chooseSplit(perm.map((i) => X[i]), perm.map((i) => `e${i}`));
    expect(isSplit(d2)).toBe(true);
    if (isSplit(d2)) expect(ari(perm.map((i) => d.labels[i]), d2.labels)).toBeCloseTo(1, 6);
  });
  it("rejects structureless noise", () => {
    const r = rng(42);
    const X = Array.from({ length: 16 }, () => noise(r, 1));
    expect(isSplit(chooseSplit(X, ids(16)))).toBe(false);
  });
  it("keeps a lone outlier as a leftover, not a group", () => {
    const X = [...clustered([6, 6]), ...clustered([1], 3, 4)];
    const d = chooseSplit(X, ids(13));
    if (isSplit(d)) {
      expect(d.labels.filter((l) => l >= 0).length).toBeGreaterThanOrEqual(DEFAULT_RULES.minGroup * 2);
      for (let g = 0; g < d.k; g++) expect(d.labels.filter((l) => l === g).length).toBeGreaterThanOrEqual(DEFAULT_RULES.minGroup);
    }
  });
});

describe("extractLeftovers", () => {
  it("flags singletons and negative-silhouette points", () => {
    const X = centre(clustered([4, 4]));
    const labels = [0, 0, 0, 0, 1, 1, 1, 0]; // last point sits in the wrong group
    const out = extractLeftovers(X, labels);
    expect(out[7]).toBe(-1);
    expect(out.slice(0, 4)).toEqual([0, 0, 0, 0]);
    expect(extractLeftovers(X.slice(0, 3), [0, 0, 1])[2]).toBe(-1);
  });
});

describe("findMisplaced", () => {
  it("lists an entry that is closer to another section by the margin", () => {
    const A = clustered([5], 1, 1).map((v, i) => ({ id: `a${i}`, vec: v, section: "A" }));
    const B = clustered([5], 2, 1).map((v, i) => ({ id: `b${i}`, vec: v.map((x, d) => (d === 1 ? 0 : d === 5 ? 1 : x)), section: "B" }));
    const stray = { id: "x", vec: B[0].vec.map((x, i) => x + (i === 3 ? 0.01 : 0)), section: "A" };
    const mis = findMisplaced([...A, ...B, stray]);
    expect(mis.map((m) => m.id)).toEqual(["x"]);
    expect(mis[0]).toMatchObject({ from: "A", to: "B" });
  });
  it("is empty when everything sits right", () => {
    const A = clustered([5], 1).map((v, i) => ({ id: `a${i}`, vec: v, section: "A" }));
    const B = clustered([5], 2, 1).map((v, i) => ({ id: `b${i}`, vec: v.map((x, d) => (d === 1 ? 0 : d === 5 ? 1 : x)), section: "B" }));
    expect(findMisplaced([...A, ...B])).toEqual([]);
  });
});

describe("hashSectionId / restatesParent", () => {
  it("ignores member order and differs by members or domain", () => {
    expect(hashSectionId("wp", ["b", "a"])).toBe(hashSectionId("wp", ["a", "b"]));
    expect(hashSectionId("wp", ["a", "b"])).not.toBe(hashSectionId("wp", ["a", "c"]));
    expect(hashSectionId("wp", ["a"])).not.toBe(hashSectionId("sj", ["a"]));
    expect(hashSectionId("wp", ["a"])).toMatch(/^sec-wp-[A-Za-z0-9]{6}$/);
  });
  it("catches restated parents and allows real subtopics", () => {
    expect(restatesParent("Console Chat", "Console Chat and Integrations")).toBe(true);
    expect(restatesParent("Chat Console Features", "Console Chat Features")).toBe(true);
    // a narrower child is not a restatement
    expect(restatesParent("Shipping Policy", "Task Creation Workflow and Shipping Policy")).toBe(false);
    expect(restatesParent("Discord Tooling", "Console Chat and Integrations")).toBe(false);
    expect(restatesParent("Subagent Side Panel", "Console Chat and Integrations")).toBe(false);
  });
});
