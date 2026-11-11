// Throwaway analysis (work-wolfpack-Qm8jIZf): what-if variants of the KB rebuild's loose-entry rules on a real plan.
// No behaviour change; not part of the suite. Imports from dist, so run `pnpm --filter @wolfpack/kb build` first.
//   node --experimental-strip-types packages/kb/scripts/rebuild-whatif.mts [--data /tmp/whatif-data] [--out <dir>]
//        [--deltas 0.01,0.02,0.03,0.05] [--best-delta 0.02] [--best-m 0] [--best-mode min|p25] [--claude] [--claude-max 60]
// --data must be a COPY of the rebuild data dir (the embedder may write to it). Variant C only runs with --claude
// (real Claude calls through the Agent SDK); answers are cached in <out>/claude-cache.json.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { argv } from "node:process";
import { DEFAULT_RULES, centre, cosine, meanVec, unit, validatePartition, isPartition } from "../dist/librarian/tree-rules.js";
import { splitCacheKey, enginePartitioner, isValidProposal } from "../dist/librarian/llm-split.js";
import { createEmbedder, buildEntryVectors } from "../dist/librarian/embed.js";
import { readLedger, foldRegistry } from "../dist/librarian/ledger.js";
import { loadRebuildEntries } from "../dist/librarian/rebuild.js";

type Vec = number[];
interface Prop { categories: { name: string; ids: string[] }[]; doesntFit: string[] }
const arg = (n: string, d: string) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : d; };
const SCRATCH = "/Users/lukaflores/wolves/local/1uk4/scratch/kb-rebuild-20261111";
const DATA = arg("data", "/tmp/whatif-data");
const OUT = arg("out", join(SCRATCH, "whatif"));
const PLAN = join(SCRATCH, "data2/rebuild-plans/wolfpack-2026-11-11T03-18-41Z.json");
const MODELS = join(SCRATCH, "etc/hubd-curator-models.json");
const DELTAS = arg("deltas", "0.01,0.02,0.03,0.05").split(",").map(Number);
const BEST_DELTA = Number(arg("best-delta", "0.02"));
const BEST_M = Number(arg("best-m", "0"));
const BEST_MODE = arg("best-mode", "min") as "min" | "p25";
const USE_CLAUDE = argv.includes("--claude");
const CLAUDE_MAX = Number(arg("claude-max", "60"));
const DOMAIN = "wolfpack";
let rules = DEFAULT_RULES;
// --sweep (work-wolfpack-pVfVjXK): dial sensitivity from cached answers only. The engine is never built and the
// partitioner stays undefined; grow()/pass() take an exact-cache-only branch first and count misses as needsClaude.
const SWEEP = argv.includes("--sweep");
if (SWEEP && USE_CLAUDE) throw new Error("--sweep never calls Claude: do not combine it with --claude");
const FLOOR_EX = Number(arg("floor", "0.05"));
mkdirSync(OUT, { recursive: true });

// ── inputs ───────────────────────────────────────────────────────────────────
const roots = { kbBase: join(DATA, "kb/base"), opsRoot: join(DATA, "kb/ops"), denLocal: DATA };
const vectors = await buildEntryVectors(roots, foldRegistry(readLedger(roots)), createEmbedder(roots));
const entries = loadRebuildEntries(join(roots.kbBase, "domains"), DOMAIN, vectors).sort((a, b) => (a.id < b.id ? -1 : 1));
const byId = new Map(entries.map((e) => [e.id, e]));
const title = (id: string) => byId.get(id)?.title ?? id;
const plan = JSON.parse(readFileSync(PLAN, "utf-8"));
const pool: Prop[] = [];
const exact = new Map<string, Prop>();
for (const [k, v] of Object.entries(JSON.parse(readFileSync(join(DATA, "split-cache.json"), "utf-8")))) if (isValidProposal(v)) { exact.set(k, v as Prop); pool.push(v as Prop); }
const claudeCachePath = join(OUT, "claude-cache.json");
const claudeCache: Record<string, Prop> = existsSync(claudeCachePath) ? JSON.parse(readFileSync(claudeCachePath, "utf-8")) : {};
let claudeCalls = 0;
let partitioner: ReturnType<typeof enginePartitioner> | undefined;
let engineNote = "not requested (run with --claude)";
if (USE_CLAUDE && !SWEEP) {
  try {
    const { loadModelTable } = await import("@wolfpack/engine");
    const { createLibrarianEngine } = await import("../dist/librarian/engine.js");
    partitioner = enginePartitioner(createLibrarianEngine(loadModelTable({ file: MODELS }).table));
    engineNote = "built with createLibrarianEngine(loadModelTable({file: hubd-curator-models.json}))";
  } catch (e) { engineNote = "engine could not be built: " + (e instanceof Error ? e.message : String(e)); }
}

