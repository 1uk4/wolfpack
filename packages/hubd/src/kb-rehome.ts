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
 *   2. ledger: one `entry_placed` per move that changed the file or has no placement in the ledger yet (basis "curator-pinned": the
 *      placement enum has no "manual" and widening it would change the entry frontmatter schema; fit 1), then one `sections_replaced`
 *      for EVERY touched domain (see below);
 *   3. `_sections.json`: removed sections dropped, parents' childIds fixed, memberCount of every section of the touched domains
 *      recounted from the entries with the curator's rule (centroids of the kept sections stay);
 *   4. INDEX.md + _digest.json of each touched domain and _registry.md, rendered as the curator does (commitKb).
 * Ledger fold: foldSections has no "section removed" event, only `sections_replaced` ("drop every section of the domain, take this
 * snapshot"), and its entry_placed handler only ever increments memberCount. So every touched domain gets a `sections_replaced` with
 * the domain's sections as written to _sections.json, WITH their centroids (so the fold never holds `centroid: []` for a touched domain) and without the transient `dirty` flag. That removes
 * dropped sections and resets the additive counts, so the fold and _sections.json agree after a moves-only run too.
 * memberCount rule = the curator's (rebuild.ts Tree.counts()/direct(): entries DIRECTLY in the section, NOT their subtree, and
 * excluding grouped entries, i.e. entries whose frontmatter has an anchor `group:`; retired entries have no file so they never
 * count; the code has no "superseded" state). The dry run prints memberCount before -> after for every section of the touched domains.
 * A --remove-section that is already gone is a no-op; its domain is read from the id (`sec-<domain>-<id>`) and re-rendered.
 * ORDER: run `kb-backfill --aliases` BEFORE kb-rehome. rehome's commitKb writes non-`bf-` entry_written events, which the
 * backfill's skip rule for entry_retired treats as curator rewrites, so a later backfill would skip retires for those entries.
 *
 * Safety: hubd must be STOPPED (a running hubd holds the KB writer lock, so apply fails with a lock error even when the curator is off).
 * Before taking anything it refuses while the curator sweep lease
 * (`<dataDir>/kb/ops/contributions/.sweep-lease`) is fresh; on apply it holds that lease itself (owner "hub") for the whole run.
 * The dry run takes no lock, but still refuses a held lease.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { acquireLease, foldRegistry, freshLeaseIn, groupOf, readLedger, readSections, scanEntryDomains } from "@wolfpack/kb/librarian";
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
  moves: Array<{ entryId: string; domain: string; from: string; to: string; changed: boolean; ledgerOnly: boolean }>;
  removed: string[];
  /** --remove-section ids that were already gone (no-op). */
  alreadyGone: string[];
  /** memberCount before -> after for every section of the touched domains (after null = removed). */
  counts: Array<{ id: string; domain: string; before: number; after: number | null }>;
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
const unquote = (v: string): string => v.replace(/^(["'])(.*)\1$/, "$2");
/** @internal exported for tests */
export const sectionOf = (raw: string): string => {
  const fm = frontmatter(raw);
  return fm ? unquote(/^section:[ \t]*([^\r\n]*?)[ \t\r]*$/m.exec(fm.block)?.[1] ?? "") : "";
};
/** @internal exported for tests. A bare `section:` is replaced, never duplicated. */
export const setSection = (raw: string, id: string): string => {
  const fm = frontmatter(raw);
  if (!fm) throw new Error("entry has no frontmatter block");
  let block: string;
  if (/^section:/m.test(fm.block)) block = fm.block.replace(/^section:.*$/m, `section: ${id}`);
  else if (/^domain: .+$/m.test(fm.block)) {
    const m = /^domain: [^\r\n]+/m.exec(fm.block)!;
    const at = m.index + m[0].length;
    block = fm.block.slice(0, at) + fm.eol + `section: ${id}` + fm.block.slice(at);
  }
  else throw new Error("entry has neither a 'section:' nor a 'domain:' line in its frontmatter");
  return raw.slice(0, fm.start) + block + raw.slice(fm.end);
};

/** Validate and plan (pure reads). Fills rep.errors / moves / removed / domains. */
function plan(opts: RehomeOptions, rep: RehomeReport): { sections: Section[]; after: Map<string, string>; counted: Map<string, string>; eFile: (d: string, id: string) => string } {
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
  const knownDomains = new Set([...domainOf.values(), ...sections.map((x) => String(x.domain))]);
  for (const r of new Set(opts.removeSections ?? [])) {
    if (byId.has(r)) continue;
    rep.alreadyGone.push(r);
    const d = /^sec-([a-z0-9-]+)-[A-Za-z0-9]+$/.exec(r)?.[1]; // the domain from the id, so the renders can be redone
    if (d && knownDomains.has(d)) touchedDomains.add(d);
  }
  const after = new Map<string, string>(); // entryId -> section after the moves (touched domains only; every entry file)
  const counted = new Map<string, string>(); // the same without grouped entries: what the curator counts
  for (const [id, domain] of domainOf) {
    if (!touchedDomains.has(domain)) continue;
    const raw = readFileSync(eFile(domain, id), "utf-8");
    const sec = target.get(id) ?? sectionOf(raw);
    after.set(id, sec);
    if (!groupOf(raw)) counted.set(id, sec);
  }
  const members = (sid: string): string[] => [...after].filter(([, x]) => x === sid).map(([id]) => id);
  for (const r of remove) {
    if ([...target.values()].includes(r)) fail(`section ${r}: cannot be removed, it is a move target`);
    const left = members(r);
    if (left.length) fail(`section ${r} is not empty after the moves (${left.length} entries, e.g. ${left.slice(0, 3).join(", ")})`);
    const kids = sections.filter((c) => String(c.parent) === r && !remove.includes(String(c.id)));
    if (kids.length) fail(`section ${r} still has child sections (${kids.map((k) => String(k.id)).join(", ")}); remove them too or move them first`);
  }
  const placed = new Set(readLedger(roots).filter((e) => e.t === "entry_placed").map((e) => `${(e as { entryId: string }).entryId}\0${(e as { sectionId: string }).sectionId}`));
  for (const [entryId, to] of target) {
    const d = domainOf.get(entryId);
    if (!d) continue;
    const cur = sectionOf(readFileSync(eFile(d, entryId), "utf-8"));
    rep.moves.push({ entryId, domain: d, from: cur, to, changed: cur !== to, ledgerOnly: cur === to && !placed.has(`${entryId}\0${to}`) });
  }
  const direct = new Map<string, number>();
  for (const sid of counted.values()) direct.set(sid, (direct.get(sid) ?? 0) + 1);
  for (const x of sections) {
    if (!touchedDomains.has(String(x.domain))) continue;
    const gone = remove.includes(String(x.id));
    rep.counts.push({ id: String(x.id), domain: String(x.domain), before: x.memberCount, after: gone ? null : direct.get(String(x.id)) ?? 0 });
  }
  rep.removed = remove;
  rep.domains = [...touchedDomains].sort();
  return { sections, after, counted, eFile };
}

export async function kbRehome(opts: RehomeOptions): Promise<RehomeReport> {
  const roots = hubRoots(opts.dataDir);
  const lane = contributionsRoot(opts.dataDir);
  const rep: RehomeReport = { apply: !!opts.apply, moves: [], removed: [], alreadyGone: [], domains: [], counts: [], errors: [] };

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
      const { sections, counted, eFile } = plan(opts, rep);
      if (rep.errors.length) throw new Error(`kb-rehome refuses:\n  ${rep.errors.join("\n  ")}`);
      const w = createHubSweepWriter({ commit: (a, r) => kb.commit(a, r), exclusive: (fn) => kb.exclusive(fn) });
      for (const m of rep.moves) {
        if (!m.changed) continue;
        await w.patchEntry(roots, m.domain, m.entryId, setSection(readFileSync(eFile(m.domain, m.entryId), "utf-8"), m.to));
      }
      // entry_placed for every move that changed the file or whose placement is not in the ledger yet (an entry moved by an earlier,
      // interrupted run).
      const events: KbEvent[] = rep.moves
        .filter((m) => m.changed || m.ledgerOnly)
        .map((m) => ev.entryPlaced({ entryId: m.entryId, sectionId: m.to, basis: "curator-pinned", fit: 1 }));
      // New tree: drop removed, fix parents' childIds, recount EVERY section of the touched domains with the curator's rule.
      const gone = new Set(rep.removed);
      const domains = new Set(rep.domains);
      const direct = new Map<string, number>();
      for (const sid of counted.values()) direct.set(sid, (direct.get(sid) ?? 0) + 1);
      const next = sections.filter((x) => !gone.has(String(x.id))).map((x) => {
        if (!domains.has(String(x.domain))) return x; // other domains are untouched, byte for byte
        const count = direct.get(String(x.id)) ?? 0;
        const kids = x.childIds.filter((c) => !gone.has(String(c)));
        const changed = count !== x.memberCount || kids.length !== x.childIds.length;
        return { ...x, childIds: kids, memberCount: count, ...(changed ? { dirty: true } : {}) };
      });
      for (const d of rep.domains) {
        const snap = next.filter((x) => String(x.domain) === d).map(({ dirty: _d, ...rest }) => rest) as unknown as Array<Record<string, unknown>>;
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
    ...r.moves.map((m) => `  ${p(m.entryId)} [${m.domain}]: ${m.changed ? `${p(m.from) || "(none)"} -> ${p(m.to)}` : `already in ${p(m.to)}`}${m.ledgerOnly ? " (ledger entry_placed)" : ""}`),
    ...r.removed.map((s) => `  remove section ${p(s)}`),
    ...r.alreadyGone.map((s) => `  section ${p(s)} already gone (no-op)`),
    ...r.counts.map((c) => `  memberCount ${p(c.id)} [${c.domain}]: ${c.before} -> ${c.after === null ? "(removed)" : c.after}`),
    ...r.errors.map((e) => `  ERROR: ${p(e)}`),
  ];
}
