/**
 * rebuild-commit — the one write of a rebuild, and its crash recovery.
 *
 * commitRebuild: validates that every entry file in the domain ends up in the
 * new tree (orphans are placed or the commit aborts, before anything is
 * written), keeps a backup of the old sections and a per-entry map of old
 * section values, writes every changed file to an fsynced temp, writes a
 * journal listing the renames (plus the ledger event), then renames: entries
 * first, sections last. A crash after the journal is finished by
 * recoverRebuild, which the sweep, the tick and the next rebuild all call
 * under the KB lock; it is idempotent.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, copyFileSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseFrontmatter } from "@wolfpack/engine";
import type { KbRoots, KbEvent } from "../shared/index.js";
import { ev } from "../shared/index.js";
import { readSections, sectionsFile } from "./sections.js";
import { appendLedger, readLedger } from "./ledger.js";
import { cosine } from "./tree-rules.js";
import type { RebuildPlan } from "./rebuild.js";

/** Pure: the entry file text with its `section:` line set. */
export function withSectionLine(raw: string, sectionId: string): string {
  if (/^section: .+$/m.test(raw)) return raw.replace(/^section: .+$/m, `section: ${sectionId}`);
  if (/^domain: .+$/m.test(raw)) return raw.replace(/^(domain: .+)$/m, `$1\nsection: ${sectionId}`);
  throw new Error(`entry has neither a 'section:' nor a 'domain:' line; cannot assign ${sectionId}`);
}

export const rebuildJournalFile = (r: KbRoots) => join(r.denLocal, ".rebuild-journal.json");
export const rebuildOldValuesFile = (r: KbRoots) => join(r.denLocal, ".rebuild-old-sections.json");
export const sectionsBackupFile = (r: KbRoots) => join(r.denLocal, "sections.json.pre-rebuild");
/** Temp files are hidden and do not end in .md, so no entry scan picks them up. Syncthing ignores `.rebuild-tmp-*`. */
export const TMP_PREFIX = ".rebuild-tmp-";
const tmpPath = (file: string) => join(dirname(file), `${TMP_PREFIX}${basename(file)}.tmp`);

interface Journal { version: 2; domain: string; at: string; renames: Array<{ tmp: string; final: string }>; ledger?: KbEvent }

export interface CommitHooks {
  /** Test seam: replaces renameSync (crash injection). */
  rename?: (from: string, to: string) => void;
  /** Vector for an entry that is not in the plan (to place it by similarity). */
  vectorOf?: (entryId: string) => number[] | undefined;
}

function writeSynced(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "w");
  try { writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
}

function finish(roots: KbRoots, j: Journal, rename: (a: string, b: string) => void): number {
  let n = 0;
  for (const r of j.renames) if (existsSync(r.tmp)) { rename(r.tmp, r.final); n++; }
  if (j.ledger) {
    const dup = readLedger(roots).some((e) => e.t === "sections_replaced" && e.at === j.ledger!.at && (e as { domain: string }).domain === j.domain);
    if (!dup) appendLedger(roots, [j.ledger]);
  }
  rmSync(rebuildJournalFile(roots), { force: true });
  return n;
}

/** Finish a commit that was interrupted after its journal was written. Idempotent. Returns the renames completed. */
export function recoverRebuild(roots: KbRoots, hooks: Pick<CommitHooks, "rename"> = {}): number {
  const jf = rebuildJournalFile(roots);
  if (!existsSync(jf)) return 0;
  let j: Journal;
  try { j = JSON.parse(readFileSync(jf, "utf-8")) as Journal; } catch { return 0; }
  return finish(roots, j, hooks.rename ?? renameSync);
}

const entryFiles = (eDir: string) =>
  existsSync(eDir) ? readdirSync(eDir).filter((f) => f.endsWith(".md") && !f.startsWith(".")).sort() : [];

/**
 * ONE commit for the domain. Caller holds the KB lock. Throws (having written
 * nothing) when an entry cannot be placed in the new tree.
 */
