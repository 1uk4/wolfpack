/**
 * rebuild-commit — the one write of a rebuild, and its crash recovery.
 *
 * commitRebuild (caller holds the KB lock) validates first and writes nothing
 * if anything is wrong: the entry-file set must be what the plan saw, the
 * sections snapshot must be readable (or the other domains foldable from the
 * ledger), no entry may end up pointing outside the new tree (orphans are
 * placed by vector or the commit aborts), and the new tree must not have
 * collapsed (fewer than half the old sections) unless allowed. Then it takes
 * timestamped backups, writes the new sections.json to an fsynced temp, writes
 * a journal {entries: [{path, section}], renames: [sections temp → final],
 * ledger event}, and applies it: entries first (each re-reads the CURRENT file
 * text and sets only its `section:` line, so recovery never overwrites later
 * edits), sections.json last. recoverRebuild finishes an interrupted commit; it
 * is idempotent, and the sweep, the tick and the next rebuild all call it.
 *
 * Restore: see restoreRebuild / `wolfpack-kb rebuild --restore <timestamp> --yes`.
 */
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseFrontmatter } from "@wolfpack/engine";
import type { KbRoots, KbEvent } from "../shared/index.js";
import { ev } from "../shared/index.js";
import type { Section } from "../schema/knowledge.js";
import { sectionsFile, foldSections } from "./sections.js";
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
export const rebuildBadJournalFile = (r: KbRoots) => join(r.denLocal, ".rebuild-journal.bad");
/** Timestamp for backup names: 2026-10-29T10-02-23Z (no colons). */
export const backupStamp = (d = new Date()) => d.toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
export const sectionsBackupFile = (r: KbRoots, stamp: string) => join(r.denLocal, `sections.json.pre-rebuild-${stamp}`);
export const rebuildOldValuesFile = (r: KbRoots, stamp: string) => join(r.denLocal, `.rebuild-old-sections-${stamp}.json`);
/** Temp files are hidden and do not end in .md, so no entry scan picks them up. Syncthing ignores `.rebuild-tmp-*`. */
export const TMP_PREFIX = ".rebuild-tmp-";
const tmpPath = (file: string) => join(dirname(file), `${TMP_PREFIX}${basename(file)}.tmp`);

/** The new tree may not have fewer than this fraction of the old section count (unless allowCollapse). */
export const COLLAPSE_RATIO = 0.5;
/** Only judge collapse for trees of at least this many old sections. */
export const COLLAPSE_MIN_OLD = 4;
export function collapseGuardFires(oldCount: number, newCount: number): boolean {
  return oldCount >= COLLAPSE_MIN_OLD && newCount < oldCount * COLLAPSE_RATIO;
}

interface Journal {
  version: 3; domain: string; at: string;
  entries: Array<{ path: string; section: string }>;
  renames: Array<{ tmp: string; final: string }>;
  ledger?: KbEvent;
}

export interface CommitHooks {
  /** Test seam: writes one entry file's new text (default: fsynced temp + rename). */
  writeFile?: (path: string, text: string) => void;
  /** Test seam: renames the sections temp into place. */
  rename?: (from: string, to: string) => void;
  /** Vector for an entry that is not in the plan (to place it by similarity). */
  vectorOf?: (entryId: string) => number[] | undefined;
  /** Proceed although the new tree has collapsed (see collapseGuardFires). */
  allowCollapse?: boolean;
  notify?: (msg: string) => void;
}

function writeSynced(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "w");
  try { writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
}
const defaultWrite = (path: string, text: string) => { writeSynced(tmpPath(path), text); renameSync(tmpPath(path), path); };

function finish(roots: KbRoots, j: Journal, hooks: CommitHooks): number {
  let n = 0;
  const write = hooks.writeFile ?? defaultWrite;
  for (const e of j.entries) {
    if (!existsSync(e.path)) continue;
    const raw = readFileSync(e.path, "utf-8");
    let next: string;
    try { next = withSectionLine(raw, e.section); } catch { continue; }
    if (next === raw) continue;
    write(e.path, next);
    n++;
  }
  const rename = hooks.rename ?? renameSync;
  for (const r of j.renames) if (existsSync(r.tmp)) { rename(r.tmp, r.final); n++; }
  if (j.ledger) {
    const dup = readLedger(roots).some((e) => e.t === "sections_replaced" && e.at === j.ledger!.at && (e as { domain: string }).domain === j.domain);
    if (!dup) appendLedger(roots, [j.ledger]);
  }
  rmSync(rebuildJournalFile(roots), { force: true });
  return n;
}

