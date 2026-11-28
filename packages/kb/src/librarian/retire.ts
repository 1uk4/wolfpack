/**
 * retire — remove entries from the KB on purpose.
 *
 * The KB is mirrored to wolves as receive-only folders, so deleting an entry
 * file on a wolf's machine never reaches the librarian. Retirement happens
 * here, on the librarian: move the entry file into versions/ (kept, not
 * deleted), record `entry_retired` in the
 * ledger (so the registry stops listing it), and re-render the domain's
 * registry, INDEX, and digest. Section member counts are left for `reorg`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type KbRoots, entriesDir, ev } from "../shared/index.js";
import { EntryId } from "../schema/knowledge.js";
import { readLedger, appendLedger, foldRegistry } from "./ledger.js";
import { anchorOf } from "./anchors.js";
import { renderRegistry } from "./registry.js";
import { archiveRetiredEntry } from "./versions.js";
import { renderDomainIndex, renderDomainDigest } from "./domains.js";
import { readSections, writeSections } from "./sections.js";
import { listEntryFiles, readEntryCached } from "./entry-cache.js";

/** The section an entry file sits in ("" when none). */
function sectionOfFile(file: string): string {
  try { return String(readEntryCached(file)?.fields.section ?? ""); } catch { return ""; }
}

/**
 * Drop sections the retire just emptied: a section that held a retired entry, has no live entry left and no child section
 * (its parent is then checked the same way). Sections that were never populated are left alone. Returns the ids removed.
 */
function pruneEmptySections(roots: KbRoots, domain: string, candidates: Set<string>): string[] {
  if (!candidates.size) return [];
  const dir = entriesDir(roots, domain);
  const used = new Set<string>();
  if (existsSync(dir)) for (const f of listEntryFiles(dir)) used.add(sectionOfFile(join(dir, f)));
  const sections = readSections(roots);
  const removed: string[] = [];
  const queue = [...candidates];
  while (queue.length) {
    const id = queue.pop()!;
    const sec = sections.find((s) => String(s.id) === id && String(s.domain) === domain);
    if (!sec || used.has(id) || removed.includes(id)) continue;
    if (sections.some((s) => String(s.parent) === id && !removed.includes(String(s.id)))) continue;
    removed.push(id);
    if (sec.parent) queue.push(String(sec.parent));
  }
  if (!removed.length) return [];
  writeSections(roots, sections.filter((s) => !removed.includes(String(s.id))).map((s) => ({ ...s, childIds: s.childIds.filter((c) => !removed.includes(String(c))) })));
  appendLedger(roots, removed.map((id) => ev.sectionRemoved(id, domain)));
  return removed;
}

export interface RetireResult {
  /** Entries retired (file removed and/or registry reference dropped). */
  retired: Array<{ entryId: string; domain: string; hadFile: boolean }>;
  /** Ids that are neither on disk nor in the registry (already gone). */
  notFound: string[];
  /** Domains whose projections were re-rendered. */
  domains: string[];
}

/** Domain of a well-formed entry id (`kb-<domain>-<7id>`). */
function domainOf(entryId: string): string {
  return entryId.split("-")[1];
}

export function retireEntries(
  roots: KbRoots,
  entryIds: string[],
  opts: { reason?: string; /** Entries that replaced these; default: the one a "merged into"/"moved to" reason names, else none. */ survivors?: string[]; dryRun?: boolean; force?: boolean } = {}
): RetireResult {
  const bad = entryIds.filter((id) => !EntryId.safeParse(id).success);
  if (bad.length) throw new Error(`not entry ids (want kb-<domain>-<7id>): ${bad.join(", ")}`);

  const reg = foldRegistry(readLedger(roots));
  const inRegistry = new Set([...reg.values()].flatMap((t) => t.entries));

  // An anchored entry (an initiative's, a standing feature's) is a subject's identity,
  // not a candidate for cleanup: retiring it needs an explicit force.
  if (!opts.force) {
    const anchored: string[] = [];
    for (const entryId of new Set(entryIds)) {
      const file = join(entriesDir(roots, domainOf(entryId)), `${entryId}.md`);
      if (!existsSync(file)) continue;
      const key = anchorOf(readFileSync(file, "utf-8"));
      if (key) anchored.push(`${entryId} (anchor ${key})`);
    }
    if (anchored.length) {
      throw new Error(`refusing to retire anchored entr${anchored.length === 1 ? "y" : "ies"}: ${anchored.join(", ")}. Anchored entries are pinned records; pass --force to retire them anyway.`);
    }
  }

  const result: RetireResult = { retired: [], notFound: [], domains: [] };
  for (const entryId of new Set(entryIds)) {
    const domain = domainOf(entryId);
    const file = join(entriesDir(roots, domain), `${entryId}.md`);
    const hadFile = existsSync(file);
    if (!hadFile && !inRegistry.has(entryId)) {
      result.notFound.push(entryId);
      continue;
    }
    result.retired.push({ entryId, domain, hadFile });
  }
  result.domains = [...new Set(result.retired.map((r) => r.domain))].sort();
  if (opts.dryRun || result.retired.length === 0) return result;

  // Ledger first: if the file move then fails, a re-run still sees the entry
  // on disk and retires it again (the fold tolerates duplicate retirements).
  // Always recorded: [] says "retired with no replacement", not "unknown".
  const named = /\b(?:merged into|moved to)\s+(kb-[A-Za-z0-9-]+)/i.exec(opts.reason ?? "")?.[1];
  const survivors = opts.survivors ?? (named ? [named] : []);
  appendLedger(roots, result.retired.map((r) => ev.entryRetired(r.entryId, opts.reason, survivors)));
  const emptied = new Map<string, Set<string>>();
  for (const r of result.retired) {
    if (!r.hadFile) continue;
    const sec = sectionOfFile(join(entriesDir(roots, r.domain), `${r.entryId}.md`));
    if (sec) emptied.set(r.domain, (emptied.get(r.domain) ?? new Set()).add(sec));
  }
  for (const r of result.retired) {
    if (r.hadFile) archiveRetiredEntry(roots, r.domain, r.entryId, join(entriesDir(roots, r.domain), `${r.entryId}.md`), opts.reason, survivors);
  }

  for (const [domain, secs] of emptied) pruneEmptySections(roots, domain, secs);
  renderRegistry(roots, foldRegistry(readLedger(roots)), result.domains);
  for (const d of result.domains) {
    renderDomainIndex(roots, d);
    renderDomainDigest(roots, d);
  }
  return result;
}
