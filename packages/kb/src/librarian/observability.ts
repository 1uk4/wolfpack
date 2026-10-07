/**
 * observability.ts — Dump section tree and routing decisions to /tmp for inspection.
 * 
 * Phase 2 requirement: provide a way to inspect the tree structure and routing
 * behavior without touching production data.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Section } from "../schema/knowledge.js";
import type { TreeRouteDecision } from "./route.js";

const KB_TMP_DIR = "/tmp/wolfpack-kb";

/** Generate a run ID for observability outputs. */
export function mkRunId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}

/** Ensure the tmp directory exists. */
function ensureTmpDir(runId: string): string {
  const dir = join(KB_TMP_DIR, runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ════════════════════════════════════════════════════════════════════════════
// Section tree dumps
// ════════════════════════════════════════════════════════════════════════════

export interface TreeDumpOptions {
  runId: string;
  label?: string;
}

/**
 * Dump the section tree to /tmp/wolfpack-kb/<runId>/sections-<label>.json
 */
export function dumpSectionTree(
  sections: Section[],
  opts: TreeDumpOptions
): void {
  const dir = ensureTmpDir(opts.runId);
  const label = opts.label ?? "tree";
  const filename = `sections-${label}.json`;
  const path = join(dir, filename);

  writeFileSync(path, JSON.stringify(sections, null, 2));
  console.log(`[observability] Section tree dumped to ${path}`);
}

/**
 * Dump a human-readable tree visualization.
 */
export function dumpTreeVisualization(
  sections: Section[],
  opts: TreeDumpOptions
): void {
  const dir = ensureTmpDir(opts.runId);
  const label = opts.label ?? "tree";
  const filename = `sections-${label}.txt`;
  const path = join(dir, filename);

  const lines: string[] = ["Section Tree Visualization", "=".repeat(80), ""];

  // Group by domain
  const byDomain = new Map<string, Section[]>();
  for (const s of sections) {
    if (!byDomain.has(s.domain)) byDomain.set(s.domain, []);
    byDomain.get(s.domain)!.push(s);
  }

  for (const [domain, domainSections] of byDomain) {
    lines.push(`Domain: ${domain}`, "");

    // Render tree starting from roots
    const roots = domainSections.filter((s) => s.parent === null);
    for (const root of roots) {
      renderNode(root, domainSections, lines, 0);
    }
    lines.push("");
  }

  writeFileSync(path, lines.join("\n"));
  console.log(`[observability] Tree visualization dumped to ${path}`);
}

function renderNode(
  node: Section,
  allSections: Section[],
  lines: string[],
  depth: number
): void {
  const indent = "  ".repeat(depth);
  const marker = depth === 0 ? "●" : "○";
  
  lines.push(
    `${indent}${marker} ${node.id} — ${node.title}`,
    `${indent}  members: ${node.memberCount}, depth: ${node.depth}, ` +
    `dirty: ${node.dirty}, children: ${node.childIds.length}`
  );

  // Render children
  const children = allSections.filter((s) => s.parent === node.id);
  for (const child of children) {
    renderNode(child, allSections, lines, depth + 1);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Routing decision logs
// ════════════════════════════════════════════════════════════════════════════

export interface RoutingLog {
  timestamp: string;
  contributionId: string;
  domain: string;
  decision: TreeRouteDecision;
  vector?: number[]; // first 10 dims for inspection
}

/**
 * Append a routing decision to the log.
 */
export function logRoutingDecision(
  runId: string,
  log: RoutingLog
): void {
  const dir = ensureTmpDir(runId);
  const path = join(dir, "routing-log.jsonl");

  const line = JSON.stringify(log) + "\n";
  
  try {
    const fs = require("node:fs");
    fs.appendFileSync(path, line);
  } catch (err) {
    console.error(`[observability] Failed to log routing decision: ${err}`);
  }
}

/**
 * Dump routing stats summary.
 */
export function dumpRoutingStats(
  runId: string,
  decisions: TreeRouteDecision[]
): void {
  const dir = ensureTmpDir(runId);
  const path = join(dir, "routing-stats.json");

  const stats = {
    total: decisions.length,
    routed: decisions.filter((d) => d.basis === "routed").length,
    unplaced: decisions.filter((d) => d.basis === "unplaced").length,
    avgFit: decisions.reduce((sum, d) => sum + d.fit, 0) / decisions.length,
    sectionDistribution: {} as Record<string, number>,
  };

  for (const d of decisions) {
    if (d.section !== "_unplaced") {
      const sec = String(d.section);
      stats.sectionDistribution[sec] = (stats.sectionDistribution[sec] ?? 0) + 1;
    }
  }

  writeFileSync(path, JSON.stringify(stats, null, 2));
  console.log(`[observability] Routing stats dumped to ${path}`);
}

// ════════════════════════════════════════════════════════════════════════════
// Health metrics
// ════════════════════════════════════════════════════════════════════════════

export interface TreeHealth {
  totalSections: number;
  byDomain: Record<string, number>;
  byDepth: Record<number, number>;
  avgMemberCount: number;
  dirtySections: number;
  leafSections: number;
  avgChildrenPerParent: number;
}

/**
 * Compute and dump tree health metrics.
 */
export function dumpTreeHealth(
  sections: Section[],
  opts: TreeDumpOptions
): void {
  const dir = ensureTmpDir(opts.runId);
  const path = join(dir, "tree-health.json");

  const health: TreeHealth = {
    totalSections: sections.length,
    byDomain: {},
    byDepth: {},
    avgMemberCount: 0,
    dirtySections: 0,
    leafSections: 0,
    avgChildrenPerParent: 0,
  };

  let totalMembers = 0;
  let totalChildren = 0;
  let parentsCount = 0;

  for (const s of sections) {
    // By domain
    health.byDomain[s.domain] = (health.byDomain[s.domain] ?? 0) + 1;

    // By depth
    health.byDepth[s.depth] = (health.byDepth[s.depth] ?? 0) + 1;

    // Members
    totalMembers += s.memberCount;

    // Dirty
    if (s.dirty) health.dirtySections++;

    // Leaves
    if (s.childIds.length === 0) health.leafSections++;

    // Children
    if (s.childIds.length > 0) {
      totalChildren += s.childIds.length;
      parentsCount++;
    }
  }

  health.avgMemberCount = sections.length > 0 ? totalMembers / sections.length : 0;
  health.avgChildrenPerParent = parentsCount > 0 ? totalChildren / parentsCount : 0;

  writeFileSync(path, JSON.stringify(health, null, 2));
  console.log(`[observability] Tree health dumped to ${path}`);
}
