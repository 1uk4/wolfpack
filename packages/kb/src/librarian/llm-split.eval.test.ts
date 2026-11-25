/**
 * Eval of the LLM-proposed, vector-validated split on the frozen real sections (see tree-rules.eval.test.ts for
 * the fixtures). The LLM is stubbed with the haiku partitions recorded in the split experiment
 * (fixtures/tree-eval/llm-partitions.json, ids resolved to full entry ids). For a SUBSET of a fixture section
 * (the insert path grows a leaf one entry at a time) the stub answers with the same categorisation restricted to
 * the members present; an entry it never categorised goes to "doesn't fit".
 *
 * Inserts vs rebuild (stay-in-parent placement rule): Work Item Tracking ARI .76 (passes), Console Chat .32 (known gap, below).
 * Current rules (work-wolfpack-Fs0BlY6, work-wolfpack-HIr2pfl): a split needs >= minCoherentGroups (3) coherent groups covering
 * >= minCoverage (70%) of the members; the size threshold is per domain (splitThresholdFor, 12..24), but these evals pass
 * ignoreSize, so only the group-count and coverage rules decide. With the recorded partitions (llmMinCoherence .7, identical
 * at .8; same verdict with joinLeftovers on or off), NO fixture section is accepted any more:
 *   Console Chat (30)        rejected: low-coverage. 4 categories survive ("Console chat UI" as a partial group of its coherent members;
 *                            "CLI, providers" is dropped, 1/4 coherent) but they cover only 18/30 = 60% < 70%
 *   Work Item Tracking (14)  rejected: fewer-than-three-groups. Only 2 categories survive (graph routes, operations/cutover)
 *   Graduation (9)           rejected: fewer-than-three-groups. Only 2 categories survive (tree construction, graduation intake)
 *   Game Tracking (9)        rejected: no-coherent-category
 *   grab bag (14)            nothing categorised: no split
 * Because nothing is accepted, the rebuild shapes are all one section.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { judgeSplit, memorySplitCache, type Partitioner } from "./llm-split.js";
import { planRebuild, insertEntry, repairPath, type RebuildEntry, type RebuildState } from "./rebuild.js";
import { ari, DEFAULT_RULES, type Vec } from "./tree-rules.js";
/** The join bar off: these shapes were measured without it (it joins leftovers to their closest group; see tree-rules.test.ts). */
const NO_JOIN = { ...DEFAULT_RULES, joinLeftovers: false };

interface Fx { id: string; title: string; summary: string; vec: Vec }
const F = JSON.parse(readFileSync(new URL("../../test/fixtures/tree-eval/sections.json", import.meta.url), "utf-8")) as {
  sections: Record<string, { title: string; entries: Fx[] }>; grabBag: Fx[];
};
const P = JSON.parse(readFileSync(new URL("../../test/fixtures/tree-eval/llm-partitions.json", import.meta.url), "utf-8")) as
  Record<string, { categories: Array<{ name: string; ids: string[] }>; doesntFit: string[] }>;
const CONSOLE = "sec-wolfpack-Xvhq6R", WORK = "sec-wolfpack-RU4PVv", GRAD = "sec-wolfpack-J8KiD9", GAME = "sec-snapjack-gtT6T1";
const set = (id: string) => F.sections[id].entries;

