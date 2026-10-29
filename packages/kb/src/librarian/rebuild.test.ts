import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "@wolfpack/engine";
import { reorg } from "./reorg.js";
import {
  planRebuild, commitRebuild, recoverRebuild, rebuildJournalFile, renderProposal, withSectionLine,
  listRebuildTemps, listRebuildBackups, restoreRebuild, type RebuildEntry, type Namer,
} from "./rebuild.js";
import { readSections, foldSections } from "./sections.js";
import { readLedger } from "./ledger.js";
import { rng } from "./tree-rules.js";
import type { KbRoots } from "../shared/index.js";

const DIM = 24;
/** n entries around one direction `axis`, on top of a shared offset; `sub` adds substructure axes. */
export function synth(prefix: string, groups: Array<{ axis: number; n: number }>, seed = 3): RebuildEntry[] {
  const r = rng(seed);
  const out: RebuildEntry[] = [];
  let i = 0;
  for (const g of groups) {
    for (let k = 0; k < g.n; k++, i++) {
      const v = Array.from({ length: DIM }, (_, d) => (d === 0 ? 3 : 0) + (d === g.axis ? 1.2 : 0) + (r() + r() + r() - 1.5) * 0.12);
      out.push({ id: `${prefix}${String(i).padStart(3, "0")}`, title: `${prefix} entry ${i}`, summary: `about ${g.axis}`, vector: v });
    }
  }
  return out;
}

let counter = 0;
const uniqueNamer: Namer = async () => ({ title: `Topic ${++counter} ${["alpha", "beta", "gamma", "delta", "kappa", "omega", "sigma", "theta"][counter % 8]}${counter}`, summary: `sum ${counter}` });

const plain = (plan: Awaited<ReturnType<typeof planRebuild>>) =>
  JSON.stringify({ s: plan.state.sections.map((s) => [s.id, s.parent, s.depth, s.memberCount]), a: [...plan.state.assignment].sort() });

