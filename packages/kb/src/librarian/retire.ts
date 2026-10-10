/**
 * retire — remove entries from the KB on purpose.
 *
 * The KB is mirrored to wolves as receive-only folders, so deleting an entry
 * file on a wolf's machine never reaches the librarian. Retirement happens
 * here, on the librarian: delete the entry file, record `entry_retired` in the
 * ledger (so the registry stops listing it), and re-render the domain's
 * registry, INDEX, and digest. Section member counts are left for `reorg`.
 */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type KbRoots, entriesDir, ev } from "../shared/index.js";
import { EntryId } from "../schema/knowledge.js";
import { readLedger, appendLedger, foldRegistry } from "./ledger.js";
import { renderRegistry } from "./registry.js";
import { renderDomainIndex, renderDomainDigest } from "./domains.js";

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
  opts: { reason?: string; dryRun?: boolean } = {}
): RetireResult {
  const bad = entryIds.filter((id) => !EntryId.safeParse(id).success);
  if (bad.length) throw new Error(`not entry ids (want kb-<domain>-<7id>): ${bad.join(", ")}`);

  const reg = foldRegistry(readLedger(roots));
  const inRegistry = new Set([...reg.values()].flatMap((t) => t.entries));

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

  // Ledger first: if a file delete then fails, a re-run still sees the entry
  // on disk and retires it again (the fold tolerates duplicate retirements).
  appendLedger(roots, result.retired.map((r) => ev.entryRetired(r.entryId, opts.reason)));
  for (const r of result.retired) {
    if (r.hadFile) rmSync(join(entriesDir(roots, r.domain), `${r.entryId}.md`));
  }

  renderRegistry(roots, foldRegistry(readLedger(roots)), result.domains);
  for (const d of result.domains) {
    renderDomainIndex(roots, d);
    renderDomainDigest(roots, d);
  }
  return result;
}
