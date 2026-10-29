/**
 * Eval of the LLM-proposed, vector-validated split on the frozen real sections (see tree-rules.eval.test.ts for
 * the fixtures). The LLM is stubbed with the haiku partitions recorded in the split experiment
 * (fixtures/tree-eval/llm-partitions.json, ids resolved to full entry ids). For a SUBSET of a fixture section
 * (the insert path grows a leaf one entry at a time) the stub answers with the same categorisation restricted to
 * the members present; an entry it never categorised goes to "doesn't fit".
 *
 * Tree shapes B produces (rebuild from one root, default rules; "k" groups + leftovers kept in the parent):
 *   Console Chat (30)        3 groups of 4/5/5 (14 entries) + 16 leftovers   (two categories dropped: 4/7 and 1/4 coherent)
 *   Work Item Tracking (14)  2 groups of 3/3 (6 entries)    + 8 leftovers    (three categories dropped or too small)
 *   Graduation (9)           not judged (<= splitAbove); with the size gate off: 2 groups of 3/4 + 2 leftovers
 *   Game Tracking (9)        not judged; with the size gate off: no coherent category, no split
 *   grab bag (14)            nothing categorised: no split
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { judgeSplit, memorySplitCache, type Partitioner } from "./llm-split.js";
import { planRebuild, insertEntry, repairPath, type RebuildEntry, type RebuildState } from "./rebuild.js";
import { ari, type Vec } from "./tree-rules.js";

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
const groupSizes = (labels: number[], k: number) => Array.from({ length: k }, (_, g) => labels.filter((l) => l === g).length).sort((a, b) => a - b);

describe("B: the validated LLM partition on the real sections (size gate off)", () => {
  const judge = (es: Fx[]) => judgeSplit({ partitioner: stub(), ignoreSize: true }, { domain: "wp", parentTitle: "p", members: toMembers(es) });

  it("Console Chat: three coherent categories survive, the rest are leftovers", async () => {
    const v = await judge(set(CONSOLE));
    expect(v.decision?.k).toBe(3);
    expect(groupSizes(v.decision!.labels, 3)).toEqual([4, 5, 5]);
    expect(v.decision!.leftovers).toHaveLength(16);
    expect(v.categories!.filter((c) => !c.kept).map((c) => c.name).sort()).toEqual(["CLI, providers and local runtime", "Console chat UI and thread settings"]);
  });
  it("Work Item Tracking: two categories survive", async () => {
    const v = await judge(set(WORK));
    expect(v.decision?.k).toBe(2);
    expect(groupSizes(v.decision!.labels, 2)).toEqual([3, 3]);
    expect(v.decision!.leftovers).toHaveLength(8);
    expect(v.decision!.names!.sort()).toEqual(["Knowledge graph routes and visuals", "Operations, cleanup and cutover"]);
  });
  it("Graduation: two groups; Game Tracking: no coherent category", async () => {
    const g = await judge(set(GRAD));
    expect(groupSizes(g.decision!.labels, g.decision!.k)).toEqual([3, 4]);
    expect(g.decision!.leftovers).toHaveLength(2);
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
  const rebuild = (es: Fx[]) => planRebuild({ domain: "wp", entries: toEntries(es), namer, partitioner: stub() });
  const direct = (plan: Awaited<ReturnType<typeof rebuild>>, id: string) => [...plan.state.assignment.values()].filter((s) => s === id).length;

  it("Console Chat (30): a root holding its 16 leftovers plus three groups", async () => {
    const plan = await rebuild(set(CONSOLE));
    const root = plan.state.sections.find((s) => s.parent === null)!;
    const kids = plan.state.sections.filter((s) => String(s.parent) === String(root.id));
    expect(kids.map((k) => direct(plan, String(k.id))).sort()).toEqual([4, 5, 5]);
    expect(direct(plan, String(root.id))).toBe(16);
    expect(plan.leftovers.get(String(root.id))).toHaveLength(16);
    expect(plan.judged[0]).toMatchObject({ outcome: "split", source: "llm" });
  });
  it("Work Item Tracking (14): root with 8 leftovers and groups of 3 and 3", async () => {
    const plan = await rebuild(set(WORK));
    expect(plan.state.sections).toHaveLength(3);
    const root = plan.state.sections.find((s) => s.parent === null)!;
    expect(direct(plan, String(root.id))).toBe(8);
  });
  it("Graduation, Game Tracking (9 each) and the grab bag (14) stay one section", async () => {
    for (const es of [set(GRAD), set(GAME), F.grabBag]) expect((await rebuild(es)).state.sections).toHaveLength(1);
  });
});

describe("B: acceptance — one-by-one inserts vs rebuild", () => {
  const namer = async () => ({ title: `T${Math.random()}`, summary: "s" });
  const cases: Array<[string, Fx[], boolean]> = [
    // [name, entries, equivalent]. Measured ARI of inserts vs rebuild: Console Chat .38, Work Item Tracking .36, the rest 1.00.
    ["Console Chat (30)", set(CONSOLE), false], ["Work Item Tracking (14)", set(WORK), false], ["Graduation (9)", set(GRAD), true],
    ["Game Tracking (9)", set(GAME), true], ["grab bag (14)", F.grabBag, true],
  ];
  async function run(fx: Fx[]) {
    const entries = toEntries(fx);
    const ids = entries.map((e) => e.id).sort();
    const reb = await planRebuild({ domain: "wp", entries, namer, partitioner: stub() });
    const spy = vi.fn(stub());
    const cache = memorySplitCache();
    const info = new Map<string, { title: string; summary?: string }>();
    const st: RebuildState = { sections: [], assignment: new Map() };
    const vec = new Map<string, number[]>();
    for (const e of [...entries].sort((a, b) => (a.id < b.id ? -1 : 1))) await insertEntry(st, e, vec, "wp", undefined, { partitioner: spy, cache, info });
    const lab = (s: RebuildState) => { const m = new Map<string, number>(); return ids.map((i) => { const x = s.assignment.get(i)!; if (!m.has(x)) m.set(x, m.size); return m.get(x)!; }); };
    return { ari: ari(lab(reb.state), lab(st)), st, vec, spy, cache, info };
  }

  for (const [name, fx, equivalent] of cases) {
    // KNOWN GAP (work-wolfpack-t800z3L): for the two fixtures that split, the insert path diverges from the rebuild.
    // The rebuild keeps the entries the LLM did not categorise (Console 16/30, Work 8/14) as direct entries of the parent.
    // The insert path splits as soon as a leaf passes 10 entries, on the members present, and every LATER entry then
    // descends to its nearest child by centroid (placeEntry has no "fits no child" outcome), so the leftovers are
    // absorbed into the groups (Work: 5 + 5 + 4 instead of 8 + 3 + 3). Closing it needs a placement rule that can
    // leave an entry in the parent. The test is `fails` so it flags the day this starts to pass.
    (equivalent ? it : it.fails)(`${name}: inserts group like the rebuild (ARI >= .7)`, async () => {
      expect((await run(fx)).ari, name).toBeGreaterThanOrEqual(0.7);
    }, 300_000);

    it(`${name}: a second pass changes nothing, and the LLM is asked at most once per member set`, async () => {
      const { st, vec, spy, cache, info } = await run(fx);
      const distinct = () => new Set(spy.mock.calls.map((c) => c[0].members.map((m) => m.id).sort().join(",")));
      expect(distinct().size).toBe(spy.mock.calls.length);
      const snap = () => JSON.stringify({ s: st.sections.map((s) => [s.id, s.parent, s.memberCount]), a: [...st.assignment].sort() });
      const before = snap();
      const pass = async () => { for (const s of [...st.sections]) expect(await repairPath(st, String(s.id), vec, "wp", undefined, { partitioner: spy, cache, info })).toEqual([]); };
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