function removeStaleTemps(roots: KbRoots): void {
  const dRoot = join(roots.kbBase, "domains");
  const dirs = [dirname(sectionsFile(roots))];
  if (existsSync(dRoot)) for (const d of readdirSync(dRoot)) dirs.push(join(dRoot, d, "entries"));
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) if (f.startsWith(TMP_PREFIX)) rmSync(join(dir, f), { force: true });
  }
}

/**
 * Finish a commit that was interrupted after its journal was written. Idempotent.
 * Returns the writes completed. An unreadable journal is moved to .rebuild-journal.bad,
 * stale temps are deleted, and `notify` is told once.
 */
export function recoverRebuild(roots: KbRoots, hooks: CommitHooks = {}): number {
  const jf = rebuildJournalFile(roots);
  if (!existsSync(jf)) return 0;
  let j: Journal;
  try {
    j = JSON.parse(readFileSync(jf, "utf-8")) as Journal;
    if (j.version !== 3 || !Array.isArray(j.entries) || !Array.isArray(j.renames)) throw new Error("unsupported journal");
  } catch (err) {
    renameSync(jf, rebuildBadJournalFile(roots));
    removeStaleTemps(roots);
    hooks.notify?.(`rebuild journal unreadable (${err instanceof Error ? err.message : err}); moved to ${rebuildBadJournalFile(roots)} and stale temp files removed. Check the KB with \`status\`; restore with \`rebuild --restore\` if needed`);
    return 0;
  }
  return finish(roots, j, hooks);
}

/** The domain of a pending journal, if any (for re-rendering after recovery). */
export function pendingJournalDomain(roots: KbRoots): string | null {
  try { return (JSON.parse(readFileSync(rebuildJournalFile(roots), "utf-8")) as Journal).domain ?? null; } catch { return null; }
}

export const entryFiles = (eDir: string) =>
  existsSync(eDir) ? readdirSync(eDir).filter((f) => f.endsWith(".md") && !f.startsWith(".")).sort() : [];

/** The sections of the OTHER domains, never silently dropped: from the snapshot, else folded from the ledger, else abort. */
function otherDomainSections(roots: KbRoots, domain: string): Section[] {
  const sf = sectionsFile(roots);
  let all: Section[] | null = null;
  if (existsSync(sf)) {
    try { const j = JSON.parse(readFileSync(sf, "utf-8")); if (Array.isArray(j)) all = j as Section[]; } catch { /* fall through */ }
  }
  if (all) return all.filter((s) => String(s.domain) !== domain);
  const folded = foldSections(readLedger(roots)).filter((s) => String(s.domain) !== domain);
  const dRoot = join(roots.kbBase, "domains");
  const missing = existsSync(dRoot)
    ? readdirSync(dRoot).filter((d) => d !== domain && entryFiles(join(dRoot, d, "entries")).length > 0 && !folded.some((s) => String(s.domain) === d))
    : [];
  if (missing.length) {
    throw new Error(`rebuild: ${sf} is ${existsSync(sf) ? "unparsable" : "missing"} and the ledger has no sections for ${missing.join(", ")}; writing a new snapshot would drop those trees. Aborting (nothing was written)`);
  }
  return folded;
}

/**
 * ONE commit for the domain. Caller holds the KB lock. Throws, having written nothing, when a
 * check fails. `plan.fileIds` (the entry files the plan was made from) must match the directory now.
 */
