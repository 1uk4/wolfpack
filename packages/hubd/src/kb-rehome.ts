/**
 * `hubd kb-rehome --data-dir <dir> --move <entryId>=<sectionId> ... [--remove-section <id> ...] [--apply]`
 *
 * Operator tool: re-home entries into other sections and delete (emptied) sections, through the SAME write path the hub curator
 * uses: the hub sweep writer (curator.ts createHubSweepWriter) on the KB writer (kb-commits.ts createKbWriter: writer lock, journal,
 * commitKb, revision log). It does not use the packages/kb reorg / rebuild / split tools (those write the KB directly).
 * Dry run by default: it prints the plan and writes nothing.
 *
 * Checks (any failure refuses the whole run, nothing is written): every moved entry has a file; every target section exists in
 * `_sections.json` and is in the entry's domain; every section to remove exists and, AFTER the moves, has no entry (entry
 * frontmatter `section:` is the truth) and no remaining child section, and is not a move target.
 *
 * Apply, in order (all in the writer queue):
 *   1. each entry file: `section:` line rewritten via commitKb (update, prevHash compare-and-set; logs entry_written as every commit does);
 *   2. ledger: one `entry_placed` per move (basis "curator-pinned": the placement enum has no "manual" and widening it would change the
 *      entry frontmatter schema; fit 1), then one `sections_replaced` per domain that loses a section;
 *   3. `_sections.json`: removed sections dropped, parents' childIds fixed, memberCount of touched sections recounted from the entries
 *      (centroids of the kept sections stay);
 *   4. INDEX.md + _digest.json of each touched domain and _registry.md, rendered as the curator does (commitKb).
 * Section removal and the ledger fold: foldSections has no "section removed" event, only `sections_replaced` ("drop every section of
 * the domain, take this snapshot"), so removal appends that event with the domain's REMAINING sections (no centroids, as rebuild
 * does; a bootstrap recomputes them), memberCount recounted from the entries. It also resets the additive memberCounts that
 * entry_placed leaves in the fold, so the fold agrees with _sections.json again for that domain.
 *
 * Safety: hubd must be STOPPED (a running hubd holds the KB writer lock, so apply fails with a lock error even when the curator is off).
 * Before taking anything it refuses while the curator sweep lease
 * (`<dataDir>/kb/ops/contributions/.sweep-lease`) is fresh; on apply it holds that lease itself (owner "hub") for the whole run.
 * The dry run takes no lock, but still refuses a held lease.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { acquireLease, appendLedger, foldRegistry, freshLeaseIn, readLedger, readSections, renderRegistry, scanEntryDomains, writeSections } from "@wolfpack/kb/librarian";
import { ev, type KbEvent } from "@wolfpack/kb/shared";
import { createHubSweepWriter } from "./curator.js";
import { createKbWriter } from "./kb-commits.js";
import { contributionsRoot, hubRoots } from "./layout.js";

export interface RehomeOptions {
  dataDir: string;
  moves: Array<{ entryId: string; sectionId: string }>;
  removeSections?: string[];
  apply?: boolean;
}
export interface RehomeReport {
  apply: boolean;
  moves: Array<{ entryId: string; domain: string; from: string; to: string; changed: boolean }>;
  removed: string[];
  domains: string[];
  errors: string[];
}

const sectionOf = (raw: string): string => /^section: (.+)$/m.exec(raw)?.[1]?.trim() ?? "";
const setSection = (raw: string, id: string): string => {
  if (/^section: .+$/m.test(raw)) return raw.replace(/^section: .+$/m, `section: ${id}`);
  if (/^domain: .+$/m.test(raw)) return raw.replace(/^(domain: .+)$/m, `$1\nsection: ${id}`);
  throw new Error("entry has neither a 'section:' nor a 'domain:' line");
};

export async function kbRehome(opts: RehomeOptions): Promise<RehomeReport> {
  const roots = hubRoots(opts.dataDir);
  const lane = contributionsRoot(opts.dataDir);
  const rep: RehomeReport = { apply: !!opts.apply, moves: [], removed: [], domains: [], errors: [] };
  const fail = (m: string) => rep.errors.push(m);

  const held = freshLeaseIn([lane]);
  if (held) throw new Error(`kb-rehome refuses: the curator sweep lease is held (${held.owner} pid ${held.pid} on ${held.host}); stop hubd (or turn the curator off) first`);

  const sections = readSections(roots);
  const byId = new Map(sections.map((s) => [String(s.id), s]));
  const domainOf = scanEntryDomains(roots.kbBase);
  const eFile = (domain: string, id: string) => join(roots.kbBase, "domains", domain, "entries", `${id}.md`);
  const target = new Map<string, string>(); // entryId -> section
  for (const m of opts.moves) {
    if (target.has(m.entryId) && target.get(m.entryId) !== m.sectionId) fail(`${m.entryId}: moved to two different sections`);
    target.set(m.entryId, m.sectionId);
    const domain = domainOf.get(m.entryId);
    if (!domain) { fail(`${m.entryId}: no such entry in the hub KB`); continue; }
    const sec = byId.get(m.sectionId);
    if (!sec) { fail(`${m.entryId}: target section ${m.sectionId} does not exist`); continue; }
    if (String(sec.domain) !== domain) fail(`${m.entryId}: target section ${m.sectionId} is in domain ${String(sec.domain)}, the entry is in ${domain}`);
  }
  // Section of every entry in the domains concerned, after the moves.
  const remove = [...new Set(opts.removeSections ?? [])];
  const touchedDomains = new Set<string>();
  for (const id of target.keys()) { const d = domainOf.get(id); if (d) touchedDomains.add(d); }
  for (const r of remove) {
    const s = byId.get(r);
    if (!s) { fail(`section ${r} to remove does not exist`); continue; }
    touchedDomains.add(String(s.domain));
  }
  const after = new Map<string, string>(); // entryId -> section after the moves
  for (const [id, domain] of domainOf) {
    if (!touchedDomains.has(domain)) continue;
    const f = eFile(domain, id);
    after.set(id, target.get(id) ?? sectionOf(readFileSync(f, "utf-8")));
  }
  const members = (sid: string): string[] => [...after].filter(([, s]) => s === sid).map(([id]) => id);
  for (const r of remove) {
    const s = byId.get(r);
    if (!s) continue;
    if ([...target.values()].includes(r)) fail(`section ${r}: cannot be removed, it is a move target`);
    const left = members(r);
    if (left.length) fail(`section ${r} is not empty after the moves (${left.length} entries, e.g. ${left.slice(0, 3).join(", ")})`);
    const kids = sections.filter((c) => String(c.parent) === r && !remove.includes(String(c.id)));
    if (kids.length) fail(`section ${r} still has child sections (${kids.map((k) => String(k.id)).join(", ")}); remove them too or move them first`);
  }
  for (const m of opts.moves) {
    const d = domainOf.get(m.entryId);
    if (!d) continue;
    const cur = after.has(m.entryId) ? sectionOf(readFileSync(eFile(d, m.entryId), "utf-8")) : "";
    rep.moves.push({ entryId: m.entryId, domain: d, from: cur, to: m.sectionId, changed: cur !== m.sectionId });
  }
  rep.removed = remove.filter((r) => byId.has(r));
  rep.domains = [...touchedDomains].sort();
  if (rep.errors.length) throw new Error(`kb-rehome refuses:\n  ${rep.errors.join("\n  ")}`);
  if (!opts.apply) return rep;

  const lease = acquireLease([lane], "hub");
  if (!lease) throw new Error("kb-rehome refuses: could not take the curator sweep lease (another sweeper holds it)");
  let kb: ReturnType<typeof createKbWriter> | undefined;
  try {
    kb = createKbWriter({ dataDir: opts.dataDir, roots, onChanged: () => undefined }); // throws when a running hubd holds the writer lock
    const w = createHubSweepWriter({ commit: (a, r) => kb!.commit(a, r), exclusive: (fn) => kb!.exclusive(fn) });
    for (const m of rep.moves) {
      if (!m.changed) continue;
      const f = eFile(m.domain, m.entryId);
      await w.patchEntry(roots, m.domain, m.entryId, setSection(readFileSync(f, "utf-8"), m.to));
    }
    const events: KbEvent[] = rep.moves.filter((m) => m.changed).map((m) => ev.entryPlaced({ entryId: m.entryId, sectionId: m.to, basis: "curator-pinned", fit: 1 }));
    // New section tree: drop removed, fix parents, recount touched.
    const gone = new Set(rep.removed);
    const touchedSections = new Set(rep.moves.flatMap((m) => [m.from, m.to]).filter(Boolean));
    const next = sections.filter((s) => !gone.has(String(s.id))).map((s) => {
      const kids = s.childIds.filter((c) => !gone.has(String(c)));
      const touched = touchedSections.has(String(s.id));
      return { ...s, childIds: kids, ...(touched ? { memberCount: members(String(s.id)).length, dirty: true } : {}) };
    });
    const removedDomains = new Set(rep.removed.map((r) => String(byId.get(r)!.domain)));
    for (const d of [...removedDomains].sort()) {
      const snap = next.filter((s) => String(s.domain) === d).map(({ centroid: _c, ...rest }) => ({ ...rest, memberCount: members(String(rest.id)).length })) as unknown as Array<Record<string, unknown>>;
      events.push(ev.sectionsReplaced(d, snap));
    }
    await w.appendLedger(roots, events);
    if (rep.moves.some((m) => m.changed) || rep.removed.length) await w.writeSections(roots, next);
    for (const d of rep.domains) await w.renderDomain(roots, d);
    await w.renderRegistry(roots, foldRegistry(readLedger(roots)));
  } finally {
    if (kb) await kb.close();
    lease.release();
  }
  return rep;
}

export function formatRehomeReport(r: RehomeReport): string[] {
  const p = (x: string) => x.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
  return [
    `kb-rehome${r.apply ? " (applied)" : " (dry run, nothing written; pass --apply)"}: ${r.moves.filter((m) => m.changed).length} move(s), ${r.removed.length} section(s) removed, domains ${r.domains.join(", ") || "-"}`,
    ...r.moves.map((m) => `  ${p(m.entryId)} [${m.domain}]: ${m.changed ? `${p(m.from) || "(none)"} -> ${p(m.to)}` : `already in ${p(m.to)}`}`),
    ...r.removed.map((s) => `  remove section ${p(s)}`),
  ];
}