// ── validation (copy of validatePartition with a tolerance; delta 0 is checked against the real one) ───────────
interface Decision { labels: number[]; k: number; names: string[]; leftovers: number[]; ok: boolean; reports: { name: string; size: number; coherent: number; kept: boolean }[]; margins: Map<number, { own: number; other: number }> }
function validate(vecs: Vec[], p: { names: string[]; members: number[][] }, r: typeof rules, delta: number): Decision {
  const n = vecs.length, seen = new Set<number>();
  const honoured = new Set(p.members.map((ms, c) => ({ c, size: ms.length })).sort((a, b) => b.size - a.size || a.c - b.c).slice(0, r.llmMaxCategories).map((x) => x.c));
  const cats = p.members.map((ms, c) => (honoured.has(c) ? ms : [])).map((ms) => ms.filter((i) => i >= 0 && i < n && !seen.has(i) && (seen.add(i), true)));
  const X = centre(vecs);
  const cents = cats.map((ms) => (ms.length ? unit(meanVec(ms.map((i) => X[i]))) : null));
  const reports: Decision["reports"] = [], sets: number[][] = [], margins = new Map<number, { own: number; other: number }>();
  cats.forEach((ms, c) => {
    const good: number[] = [];
    for (const i of ms) {
      const rest = ms.filter((j) => j !== i);
      if (!rest.length) continue;
      const own = cosine(unit(meanVec(rest.map((j) => X[j]))), X[i]);
      let other = -Infinity;
      cents.forEach((cc, d) => { if (d !== c && cc) other = Math.max(other, cosine(cc, X[i])); });
      margins.set(i, { own, other });
      if (own > other - delta) good.push(i);
    }
    const share = ms.length ? good.length / ms.length : 0;
    const kept = honoured.has(c) && good.length >= r.minGroup && share >= r.llmMinPartialShare;
    reports.push({ name: p.names[c] ?? `Category ${c + 1}`, size: ms.length, coherent: good.length, kept });
    sets.push(kept ? good : []);
  });
  const chosen = reports.map((x, c) => (x.kept ? c : -1)).filter((c) => c >= 0);
  const labels = new Array<number>(n).fill(-1);
  chosen.forEach((c, g) => { for (const i of sets[c]) labels[i] = g; });
  return { labels, k: chosen.length, names: chosen.map((c) => reports[c].name), leftovers: labels.flatMap((l, i) => (l < 0 ? [i] : [])), ok: chosen.length >= 2, reports, margins };
}
function checkAgainstReal(vecs: Vec[], p: { names: string[]; members: number[][] }, mine: Decision): void {
  const real = validatePartition(vecs, { ...p, doesntFit: [] }, rules);
  if (isPartition(real)) { if (!mine.ok || real.labels.join() !== mine.labels.join()) throw new Error("validate copy diverges from validatePartition"); }
  else if (mine.ok) throw new Error("validate copy diverges from validatePartition (real rejected)");
}

// ── proposals: exact cache hit, else the best-overlapping cached proposal restricted to the set ──────────────
function resolver(ids: string[]) {
  const ex = new Map(ids.map((id, i) => [id, i])), suf = new Map<string, number | null>();
  ids.forEach((id, i) => { const s = id.slice(id.lastIndexOf("-") + 1); suf.set(s, suf.has(s) ? null : i); });
  return (xs: string[]) => xs.map((x) => x.trim()).map((x) => ex.get(x) ?? suf.get(x) ?? undefined).filter((i): i is number => i !== undefined);
}
function lookup(key: string, ids: string[]): { prop: Prop; approx: boolean } | undefined {
  const hit = exact.get(key) ?? claudeCache[key];
  if (hit) return { prop: hit, approx: false };
  const S = new Set(ids);
  let best: { prop: Prop; cov: number } | undefined;
  for (const p of pool) {
    // a proposal made for (almost) a subset of S: >= 80% of its ids are in S, and it covers as many of S as possible
    const all = new Set(p.categories.flatMap((c) => c.ids));
    const inter = [...all].filter((x) => S.has(x)).length;
    if (all.size && inter / all.size >= 0.8 && inter >= 6 && (!best || inter > best.cov)) best = { prop: p, cov: inter };
  }
  if (!best) return undefined;
  return { prop: { categories: best.prop.categories.map((c) => ({ name: c.name, ids: c.ids.filter((x) => S.has(x)) })), doesntFit: [] }, approx: true };
}

// ── the tree ─────────────────────────────────────────────────────────────────
interface Node { name: string; direct: string[]; children: Node[]; note?: string }
interface Placement { entry: string; section: string; target: string; score: number; threshold: number; second: string; secondScore: number }
interface Move { entry: string; group: string; own: number; other: number; rival?: string }
interface NewGroup { section: string; name: string; members: string[] }
interface Cfg { label: string; delta: number; place?: { m: number; mode: "min" | "p25" | "median"; floor?: number }; claude?: boolean; maxDepth?: number }
interface Stats { leftMiss: number; placements: Placement[]; gained: Move[]; newGroups: NewGroup[]; approx: number; pending: string[]; claudeCalls: number; failures: string[] }

