/**
 * Tree-rules eval: frozen real entries (Dewey's mirrored nomic vectors, 2026-10-29)
 * from packages/kb/test/fixtures/tree-eval/sections.json — the sections the
 * split experiment studied (wolfpack Console Chat 30, Work Item Tracking 14,
 * Graduation 9, snapjack Game Tracking 9) plus a grab-bag negative control
 * (14 entries, each from a different section). This is where the tree rules are
 * verified; nothing in the sweep checks tree health at runtime.
 *
 * Measured with the shipped rules (see tuning.ts SECTION_TREE.rules):
 *  - null p is 0.0099 (the floor with 100 replicates) for ALL five sets, grab bag
 *    included: the permutation null is weak (the experiment said so). What
 *    separates the grab bag and Console Chat is the seed/bootstrap stability gate.
 *  - Work Item Tracking and Graduation split into 2 groups; the accepted partition is
 *    identical across seeds, but they sit near the ARI .7 gate (mean ~.75), so the
 *    accept/reject decision itself flips on ~1 seed in 6. In production the seed is
 *    derived from the member ids, so a given section always decides the same way.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  chooseSplit, isSplit, ari, cosine, meanVec, DEFAULT_RULES, type SplitDecision, type SplitRejected, type Vec,
} from "./tree-rules.js";
import { planRebuild, insertEntry, repairPath, type RebuildEntry, type RebuildState } from "./rebuild.js";

interface Fx { id: string; title: string; summary: string; vec: Vec }
const F = JSON.parse(readFileSync(new URL("../../test/fixtures/tree-eval/sections.json", import.meta.url), "utf-8")) as {
  sections: Record<string, { title: string; entries: Fx[] }>;
  grabBag: Fx[];
};
const CONSOLE = "sec-wolfpack-Xvhq6R", WORK = "sec-wolfpack-RU4PVv", GRAD = "sec-wolfpack-J8KiD9", GAME = "sec-snapjack-gtT6T1";
const set = (id: string) => F.sections[id].entries;
const run = (es: Fx[], seed: number) => chooseSplit(es.map((e) => e.vec), es.map((e) => e.id), { ...DEFAULT_RULES, seed }, { ignoreSize: true });
const accepted = (r: SplitDecision | SplitRejected): r is SplitDecision => isSplit(r);
const SLOW = 240_000;
/** The rules are CPU-bound; yielding between runs keeps the vitest worker answering its RPC heartbeat. */
const yieldLoop = () => new Promise<void>((r) => setImmediate(r));

describe("fixtures", () => {
  it("have the expected shapes", () => {
    expect([CONSOLE, WORK, GRAD, GAME].map((s) => set(s).length)).toEqual([30, 14, 9, 9]);
    expect(F.grabBag).toHaveLength(14);
    expect(new Set(F.grabBag.map((e: any) => e.section)).size).toBe(14);
  });
});

describe("determinism", () => {
  it("one partition across seeds: every accepted split is the same grouping", async () => {
    for (const sid of [WORK, GRAD]) {
      const runs = [];
      for (const s of [1, 2, 3, 4, 5, 6]) { runs.push(run(set(sid), s)); await yieldLoop(); }
      const ok = runs.filter(accepted);
      expect(ok.length, `${sid} accepted in ${ok.length}/6 seeds`).toBeGreaterThanOrEqual(4);
      for (const r of ok) expect(ari(ok[0].labels, r.labels)).toBeCloseTo(1, 6);
      expect(ok[0].k).toBe(2);
    }
  }, SLOW);

  it("clear rejections are rejected on every seed", async () => {
    for (const [name, es, seeds] of [[CONSOLE, set(CONSOLE), [1, 2, 3]], [GAME, set(GAME), [1, 2, 3, 4, 5, 6]]] as const) {
      for (const s of seeds) { expect(accepted(run(es, s)), `${name} seed ${s}`).toBe(false); await yieldLoop(); }
    }
  }, SLOW);

  it("the same members and seed always decide the same way", () => {
    expect(run(set(WORK), 1)).toEqual(run(set(WORK), 1));
  }, SLOW);
});

describe("null gate on real sections", () => {
  it("substructure beats the permutation null on all four real sections (p < .05)", async () => {
    for (const sid of [CONSOLE, WORK, GRAD, GAME]) {
      const r = run(set(sid), 1);
      await yieldLoop();
      const p = accepted(r) ? r.p : (r.detail?.p as number);
      expect(p, sid).toBeLessThan(DEFAULT_RULES.nullAlpha);
    }
  }, SLOW);
});

describe("negative control: the grab bag", () => {
  it("is never split, on any seed (rejected by the stability gate, not the weak null)", async () => {
    for (const s of [1, 2, 3, 4, 5, 6]) {
      const r = run(F.grabBag, s);
      await yieldLoop();
      expect(accepted(r), `seed ${s}`).toBe(false);
      expect((r as SplitRejected).reason).toBe("unstable");
    }
  }, SLOW);
});