describe("planRebuild (in memory)", () => {
  const data = () => synth("e", [{ axis: 1, n: 9 }, { axis: 2, n: 9 }, { axis: 3, n: 9 }, { axis: 4, n: 5 }]);

  it("assigns every entry exactly once to an existing section and keeps counts consistent", async () => {
    const plan = await planRebuild({ domain: "wp", entries: data(), namer: uniqueNamer });
    const ids = new Set(plan.state.sections.map((s) => String(s.id)));
    expect(plan.state.assignment.size).toBe(32);
    for (const sid of plan.state.assignment.values()) expect(ids.has(sid)).toBe(true);
    for (const s of plan.state.sections) {
      const direct = [...plan.state.assignment.values()].filter((x) => x === String(s.id)).length;
      expect(s.memberCount).toBe(direct);
      expect(s.title).not.toBe("");
      for (const c of s.childIds) expect(plan.state.sections.find((x) => x.id === c)?.parent).toBe(s.id);
    }
  });

  it("is deterministic: the same entries give the same tree and ids, whatever the input order", async () => {
    const a = await planRebuild({ domain: "wp", entries: data(), namer: uniqueNamer });
    const b = await planRebuild({ domain: "wp", entries: data().reverse(), namer: uniqueNamer });
    expect(plain(b)).toBe(plain(a));
  });

  it("splits an oversized section into hash-id children and keeps leftovers in the parent", async () => {
    // 24 clear entries in 3 groups plus 2 strays that fit nowhere
    const entries = [...synth("g", [{ axis: 1, n: 8 }, { axis: 2, n: 8 }, { axis: 3, n: 8 }]), ...synth("x", [{ axis: 9, n: 1 }], 11), ...synth("y", [{ axis: 15, n: 1 }], 12)];
    const plan = await planRebuild({ domain: "wp", entries, namer: uniqueNamer });
    // whatever the shape, no section exceeds the split threshold unless its split was rejected
    for (const s of plan.state.sections) {
      if (s.memberCount > 10) expect(plan.rejected.some((r) => r.sectionId === String(s.id))).toBe(true);
    }
    for (const [child, parent] of plan.splitChildren) {
      expect(child).toMatch(/^sec-wp-[A-Za-z0-9]{6}$/);
      expect(plan.state.sections.find((s) => String(s.id) === parent)).toBeDefined();
    }
    for (const [sid, left] of plan.leftovers) {
      const sec = plan.state.sections.find((s) => String(s.id) === sid)!;
      expect(sec.memberCount).toBeGreaterThanOrEqual(left.length); // the parent is not zeroed
      for (const e of left) expect(plan.state.assignment.get(e)).toBe(sid);
    }
  });

  /** One oversized root holding everything: exercises the gated split directly. */
  const oneRoot = (entries: RebuildEntry[]) => {
    const sec = { id: "sec-wp-root00", domain: "wp", parent: null, depth: 0, label: "root", title: "", centroid: [], memberCount: entries.length, childIds: [], summary: "", summaryHash: "", dirty: true, memberCountAtLastLabel: 0, created: "x", updated: "x" } as any;
    return { sections: [sec], assignment: new Map(entries.map((e) => [e.id, "sec-wp-root00"])) };
  };
  const big = () => [...synth("g", [{ axis: 1, n: 9 }, { axis: 2, n: 9 }, { axis: 3, n: 9 }]), ...synth("x", [{ axis: 9, n: 1 }], 11)];

  it("splits one oversized section into its real groups; the root keeps its id", async () => {
    const entries = big();
    const plan = await planRebuild({ domain: "wp", entries, namer: uniqueNamer, start: oneRoot(entries) });
    expect(plan.splitChildren.size).toBe(3);
    const root = plan.state.sections.find((s) => String(s.id) === "sec-wp-root00")!;
    expect(root.childIds.length).toBe(3);
    for (const k of root.childIds) expect(plan.state.sections.find((s) => s.id === k)!.memberCount).toBe(9);
    // the stray fits no group: it stays a direct entry of the parent (not zeroed)
    expect(plan.leftovers.get("sec-wp-root00")).toEqual(["x000"]);
    expect(root.memberCount).toBe(1);
    expect(renderProposal(plan)).toContain("1 leftover");
  });

  it("rejects a split whose child label restates the parent", async () => {
    const entries = big();
    const same: Namer = async () => ({ title: "Same Thing", summary: "s" });
    const bad = await planRebuild({ domain: "wp", entries, namer: same, start: oneRoot(entries) });
    expect(bad.splitChildren.size).toBe(0);
    expect(bad.rejected.some((r) => r.reason === "child-label-restates-parent")).toBe(true);
    expect(bad.state.sections.length).toBe(1);
    expect(bad.state.assignment.size).toBe(28);
    expect(bad.leftovers.size).toBe(0);
  });

  it("leaves structureless oversized sections whole and says why", async () => {
    const r = rng(5);
    const noise: RebuildEntry[] = Array.from({ length: 14 }, (_, i) => ({ id: `n${i}`, title: `n${i}`, vector: Array.from({ length: DIM }, () => r() - 0.5) }));
    const plan = await planRebuild({ domain: "wp", entries: noise, namer: uniqueNamer, start: oneRoot(noise) });
    expect(plan.splitChildren.size).toBe(0);
    expect(plan.rejected[0]).toMatchObject({ sectionId: "sec-wp-root00", n: 14 });
  });

  it("a failing namer falls back to auto titles and is listed", async () => {
    const boom: Namer = async () => { throw new Error("llm down"); };
    const plan = await planRebuild({ domain: "wp", entries: data(), namer: boom });
    expect(plan.unnamed.length).toBeGreaterThan(0);
    expect(plan.state.sections.every((s) => s.title !== "")).toBe(true);
  });

  it("renders a proposal with the tree and the sections it lists", async () => {
    const plan = await planRebuild({ domain: "wp", entries: data(), namer: uniqueNamer });
    const md = renderProposal(plan);
    expect(md).toContain("# KB rebuild proposal: wp");
    expect(md).toContain("## Leftovers");
    expect(md).toContain("## Moves");
    expect(md).toContain("## Rejected");
    for (const s of plan.state.sections) expect(md).toContain(String(s.id));
  });
});