async function pass(vecs: Vec[], ids: string[], first: Decision, salt: string, cfg: Cfg, st: Stats, title0: string): Promise<Decision> {
  if (first.leftovers.length < rules.minGroup) return first;
  const leftIds = first.leftovers.map((i) => ids[i]);
  const key = splitCacheKey(DOMAIN + salt, leftIds);
  let prop: Prop | undefined;
  if (SWEEP) {
    const hit = exact.get(key) ?? claudeCache[key];
    if (!hit) { st.leftMiss++; return first; }
    prop = { ...hit, categories: hit.categories.slice(0, rules.llmMaxCategories) };
  } else if (salt === "#leftovers3") {
    prop = claudeCache[key];
    if (!prop) {
      if (!partitioner || claudeCalls >= CLAUDE_MAX) return first;
      try {
        claudeCalls++; st.claudeCalls++;
        const fresh = await partitioner({ parentTitle: `${title0} (entries that fit none of its other groups)`, members: leftIds.map((id) => ({ id, title: title(id), summary: byId.get(id)?.summary })) });
        if (!isValidProposal(fresh)) throw new Error("malformed proposal");
        prop = fresh as Prop; claudeCache[key] = prop;
        writeFileSync(claudeCachePath, JSON.stringify(claudeCache));
      } catch (e) { st.failures.push(`${title0}: ${e instanceof Error ? e.message.slice(0, 120) : e}`); return first; }
    }
  } else {
    const l = lookup(key, leftIds);
    if (!l) return first;
    if (l.approx) st.approx++;
    prop = l.prop;
  }
  const kept = first.names.map((_, g) => first.labels.flatMap((l, i) => (l === g ? [i] : [])));
  const rl = resolver(leftIds);
  const fresh = prop.categories.map((c) => rl(c.ids).map((j) => first.leftovers[j]));
  const total = kept.length + fresh.length;
  const names = [...first.names, ...prop.categories.map((c) => c.name)];
  const r2 = { ...rules, llmMaxCategories: Math.max(rules.llmMaxCategories, Math.min(total, rules.llmMaxCategoriesTotal)) };
  const both = validate(vecs, { names, members: [...kept, ...fresh] }, r2, cfg.delta);
  if (!both.ok || both.k <= first.k || both.k > rules.llmMaxCategoriesTotal) return first;
  if (!kept.every((ms) => ms.length > 0 && new Set(ms.map((i) => both.labels[i])).size === 1 && both.labels[ms[0]] >= 0)) return first;
  if (salt === "#leftovers3") both.names.slice(first.k).forEach((name, j) => st.newGroups.push({ section: title0, name, members: ids.filter((_, i) => both.labels[i] === first.k + j) }));
  return both;
}

function percentile(sorted: number[], q: number): number { return sorted[Math.floor(q * (sorted.length - 1))]; }