/** id → category name, from the recorded partitions. */
const known = new Map<string, string>();
for (const [sid, p] of Object.entries(P)) for (const c of p.categories) for (const id of c.ids) known.set(id, `${sid}/${c.name}`);
/** The recorded categorisation restricted to the members asked about. */
const stub = (): Partitioner & { calls: string[][] } => {
  const calls: string[][] = [];
  const fn = (async ({ members }: { members: Array<{ id: string }> }) => {
    calls.push(members.map((m) => m.id));
    const byCat = new Map<string, string[]>();
    const dnf: string[] = [];
    for (const m of members) {
      const c = known.get(m.id);
      if (!c) dnf.push(m.id); else byCat.set(c, [...(byCat.get(c) ?? []), m.id]);
    }
    return { categories: [...byCat].sort().map(([c, ids]) => ({ name: c.split("/")[1], ids })), doesntFit: dnf };
  }) as Partitioner & { calls: string[][] };
  fn.calls = calls;
  return fn;
};
const toMembers = (es: Fx[]) => es.map((e) => ({ id: e.id, title: e.title, summary: e.summary, vector: e.vec }));
const toEntries = (es: Fx[]): RebuildEntry[] => es.map((e) => ({ id: e.id, title: e.title, summary: e.summary, vector: e.vec, kind: "fact" }));

describe("B: the validated LLM partition on the real sections (size gate off)", () => {
  const judge = (es: Fx[]) => judgeSplit({ partitioner: stub(), ignoreSize: true, rules: NO_JOIN }, { domain: "wp", parentTitle: "p", members: toMembers(es) });

  it("Console Chat: four categories survive but cover only 60% of the members, so the split is rejected (low-coverage)", async () => {
    const v = await judge(set(CONSOLE));
    expect(v.decision).toBeUndefined();
    expect(v.reason).toBe("low-coverage");
    expect(v.categories!.filter((c) => c.kept)).toHaveLength(4);
    expect(v.categories!.filter((c) => !c.kept).map((c) => c.name).sort()).toEqual(["CLI, providers and local runtime"]);
  });
  it("Work Item Tracking: only two categories survive, so the split is rejected (fewer-than-three-groups)", async () => {
    const v = await judge(set(WORK));
    expect(v.decision).toBeUndefined();
    expect(v.reason).toBe("fewer-than-three-groups");
    expect(v.categories!.filter((c) => c.kept).map((c) => c.name).sort()).toEqual(["Knowledge graph routes and visuals", "Operations, cleanup and cutover"]);
  });
  it("Graduation: two groups, rejected (fewer-than-three-groups); Game Tracking: no coherent category", async () => {
    const g = await judge(set(GRAD));
    expect(g.decision).toBeUndefined();
    expect(g.reason).toBe("fewer-than-three-groups");
    const game = await judge(set(GAME));
    expect(game.decision).toBeUndefined();
    expect(game.reason).toBe("no-coherent-category");
  });
  it("the grab bag (nothing categorised) never splits", async () => {
    const v = await judge(F.grabBag);
    expect(v.decision).toBeUndefined();
    expect(v.doesntFit).toHaveLength(14);
  });
  it("deterministic: the same verdict every time", async () => {
    const a = await judge(set(CONSOLE)), b = await judge([...set(CONSOLE)].reverse());
    expect(b.decision).toEqual(a.decision);
  });
});

describe("B: rebuild shapes", () => {
  const namer = async () => ({ title: `T${Math.random()}`, summary: "s" });
  const rebuild = (es: Fx[]) => planRebuild({ domain: "wp", entries: toEntries(es), namer, partitioner: stub(), rules: NO_JOIN });
  const direct = (plan: Awaited<ReturnType<typeof rebuild>>, id: string) => [...plan.state.assignment.values()].filter((s) => s === id).length;

  it("Console Chat (30): the rejected split (low-coverage) leaves one section holding all 30", async () => {
    const plan = await rebuild(set(CONSOLE));
    expect(plan.state.sections).toHaveLength(1);
    expect(direct(plan, String(plan.state.sections[0].id))).toBe(30);
  });
  it("Work Item Tracking (14): the rejected split (two groups) leaves one section holding all 14", async () => {
    const plan = await rebuild(set(WORK));
    expect(plan.state.sections).toHaveLength(1);
    expect(direct(plan, String(plan.state.sections[0].id))).toBe(14);
  });
  it("Graduation, Game Tracking (9 each) and the grab bag (14) stay one section", async () => {
    for (const es of [set(GRAD), set(GAME), F.grabBag]) expect((await rebuild(es)).state.sections).toHaveLength(1);
  });
});

