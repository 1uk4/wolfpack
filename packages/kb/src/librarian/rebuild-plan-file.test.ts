import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { KbRoots } from "../shared/index.js";
import type { Namer, RebuildEntry } from "./rebuild.js";
import { readSections, writeSections, sectionsFile } from "./sections.js";
import { readLedger } from "./ledger.js";
import { restoreRebuild } from "./rebuild.js";
import { previewToFile, applyPlanFile, loadPlanFile, type PlanFlags } from "./rebuild-plan-file.js";
import { rng } from "./tree-rules.js";

/** n entries around each group axis on a shared offset (same shape as the fixture in rebuild.test.ts, which cannot be imported without re-running its suites). */
function synth(prefix: string, groups: Array<{ axis: number; n: number }>, seed = 3): RebuildEntry[] {
  const r = rng(seed);
  const out: RebuildEntry[] = [];
  let i = 0;
  for (const g of groups) for (let k = 0; k < g.n; k++, i++) {
    const v = Array.from({ length: 24 }, (_, d) => (d === 0 ? 3 : 0) + (d === g.axis ? 1.2 : 0) + (r() + r() + r() - 1.5) * 0.12);
    out.push({ id: `${prefix}${String(i).padStart(3, "0")}`, title: `${prefix} entry ${i}`, summary: `about ${g.axis}`, vector: v });
  }
  return out;
}

let counter = 0;
const namer: Namer = async () => ({ title: `Topic ${++counter} ${["alpha", "beta", "gamma", "delta"][counter % 4]}${counter}`, summary: `sum ${counter}` });
const FLAGS: PlanFlags = { from: "current", applyCrossMoves: false, approvedCrossMoves: [], allowCollapse: false, allowKmeansFallback: true };

