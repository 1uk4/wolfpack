/**
 * rebuild-plan-file — a rebuild as a file: preview writes the exact plan, apply commits exactly that plan.
 *
 *   previewToFile  plans in memory (model calls happen here, outside any lock) and writes
 *                  `<outDir>/<domain>-<stamp>.json` (+ the rendered proposal as `.md`): the tree, every entry's section,
 *                  the moves, the flags used, and a fingerprint of the entry set it was made from.
 *   applyPlanFile  NO model calls. The CALLER holds the KB lock (the hub: its writer queue; nothing here locks). Checks the
 *                  plan version, the expected flags and the entry-set fingerprint (refusing, having written nothing, on any
 *                  difference), backs the domain up, runs the existing commitRebuild with the plan as it was, and returns the
 *                  backup stamp that `restoreRebuild` takes. Re-rendering the registry/digest/INDEX is the caller's job.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { KbRoots } from "../shared/index.js";
import type { Section } from "../schema/knowledge.js";
import {
  planRebuild, renderProposal, loadGrouped, listEntryIds, currentTreeStart, commitRebuild, listRebuildBackups,
  type Namer, type RebuildEntry, type RebuildMove, type RebuildPlan, type CommitHooks,
} from "./rebuild.js";
import { unit, meanVec } from "./tree-rules.js";
import { sectionsFile, readSections } from "./sections.js";
import { entryHashOf } from "./entry-hash.js";
import type { EntryVector } from "./embed.js";
import { PROMPT_VERSION, type Partitioner, type SplitCache } from "./llm-split.js";
import { backupStamp } from "./rebuild-commit.js";

export const PLAN_FILE_VERSION = 1;

/** The plan cannot be applied as it stands (the entries or the flags no longer match it); nothing was written. */
export class PlanRefusedError extends Error {}

export interface PlanFlags {
  from: "current" | "scratch";
  applyCrossMoves: boolean;
  approvedCrossMoves: string[];
  allowCollapse: boolean;
  allowKmeansFallback: boolean;
}

type TreeNode = Omit<Section, "centroid">;

export interface PlanFile {
  version: number;
  domain: string;
  createdAt: string;
  promptVersion: string;
  codeVersion: string;
  flags: PlanFlags;
  tree: TreeNode[];
  /** [entryId, sectionId] for every entry, grouped entries included (at their holder's section). */
  assignment: Array<[string, string]>;
  /** grouped entry → holder entry. */
  grouped: Array<[string, string]>;
  moves: RebuildMove[];
  crossMoves: RebuildMove[];
  oldSectionCount: number;
  fileIds: string[];
  entrySetHash: string;
  baseSectionsHash: string;
  /** Which engine the preview really used: the LLM partitioner or k-means, the LLM namer or auto-titles. */
  engine: { partitionerUsed: boolean; partitionerFallbacks: Array<{ id: string; reason: string }>; namerFallbacks: string[] };
}

const domainEntriesDir = (roots: KbRoots, domain: string) => join(roots.kbBase, "domains", domain, "entries");

/** sha256 over the sorted `id:contentHash` of the domain's entry files (content, not section lines: a rebuild's own writes do not change it). */
export function entrySetFingerprint(roots: KbRoots, domain: string): string {
  const dir = domainEntriesDir(roots, domain);
  const lines = listEntryIds(join(roots.kbBase, "domains"), domain).map((id) => `${id}:${entryHashOf(readFileSync(join(dir, `${id}.md`), "utf-8"))}`);
  return createHash("sha256").update(lines.sort().join("\n")).digest("hex");
}

/** The domain's own sections as stored now (centroids excluded). */
function baseSectionsHash(roots: KbRoots, domain: string): string {
  const mine = readSections(roots).filter((s) => String(s.domain) === domain).map(({ centroid: _c, ...rest }) => rest);
  return createHash("sha256").update(JSON.stringify(mine)).digest("hex");
}

