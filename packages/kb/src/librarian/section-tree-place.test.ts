import { describe, it, expect } from "vitest";
import { placeEntry, chooseChild } from "./section-tree.js";
import type { Section } from "../schema/knowledge.js";
import type { EntryWithVector } from "./hierarchy.js";
import { rng } from "./tree-rules.js";

const DIM = 12;
const unitv = (v: number[]) => { const n = Math.hypot(...v); return v.map((x) => x / n); };
const r = rng(11);
const vecOf = (axis: number | null, spread = 0.08) =>
  unitv(Array.from({ length: DIM }, (_, d) => (d === 0 ? 2 : 0) + (axis !== null && d === axis ? 1.4 : 0) + (r() + r() - 1) * spread));
const sec = (id: string, parent: string | null, centroid: number[], depth = 0): Section =>
  ({ id, domain: "wp", parent, depth, label: id, title: id, centroid, memberCount: 0, childIds: [], summary: "", summaryHash: "", dirty: false, memberCountAtLastLabel: 0, created: "x", updated: "x" }) as unknown as Section;
const ent = (id: string, sectionId: string, vector: number[]): EntryWithVector => ({ entryId: id, sectionId: sectionId as never, vector });

// root with two children (axes 1 and 2) and its own direct entries around axis 5 (the leftover group)
const kidA = Array.from({ length: 5 }, (_, i) => ent(`a${i}`, "kidA", vecOf(1)));
const kidB = Array.from({ length: 5 }, (_, i) => ent(`b${i}`, "kidB", vecOf(2)));
const left = Array.from({ length: 5 }, (_, i) => ent(`l${i}`, "root", vecOf(5)));
const centroid = (es: EntryWithVector[]) => unitv(es[0].vector.map((_, d) => es.reduce((s, e) => s + e.vector[d], 0)));
const sections = [
  sec("root", null, centroid([...kidA, ...kidB, ...left])),
  sec("kidA", "root", centroid(kidA), 1),
  sec("kidB", "root", centroid(kidB), 1),
];
const members = new Map<string, EntryWithVector[]>([["root", left], ["kidA", kidA], ["kidB", kidB]]);
const place = (v: number[], m = members, kind = "fact") => placeEntry(v, { kind }, sections, v, m);

describe("placeEntry: stay in the parent unless coherent with a child", () => {
  it("an entry like child A's goes into A", () => {
    expect(place(vecOf(1)).sectionId).toBe("kidA");
    expect(place(vecOf(2)).sectionId).toBe("kidB");
  });
  it("an entry like the parent's own direct entries stays a direct entry of the parent", () => {
    expect(place(vecOf(5)).sectionId).toBe("root");
  });
  it("an entry that fits no child (equally far from both, nearer the leftover group) stays in the parent", () => {
    const stray = unitv(vecOf(1).map((x, i) => x + vecOf(2)[i] + (i === 5 ? 1.2 : 0)));
    expect(chooseChild(stray, sections[0], [sections[1], sections[2]], sections, members)).toBe("parent");
    expect(place(stray).sectionId).toBe("root");
  });
  it("without direct entries (a pure wrapper) the old behaviour holds: descend to the nearest child", () => {
    const m = new Map(members); m.delete("root");
    expect(chooseChild(vecOf(5), sections[0], [sections[1], sections[2]], sections, m)).toBeNull();
    expect(["kidA", "kidB"]).toContain(place(vecOf(5), m).sectionId);
  });
  it("is deterministic and does not mutate its inputs", () => {
    const v = vecOf(1);
    const before = JSON.stringify([...members]);
    expect(place(v).sectionId).toBe(place(v).sectionId);
    expect(JSON.stringify([...members])).toBe(before);
  });

  it("a chosen child that the next level rejects as _unplaced (centroid below the isolation threshold) leaves the entry in the parent, not unplaced", () => {
    const far = unitv(Array.from({ length: DIM }, (_, d) => (d === 9 ? 1 : 0)));
    const farKid = { ...sections[1], centroid: far } as Section;
    const secs = [sections[0], farKid, sections[2]];
    const v = vecOf(1);
    // the coherence rule picks kid A ...
    expect(chooseChild(v, secs[0], [secs[1], secs[2]], secs, members)).toBe(farKid);
    // ... whose stored centroid is nowhere near the entry; the result must still be a placement
    const r = placeEntry(v, { kind: "fact" }, secs, v, members);
    expect(r.sectionId).toBe("root");
  });

  it("fewer than minGroup direct entries do not form a competing group: old behaviour (null)", () => {
    const m = new Map(members); m.set("root", left.slice(0, 2));
    expect(chooseChild(vecOf(5), sections[0], [sections[1], sections[2]], sections, m)).toBeNull();
  });
});