describe("rebuild plan file: preview writes it, apply commits exactly it", () => {
  let base: string;
  let roots: KbRoots;
  let es: RebuildEntry[];
  const eDir = () => join(roots.kbBase, "domains", "wp", "entries");
  const file = (id: string) => join(eDir(), `${id}.md`);
  const sectionOf = (id: string) => /^section: (.+)$/m.exec(readFileSync(file(id), "utf-8"))![1];
  const put = (id: string, body = "body") =>
    writeFileSync(file(id), `---\nid: ${id}\ntitle: ${id}\ndomain: wp\nsummary: s\nsection: sec-wp-root00\n---\n\n# ${id}\n\ns\n\n${body}\n`);
  const sectionsBytes = () => readFileSync(sectionsFile(roots), "utf-8");
  const entriesState = () => Object.fromEntries(readdirSync(eDir()).sort().map((f) => [f, readFileSync(join(eDir(), f), "utf-8")]));
  const preview = (flags = FLAGS) => previewToFile({ roots, domain: "wp", entries: es, flags, namer, outDir: join(base, "plans"), codeVersion: "test" });
  const applyOpts = () => ({ backupDir: join(base, "backups") });

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "kb-planfile-"));
    roots = { kbBase: join(base, "base"), opsRoot: join(base, "ops"), denLocal: join(base, "den") };
    mkdirSync(eDir(), { recursive: true });
    es = synth("e", [{ axis: 1, n: 9 }, { axis: 2, n: 9 }, { axis: 3, n: 9 }]);
    for (const e of es) put(e.id);
    es = es.map((e) => ({ ...e, section: "sec-wp-root00" }));
    writeSections(roots, [{ id: "sec-wp-root00", domain: "wp", parent: null, depth: 0, label: "root", title: "Root", centroid: [], memberCount: es.length, childIds: [], summary: "r", summaryHash: "", dirty: false, memberCountAtLastLabel: 0, created: "x", updated: "x" } as never]);
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("apply equals plan: every entry's section line and the domain's tree are the plan's", async () => {
    const { file: planFile } = await preview();
    const plan = loadPlanFile(planFile);
    expect(plan.flags).toEqual(FLAGS);
    expect(plan.assignment).toHaveLength(es.length);
    expect(plan.tree.length).toBeGreaterThan(1);
    const before = sectionsBytes();
    const vectors = es.map((e) => ({ entryId: e.id, canonicalId: "", domain: "wp", vector: e.vector }));
    const r = applyPlanFile(roots, planFile, { ...applyOpts(), vectors });
    expect(r.entriesWritten).toBeGreaterThan(0);
    for (const s of readSections(roots).filter((x) => x.domain === "wp")) expect(s.centroid.length).toBe(24); // routing needs centroids
    for (const [id, sec] of plan.assignment) expect(sectionOf(id)).toBe(sec);
    const now = readSections(roots).filter((s) => s.domain === "wp");
    expect(now.map((s) => [s.id, s.parent, s.title, s.summary]).sort()).toEqual(plan.tree.map((s) => [s.id, s.parent, s.title, s.summary]).sort());
    expect(sectionsBytes()).not.toBe(before);
    expect(readLedger(roots).filter((e) => e.t === "sections_replaced")).toHaveLength(1);
    expect(readdirSync(join(base, "backups"))).toContain(r.stamp);
  });

  it("refuses when an entry was added since the plan, writing nothing", async () => {
    const { file: planFile } = await preview();
    put("late-arrival");
    const sBefore = sectionsBytes(), eBefore = entriesState();
    expect(() => applyPlanFile(roots, planFile, applyOpts())).toThrow(/entry set changed/);
    expect(sectionsBytes()).toBe(sBefore);
    expect(entriesState()).toEqual(eBefore);
  });

  it("refuses a content edit that keeps the same ids", async () => {
    const { file: planFile } = await preview();
    put(es[3].id, "EDITED after the plan");
    const sBefore = sectionsBytes(), eBefore = entriesState();
    expect(() => applyPlanFile(roots, planFile, applyOpts())).toThrow(/entry set changed/);
    expect(sectionsBytes()).toBe(sBefore);
    expect(entriesState()).toEqual(eBefore);
  });

  it("refuses when the expected flags differ from the plan's flags, and needs no engine to say so", async () => {
    const { file: planFile } = await preview();
    const sBefore = sectionsBytes();
    expect(() => applyPlanFile(roots, planFile, { ...applyOpts(), expectFlags: { ...FLAGS, allowCollapse: true } })).toThrow(/flags differ/);
    expect(sectionsBytes()).toBe(sBefore);
    // the same flags are accepted
    expect(applyPlanFile(roots, planFile, { ...applyOpts(), expectFlags: FLAGS }).entriesWritten).toBeGreaterThan(0);
  });

  it("restore returns the entries' section lines and the sections to the pre-apply state", async () => {
    const { file: planFile } = await preview();
    const sBefore = readSections(roots), eBefore = entriesState();
    const { stamp } = applyPlanFile(roots, planFile, applyOpts());
    expect(entriesState()).not.toEqual(eBefore);
    restoreRebuild(roots, stamp);
    expect(entriesState()).toEqual(eBefore);
    const after = readSections(roots);
    expect(after.map((s) => [s.id, s.parent, s.title])).toEqual(sBefore.map((s) => [s.id, s.parent, s.title]));
    expect(existsSync(sectionsFile(roots))).toBe(true);
  });

  it("a namer that fails marks the plan with the auto-titled sections and fails the preview unless the fallback is allowed", async () => {
    const failing: Namer = async () => { throw new Error("model unreachable"); };
    await expect(previewToFile({ roots, domain: "wp", entries: es, flags: { ...FLAGS, allowKmeansFallback: false }, namer: failing, outDir: join(base, "plans"), codeVersion: "test" })).rejects.toThrow(/auto-titled/);
    expect(existsSync(join(base, "plans"))).toBe(false);
    const r = await previewToFile({ roots, domain: "wp", entries: es, flags: FLAGS, namer: failing, outDir: join(base, "plans"), codeVersion: "test" });
    expect(r.plan.engine.namerFallbacks.length).toBeGreaterThan(0);
    expect(r.plan.engine.partitionerUsed).toBe(false);
    expect(readFileSync(r.mdFile, "utf-8").split("\n")[0]).toMatch(/^WARNING: \d+ sections? auto-titled, the model was unreachable/);
  });

  it("refuses a malformed plan (path-like domain, assignment to an unknown section) before writing anything", async () => {
    const { file: planFile } = await preview();
    const good = JSON.parse(readFileSync(planFile, "utf-8"));
    const sBefore = sectionsBytes(), eBefore = entriesState();
    for (const bad of [{ ...good, domain: "../x" }, { ...good, assignment: [...good.assignment.slice(1), [good.assignment[0][0], "sec-wp-nowhere"]] }]) {
      const f = join(base, "bad.json");
      writeFileSync(f, JSON.stringify(bad));
      expect(() => applyPlanFile(roots, f, applyOpts())).toThrow(/invalid rebuild plan/);
    }
    expect(sectionsBytes()).toBe(sBefore);
    expect(entriesState()).toEqual(eBefore);
    expect(existsSync(join(base, "backups"))).toBe(false);
  });

  it("refuses when the domain's sections changed since the plan (a reorg), writing nothing", async () => {
    const { file: planFile } = await preview();
    const secs = readSections(roots);
    writeSections(roots, secs.map((s) => ({ ...s, title: "Renamed by a reorg" })));
    const eBefore = entriesState();
    expect(() => applyPlanFile(roots, planFile, applyOpts())).toThrow(/sections changed/);
    expect(entriesState()).toEqual(eBefore);
  });
});