export function serializePlan(plan: RebuildPlan, meta: { partitionerUsed?: boolean; flags: PlanFlags; roots: KbRoots; codeVersion: string; createdAt?: string }): PlanFile {
  return {
    version: PLAN_FILE_VERSION,
    domain: plan.domain,
    createdAt: meta.createdAt ?? new Date().toISOString(),
    promptVersion: PROMPT_VERSION,
    codeVersion: meta.codeVersion,
    flags: meta.flags,
    tree: plan.state.sections.map(({ centroid: _c, ...rest }) => rest as TreeNode),
    assignment: [...plan.state.assignment].sort(),
    grouped: [...plan.grouped].sort(),
    moves: plan.moves,
    crossMoves: plan.crossMoves,
    oldSectionCount: plan.oldSectionCount ?? 0,
    fileIds: plan.fileIds ?? [],
    entrySetHash: entrySetFingerprint(meta.roots, plan.domain),
    baseSectionsHash: baseSectionsHash(meta.roots, plan.domain),
    engine: {
      partitionerUsed: !!meta.partitionerUsed,
      partitionerFallbacks: plan.judged.filter((j) => j.fallbackReason).map((j) => ({ id: j.id, reason: String(j.fallbackReason) })),
      namerFallbacks: [...plan.unnamed],
    },
  };
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FlagsSchema = z.object({
  from: z.enum(["current", "scratch"]), applyCrossMoves: z.boolean(), approvedCrossMoves: z.array(z.string()), allowCollapse: z.boolean(), allowKmeansFallback: z.boolean(),
});
const MoveSchema = z.object({}).passthrough();
const PlanSchema = z.object({
  version: z.literal(PLAN_FILE_VERSION),
  domain: z.string().regex(ID),
  createdAt: z.string(),
  promptVersion: z.string(),
  codeVersion: z.string(),
  flags: FlagsSchema,
  tree: z.array(z.object({ id: z.string().min(1), parent: z.string().nullable().optional(), title: z.string() }).passthrough()).min(1),
  assignment: z.array(z.tuple([z.string(), z.string()])),
  grouped: z.array(z.tuple([z.string(), z.string()])),
  moves: z.array(MoveSchema),
  crossMoves: z.array(MoveSchema),
  oldSectionCount: z.number(),
  fileIds: z.array(z.string()),
  entrySetHash: z.string(),
  baseSectionsHash: z.string(),
  engine: z.object({ partitionerUsed: z.boolean(), partitionerFallbacks: z.array(z.object({ id: z.string(), reason: z.string() })), namerFallbacks: z.array(z.string()) }),
});

/** Read and validate a plan file: version, shape, a safe domain name, and every assigned section present in the tree. Throws before anything is touched. */
export function loadPlanFile(path: string): PlanFile {
  const raw = JSON.parse(readFileSync(path, "utf-8")) as { version?: unknown };
  if (raw.version !== PLAN_FILE_VERSION) throw new Error(`rebuild plan ${path}: unsupported version ${String(raw.version)} (this code reads ${PLAN_FILE_VERSION})`);
  const r = PlanSchema.safeParse(raw);
  if (!r.success) throw new PlanRefusedError(`invalid rebuild plan ${path}: ${r.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const p = r.data as unknown as PlanFile;
  const ids = new Set(p.tree.map((s) => String(s.id)));
  const unknown = p.assignment.find(([, sec]) => !ids.has(sec));
  if (unknown) throw new PlanRefusedError(`invalid rebuild plan ${path}: entry ${unknown[0]} is assigned to section ${unknown[1]}, which is not in the tree`);
  return p;
}

/** Rehydrate the maps and sets commitRebuild reads. Centroids are empty: derived data, recomputed by the next bootstrap/reorg. */
function toRebuildPlan(p: PlanFile): RebuildPlan {
  return {
    domain: p.domain, entries: [],
    state: { sections: p.tree.map((s) => ({ ...s, centroid: [] }) as Section), assignment: new Map(p.assignment) },
    moves: p.moves, crossMoves: p.crossMoves, unmatchedApprovals: [], blockedApprovals: [], rejected: [],
    leftovers: new Map(), splitChildren: new Map(), unnamed: [], grouped: new Map(p.grouped),
    reused: new Set(), labelKept: new Set(), capWrappers: new Set(), judged: [], initialTitles: new Map(),
    from: p.flags.from, oldSectionCount: p.oldSectionCount, fileIds: p.fileIds,
  };
}

/** Each section's centroid: the unit mean of the vectors of the entries in its subtree, by the PLAN's assignment (the files still carry the old sections). */
function setCentroids(plan: RebuildPlan, vectors: EntryVector[]): void {
  const vec = new Map(vectors.filter((v) => v.domain === plan.domain).map((v) => [v.entryId, v.vector]));
  const direct = new Map<string, number[][]>();
  for (const [e, sec] of plan.state.assignment) { const v = vec.get(e); if (v) direct.set(sec, [...(direct.get(sec) ?? []), v]); }
  const sub = (id: string): number[][] => [...(direct.get(id) ?? []), ...plan.state.sections.filter((c) => String(c.parent) === id).flatMap((c) => sub(String(c.id)))];
  for (const s of plan.state.sections) { const vs = sub(String(s.id)); if (vs.length) s.centroid = unit(meanVec(vs)); }
}

export interface PreviewOptions {
  roots: KbRoots;
  domain: string;
  /** The domain's entries with their vectors (the caller embeds; see loadRebuildEntries). */
  entries: RebuildEntry[];
  flags: PlanFlags;
  namer: Namer;
  partitioner?: Partitioner;
  splitCache?: SplitCache;
  outDir: string;
  codeVersion: string;
  notify?: (msg: string) => void;
}

export async function previewToFile(o: PreviewOptions): Promise<{ planId: string; file: string; mdFile: string; plan: PlanFile }> {
  const domainsRoot = join(o.roots.kbBase, "domains");
  const fileIds = listEntryIds(domainsRoot, o.domain);
  const oldSections = readSections(o.roots).filter((s) => String(s.domain) === o.domain);
  const start = o.flags.from === "current" ? currentTreeStart(oldSections, o.entries, o.domain) : undefined;
  const plan = await planRebuild({
    domain: o.domain, entries: o.entries, namer: o.namer, notify: o.notify, start,
    applyCrossMoves: o.flags.applyCrossMoves, approvedCrossMoves: o.flags.approvedCrossMoves,
    partitioner: o.partitioner, splitCache: o.splitCache, diagnostics: true,
    grouped: loadGrouped(domainsRoot, o.domain), oldSections,
  });
  plan.fileIds = fileIds;
  plan.oldSectionCount = oldSections.length;
  const fell = plan.judged.filter((j) => j.fallbackReason);
  if (fell.length && !o.flags.allowKmeansFallback) {
    throw new Error(`rebuild preview: ${fell.length} section(s) fell back to k-means because the LLM split proposal failed (${fell.map((j) => `${j.id}: ${j.fallbackReason}`).join("; ")}); no plan written. Re-run, or allow the k-means fallback`);
  }
  if (plan.unnamed.length && !o.flags.allowKmeansFallback) {
    throw new Error(`rebuild preview: ${plan.unnamed.length} section(s) were auto-titled because the namer call failed (${plan.unnamed.join(", ")}); no plan written. Re-run, or allow the fallback`);
  }
  const file0 = serializePlan(plan, { partitionerUsed: !!o.partitioner, flags: o.flags, roots: o.roots, codeVersion: o.codeVersion });
  const planId = `${o.domain}-${backupStamp(new Date(file0.createdAt))}`;
  mkdirSync(o.outDir, { recursive: true });
  const file = join(o.outDir, `${planId}.json`), mdFile = join(o.outDir, `${planId}.md`);
  writeFileSync(file, JSON.stringify(file0, null, 1));
  const warn = [
    ...(file0.engine.namerFallbacks.length ? [`WARNING: ${file0.engine.namerFallbacks.length} section${file0.engine.namerFallbacks.length === 1 ? "" : "s"} auto-titled, the model was unreachable (${file0.engine.namerFallbacks.join(", ")})`] : []),
    ...(file0.engine.partitionerFallbacks.length ? [`WARNING: ${file0.engine.partitionerFallbacks.length} section${file0.engine.partitionerFallbacks.length === 1 ? "" : "s"} split by k-means fallback, the LLM proposal failed (${file0.engine.partitionerFallbacks.map((f) => f.id).join(", ")})`] : []),
    `Engine: partitioner ${file0.engine.partitionerUsed ? "LLM" : "k-means only"}; namer ${file0.engine.namerFallbacks.length ? "LLM with auto-title fallbacks" : "LLM"}`,
  ];
  writeFileSync(mdFile, `${warn.join("\n")}\n\n${renderProposal(plan)}`);
  return { planId, file, mdFile, plan: file0 };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export interface ApplyOptions extends Pick<CommitHooks, "vectorOf" | "notify" | "writeFile" | "rename"> {
  /** If given, must equal the plan's own flags. */
  expectFlags?: PlanFlags;
  /** Entry vectors (from the embedding cache) to compute the new sections' centroids from; without them the sections carry none until the next bootstrap. */
  vectors?: EntryVector[];
  /** Where the pre-apply copy of the domain goes: `<backupDir>/<stamp>/`. */
  backupDir: string;
}

export function applyPlanFile(roots: KbRoots, planPath: string, o: ApplyOptions): { stamp: string; entriesWritten: number; orphansPlaced: string[]; backupDir: string } {
  const p = loadPlanFile(planPath);
  if (o.expectFlags && !same(o.expectFlags, p.flags)) {
    throw new PlanRefusedError(`rebuild apply: the flags differ from the plan's (plan: ${JSON.stringify(p.flags)}; expected: ${JSON.stringify(o.expectFlags)}); nothing was written`);
  }
  if (entrySetFingerprint(roots, p.domain) !== p.entrySetHash) {
    throw new PlanRefusedError("rebuild apply: the entry set changed since the plan was made (an entry was added, removed or edited); nothing was written. Preview again");
  }
  if (baseSectionsHash(roots, p.domain) !== p.baseSectionsHash) {
    throw new PlanRefusedError("rebuild apply: the domain's sections changed since the plan was made (a reorg or another rebuild); nothing was written. Preview again");
  }
  const before = new Set(listRebuildBackups(roots));
  const copy = join(o.backupDir, backupStamp());
  mkdirSync(copy, { recursive: true });
  cpSync(domainEntriesDir(roots, p.domain), join(copy, "entries"), { recursive: true });
  if (existsSync(sectionsFile(roots))) copyFileSync(sectionsFile(roots), join(copy, "_sections.json"));
  const plan = toRebuildPlan(p);
  if (o.vectors) setCentroids(plan, o.vectors);
  const r = commitRebuild(roots, plan, { allowCollapse: p.flags.allowCollapse, vectorOf: o.vectorOf, notify: o.notify, writeFile: o.writeFile, rename: o.rename });
  const stamp = listRebuildBackups(roots).find((s) => !before.has(s));
  if (!stamp) throw new Error("rebuild apply: committed, but no restore point was recorded");
  return { stamp, ...r, backupDir: copy };
}