async function grow(node: Node, memberIds: string[], depth: number, cfg: Cfg, st: Stats): Promise<void> {
  const ids = [...memberIds].sort();
  node.direct = ids;
  if (ids.length <= rules.splitAbove) return;
  if (cfg.maxDepth && depth >= cfg.maxDepth) return;
  const vecs = ids.map((id) => byId.get(id)!.vector);
  const key = splitCacheKey(DOMAIN, ids);
  let l: { prop: Prop; approx: boolean } | undefined;
  if (SWEEP) {
    const hit = exact.get(key) ?? claudeCache[key];
    l = hit ? { prop: { ...hit, categories: hit.categories.slice(0, rules.llmMaxCategories) }, approx: false } : undefined;
    if (!l) { st.pending.push(`${node.name} (${ids.length})`); return; }
  } else l = partitioner ? ((exact.get(key) ?? claudeCache[key]) ? { prop: (exact.get(key) ?? claudeCache[key]) as Prop, approx: false } : undefined) : lookup(key, ids);
  if (!l && partitioner && claudeCalls < CLAUDE_MAX) {
    try {
      claudeCalls++; st.claudeCalls++;
      const fresh = await partitioner({ parentTitle: node.name, members: ids.map((id) => ({ id, title: title(id), summary: byId.get(id)?.summary })) });
      if (!isValidProposal(fresh)) throw new Error("malformed proposal");
      claudeCache[key] = fresh as Prop;
      writeFileSync(claudeCachePath, JSON.stringify(claudeCache));
      l = { prop: fresh as Prop, approx: false };
    } catch (e) { st.failures.push(`${node.name}: ${e instanceof Error ? e.message.slice(0, 120) : e}`); }
  }
  if (!l) { st.pending.push(`${node.name} (${ids.length})`); return; }
  if (l.approx) st.approx++;
  const rp = resolver(ids);
  const p = { names: l.prop.categories.map((c) => c.name), members: l.prop.categories.map((c) => rp(c.ids)) };
  let d = validate(vecs, p, rules, cfg.delta);
  if (cfg.delta === 0 && !SWEEP) checkAgainstReal(vecs, p, d);
  if (!d.ok) {
    const one = d.reports.map((x, c) => (x.kept ? c : -1)).filter((c) => c >= 0);
    if (one.length !== 1) return;
    // one category survived: the leftovers may hold its partner (same as judgeSplit)
    const labels = d.labels.map((x) => (x >= 0 ? 0 : -1));
    d = { ...d, labels, k: 1, names: [d.reports[one[0]].name], leftovers: labels.flatMap((x, i) => (x < 0 ? [i] : [])) };
  }
  d = await pass(vecs, ids, d, "#leftovers", cfg, st, node.name);
  if (cfg.claude && d.k >= 2) d = await pass(vecs, ids, d, "#leftovers3", cfg, st, node.name);
  if (d.k < 2) return;
  const groups = d.names.map((name, g) => ({ name, ids: ids.filter((_, i) => d.labels[i] === g), base: ids.filter((_, i) => d.labels[i] === g) }));
  let loose = ids.filter((_, i) => d.labels[i] < 0);
  // record members that only the tolerance let in (own <= other)
  if (cfg.delta > 0) ids.forEach((id, i) => {
    const m = d.margins.get(i), g = d.labels[i];
    if (m && g >= 0 && m.own <= m.other) st.gained.push({ entry: id, group: `${node.name} / ${d.names[g]}`, own: m.own, other: m.other });
  });
  // nearest-group placement
  if (cfg.place) {
    const X = centre(vecs), pos = new Map(ids.map((id, i) => [id, i]));
    const info = groups.map((g) => {
      const ix = g.base.map((id) => pos.get(id)!);
      const loo = ix.map((i) => cosine(unit(meanVec(ix.filter((j) => j !== i).map((j) => X[j]))), X[i])).sort((a, b) => a - b);
      const bar = cfg.place!.mode === "min" ? loo[0] : cfg.place!.mode === "median" ? percentile(loo, 0.5) : percentile(loo, 0.25);
      return { cent: unit(meanVec(ix.map((i) => X[i]))), thr: Math.max(bar, cfg.place!.floor ?? -Infinity) };
    });
    const still: string[] = [];
    for (const id of loose) {
      const sc = info.map((x, g) => ({ g, s: cosine(x.cent, X[pos.get(id)!]) })).sort((a, b) => b.s - a.s);
      const [b, s2] = [sc[0], sc[1]];
      if (b.s >= info[b.g].thr && b.s - s2.s >= cfg.place.m) {
        groups[b.g].ids.push(id);
        st.placements.push({ entry: id, section: node.name, target: groups[b.g].name, score: b.s, threshold: info[b.g].thr, second: groups[s2.g].name, secondScore: s2.s });
      } else still.push(id);
    }
    loose = still;
  }
  node.direct = loose;
  for (const g of groups) {
    const child: Node = { name: g.name, direct: [], children: [] };
    node.children.push(child);
    await grow(child, g.ids, depth + 1, cfg, st);
  }
}

// ── metrics and rendering ────────────────────────────────────────────────────
const total = (n: Node): number => n.direct.length + n.children.reduce((a, c) => a + total(c), 0);
function levels(root: Node): { depth: number; loose: number; under: number }[] {
  const acc = new Map<number, { loose: number; under: number }>();
  const walk = (n: Node, d: number) => {
    if (n.children.length) { const a = acc.get(d) ?? { loose: 0, under: 0 }; a.loose += n.direct.length; a.under += total(n); acc.set(d, a); }
    n.children.forEach((c) => walk(c, d + 1));
  };
  walk(root, 0);
  return [...acc].sort((a, b) => a[0] - b[0]).map(([depth, v]) => ({ depth, ...v }));
}
const looseTotal = (n: Node): number => (n.children.length ? n.direct.length : 0) + n.children.reduce((a, c) => a + looseTotal(c), 0);
function sectionsOver(n: Node, path = n.name, out: string[] = []): string[] {
  if (n.direct.length > rules.splitAbove) out.push(`${path} (${n.direct.length} direct)`);
  n.children.forEach((c) => sectionsOver(c, path + " / " + c.name, out));
  return out;
}
function countSections(n: Node): number { return 1 + n.children.reduce((a, c) => a + countSections(c), 0); }
function tree(n: Node, ind = 0): string[] {
  const t = total(n);
  const head = "  ".repeat(ind) + `- ${n.name} — ${t} total` + (n.children.length ? `, ${n.direct.length} loose` : "");
  return [head, ...n.children.flatMap((c) => tree(c, ind + 1))];
}
const pick = <T,>(xs: T[], k: number): T[] => (xs.length <= k ? xs : Array.from({ length: k }, (_, i) => xs[Math.floor((i * xs.length) / k)]));
const f = (x: number) => x.toFixed(3);

// ── run ──────────────────────────────────────────────────────────────────────
interface Result { cfg: Cfg; root: Node; st: Stats }
async function run(cfg: Cfg): Promise<Result> {
  const st: Stats = { leftMiss: 0, placements: [], gained: [], newGroups: [], approx: 0, pending: [], claudeCalls: 0, failures: [] };
  const root: Node = { name: `ROOT (${DOMAIN})`, direct: [], children: [] };
  await grow(root, entries.map((e) => e.id), 0, cfg, st);
  return { cfg, root, st };
}