export function commitRebuild(roots: KbRoots, plan: RebuildPlan, hooks: CommitHooks = {}): { entriesWritten: number; orphansPlaced: string[] } {
  recoverRebuild(roots, hooks);
  const eDir = join(roots.kbBase, "domains", plan.domain, "entries");
  const newIds = new Set(plan.state.sections.map((s) => String(s.id)));
  if (newIds.size !== plan.state.sections.length) throw new Error("rebuild: duplicate section ids in the plan; aborting");

  // ── the entry set must be what the plan saw (the plan was made outside the lock) ──
  const files = entryFiles(eDir);
  if (plan.fileIds) {
    const now = new Set(files.map((f) => f.slice(0, -3)));
    const was = new Set(plan.fileIds);
    const added = [...now].filter((i) => !was.has(i)), gone = [...was].filter((i) => !now.has(i));
    if (added.length || gone.length) {
      throw new Error(`rebuild: the entries changed while the plan was made (${added.length} added, ${gone.length} removed); aborting, nothing was written. Run the rebuild again`);
    }
  }

  // ── collapse guard ──
  if (!hooks.allowCollapse && plan.oldSectionCount !== undefined && collapseGuardFires(plan.oldSectionCount, plan.state.sections.length)) {
    throw new Error(`rebuild: the new tree has ${plan.state.sections.length} sections, fewer than half of the current ${plan.oldSectionCount}; aborting. Re-run with --allow-collapse if that is intended`);
  }

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
  for (const f of files) {
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

  // ── the other domains' trees must survive the snapshot rewrite ──
  const others = otherDomainSections(roots, plan.domain);

  // ── timestamped backups ──
  const stamp = backupStamp();
  const sf = sectionsFile(roots);
  if (existsSync(sf)) copyFileSync(sf, sectionsBackupFile(roots, stamp));
  writeSynced(rebuildOldValuesFile(roots, stamp), JSON.stringify({ domain: plan.domain, at: new Date().toISOString(), entries: oldValues }, null, 1));

  // ── sections temp (fsynced), then the journal, then apply ──
  const journalEntries: Journal["entries"] = [];
  for (const [id, sec] of [...target].sort()) {
    const raw = raws.get(id);
    if (raw === undefined) continue; // planned but the file vanished
    if (withSectionLine(raw, sec) === raw) continue;
    journalEntries.push({ path: join(eDir, `${id}.md`), section: sec });
  }
  const sectionsTmp = tmpPath(sf);
  try {
    writeSynced(sectionsTmp, JSON.stringify([...others, ...plan.state.sections], null, 2));
    // The ledger snapshot carries no centroids (they are derived; foldSections leaves them empty and a bootstrap recomputes them).
    const snapshot = plan.state.sections.map(({ centroid: _c, ...rest }) => rest) as unknown as Array<Record<string, unknown>>;
    const journal: Journal = {
      version: 3, domain: plan.domain, at: new Date().toISOString(),
      entries: journalEntries, renames: [{ tmp: sectionsTmp, final: sf }],
      ledger: ev.sectionsReplaced(plan.domain, snapshot),
    };
    writeSynced(rebuildJournalFile(roots), JSON.stringify(journal));
    finish(roots, journal, hooks);
    return { entriesWritten: journalEntries.length, orphansPlaced };
  } catch (err) {
    // Before the journal exists nothing is committed: drop the temp. After it, recovery finishes the job.
    if (!existsSync(rebuildJournalFile(roots))) rmSync(sectionsTmp, { force: true });
    throw err;
  }
}

/** Leftover rebuild temp files in a domain's entries dir (for tests and diagnostics). */
export function listRebuildTemps(roots: KbRoots, domain: string): string[] {
  const eDir = join(roots.kbBase, "domains", domain, "entries");
  return existsSync(eDir) ? readdirSync(eDir).filter((f) => f.startsWith(TMP_PREFIX)) : [];
}

/** Backups a rebuild left, newest last: the timestamps usable with restoreRebuild. */
export function listRebuildBackups(roots: KbRoots): string[] {
  if (!existsSync(roots.denLocal)) return [];
  return readdirSync(roots.denLocal)
    .map((f) => /^\.rebuild-old-sections-(.+)\.json$/.exec(f)?.[1])
    .filter((s): s is string => !!s)
    .sort();
}

/**
 * Restore the state before the rebuild stamped `stamp`: the sections snapshot is copied back and every
 * entry's `section:` line is set to its old value. Entries created since keep their line. Caller holds the KB lock.
 * (The ledger keeps the sections_replaced event; the snapshot file is what readers use.)
 */
export function restoreRebuild(roots: KbRoots, stamp: string): { entriesRestored: number } {
  const backup = sectionsBackupFile(roots, stamp), map = rebuildOldValuesFile(roots, stamp);
  if (!existsSync(map)) throw new Error(`restore: no old-sections map for ${stamp}; known: ${listRebuildBackups(roots).join(", ") || "none"}`);
  recoverRebuild(roots);
  const { domain, entries } = JSON.parse(readFileSync(map, "utf-8")) as { domain: string; entries: Record<string, string> };
  const eDir = join(roots.kbBase, "domains", domain, "entries");
  let n = 0;
  for (const [id, sec] of Object.entries(entries)) {
    const file = join(eDir, `${id}.md`);
    if (!existsSync(file) || !sec) continue;
    const raw = readFileSync(file, "utf-8");
    const next = withSectionLine(raw, sec);
    if (next !== raw) { defaultWrite(file, next); n++; }
  }
  if (existsSync(backup)) copyFileSync(backup, sectionsFile(roots));
  return { entriesRestored: n };
}
