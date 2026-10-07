#!/usr/bin/env node
/**
 * kb-health (v2) — measure section tree health: balance, cohesion, summary state.
 *
 * Replaces the v1 graph-based health check (Louvain/PageRank/modularity) with
 * tree metrics for the KB v2 hierarchical section backbone.
 *
 * METRICS:
 *   BALANCE/FANOUT  depth distribution, over-full/under-full nodes (vs HIERARCHY
 *                   thresholds), max depth vs maxDepth
 *   COHESION        child-centroid-to-parent-centroid cosine (proxy for section
 *                   tightness; flags sections below HIERARCHY.minCohesion)
 *   SUMMARY HEALTH  count sections with empty summary or dirty=true (stale)
 *   STRUCTURE       root/leaf counts, total sections, orphan check (parent id
 *                   that doesn't exist)
 *
 * Emits: console report, maps/KB-HEALTH.md (Obsidian), maps/tree/kb-health.json.
 *
 * PRE-MIGRATION GRACE: if no section tree exists yet (_sections.json missing),
 * prints a helpful message and exits 0 (non-blocking).
 *
 * Usage:
 *   KB_DEN_LOCAL=$WOLF_DEN/kb node scripts/kb-health.mjs
 *   (defaults: KB_BASE=~/wolves/knowledge/base, KB_DEN_LOCAL=$WOLF_DEN/kb)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const KB_BASE = process.env.KB_BASE || join(process.env.HOME, "wolves", "knowledge", "base");
const KB_DEN_LOCAL = process.env.KB_DEN_LOCAL || join(process.env.HOME, "wolves", "local", "dewey", "kb");
const SECTIONS_FILE = join(KB_DEN_LOCAL, "sections", "_sections.json");
const OUT = process.env.OUT || join(KB_BASE, "maps");

// HIERARCHY thresholds (mirrored from packages/engine/src/config/tuning.ts)
const HIERARCHY = {
  splitAt: 12,
  mergeBelow: 3,
  minCohesion: 0.80,
  maxDepth: 4,
};

// ── graceful pre-migration state ──────────────────────────────────────────────
if (!existsSync(SECTIONS_FILE)) {
  console.log("\n╔═══ KB HEALTH (v2 tree metrics) ═══");
  console.log("\n⚠️  No section tree yet.");
  console.log("    Run the KB v2 migration to build the section tree from existing entries.");
  console.log(`    Expected: ${SECTIONS_FILE}\n`);
  process.exit(0);
}

// ── load section tree ─────────────────────────────────────────────────────────
let sections;
try {
  sections = JSON.parse(readFileSync(SECTIONS_FILE, "utf-8"));
} catch (err) {
  console.error(`Failed to read or parse ${SECTIONS_FILE}: ${err.message}`);
  process.exit(1);
}

if (!Array.isArray(sections) || sections.length === 0) {
  console.log("\n╔═══ KB HEALTH (v2 tree metrics) ═══");
  console.log("\n⚠️  Section tree is empty.");
  console.log("    The tree file exists but contains no sections.\n");
  process.exit(0);
}

const N = sections.length;

// ── build indices ─────────────────────────────────────────────────────────────
const byId = new Map(sections.map(s => [s.id, s]));
const roots = sections.filter(s => s.parent === null);
const leaves = sections.filter(s => s.childIds.length === 0);

// orphan check: parent id that doesn't exist
const orphans = sections.filter(s => s.parent !== null && !byId.has(s.parent));

// depth distribution
const depthDist = new Map();
for (const s of sections) {
  depthDist.set(s.depth, (depthDist.get(s.depth) || 0) + 1);
}
const maxDepth = Math.max(...sections.map(s => s.depth));
const depthDistArr = [...depthDist.entries()].sort((a, b) => a[0] - b[0]);

// balance: over-full and under-full nodes
const overFull = sections.filter(s => {
  // over-full if EITHER childIds OR memberCount exceeds splitAt
  return s.childIds.length > HIERARCHY.splitAt || s.memberCount > HIERARCHY.splitAt;
});

const underFull = sections.filter(s => {
  // under-full if a NON-ROOT, NON-LEAF section has memberCount below mergeBelow
  // (leaves can be small; roots can be anything; interior nodes should be above threshold)
  if (s.parent === null) return false; // root can be any size
  if (s.childIds.length === 0) return false; // leaves can be small
  return s.memberCount < HIERARCHY.mergeBelow;
});

// ── cohesion (child-centroid-to-parent-centroid cosine) ───────────────────────
const cos = (a, b) => {
  if (!a || !b || a.length !== b.length) return null;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
};

const cohesionScores = [];
for (const s of sections) {
  if (s.parent === null || !s.centroid) continue; // root or missing centroid
  const parent = byId.get(s.parent);
  if (!parent || !parent.centroid) continue;
  const score = cos(s.centroid, parent.centroid);
  if (score !== null) {
    cohesionScores.push({ id: s.id, title: s.title, score, parent: parent.id });
  }
}

const lowCohesion = cohesionScores.filter(c => c.score < HIERARCHY.minCohesion);
const avgCohesion = cohesionScores.length > 0
  ? cohesionScores.reduce((sum, c) => sum + c.score, 0) / cohesionScores.length
  : null;

// ── summary health ────────────────────────────────────────────────────────────
const emptySummary = sections.filter(s => !s.summary || s.summary.trim() === "");
const dirtySummary = sections.filter(s => s.dirty === true);

// ── composite health score (heuristic) ────────────────────────────────────────
const clamp = (x) => Math.max(0, Math.min(1, x));

const sub = {
  // balance: no over-full, few under-full, depth within limit
  balance: clamp(1 - (overFull.length + underFull.length * 0.5) / N) *
           (maxDepth <= HIERARCHY.maxDepth ? 1 : 0.5),
  // cohesion: average child→parent similarity
  cohesion: avgCohesion !== null ? clamp((avgCohesion - 0.7) / 0.25) : 0.5,
  // summary: few empty/dirty
  summaries: clamp(1 - (emptySummary.length + dirtySummary.length) / N),
  // structure: one or more roots, no orphans
  structure: (roots.length > 0 ? 0.5 : 0) + (orphans.length === 0 ? 0.5 : 0),
};

const W = { balance: 0.3, cohesion: 0.3, summaries: 0.2, structure: 0.2 };
const score = Math.round(100 * Object.entries(W).reduce((s, [k, w]) => s + w * sub[k], 0));
const grade = score >= 85 ? "A" : score >= 75 ? "B" : score >= 65 ? "C" : score >= 50 ? "D" : "F";

// ════════════════════════ REPORT ════════════════════════
const pct = (x) => (100 * x).toFixed(0) + "%";
const lines = [];
const log = (s) => { lines.push(s); console.log(s); };

log(`\n╔═══ KB HEALTH (v2 tree metrics) ═══  score ${score}/100  (grade ${grade})`);
log(`${N} sections · ${roots.length} root(s) · ${leaves.length} leaves · max depth ${maxDepth}\n`);

log(`BALANCE / FANOUT`);
log(`  depth distribution`);
for (const [depth, count] of depthDistArr) {
  const bar = "█".repeat(Math.round(30 * count / N));
  log(`    depth ${depth}  ${count.toString().padStart(3)} sections  ${bar}`);
}
log(`  max depth         ${maxDepth} / ${HIERARCHY.maxDepth} limit  ${maxDepth <= HIERARCHY.maxDepth ? "✓" : "⚠️ exceeds"}`);
log(`  over-full nodes   ${overFull.length} sections (childIds or memberCount > ${HIERARCHY.splitAt})`);
log(`  under-full nodes  ${underFull.length} interior sections (memberCount < ${HIERARCHY.mergeBelow})`);

log(`\nCOHESION (child centroid → parent centroid cosine)`);
if (avgCohesion !== null) {
  log(`  average           ${avgCohesion.toFixed(3)}  (proxy for section tightness)`);
  log(`  below threshold   ${lowCohesion.length} sections < ${HIERARCHY.minCohesion}`);
} else {
  log(`  (no cohesion data — roots or missing centroids)`);
}

log(`\nSUMMARY HEALTH`);
log(`  empty summaries   ${emptySummary.length} sections`);
log(`  dirty (stale)     ${dirtySummary.length} sections  (need regeneration)`);

log(`\nSTRUCTURE`);
log(`  roots             ${roots.length} section(s)`);
log(`  leaves            ${leaves.length} section(s)`);
log(`  orphans           ${orphans.length} sections  (parent id doesn't exist)`);

log(`\nSUB-SCORES`);
log(`  ` + Object.entries(sub).map(([k, v]) => `${k} ${pct(v)}`).join(" · "));

if (overFull.length > 0) {
  log(`\n  over-full sections (need split):`);
  overFull.slice(0, 5).forEach(s => log(`    ${s.id}  "${s.title}"  (children: ${s.childIds.length}, members: ${s.memberCount})`));
  if (overFull.length > 5) log(`    ... and ${overFull.length - 5} more`);
}

if (lowCohesion.length > 0) {
  log(`\n  low cohesion (below ${HIERARCHY.minCohesion}):`);
  lowCohesion.slice(0, 5).forEach(c => log(`    ${c.score.toFixed(3)}  ${c.id}  "${c.title}"  (parent: ${c.parent})`));
  if (lowCohesion.length > 5) log(`    ... and ${lowCohesion.length - 5} more`);
}

if (orphans.length > 0) {
  log(`\n  orphan sections (broken parent ref):`);
  orphans.forEach(s => log(`    ${s.id}  "${s.title}"  (missing parent: ${s.parent})`));
}

// ── machine + Obsidian artifacts ──────────────────────────────────────────────
mkdirSync(join(OUT, "tree"), { recursive: true });
writeFileSync(join(OUT, "tree", "kb-health.json"), JSON.stringify({
  generated: new Date().toISOString(),
  version: "v2-tree",
  score,
  grade,
  subScores: sub,
  structure: {
    totalSections: N,
    roots: roots.length,
    leaves: leaves.length,
    maxDepth,
    depthDistribution: Object.fromEntries(depthDistArr),
    orphans: orphans.length,
  },
  balance: {
    overFull: overFull.length,
    underFull: underFull.length,
    overFullDetails: overFull.map(s => ({ id: s.id, title: s.title, childCount: s.childIds.length, memberCount: s.memberCount })),
    underFullDetails: underFull.map(s => ({ id: s.id, title: s.title, memberCount: s.memberCount })),
  },
  cohesion: {
    average: avgCohesion,
    belowThreshold: lowCohesion.length,
    lowCohesionDetails: lowCohesion.map(c => ({ id: c.id, title: c.title, score: c.score, parent: c.parent })),
  },
  summaries: {
    empty: emptySummary.length,
    dirty: dirtySummary.length,
    emptyDetails: emptySummary.map(s => ({ id: s.id, title: s.title })),
    dirtyDetails: dirtySummary.map(s => ({ id: s.id, title: s.title })),
  },
}, null, 2));

const md = [
  "---", "type: map", "generated_by: kb-health-v2", "---",
  `# KB Health (v2 tree) — ${score}/100 (${grade})`, "",
  `${N} sections · ${roots.length} root(s) · ${leaves.length} leaves · max depth ${maxDepth} · generated ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
  `Tree metrics (v2): \`maps/tree/kb-health.json\``, "",
  "## Scorecard", "| dimension | value |", "|---|---|",
  `| balance (depth, fanout) | ${pct(sub.balance)} |`,
  `| cohesion (child→parent) | ${avgCohesion !== null ? avgCohesion.toFixed(3) : "n/a"} |`,
  `| summaries (complete, fresh) | ${pct(sub.summaries)} |`,
  `| structure (roots, no orphans) | ${pct(sub.structure)} |`,
  "", "## Depth distribution",
  ...depthDistArr.map(([d, c]) => `- depth ${d}: ${c} sections`),
  "", "## Issues",
  `- **Over-full** (need split): ${overFull.length} sections`,
  `- **Under-full** (need merge): ${underFull.length} sections`,
  `- **Low cohesion** (< ${HIERARCHY.minCohesion}): ${lowCohesion.length} sections`,
  `- **Empty summaries**: ${emptySummary.length} sections`,
  `- **Stale summaries** (dirty): ${dirtySummary.length} sections`,
  `- **Orphans** (broken parent): ${orphans.length} sections`,
  "",
  overFull.length > 0 ? "### Over-full sections" : null,
  ...overFull.slice(0, 10).map(s => `- \`${s.id}\` "${s.title}" (children: ${s.childIds.length}, members: ${s.memberCount})`),
  lowCohesion.length > 0 ? "\n### Low cohesion sections" : null,
  ...lowCohesion.slice(0, 10).map(c => `- \`${c.id}\` "${c.title}" (score: ${c.score.toFixed(3)}, parent: ${c.parent})`),
  "",
].filter(l => l !== null).join("\n");

writeFileSync(join(OUT, "KB-HEALTH.md"), md);

log(`\nWrote maps/KB-HEALTH.md + maps/tree/kb-health.json\n`);