describe("B: acceptance — one-by-one inserts vs rebuild", () => {
  const namer = async () => ({ title: `T${Math.random()}`, summary: "s" });
  const cases: Array<[string, Fx[], boolean]> = [
    // [name, entries, equivalent]. Measured ARI of inserts vs rebuild with the stay-in-parent placement rule:
    // Work Item Tracking .76 (was .36), Console Chat .32 (was .38), the rest 1.00.
    ["Console Chat (30)", set(CONSOLE), true], ["Work Item Tracking (14)", set(WORK), true], ["Graduation (9)", set(GRAD), true],
    ["Game Tracking (9)", set(GAME), true], ["grab bag (14)", F.grabBag, true],
  ];
  async function run(fx: Fx[]) {
    const entries = toEntries(fx);
    const ids = entries.map((e) => e.id).sort();
    const reb = await planRebuild({ domain: "wp", entries, namer, partitioner: stub(), rules: NO_JOIN });
    const spy = vi.fn(stub());
    const cache = memorySplitCache();
    const info = new Map<string, { title: string; summary?: string }>();
    const st: RebuildState = { sections: [], assignment: new Map() };
    const vec = new Map<string, number[]>();
    for (const e of [...entries].sort((a, b) => (a.id < b.id ? -1 : 1))) await insertEntry(st, e, vec, "wp", NO_JOIN, { partitioner: spy, cache, info });
    const lab = (s: RebuildState) => { const m = new Map<string, number>(); return ids.map((i) => { const x = s.assignment.get(i)!; if (!m.has(x)) m.set(x, m.size); return m.get(x)!; }); };
    return { ari: ari(lab(reb.state), lab(st)), st, vec, spy, cache, info };
  }

  for (const [name, fx, equivalent] of cases) {
    // KNOWN GAP (work-wolfpack-t800z3L), Console Chat only: the rebuild judges all 30 entries at once (groups 5/4/5 + 16 left in the
    // parent). The insert path splits when the leaf first passes 10 entries, on the members present then; the "Interaction cards"
    // category has too few coherent members at that moment to survive, so its entries are absorbed by the neighbouring child
    // (17/5/8 instead of 16/5/4/5), and a child of 8 is never re-judged (<= splitAbove). Closing it needs re-judging a parent's
    // subtree as it grows (ancestor repair / depth-weighted stability), the deferred repairPath work. `it.fails` flags the day it passes.
    (equivalent ? it : it.fails)(`${name}: inserts group like the rebuild (ARI >= .7)`, async () => {
      expect((await run(fx)).ari, name).toBeGreaterThanOrEqual(0.7);
    }, 300_000);

    it(`${name}: a second pass changes nothing, and the LLM is asked at most once per member set`, async () => {
      const { st, vec, spy, cache, info } = await run(fx);
      const distinct = () => new Set(spy.mock.calls.map((c) => c[0].members.map((m) => m.id).sort().join(",")));
      expect(distinct().size).toBe(spy.mock.calls.length);
      const snap = () => JSON.stringify({ s: st.sections.map((s) => [s.id, s.parent, s.memberCount]), a: [...st.assignment].sort() });
      const before = snap();
      const pass = async () => { for (const s of [...st.sections]) expect(await repairPath(st, String(s.id), vec, "wp", NO_JOIN, { partitioner: spy, cache, info })).toEqual([]); };
      // A section the inserts never landed in (a parent holding > splitAbove leftovers) is judged for the first time here,
      // which may ask once for its member set; after that, passes are free.
      await pass();
      expect(snap()).toBe(before);
      expect(distinct().size).toBe(spy.mock.calls.length);
      const calls = spy.mock.calls.length;
      await pass();
      expect(spy.mock.calls.length).toBe(calls);
      expect(snap()).toBe(before);
    }, 300_000);
  }
});