// ── --sweep: one dial at a time, cached answers only ─────────────────────────
if (SWEEP) {
  partitioner = (async () => { throw new Error("sweep: the partitioner was called (no Claude calls are allowed in --sweep)"); }) as unknown as typeof partitioner;
  const D = { ...DEFAULT_RULES };
  const N = entries.length;
  interface Row { dial: string; setting: string; lt: number; perLevel: string; secs: number; depth: number; kids: number; changed: number; needs: number; needs2: number; ms: number; res: Result }
  const pathsOf = (root: Node): Map<string, string> => {
    const m = new Map<string, string>();
    const walk = (n: Node, p: string) => { for (const id of n.direct) m.set(id, p); n.children.forEach((c) => walk(c, p + " / " + c.name)); };
    walk(root, root.name); return m;
  };
  const depthOf = (n: Node): number => (n.children.length ? 1 + Math.max(...n.children.map(depthOf)) : 0);
  const kidsOf = (n: Node): number => Math.max(n.children.length, ...n.children.map(kidsOf), 0);
  let basePaths: Map<string, string> | undefined;
  const exec = async (dial: string, setting: string, over: Partial<typeof D>, cfg: Partial<Cfg>): Promise<Row> => {
    rules = { ...D, ...over };
    const t0 = performance.now();
    const res = await run({ label: `${dial}: ${setting}`, delta: 0, ...cfg });
    const ms = performance.now() - t0;
    const lv = levels(res.root), paths = pathsOf(res.root);
    basePaths ??= paths;
    let changed = 0; for (const [id, p] of paths) if (basePaths.get(id) !== p) changed++;
    const row: Row = { dial, setting, lt: looseTotal(res.root), perLevel: lv.map((x) => `d${x.depth}:${x.loose}`).join(" "), secs: countSections(res.root), depth: depthOf(res.root), kids: kidsOf(res.root), changed, needs: res.st.pending.length, needs2: res.st.leftMiss, ms, res };
    rules = D; return row;
  };
  const rows: Row[] = [];
  const add = async (dial: string, setting: string, over: Partial<typeof D>, cfg: Partial<Cfg> = {}) => { const r = await exec(dial, setting, over, cfg); rows.push(r); return r; };
  // default run first (also checks the δ=0 copy against the real validatePartition once)
  rules = D;
  const dflt = await add("default", "all defaults", {});
  for (const v of [6, 8, 10, 14, 20]) await add("splitAbove", String(v), { splitAbove: v });
  for (const v of [2, 3, 4, 5]) await add("llmMaxCategories", String(v), { llmMaxCategories: v });
  for (const v of [2, 3, 4, 5, 6]) await add("minGroup", String(v), { minGroup: v });
  for (const v of [-0.05, 0, 0.03, 0.05, 0.08, 0.12]) await add("delta", String(v), {}, { delta: v });
  await add("join", "off", {});
  for (const mode of ["median", "p25", "min"] as const) for (const floor of [0, 0.02, 0.05, 0.08]) await add("join", `${mode === "min" ? "weakest" : mode} floor ${floor}`, {}, { place: { m: 0.01, mode, floor } });
  for (const v of [2, 3, 4, 0]) await add("maxDepth", v ? String(v) : "none", {}, { maxDepth: v });
  // maxDepth does nothing at defaults (the default tree stops at depth 2), so repeat it on top of the join where the tree goes deeper
  for (const v of [2, 3, 4]) await add("maxDepth+join", `${v} (with join weakest floor 0.05)`, {}, { maxDepth: v, place: { m: 0.01, mode: "min", floor: 0.05 } });
  const sweepRows = rows.length;
  const COMBOS: { label: string; over: Partial<typeof D>; cfg: Partial<Cfg> }[] = JSON.parse(arg("combos", JSON.stringify([
    { label: "join weakest floor 0.05 + δ 0.03", over: {}, cfg: { delta: 0.03, place: { m: 0.01, mode: "min", floor: 0.05 } } },
    { label: "join weakest floor 0.05 + δ 0.03 + minGroup 2", over: { minGroup: 2 }, cfg: { delta: 0.03, place: { m: 0.01, mode: "min", floor: 0.05 } } },
    { label: "join weakest floor 0.05 + δ 0.03 + splitAbove 14", over: { splitAbove: 14 }, cfg: { delta: 0.03, place: { m: 0.01, mode: "min", floor: 0.05 } } },
  ])));
  for (const c of COMBOS) await add("combo", c.label, c.over, c.cfg);
  // verdicts: range over each dial's settings
  const dials = ["splitAbove", "llmMaxCategories", "minGroup", "delta", "join", "maxDepth"];
  const span = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
  const dialRows = (d: string) => rows.slice(0, sweepRows).filter((r) => (d === "maxDepth" ? r.dial === "maxDepth+join" : r.dial === d)); // maxDepth is judged on the join-on rows only: without join the default tree never passes depth 2
  const verdicts = dials.map((d) => {
    const rs = dialRows(d);
    const l = span(rs.map((r) => r.lt)), s = span(rs.map((r) => r.secs)), dp = span(rs.map((r) => r.depth));
    const basic = l >= 20 || s >= 4 || dp >= 1, adv = l >= 10 || s >= 2 || dp >= 0.5;
    const needs = span(rs.map((r) => r.needs + r.needs2)), maxN = Math.max(...rs.map((r) => r.needs + r.needs2));
    return { d, rs, l, s, dp, verdict: basic ? "Basic" : adv ? "Advanced" : "Drop", maxN, needs };
  });
  const rangeOf = (d: string) => { const rs = dialRows(d); return rs.map((r) => r.setting).join(", ").replace(/ \(with join weakest floor 0\.05\)/g, "") + (d === "maxDepth" ? " (measured with join weakest floor 0.05)" : ""); };
  // timing: median of 5 planning passes from cache
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const timeCfg = async (over: Partial<typeof D>, cfg: Partial<Cfg>) => { const t: number[] = []; for (let i = 0; i < 5; i++) { rules = { ...D, ...over }; const t0 = performance.now(); await run({ label: "t", delta: 0, ...cfg }); t.push(performance.now() - t0); rules = D; } return median(t); };
  const heavy = rows.find((r) => r.dial === "join" && r.setting === "weakest floor 0.05")!; // most work per pass: placement plus re-judging grown groups
  const heavyOver = ((): [Partial<typeof D>, Partial<Cfg>] => { const c = COMBOS.find((x) => `${x.label}` === heavy.setting); return c ? [c.over, c.cfg] : [{}, {}]; })();
  void heavyOver;
  const tDefault = await timeCfg({}, {});
  const heavyDef = heavy.dial === "combo" ? heavyOver : heavy.dial === "join" ? [{}, { place: { m: 0.01, mode: (heavy.setting.startsWith("median") ? "median" : heavy.setting.startsWith("p25") ? "p25" : "min") as "min", floor: Number(heavy.setting.split(" ").pop()) } }] as [Partial<typeof D>, Partial<Cfg>] : heavy.dial === "delta" ? [{}, { delta: Number(heavy.setting) }] as [Partial<typeof D>, Partial<Cfg>] : heavy.dial === "splitAbove" ? [{ splitAbove: Number(heavy.setting) }, {}] as [Partial<typeof D>, Partial<Cfg>] : heavy.dial === "minGroup" ? [{ minGroup: Number(heavy.setting) }, {}] as [Partial<typeof D>, Partial<Cfg>] : [{}, {}] as [Partial<typeof D>, Partial<Cfg>];
  const tHeavy = await timeCfg(heavyDef[0], heavyDef[1]);
  // join floor examples: weakest-member bar with no floor; joined = score >= FLOOR_EX, refused = below it
  const jr = rows.find((r) => r.dial === "join" && r.setting === "weakest floor 0")!;
  const pl = jr.res.st.placements.slice().sort((a, b) => a.score - b.score);
  const joined = pl.filter((p) => p.score >= FLOOR_EX), refused = pl.filter((p) => p.score < FLOOR_EX);
  const ex = (p: Placement) => `- "${title(p.entry)}" → **${p.target}** (in ${p.section}); score ${f(p.score)}, group bar ${f(p.threshold)}, runner-up ${p.second} ${f(p.secondScore)}`;
  const S: string[] = [];
  S.push("# KB tree dials: sensitivity sweep (work-wolfpack-pVfVjXK)", "");
  S.push("| Dial | Range | Loose moved | Sections moved | Depth moved | Verdict |", "|---|---|---|---|---|---|");
  const nice: Record<string, string> = { splitAbove: "Section size before splitting", llmMaxCategories: "Most groups per section", minGroup: "Smallest group", delta: "Group strictness (δ)", join: "Join bar (+ floor)", maxDepth: "Deepest level" };
  for (const v of verdicts) S.push(`| ${nice[v.d]} | ${rangeOf(v.d)} | ${v.l} | ${v.s} | ${v.dp} | **${v.verdict}** |`);
  S.push("", `Entries: ${N}. Thresholds: Basic = loose ≥ 20, or sections ≥ 4, or depth ≥ 1; Advanced = at least half of those (loose ≥ 10, sections ≥ 2, depth ≥ 0.5); else Drop. "Moved" = max minus min across the dial's settings.`, "");
  S.push("## Caveats", "", `- Zero Claude calls: engine never constructed, \`partitioner\` replaced by a function that throws, \`--sweep\` refuses \`--claude\`, grow()/pass() look up exact cache keys only (no approximate overlap). Claude calls made: ${claudeCalls}.`, "- needsClaude = sections above splitAbove with no cached answer (left whole) + leftover re-asks with no cached answer. A small splitAbove makes many more sections eligible, so those rows are lower bounds on how much would move; larger-than-default branch counts cannot be measured.", "- llmMaxCategories: cached proposals are truncated to the first N categories in proposal order. maxDepth counts split levels below the root (root = 0; maxDepth 2 means a depth-2 section is not split further). Join floor = minimum absolute cosine to the target group's centroid, applied on top of the bar; margin over runner-up fixed at 0.01.", "");
  for (const v of verdicts) S.push(`- ${nice[v.d]}: needsClaude (first-pass + leftover) ranges up to ${v.maxN}, spread ${v.needs} across settings${v.maxN > 0 ? " → measurement incomplete" : " → complete"}.`);
  S.push("", "## All settings", "", "Changed = entries whose section differs from the default run. Loose/level = loose entries in non-leaf sections at each depth (d0 = root).", "", "| Dial | Setting | Loose | Loose per level | Sections | Max depth | Max children | Changed vs default | needsClaude (split / leftover) |", "|---|---|---|---|---|---|---|---|---|");
  rows.forEach((r) => S.push(`| ${r.dial} | ${r.setting} | ${r.lt} | ${r.perLevel} | ${r.secs} | ${r.depth} | ${r.kids} | ${r.changed} | ${r.needs} / ${r.needs2} |`));
  S.push("", `## Join floor examples (weakest-member bar; floor ${FLOOR_EX})`, "", `${pl.length} entries join with no floor; ${joined.length} have a score ≥ ${FLOOR_EX} (join at this floor), ${refused.length} are below it (refused).`, "", "Join at floor:", ...pick(joined, 6).map(ex), "", "Refused by floor (would join with no floor):", ...pick(refused, 6).map(ex), "");
  S.push("## Timing (one planning pass from cache, median of 5)", "", `- defaults: ${tDefault.toFixed(0)} ms; heaviest setting (${heavy.dial} ${heavy.setting}): ${tHeavy.toFixed(0)} ms (this machine).`, `- sfo-01 estimate at 3–4×: defaults ${(tDefault * 3 / 1000).toFixed(2)}–${(tDefault * 4 / 1000).toFixed(2)} s; heaviest ${(tHeavy * 3 / 1000).toFixed(2)}–${(tHeavy * 4 / 1000).toFixed(2)} s. Under 1.5 s there: ${tHeavy * 4 < 1500 ? "yes" : "NO"} (worst case 4×).`, "");
  if (claudeCalls !== 0) throw new Error("sweep made Claude calls");
  const outPath = join(OUT, "dials-sweep-report.md");
  writeFileSync(outPath, S.join("\n") + "\n");
  console.log(`wrote ${outPath}; claude calls ${claudeCalls}`);
  process.exit(0);
}
const results: Result[] = [];
const base = await run({ label: "Baseline (current rules)", delta: 0 });
results.push(base);
// the plan, for comparison: direct counts per section from the assignment
const planDirect = new Map<string, number>();
for (const [, s] of plan.assignment as [string, string][]) planDirect.set(s, (planDirect.get(s) ?? 0) + 1);
const planShape = (plan.tree as { id: string; childIds: string[] }[]).map((s) => `${s.childIds.length ? "N" : "L"}${planDirect.get(s.id) ?? 0}`).sort().join(",");
const shape = (n: Node): string[] => [`${n.children.length ? "N" : "L"}${n.direct.length}`, ...n.children.flatMap(shape)];
const myShape = shape(base.root).sort().join(",");
const reproduces = planShape === myShape;
for (const dl of DELTAS) results.push(await run({ label: `A: tolerance δ=${dl}`, delta: dl }));
for (const mode of ["min", "p25"] as const) for (const m of [0, 0.01, 0.02]) results.push(await run({ label: `B: nearest-group, ${mode === "min" ? "weakest member" : "25th pct"}, m=${m}`, delta: 0, place: { m, mode } }));
if (USE_CLAUDE && partitioner) {
  results.push(await run({ label: "C: Claude regroup, current rule", delta: 0, claude: true }));
  results.push(await run({ label: `C: Claude regroup, δ=${BEST_DELTA}`, delta: BEST_DELTA, claude: true }));
  results.push(await run({ label: `D: C(δ=${BEST_DELTA}) + B(${BEST_MODE}, m=${BEST_M})`, delta: BEST_DELTA, claude: true, place: { m: BEST_M, mode: BEST_MODE } }));
}