describe("commitRebuild / dry-run on disk", () => {
  let base: string;
  let roots: KbRoots;
  const eDir = () => join(roots.kbBase, "domains", "wp", "entries");
  const snapshot = () => Object.fromEntries(readdirSync(eDir()).sort().map((f) => [f, readFileSync(join(eDir(), f), "utf-8")]));
  const writeEntries = (es: RebuildEntry[]) => {
    mkdirSync(eDir(), { recursive: true });
    for (const e of es) writeFileSync(join(eDir(), `${e.id}.md`), `---\nid: ${e.id}\ntitle: ${e.title}\ndomain: wp\nsummary: ${e.summary}\nsection: sec-wp-old000\n---\n\nbody ${e.id}\n`);
  };
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "kb-rebuild-"));
    roots = { kbBase: join(base, "base"), opsRoot: join(base, "ops"), denLocal: join(base, "den") };
    mkdirSync(roots.denLocal, { recursive: true });
  });
  afterEach(() => { vi.unstubAllGlobals(); rmSync(base, { recursive: true, force: true }); });

  const entries = () => synth("e", [{ axis: 1, n: 9 }, { axis: 2, n: 9 }, { axis: 3, n: 6 }]);

  it("commits entries then sections once, leaves no temp or journal, and a second commit is a no-op", async () => {
    const es = entries();
    writeEntries(es);
    const plan = await planRebuild({ domain: "wp", entries: es, namer: uniqueNamer });
    const { entriesWritten } = commitRebuild(roots, plan);
    expect(entriesWritten).toBe(es.length);
    for (const e of es) expect(readFileSync(join(eDir(), `${e.id}.md`), "utf-8")).toContain(`section: ${plan.state.assignment.get(e.id)}`);
    expect(readSections(roots).map((s) => s.id).sort()).toEqual(plan.state.sections.map((s) => s.id).sort());
    expect(listRebuildTemps(roots, "wp")).toEqual([]);
    expect(existsSync(rebuildJournalFile(roots))).toBe(false);
    expect(commitRebuild(roots, plan).entriesWritten).toBe(0);
  });

  it("recoverRebuild finishes a commit interrupted after its journal", () => {
    mkdirSync(eDir(), { recursive: true });
    const final = join(eDir(), "a.md");
    writeFileSync(final, "---\ndomain: wp\nsection: old\n---\nbody EDITED AFTER THE PLAN\n");
    writeFileSync(join(eDir(), ".rebuild-tmp-s.json.tmp"), "[]");
    writeFileSync(rebuildJournalFile(roots), JSON.stringify({ version: 3, domain: "wp", at: "x", entries: [{ path: final, section: "sec-wp-new" }], renames: [{ tmp: join(eDir(), ".rebuild-tmp-s.json.tmp"), final: join(eDir(), "s.json") }] }));
    expect(recoverRebuild(roots)).toEqual({ n: 2, quarantined: false });
    // the CURRENT file text is kept; only the section line changes
    expect(readFileSync(final, "utf-8")).toBe("---\ndomain: wp\nsection: sec-wp-new\n---\nbody EDITED AFTER THE PLAN\n");
    expect(existsSync(rebuildJournalFile(roots))).toBe(false);
    expect(recoverRebuild(roots)).toEqual({ n: 0, quarantined: false });
  });

  it("an unreadable journal is moved to .rebuild-journal.bad, stale temps are removed, and the notify fires once", () => {
    mkdirSync(eDir(), { recursive: true });
    writeFileSync(join(eDir(), ".rebuild-tmp-a.md.tmp"), "x");
    writeFileSync(rebuildJournalFile(roots), "{ not json");
    const notes: string[] = [];
    expect(recoverRebuild(roots, { notify: (m) => notes.push(m) })).toEqual({ n: 0, quarantined: true });
    expect(existsSync(rebuildJournalFile(roots))).toBe(false);
    expect(existsSync(join(roots.denLocal, ".rebuild-journal.bad"))).toBe(true);
    expect(listRebuildTemps(roots, "wp")).toEqual([]);
    expect(notes).toHaveLength(1);
    // a stale .bad file must not turn a no-op recovery into "quarantined"
    expect(recoverRebuild(roots, { notify: (m) => notes.push(m) })).toEqual({ n: 0, quarantined: false });
    expect(notes).toHaveLength(1);
  });

  it("a rename that does not take effect is not reported as quarantined: recoverRebuild throws 'quarantine failed' and the journal stays", () => {
    mkdirSync(eDir(), { recursive: true });
    writeFileSync(rebuildJournalFile(roots), "{ not json");
    expect(() => recoverRebuild(roots, { rename: () => { /* pretends to succeed, moves nothing */ } })).toThrow(/quarantine failed/);
    expect(existsSync(rebuildJournalFile(roots))).toBe(true);
    expect(() => recoverRebuild(roots, { rename: () => { throw new Error("EXDEV"); } })).toThrow(/EXDEV/);
    expect(existsSync(rebuildJournalFile(roots))).toBe(true);
  });

  it("withSectionLine sets or inserts the section line", () => {
    expect(withSectionLine("---\ndomain: wp\nsection: a\n---\n", "b")).toContain("section: b");
    expect(withSectionLine("---\ndomain: wp\n---\n", "b")).toBe("---\ndomain: wp\nsection: b\n---\n");
  });

  it("rebuild --dry-run through reorg writes nothing to the KB and writes the proposal", async () => {
    const es = entries();
    writeEntries(es);
    const byText = new Map(es.map((e) => [e.title, e.vector]));
    const embedder = { embed: async (text: string) => { for (const [t, v] of byText) if (text.includes(t)) return v; return new Array(DIM).fill(0.1); } };
    let n = 0;
    const engine = {
      call: vi.fn(async (step: string, schema: { parse: (v: unknown) => unknown }) =>
        schema.parse(step === "sectionSummary" ? { summary: `summary ${++n}` } : { title: `Label ${++n}` })),
      usage: { summarize: () => ({}) },
    } as unknown as Engine;
    const before = snapshot();
    const proposalPath = join(base, "kb-rebuild-proposal.md");
    const res = await reorg({ engine, roots, embedder: embedder as any, domains: ["wp"], rebuild: true, dryRun: true, proposalPath });
    expect(res.rebuilt).toBe(true);
    expect(snapshot()).toEqual(before); // entry files byte-identical
    expect(existsSync(join(roots.denLocal, "sections"))).toBe(false); // no sections snapshot
    expect(existsSync(rebuildJournalFile(roots))).toBe(false);
    expect(listRebuildTemps(roots, "wp")).toEqual([]);
    const md = readFileSync(proposalPath, "utf-8");
    expect(md).toContain("# KB rebuild proposal: wp");
    expect(md).toContain("Nothing was written");
    // labels were produced (dry-run runs the full flow)
    expect(engine.call).toHaveBeenCalled();
  });
});

