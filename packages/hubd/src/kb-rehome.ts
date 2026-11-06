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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { acquireLease, foldRegistry, freshLeaseIn, readLedger, readSections, scanEntryDomains } from "@wolfpack/kb/librarian";
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
  /** --remove-section ids that were already gone (no-op). */
  alreadyGone: string[];
  domains: string[];
  errors: string[];
}

type Section = ReturnType<typeof readSections>[number];

/** The frontmatter block only (`---` .. `---`), with its EOL; null when the file has none. */
function frontmatter(raw: string): { start: number; end: number; block: string; eol: string } | null {
  const m = /^---(\r?\n)([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw.replace(/^\uFEFF/, ""));
  if (!m) return null;
  const off = raw.startsWith("\uFEFF") ? 1 : 0;
  const start = off + 3 + m[1]!.length;
  return { start, end: start + m[2]!.length, block: m[2]!, eol: m[1]! };
}
/** @internal exported for tests */
export const sectionOf = (raw: string): string => {
  const fm = frontmatter(raw);
  return fm ? /^section: (.+?)\s*$/m.exec(fm.block)?.[1] ?? "" : "";
};
/** @internal exported for tests */
export const setSection = (raw: string, id: string): string => {
  const fm = frontmatter(raw);
  if (!fm) throw new Error("entry has no frontmatter block");
  let block: string;
  if (/^section: .+$/m.test(fm.block)) block = fm.block.replace(/^section: .+$/m, `section: ${id}`);
  else if (/^domain: .+$/m.test(fm.block)) {
    const m = /^domain: [^\r\n]+/m.exec(fm.block)!;
    const at = m.index + m[0].length;
    block = fm.block.slice(0, at) + fm.eol + `section: ${id}` + fm.block.slice(at);
  }
  else throw new Error("entry has neither a 'section:' nor a 'domain:' line in its frontmatter");
  return raw.slice(0, fm.start) + block + raw.slice(fm.end);
};

/** Validate and plan (pure reads). Fills rep.errors / moves / removed / domains. */
function plan(opts: RehomeOptions, rep: RehomeReport): { sections: Section[]; after: Map<string, string>; target: Map<string, string>; eFile: (d: string, id: string) => string } {
  const roots = hubRoots(opts.dataDir);
  const fail = (m: string) => rep.errors.push(m);
  const sections = readSections(roots);
  const byId = new Map(sections.map((x) => [String(x.id), x]));
  const domainOf = scanEntryDomains(roots.kbBase);
  const eFile = (domain: string, id: string) => join(roots.kbBase, "domains", domain, "entries", `${id}.md`);
  const target = new Map<string, string>(); // entryId -> section (de-duped by entry)
  for (const m of opts.moves) {
    if (target.has(m.entryId) && target.get(m.entryId) !== m.sectionId) { fail(`${m.entryId}: moved to two different sections (${target.get(m.entryId)}, ${m.sectionId})`); continue; }
    target.set(m.entryId, m.sectionId);
    const domain = domainOf.get(m.entryId);
    if (!domain) { fail(`${m.entryId}: no such entry in the hub KB`); continue; }
    const sec = byId.get(m.sectionId);
    if (!sec) { fail(`${m.entryId}: target section ${m.sectionId} does not exist`); continue; }
    if (String(sec.domain) !== domain) fail(`${m.entryId}: target section ${m.sectionId} is in domain ${String(sec.domain)}, the entry is in ${domain}`);
  }
  const touchedDomains = new Set<string>();
  for (const id of target.keys()) { const d = domainOf.get(id); if (d) touchedDomains.add(d); }
  // A section that is already gone is a no-op (a re-run after a partial failure redoes the renders).
  const remove = [...new Set(opts.removeSections ?? [])].filter((r) => byId.has(r));
  for (const r of remove) touchedDomains.add(String(byId.get(r)!.domain));
  for (const r of new Set(opts.removeSections ?? [])) if (!byId.has(r)) rep.alreadyGone.push(r);
  const after = new Map<string, string>(); // entryId -> section after the moves (touched domains only)
  for (const [id, domain] of domainOf) {
    if (!touchedDomains.has(domain)) continue;
    after.set(id, target.get(id) ?? sectionOf(readFileSync(eFile(domain, id), "utf-8")));
  }
  const members = (sid: string): string[] => [...after].filter(([, x]) => x === sid).map(([id]) => id);
  for (const r of remove) {
    if ([...target.values()].includes(r)) fail(`section ${r}: cannot be removed, it is a move target`);
    const left = members(r);
    if (left.length) fail(`section ${r} is not empty after the moves (${left.length} entries, e.g. ${left.slice(0, 3).join(", ")})`);
    const kids = sections.filter((c) => String(c.parent) === r && !remove.includes(String(c.id)));
    if (kids.length) fail(`section ${r} still has child sections (${kids.map((k) => String(k.id)).join(", ")}); remove them too or move them first`);
  }
  for (const [entryId, to] of target) {
    const d = domainOf.get(entryId);
    if (!d) continue;
    const cur = sectionOf(readFileSync(eFile(d, entryId), "utf-8"));
    rep.moves.push({ entryId, domain: d, from: cur, to, changed: cur !== to });
  }
  rep.removed = remove;
  rep.domains = [...touchedDomains].sort();
  return { sections, after, target, eFile };
}

export async function kbRehome(opts: RehomeOptions): Promise<RehomeReport> {
  const roots = hubRoots(opts.dataDir);
  const lane = contributionsRoot(opts.dataDir);
  const rep: RehomeReport = { apply: !!opts.apply, moves: [], removed: [], alreadyGone: [], domains: [], errors: [] };

  const held = freshLeaseIn([lane]);
  const heldMsg = held ? `the curator sweep lease is held (${held.owner} pid ${held.pid} on ${held.host}); stop hubd (or turn the curator off) first` : "";
  if (!opts.apply) {
    if (held) rep.errors.push(heldMsg);
    else plan(opts, rep);
    return rep;
  }
  if (held) throw new Error(`kb-rehome refuses: ${heldMsg}`);

  // Lease and writer lock first, THEN validate: nothing can change between the check and the writes.
  const lease = acquireLease([lane], "hub");
  if (!lease) throw new Error("kb-rehome refuses: could not take the curator sweep lease (another sweeper holds it)");
  try {
    const kb = createKbWriter({ dataDir: opts.dataDir, roots, onChanged: () => undefined }); // throws when a running hubd holds the writer lock
    try {
      const { sections, after, eFile } = plan(opts, rep);
      if (rep.errors.length) throw new Error(`kb-rehome refuses:\n  ${rep.errors.join("\n  ")}`);
      const w = createHubSweepWriter({ commit: (a, r) => kb.commit(a, r), exclusive: (fn) => kb.exclusive(fn) });
      for (const m of rep.moves) {
        if (!m.changed) continue;
        await w.patchEntry(roots, m.domain, m.entryId, setSection(readFileSync(eFile(m.domain, m.entryId), "utf-8"), m.to));
      }
      // entry_placed for every move whose placement is not in the ledger yet (also an entry moved by an earlier, interrupted run).
      const log = readLedger(roots);
      const placed = new Set(log.filter((e) => e.t === "entry_placed").map((e) => `${(e as { entryId: string }).entryId}\0${(e as { sectionId: string }).sectionId}`));
      const events: KbEvent[] = rep.moves
        .filter((m) => m.changed || !placed.has(`${m.entryId}\0${m.to}`))
        .map((m) => ev.entryPlaced({ entryId: m.entryId, sectionId: m.to, basis: "curator-pinned", fit: 1 }));
      // New tree: drop removed, fix parents' childIds, recount EVERY section of the touched domains. memberCount is the number of
      // entries DIRECTLY in the section (rebuild.ts counts() / refreshPath, sweep placement), not its subtree.
      const gone = new Set(rep.removed);
      const domains = new Set(rep.domains);
      const direct = new Map<string, number>();
      for (const sid of after.values()) direct.set(sid, (direct.get(sid) ?? 0) + 1);
      const next = sections.filter((x) => !gone.has(String(x.id))).map((x) => {
        if (!domains.has(String(x.domain))) return x; // other domains are untouched, byte for byte
        const count = direct.get(String(x.id)) ?? 0;
        const kids = x.childIds.filter((c) => !gone.has(String(c)));
        const changed = count !== x.memberCount || kids.length !== x.childIds.length;
        return { ...x, childIds: kids, memberCount: count, ...(changed ? { dirty: true } : {}) };
      });
      const removedDomains = new Set(rep.removed.map((r) => String(sections.find((x) => String(x.id) === r)!.domain)));
      for (const d of [...removedDomains].sort()) {
        const snap = next.filter((x) => String(x.domain) === d).map(({ centroid: _c, ...rest }) => rest) as unknown as Array<Record<string, unknown>>;
        events.push(ev.sectionsReplaced(d, snap));
      }
      await w.appendLedger(roots, events);
      await w.writeSections(roots, next);
      for (const d of rep.domains) await w.renderDomain(roots, d);
      await w.renderRegistry(roots, foldRegistry(readLedger(roots)));
    } finally {
      try {
        await kb.close();
      } finally {
        lease.release();
      }
    }
  } catch (e) {
    lease.release(); // idempotent; covers a failing createKbWriter
    throw e;
  }
  return rep;
}

export function formatRehomeReport(r: RehomeReport): string[] {
  const p = (x: string) => x.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
  return [
    `kb-rehome${r.apply ? " (applied)" : " (dry run, nothing written; pass --apply)"}: ${r.moves.filter((m) => m.changed).length} move(s), ${r.removed.length} section(s) removed, domains ${r.domains.join(", ") || "-"}`,
    ...r.moves.map((m) => `  ${p(m.entryId)} [${m.domain}]: ${m.changed ? `${p(m.from) || "(none)"} -> ${p(m.to)}` : `already in ${p(m.to)}`}`),
    ...r.removed.map((s) => `  remove section ${p(s)}`),
    ...r.alreadyGone.map((s) => `  section ${p(s)} already gone (no-op)`),
    ...r.errors.map((e) => `  ERROR: ${p(e)}`),
  ];
}