export function commitRebuild(roots: KbRoots, plan: RebuildPlan, hooks: CommitHooks = {}): { entriesWritten: number; orphansPlaced: string[] } {
  recoverRebuild(roots, hooks);
  const eDir = join(roots.kbBase, "domains", plan.domain, "entries");
  const newIds = new Set(plan.state.sections.map((s) => String(s.id)));
  if (newIds.size !== plan.state.sections.length) throw new Error("rebuild: duplicate section ids in the plan; aborting");

  // ── targets: planned entries, grouped entries (pinned to their holder), orphans ──
  const target = new Map<string, string>(plan.state.assignment);
  for (const [g, holder] of plan.grouped) {
    const sec = plan.state.assignment.get(holder);
    if (!sec) throw new Error(`rebuild: grouped entry ${g} has holder ${holder} which is not in the plan; aborting`);
    target.set(g, sec);
  }
  const leaves = plan.state.sections.filter((s) => !plan.state.sections.some((c) => String(c.parent) === String(s.id)));
  const pool = leaves.length ? leaves : plan.state.sections;
  const oldValues: Record<string, string> = {};
  const orphansPlaced: string[] = [];
  const raws = new Map<string, string>();
  for (const f of entryFiles(eDir)) {
    const id = f.slice(0, -3);
    const raw = readFileSync(join(eDir, f), "utf-8");
    raws.set(id, raw);
    oldValues[id] = String(parseFrontmatter(raw).fields.section ?? "");
    if (target.has(id)) continue;
    const vec = hooks.vectorOf?.(id);
    if (vec && pool.length) {
      const best = pool.reduce((b, l) => (cosine(vec, l.centroid) > cosine(vec, b.centroid) ? l : b));
      target.set(id, String(best.id));
      orphansPlaced.push(id);
    } else if (newIds.has(oldValues[id])) {
      target.set(id, oldValues[id]); // already points into the new tree
    } else {
      throw new Error(`rebuild: entry ${id} is not in the plan, has no vector, and its section "${oldValues[id]}" is not in the new tree; aborting (nothing was written)`);
    }
  }
  for (const [id, sec] of target) if (!newIds.has(sec)) throw new Error(`rebuild: ${id} would point at ${sec}, which is not in the new tree; aborting`);

  // ── backups, then temps (each registered before it is written) ──
  const sf = sectionsFile(roots);
  if (existsSync(sf)) copyFileSync(sf, sectionsBackupFile(roots));
  writeSynced(rebuildOldValuesFile(roots), JSON.stringify({ domain: plan.domain, at: new Date().toISOString(), entries: oldValues }, null, 1));

  const renames: Journal["renames"] = [];
  try {
    for (const [id, sec] of [...target].sort()) {
      const raw = raws.get(id);
      if (raw === undefined) continue; // planned but the file vanished
      const next = withSectionLine(raw, sec);
      if (next === raw) continue;
      const file = join(eDir, `${id}.md`);
      renames.push({ tmp: tmpPath(file), final: file });
      writeSynced(tmpPath(file), next);
    }
    const entriesWritten = renames.length;
    const others = readSections(roots).filter((s) => String(s.domain) !== plan.domain);
    renames.push({ tmp: tmpPath(sf), final: sf });
    writeSynced(tmpPath(sf), JSON.stringify([...others, ...plan.state.sections], null, 2));
    const journal: Journal = {
      version: 2, domain: plan.domain, at: new Date().toISOString(), renames,
      ledger: ev.sectionsReplaced(plan.domain, plan.state.sections as unknown as Array<Record<string, unknown>>),
    };
    writeSynced(rebuildJournalFile(roots), JSON.stringify(journal));
    finish(roots, journal, hooks.rename ?? renameSync);
    return { entriesWritten, orphansPlaced };
  } catch (err) {
    // Before the journal exists nothing is committed: drop the temps. After it, recovery finishes the job.
    if (!existsSync(rebuildJournalFile(roots))) for (const r of renames) rmSync(r.tmp, { force: true });
    throw err;
  }
}

/** Leftover rebuild temp files in a domain's entries dir (for tests and diagnostics). */
export function listRebuildTemps(roots: KbRoots, domain: string): string[] {
  const eDir = join(roots.kbBase, "domains", domain, "entries");
  return existsSync(eDir) ? readdirSync(eDir).filter((f) => f.startsWith(TMP_PREFIX)) : [];
}