describe("commit safety", () => {
  let base: string;
  let roots: KbRoots;
  const eDir = () => join(roots.kbBase, "domains", "wp", "entries");
  const file = (id: string) => join(eDir(), `${id}.md`);
  const put = (id: string, section: string, extra = "") => {
    mkdirSync(eDir(), { recursive: true });
    writeFileSync(file(id), `---\nid: ${id}\ntitle: ${id}\ndomain: wp\nsummary: s\nsection: ${section}\n${extra}---\n\nbody\n`);
  };
  const sectionOf = (id: string) => /^section: (.+)$/m.exec(readFileSync(file(id), "utf-8"))![1];
  const all = () => synth("e", [{ axis: 1, n: 9 }, { axis: 2, n: 9 }, { axis: 3, n: 6 }]);
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "kb-commit-"));
    roots = { kbBase: join(base, "base"), opsRoot: join(base, "ops"), denLocal: join(base, "den") };
    mkdirSync(roots.denLocal, { recursive: true });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));
  const snapshot = () => Object.fromEntries(readdirSync(eDir()).sort().map((f) => [f, readFileSync(join(eDir(), f), "utf-8")]));

  it("an orphan entry (not in the plan) is placed on the nearest new leaf by vector", async () => {
    const es = all();
    for (const e of es) put(e.id, "sec-wp-old000");
    put("orphan", "sec-wp-gone00");
    const plan = await planRebuild({ domain: "wp", entries: es, namer: uniqueNamer });
    const ov = es[0].vector.map((x) => x + 0.001);
    const res = commitRebuild(roots, plan, { vectorOf: (id) => (id === "orphan" ? ov : undefined) });
    expect(res.orphansPlaced).toEqual(["orphan"]);
    const ids = new Set(plan.state.sections.map((s) => String(s.id)));
    expect(ids.has(sectionOf("orphan"))).toBe(true);
    const leaves = plan.state.sections.filter((s) => !plan.state.sections.some((c) => c.parent === s.id));
    const dotn = (a: number[], b: number[]) => a.reduce((t, x, i) => t + x * b[i], 0) / (Math.hypot(...a) * Math.hypot(...b));
    const nearest = leaves.reduce((b, l) => (dotn(ov, l.centroid) > dotn(ov, b.centroid) ? l : b));
    expect(sectionOf("orphan")).toBe(String(nearest.id));
    for (const f of readdirSync(eDir())) expect(ids.has(sectionOf(f.slice(0, -3)))).toBe(true);
  });

  it("an orphan that cannot be placed aborts the commit before anything is written", async () => {
    const es = all();
    for (const e of es) put(e.id, "sec-wp-old000");
    put("orphan", "sec-wp-gone00");
    const plan = await planRebuild({ domain: "wp", entries: es, namer: uniqueNamer });
    const before = snapshot();
    expect(() => commitRebuild(roots, plan)).toThrow(/orphan.*aborting/);
    expect(snapshot()).toEqual(before);
    expect(existsSync(rebuildJournalFile(roots))).toBe(false);
    expect(readSections(roots)).toEqual([]);
  });

  it("an entry outside the plan that already points into the new tree is kept", async () => {
    const es = all();
    for (const e of es) put(e.id, "sec-wp-old000");
    const plan = await planRebuild({ domain: "wp", entries: es, namer: uniqueNamer });
    const sid = String(plan.state.sections[0].id);
    put("parked", sid);
    expect(commitRebuild(roots, plan).orphansPlaced).toEqual([]);
    expect(sectionOf("parked")).toBe(sid);
  });

  it("grouped entries are planned into their holder's section and covered by the commit", async () => {
    const es = all();
    for (const e of es) put(e.id, "sec-wp-old000");
    put("kid", "sec-wp-old000");
    const plan = await planRebuild({ domain: "wp", entries: es, namer: uniqueNamer, grouped: new Map([["kid", es[3].id]]) });
    // not clustered, counted or listed as an entry of the plan; pinned at the holder's section at the end
    expect(plan.entries.some((e) => e.id === "kid")).toBe(false);
    expect(plan.state.assignment.get("kid")).toBe(plan.state.assignment.get(es[3].id));
    const total = plan.state.sections.reduce((n, s) => n + s.memberCount, 0);
    expect(total).toBe(es.length);
    commitRebuild(roots, plan);
    expect(sectionOf("kid")).toBe(plan.state.assignment.get(es[3].id));
  });

  it("crash injection: writes fail after N calls (and the sections rename can fail), the journal remains, recovery finishes it, and sections.json and the entries agree", async () => {
    const es = all();
    for (const e of es) put(e.id, "sec-wp-old000");
    const plan = await planRebuild({ domain: "wp", entries: es, namer: uniqueNamer });
    const cases: Array<{ failWriteAfter: number; failRename: boolean }> = [
      { failWriteAfter: 0, failRename: false }, { failWriteAfter: 3, failRename: false }, { failWriteAfter: 10, failRename: false },
      { failWriteAfter: 1e9, failRename: true },
    ];
    for (const c of cases) {
      for (const e of es) put(e.id, "sec-wp-old000");
      rmSync(rebuildJournalFile(roots), { force: true });
      let calls = 0;
      const writeFile = (p: string, t: string) => { if (calls++ >= c.failWriteAfter) throw new Error("disk gone"); writeFileSync(p, t); };
      const rename = () => { throw new Error("disk gone"); };
      expect(() => commitRebuild(roots, plan, { writeFile, ...(c.failRename ? { rename } : {}) })).toThrow(/disk gone/);
      expect(existsSync(rebuildJournalFile(roots))).toBe(true);
      const written = Math.min(c.failWriteAfter, es.length);
      expect(recoverRebuild(roots).n).toBe(es.length - written + 1);
      expect(recoverRebuild(roots)).toEqual({ n: 0, quarantined: false }); // idempotent
      expect(existsSync(rebuildJournalFile(roots))).toBe(false);
      expect(listRebuildTemps(roots, "wp")).toEqual([]);
      const ids = new Set(readSections(roots).map((s) => String(s.id)));
      expect(ids).toEqual(new Set(plan.state.sections.map((s) => String(s.id))));
      for (const e of es) { expect(sectionOf(e.id)).toBe(plan.state.assignment.get(e.id)); expect(ids.has(sectionOf(e.id))).toBe(true); }
    }
  });

  it("writes the pre-rebuild backups and the old-values map, and the ledger snapshot stops the old tree being resurrected", async () => {
    const es = all();
    for (const e of es) put(e.id, "sec-wp-old000");
    writeFileSync(join(roots.denLocal, "x"), "");
    const { writeSections } = await import("./sections.js");
    const old = { id: "sec-wp-old000", domain: "wp", parent: null, depth: 0, label: "o", title: "Old", centroid: [], memberCount: 0, childIds: [], summary: "", summaryHash: "", dirty: false, memberCountAtLastLabel: 0, created: "x", updated: "x" } as any;
    writeSections(roots, [old]);
    const { appendLedger } = await import("./ledger.js");
    const { ev } = await import("../shared/index.js");
    appendLedger(roots, [ev.sectionCreated({ sectionId: "sec-wp-old000", domain: "wp", parent: null, label: "o" })]);
    const plan = await planRebuild({ domain: "wp", entries: es, namer: uniqueNamer });
    commitRebuild(roots, plan);
    const stamp = listRebuildBackups(roots)[0];
    expect(JSON.parse(readFileSync(join(roots.denLocal, `sections.json.pre-rebuild-${stamp}`), "utf-8"))[0].id).toBe("sec-wp-old000");
    const oldVals = JSON.parse(readFileSync(join(roots.denLocal, `.rebuild-old-sections-${stamp}.json`), "utf-8"));
    expect(oldVals.entries[es[0].id]).toBe("sec-wp-old000");
    const folded = foldSections(readLedger(roots));
    expect(folded.map((s) => String(s.id)).sort()).toEqual(plan.state.sections.map((s) => String(s.id)).sort());
    expect(folded.some((s) => String(s.id) === "sec-wp-old000")).toBe(false);
  });

  const mkSec = (id: string, domain: string, centroid: number[] = [], parent: string | null = null) =>
    ({ id, domain, parent, depth: parent ? 1 : 0, label: id, title: id, centroid, memberCount: 0, childIds: [], summary: "", summaryHash: "", dirty: false, memberCountAtLastLabel: 0, created: "x", updated: "x" }) as any;

  it("restore is domain-scoped: another domain changed after the backup is kept, entries get their old sections, and a vanished section is re-homed or reported", async () => {
    const { writeSections } = await import("./sections.js");
    const { restoreAndRender } = await import("./rebuild-recover.js");
    const es = all();
    for (const e of es) put(e.id, "sec-wp-old000");
    writeSections(roots, [mkSec("sec-wp-old000", "wp", es[0].vector), mkSec("sec-other-aaaaaa", "other")]);
    const plan = await planRebuild({ domain: "wp", entries: es, namer: uniqueNamer });
    commitRebuild(roots, plan);
    const stamp = listRebuildBackups(roots)[0];
    // after the backup: the other domain gains a section, and a new wp entry is filed in a section of the rebuilt tree
    writeSections(roots, [...readSections(roots).filter((s) => s.domain === "wp"), mkSec("sec-other-aaaaaa", "other"), mkSec("sec-other-NEW111", "other")]);
    put("late", String(plan.state.sections[0].id));
    put("dangling", "sec-wp-nowhere");
    const r = restoreAndRender(roots, stamp, { vectorOf: (id) => (id === "late" || id === "dangling" ? es[0].vector : undefined) });
    // the other domain is exactly as it is NOW (both sections), the wp tree is the backed-up one
    const now = readSections(roots);
    expect(now.filter((s) => s.domain === "other").map((s) => s.id).sort()).toEqual(["sec-other-NEW111", "sec-other-aaaaaa"]);
    expect(now.filter((s) => s.domain === "wp").map((s) => s.id)).toEqual(["sec-wp-old000"]);
    for (const e of es) expect(sectionOf(e.id)).toBe("sec-wp-old000");
    // entries whose section is not in the restored tree are re-homed on the nearest leaf
    expect(r.rehomed.sort()).toEqual(["dangling", "late"]);
    expect(sectionOf("late")).toBe("sec-wp-old000");
    expect(sectionOf("dangling")).toBe("sec-wp-old000");
    expect(r.unresolved).toEqual([]);
    // the ledger fold agrees (no resurrection of the rebuilt tree) and keeps the other domain's ledger sections out of it
    const folded = foldSections(readLedger(roots)).filter((s) => s.domain === "wp");
    expect(folded.map((s) => String(s.id))).toEqual(["sec-wp-old000"]);
    expect(folded[0].centroid).toEqual([]); // centroid-less event
    // digest + index re-rendered for the domain
    expect(existsSync(join(roots.kbBase, "domains", "wp", "INDEX.md"))).toBe(true);
  });

  it("restore recomputes memberCount from the entries as they are now and marks the restored sections dirty", async () => {
    const { writeSections } = await import("./sections.js");
    const es = all();
    for (const e of es) put(e.id, "sec-wp-old000");
    writeSections(roots, [mkSec("sec-wp-old000", "wp", es[0].vector)]);
    const plan = await planRebuild({ domain: "wp", entries: es, namer: uniqueNamer });
    commitRebuild(roots, plan);
    const stamp = listRebuildBackups(roots)[0];
    put("late", "sec-wp-old000"); // created after the backup
    restoreRebuild(roots, stamp);
    const [sec] = readSections(roots).filter((s) => s.domain === "wp");
    expect(sec.memberCount).toBe(es.length + 1);
    expect(sec.dirty).toBe(true);
  });

  it("restore writes the ledger event BEFORE the snapshot; if the snapshot write fails it says to re-run, and the re-run completes", async () => {
    const { writeSections } = await import("./sections.js");
    const es = all();
    for (const e of es) put(e.id, "sec-wp-old000");
    writeSections(roots, [mkSec("sec-wp-old000", "wp", es[0].vector)]);
    const plan = await planRebuild({ domain: "wp", entries: es, namer: uniqueNamer });
    commitRebuild(roots, plan);
    const stamp = listRebuildBackups(roots)[0];
    const failing = () => { throw new Error("disk full"); };
    expect(() => restoreRebuild(roots, stamp, { rename: failing })).toThrow(/ledger was updated but writing .* failed \(disk full\); re-run `rebuild --restore/);
    // the ledger already says "restored", the snapshot still holds the rebuilt tree, no temp is left behind
    expect(foldSections(readLedger(roots)).filter((s) => s.domain === "wp").map((s) => String(s.id))).toEqual(["sec-wp-old000"]);
    expect(readSections(roots).filter((s) => s.domain === "wp").map((s) => String(s.id)).sort()).toEqual(plan.state.sections.map((s) => String(s.id)).sort());
    expect(existsSync(join(roots.denLocal, "sections", ".rebuild-tmp-_sections.json.tmp"))).toBe(false);
    restoreRebuild(roots, stamp); // the re-run completes it
    expect(readSections(roots).filter((s) => s.domain === "wp").map((s) => String(s.id))).toEqual(["sec-wp-old000"]);
  });

  it("when sections.json is unparsable and the other domains are folded from the ledger, the commit warns that they have no centroids", async () => {
    const { writeSections } = await import("./sections.js");
    const { appendLedger } = await import("./ledger.js");
    const { ev } = await import("../shared/index.js");
    const es = all();
    for (const e of es) put(e.id, "sec-wp-old000");
    writeSections(roots, [mkSec("sec-wp-old000", "wp", es[0].vector)]);
    appendLedger(roots, [ev.sectionCreated({ sectionId: "sec-other-aaaaaa", domain: "other", parent: null, label: "o" })]);
    writeFileSync(join(roots.denLocal, "sections", "_sections.json"), "{ broken");
    const plan = await planRebuild({ domain: "wp", entries: es, namer: uniqueNamer });
    const notes: string[] = [];
    commitRebuild(roots, plan, { notify: (m) => notes.push(m) });
    expect(notes.some((m) => /folded from the ledger and have NO centroids/.test(m))).toBe(true);
    expect(readSections(roots).some((s) => s.domain === "other")).toBe(true);
  });

  it("restore reports (does not guess) entries it cannot re-home, and refuses without a sections backup", async () => {
    const { writeSections } = await import("./sections.js");
    const es = all();
    for (const e of es) put(e.id, "sec-wp-old000");
    writeSections(roots, [mkSec("sec-wp-old000", "wp", es[0].vector)]);
    const plan = await planRebuild({ domain: "wp", entries: es, namer: uniqueNamer });
    commitRebuild(roots, plan);
    const stamp = listRebuildBackups(roots)[0];
    put("orphaned", "sec-wp-nowhere");
    const r = restoreRebuild(roots, stamp); // no vectors
    expect(r.unresolved).toEqual(["orphaned"]);
    rmSync(join(roots.denLocal, `sections.json.pre-rebuild-${stamp}`));
    expect(() => restoreRebuild(roots, stamp)).toThrow(/no sections backup/);
  });
});

describe("id continuity and label re-ask", () => {
  const oneRoot = (entries: RebuildEntry[]) => {
    const sec = { id: "sec-wp-root00", domain: "wp", parent: null, depth: 0, label: "root", title: "", centroid: [], memberCount: entries.length, childIds: [], summary: "", summaryHash: "", dirty: true, memberCountAtLastLabel: 0, created: "x", updated: "x" } as any;
    return { sections: [sec], assignment: new Map(entries.map((e) => [e.id, "sec-wp-root00"])) };
  };
  const big = () => [...synth("g", [{ axis: 1, n: 9 }, { axis: 2, n: 9 }, { axis: 3, n: 9 }]), ...synth("x", [{ axis: 9, n: 1 }], 11)];

  it("sections matching an old one by member overlap keep its id, title and summary and are not re-labelled", async () => {
    const entries = big();
    const first = await planRebuild({ domain: "wp", entries, namer: uniqueNamer, start: oneRoot(entries) });
    // pretend the first plan is what is on disk now
    const onDisk = entries.map((e) => ({ ...e, section: first.state.assignment.get(e.id)! }));
    let asked = 0;
    const counting: Namer = async () => { asked++; return { title: "Brand New", summary: "n" }; };
    const second = await planRebuild({ domain: "wp", entries: onDisk, namer: counting, start: oneRoot(entries), oldSections: first.state.sections });
    expect(asked).toBe(0);
    expect(second.reused.size).toBe(first.state.sections.length);
    expect(second.state.sections.map((s) => [s.id, s.title]).sort()).toEqual(first.state.sections.map((s) => [s.id, s.title]).sort());
    expect(renderProposal(second)).toContain("[reused]");
  });

  it("unmatched sections get fresh hash ids and an LLM label", async () => {
    const entries = big();
    const plan = await planRebuild({ domain: "wp", entries, namer: uniqueNamer, start: oneRoot(entries), oldSections: [] });
    expect(plan.reused.size).toBe(0);
    expect(renderProposal(plan)).toContain("[new]");
  });

  it("a restating child label is re-asked once with the parent forbidden; only a child that still restates folds back", async () => {
    const entries = big();
    const forbiddenSeen: string[][] = [];
    const order: string[] = [];
    const namer: Namer = async (c) => {
      if (c.forbidden) forbiddenSeen.push(c.forbidden);
      if (!c.parentTitle) return { title: "Console Chat Tools", summary: "root" };
      const key = c.members[0].title;
      if (!order.includes(key)) order.push(key);
      const i = order.indexOf(key);
      if (i === 0) return c.forbidden ? { title: "Subagent Panel", summary: "fixed" } : { title: "Console Chat Tools", summary: "restates" };
      if (i === 1) return { title: "Console Chat Tools", summary: "stubborn" }; // restates, and keeps restating when re-asked
      return { title: "Graduation Flow", summary: "fine" };
    };
    const plan = await planRebuild({ domain: "wp", entries, namer, start: oneRoot(entries) });
    expect(forbiddenSeen.length).toBeGreaterThanOrEqual(2);
    expect(forbiddenSeen[0]).toContain("Console Chat Tools");
    expect(plan.rejected.filter((r) => r.reason === "child-label-restates-parent")).toHaveLength(1);
    expect(plan.splitChildren.size).toBe(2); // two kept, one folded back
    expect(plan.state.assignment.size).toBe(28);
    for (const sid of plan.state.assignment.values()) expect(plan.state.sections.some((s) => String(s.id) === sid)).toBe(true);
  });
});