const N = entries.length;
const L: string[] = [];
L.push(`# Rebuild what-if: loose entries (work-wolfpack-Qm8jIZf)`, "",
  `Domain ${DOMAIN}, ${N} entries, plan \`${PLAN.split("/").pop()}\`. Vectors: nomic-embed-text cache of the KB copy. Proposals: split cache (exact key hit; where a member set changed, the best-overlapping cached proposal restricted to the set, marked "approx" below; no hit = section stays whole and is listed as pending a new Claude call).`, "",
  `Baseline reproduces the plan's shape (node kind + direct count per section): **${reproduces ? "yes" : "NO"}**. Variant C engine: ${engineNote}. Claude calls made: ${claudeCalls}.`, "",
  "Definitions: *loose* = entries sitting directly in a non-leaf section. Share per level = loose / entries under the non-leaf sections at that depth (depth 0 = root). Placement score = cosine of the (centred) entry vector to the group's centroid; a group's threshold is its weakest (or 25th-percentile) coherent member's leave-one-out cosine to the group's centroid. Margin = best minus second-best group.", "");
for (const r of results) {
  const lv = levels(r.root), lt = looseTotal(r.root);
  L.push(`## ${r.cfg.label}`, "", "### Tree", "", ...tree(r.root), "");
  L.push("### Loose entries", "", `Total loose: **${lt} of ${N} (${((100 * lt) / N).toFixed(0)}%)**; sections: ${countSections(r.root)}.`, "",
    ...lv.map((x) => `- depth ${x.depth}: ${x.loose} of ${x.under} (${((100 * x.loose) / x.under).toFixed(0)}%)`), "");
  const over = sectionsOver(r.root);
  L.push("### Follow-on", "", over.length ? `Sections above splitAbove (${rules.splitAbove}) after this variant (a leaf-level section here means no further judgement was possible or it was judged and kept whole):` : "No section is above splitAbove.", ...over.map((x) => `- ${x}`));
  if (r.st.pending.length) L.push("", `Sections that needed a proposal that is not cached (left whole; would need a new Claude call): ${r.st.pending.join("; ")}`);
  if (r.st.approx) L.push("", `Approximated proposals (overlap lookup instead of exact key): ${r.st.approx}`);
  if (r.st.failures.length) L.push("", `Claude failures: ${r.st.failures.join("; ")}`);
  L.push("", "### Examples", "");
  if (r.st.placements.length) {
    L.push(`${r.st.placements.length} entries placed.`, "");
    for (const p of pick(r.st.placements, 10)) L.push(`- "${title(p.entry)}" → **${p.target}** (in ${p.section}); score ${f(p.score)} vs group threshold ${f(p.threshold)}; runner-up ${p.second} ${f(p.secondScore)}, margin ${f(p.score - p.secondScore)}`);
  } else if (r.st.newGroups.length) {
    L.push(`${r.st.newGroups.length} new groups from Claude.`, "");
    for (const g of pick(r.st.newGroups, 10)) L.push(`- **${g.name}** (in ${g.section}, ${g.members.length} members): ${g.members.slice(0, 3).map((m) => `"${title(m)}"`).join("; ")}`);
  } else if (r.st.gained.length) {
    L.push(`${r.st.gained.length} entries are coherent only through the tolerance (own ≤ other).`, "");
    for (const g of pick(r.st.gained, 10)) L.push(`- "${title(g.entry)}" → **${g.group}**; own ${f(g.own)}, best other ${f(g.other)}, deficit ${f(g.other - g.own)}`);
  } else L.push("none (no change from baseline)");
  L.push("");
}
const gainedFor = (r: Result) => r.st.gained.length;
const rows = results.map((r) => {
  const lv = levels(r.root);
  const lt = looseTotal(r.root);
  return `| ${r.cfg.label} | ${lt} (${((100 * lt) / N).toFixed(0)}%) | ${lv.map((x) => `${((100 * x.loose) / x.under).toFixed(0)}%`).join(" / ")} | ${countSections(r.root)} | ${sectionsOver(r.root).length} | ${r.st.placements.length || gainedFor(r) || 0} | ${r.st.pending.length} |`;
});
L.push("## Comparison", "", "| Variant | Loose total | Loose share per level (0/1/2…) | Sections | Sections > 10 direct | Placed / tolerance-gained | Pending judgements |", "|---|---|---|---|---|---|---|", ...rows, "");
L.push("## Notes and recommendation", "",
  "- Method caveat: with Claude enabled, every variant (not just C) asks Claude for a fresh proposal when a section's member set has no exact split-cache key; answers are kept in claude-cache.json, so a re-run makes no calls. A/B rows therefore differ from a cache-only run.",
  "- C adds almost nothing at the root: the current rule already runs a second Claude pass over the leftovers, and a further pass over the same ~120 entries produced no group that passed validation. C only helps below the root, where new member sets get new proposals.",
  "- A (tolerance) is a small lever: delta 0.03 takes loose from 206 to about 174.",
  "- B with the weakest-member threshold is the big lever (206 to about 87 loose; root loose 5-10%). Condition 1 keeps groups self-similar by construction. The 25th-percentile threshold is stricter and leaves about 140 loose. The margin m barely matters (0 to 0.02); m=0.01 is a safe default. Placement grows several groups past 10 members, which would be judged again (one more level).",
  "- Recommended: keep validatePartition as is (or at most delta 0.03); add nearest-group placement (B, weakest-member threshold, m=0.01) after validation at every level, for both doesn't-fit and incoherent entries; then re-judge any group that grew past splitAbove. Skip C as a separate step.", "");
writeFileSync(join(OUT, "rebuild-whatif-report.md"), L.join("\n") + "\n");
console.log(`wrote ${join(OUT, "rebuild-whatif-report.md")}; reproduces plan: ${reproduces}; claude calls ${claudeCalls}`);