describe("accepted splits are coherent", () => {
  const dec = (sid: string) => {
    for (const seed of [1, 2, 4]) {
      const r = run(set(sid), seed);
      if (accepted(r)) return r;
    }
    throw new Error(`${sid} never accepted`);
  };

  it("leave-one-out: most entries are closer to their own group's other members than to the other group", () => {
    for (const sid of [WORK, GRAD]) {
      const es = set(sid), d = dec(sid);
      let good = 0, total = 0;
      es.forEach((e, i) => {
        if (d.labels[i] < 0) return;
        const own = es.filter((x, j) => j !== i && d.labels[j] === d.labels[i]).map((x) => x.vec);
        const other = es.filter((x, j) => d.labels[j] >= 0 && d.labels[j] !== d.labels[i]).map((x) => x.vec);
        total++;
        if (cosine(meanVec(own), e.vec) > cosine(meanVec(other), e.vec)) good++;
      });
      expect(good / total, sid).toBeGreaterThanOrEqual(0.85);
    }
  }, SLOW);

  it("leftovers are at most 25% of the section and every group has >= minGroup", () => {
    for (const sid of [WORK, GRAD]) {
      const d = dec(sid);
      expect(d.leftovers.length / set(sid).length).toBeLessThanOrEqual(0.25);
      for (let g = 0; g < d.k; g++) expect(d.labels.filter((l) => l === g).length).toBeGreaterThanOrEqual(DEFAULT_RULES.minGroup);
    }
  }, SLOW);
});

// ── the acceptance test: inserts keep the tree right on their own ───────────

const toEntries = (es: Fx[]): RebuildEntry[] => es.map((e) => ({ id: e.id, title: e.title, summary: e.summary, vector: e.vec, kind: "fact" }));
const labelsOf = (st: RebuildState, ids: string[]) => {
  const m = new Map<string, number>();
  return ids.map((i) => { const s = st.assignment.get(i)!; if (!m.has(s)) m.set(s, m.size); return m.get(s)!; });
};
const insertAll = async (order: RebuildEntry[]) => {
  const st: RebuildState = { sections: [], assignment: new Map() };
  const vec = new Map<string, number[]>();
  for (const e of order) { await insertEntry(st, e, vec, "wp"); await yieldLoop(); }
  return { st, vec };
};
/** Tolerance: adjusted Rand index between the groupings of the two trees >= 0.7 (the same bar as the seed-stability gate:
 *  "as alike as two re-runs of the same rule are allowed to be"). Measured on every set below: 1.00. */
const EQUIV_ARI = 0.7;

/**
 * Tree shapes the top-down rebuild produces on the fixtures (default seed; inserts give the same shapes):
 *  - Console Chat (30):   one section, 30 entries (split rejected: unstable). Intended: no stable substructure.
 *  - Work Item Tracking (14): root with 2 children of 8 and 6, no leftovers.
 *  - Graduation (9):      one section, 9 entries (below splitAbove).
 *  - Game Tracking (9):   one section, 9 entries (below splitAbove).
 *  - grab bag (14):       one section, 14 entries (rejected: unstable).
 */
describe("acceptance: one-by-one inserts ≈ top-down rebuild (work-wolfpack-t800z3L)", () => {
  const cases: Array<[string, Fx[]]> = [
    ["Console Chat (30)", set(CONSOLE)],
    ["Work Item Tracking (14)", set(WORK)],
    ["Graduation (9)", set(GRAD)],
    ["Game Tracking (9)", set(GAME)],
    ["grab bag (14, negative control)", F.grabBag],
  ];
  const namer = async () => ({ title: `T${Math.random()}`, summary: "s" });

  for (const [name, fx] of cases) {
    it(`${name}: inserts group like a rebuild, and a second pass is a no-op`, async () => {
      const entries = toEntries(fx);
      const ids = entries.map((e) => e.id).sort();
      const reb = await planRebuild({ domain: "wp", entries, namer });
      const a = await insertAll([...entries].sort((x, y) => (x.id < y.id ? -1 : 1)));
      expect(a.st.assignment.size).toBe(entries.length);
      expect(ari(labelsOf(reb.state, ids), labelsOf(a.st, ids)), name).toBeGreaterThanOrEqual(EQUIV_ARI);
      // second run: repairing every section again creates and changes nothing
      const snap = () => JSON.stringify({ s: a.st.sections.map((s) => [s.id, s.parent, s.memberCount]), a: [...a.st.assignment].sort() });
      const before = snap();
      for (const s of [...a.st.sections]) expect(await repairPath(a.st, String(s.id), a.vec, "wp")).toEqual([]);
      expect(snap()).toBe(before);
      // and rebuilding again from the rebuilt tree changes nothing either
      const again = await planRebuild({ domain: "wp", entries, namer, start: reb.state, oldSections: reb.state.sections });
      expect(ari(labelsOf(reb.state, ids), labelsOf(again.state, ids))).toBe(1);
      expect(again.state.sections.map((s) => String(s.id)).sort()).toEqual(reb.state.sections.map((s) => String(s.id)).sort());
    }, 600_000);
  }

  it("Work Item Tracking: a different insert order gives the same grouping", async () => {
    const entries = toEntries(set(WORK));
    const ids = entries.map((e) => e.id).sort();
    const sorted = [...entries].sort((x, y) => (x.id < y.id ? -1 : 1));
    const a = await insertAll(sorted), b = await insertAll([...sorted].reverse());
    expect(ari(labelsOf(a.st, ids), labelsOf(b.st, ids))).toBeGreaterThanOrEqual(EQUIV_ARI);
  }, 600_000);
});
