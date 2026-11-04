/**
 * Work reads for the hub: the state is every work file in the hub's KB copy (`work/*.md` frontmatter) with the hub's own work ledger
 * applied on top, shaped as the protocol's WorkListResponse / WorkRecordResponse. The KB files are seeded as synthetic events in front
 * of the ledger and folded by the one kb fold (`foldWork`), so ledger precedence (stage, unlink, unschedule, delete ...) is the fold's.
 * The shaping is the one in @wolfpack/memory (`work-shape.ts`), shared with the wolf-side reader in @wolfpack/harness.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@wolfpack/engine";
import { foldWork, readWorkLedger, resolveWorkItem, parseWorkEvent, type WorkEvent, type WorkItem } from "@wolfpack/kb/client";
import { workDir, workLedgerFile, type KbRoots } from "@wolfpack/kb/shared";
import { shapeWorkList, shapeWorkRecord, toWorkChild } from "@wolfpack/memory";
import type { WorkListResponse, WorkRecordResponse } from "@wolfpack/protocol";
import { HubError } from "./errors.js";

export { CHILDREN_CAP, LOG_TAIL } from "@wolfpack/memory";

type Item = WorkItem;

/** The kb DomainId shape (lower-case alphanumerics and inner hyphens): no dot, slash or backslash, so no path escape. Checked before any path is built from a domain. */
export const DOMAIN_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Parsed KB work files by path, valid while mtime+size match. Cached items are shared between calls: READ-ONLY (shallow-frozen). */
const fileCache = new Map<string, { sig: string; item: Item | null }>();
/** Merged state per (kb root, domain), keyed by the dir's per-file signatures plus the ledger's size+mtime. Read-only like the items. */
const stateCache = new Map<string, { sig: string; state: Map<string, Item> }>();
const warned = new Set<string>();

function warnOnce(key: string, msg: string): void {
  if (warned.has(key)) return;
  if (warned.size > 5000) warned.clear();
  warned.add(key);
  console.warn(`hubd: work reads: ${msg}`);
}

function sigOf(path: string): string | undefined {
  try {
    const st = statSync(path);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return undefined;
  }
}

function assertDomain(domain: string): void {
  if (!DOMAIN_RE.test(domain)) throw new HubError("invalid_request", "domain must be lower-case letters, digits and hyphens");
}

/** The KB copy's work items for a domain. `cacheable` is false when the dir is absent or any file could not be read (errors are never cached). */
function kbItems(roots: KbRoots, domain: string): { items: Item[]; sig: string; cacheable: boolean } {
  const dir = workDir(roots, domain);
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return { items: [], sig: "", cacheable: false };
  }
  const items: Item[] = [];
  const sigs: string[] = [];
  const seen = new Set<string>();
  let cacheable = true;
  for (const f of names) {
    const path = join(dir, f);
    const sig = sigOf(path);
    if (sig === undefined) { cacheable = false; continue; } // vanished mid-scan
    seen.add(path);
    sigs.push(`${f}:${sig}`);
    let hit = fileCache.get(path);
    if (!hit || hit.sig !== sig) {
      let item: Item | null = null;
      try {
        item = (resolveWorkItem(roots, domain, f.slice(0, -3))?.item as Item | undefined) ?? null;
        if (!item) warnOnce(`${path}@${sig}`, `skipping ${f}: not a work item`);
        else Object.freeze(item);
      } catch (e) {
        cacheable = false; // a read/parse error is not cached: the next call retries
        warnOnce(`${path}@${sig}`, `skipping ${f}: ${(e as Error).message}`);
        continue;
      }
      hit = { sig, item };
      fileCache.set(path, hit);
    }
    if (hit.item && hit.item.domain === domain) items.push(hit.item);
  }
  const prefix = dir + "/";
  for (const k of fileCache.keys()) if (k.startsWith(prefix) && !seen.has(k)) fileCache.delete(k);
  return { items, sig: sigs.join("|"), cacheable };
}

/** A file item as events (`by` stamps them, e.g. the import's seed marker): created, then its links / graduation / summary / schedule / standing, all before the ledger's events. */
export function seedEvents(it: Item, by?: string): WorkEvent[] {
  const day = (d: string) => `${d} 00:00`;
  const raw: object[] = [
    { type: "work.created", id: it.id, at: day(it.created), kind: it.kind, domain: it.domain, title: it.title, assignee: it.assignee, area: it.area ?? null, partOf: it.partOf ?? null, successCriteria: it.successCriteria ?? null, stage: it.stage, container: it.container ?? false },
  ];
  for (const t of it.dependsOn ?? []) raw.push({ type: "work.linked", id: it.id, at: day(it.updated), rel: "depends_on", target: t });
  for (const t of it.blocks ?? []) raw.push({ type: "work.linked", id: it.id, at: day(it.updated), rel: "blocks", target: t });
  if (it.summary) raw.push({ type: "work.summarized", id: it.id, at: day(it.updated), summary: it.summary });
  if (it.scheduledFor) raw.push({ type: "work.scheduled", id: it.id, at: day(it.updated), scheduledFor: it.scheduledFor, durationMinutes: it.durationMinutes ?? null });
  if (it.standing) raw.push({ type: "work.standing", id: it.id, at: day(it.updated), standing: true });
  if (it.graduated) raw.push({ type: "work.graduated", id: it.id, at: day(it.graduated) });
  const out: WorkEvent[] = [];
  for (const r of raw) {
    const e = parseWorkEvent(by ? { ...r, by } : r);
    if (!e) {
      if ((r as { type: string }).type === "work.created") return []; // the item itself is invalid: no seed at all
      continue; // a bad optional field drops just that field
    }
    out.push(e);
  }
  return out;
}

/**
 * The work state for one domain. Items the ledger never mentions are the file's item as-is; items it touches are the fold of
 * (file seed events + ledger events), so the ledger wins on every field it sets, a ledger delete hides the item, and a ledger
 * `work.created` for an id that also has a file replaces it. Ledger-only items are listed too.
 */
export function loadMergedWorkState(roots: KbRoots, domain: string): Map<string, Item> {
  assertDomain(domain);
  const { items: kb, sig, cacheable } = kbItems(roots, domain);
  const key = `${roots.kbBase}\0${roots.denLocal}\0${domain}`;
  const lsig = sigOf(workLedgerFile(roots)) ?? "none";
  const fullSig = `${sig}#${lsig}`;
  const cached = cacheable ? stateCache.get(key) : undefined;
  if (cached && cached.sig === fullSig) return cached.state;

  const ledger = readWorkLedger(roots);
  const touched = new Set<string>(ledger.map((e) => e.id as string));
  const files = new Map<string, Item>();
  const seeds: WorkEvent[] = [];
  for (const it of kb) {
    const ev = seedEvents(it);
    try {
      foldWork(ev); // one bad seed must not sink the list
    } catch (e) {
      warnOnce(`seed:${it.id}`, `skipping ${it.id}: ${(e as Error).message}`);
      continue;
    }
    if (ev.length === 0) { warnOnce(`seed:${it.id}`, `skipping ${it.id}: invalid work item`); continue; }
    seeds.push(...ev);
    files.set(it.id as string, it);
  }
  let folded: Map<string, Item>;
  try {
    folded = foldWork([...seeds, ...ledger]) as Map<string, Item>;
  } catch (e) {
    warnOnce("fold", `ledger fold failed, serving the KB copy only: ${(e as Error).message}`);
    folded = foldWork(seeds) as Map<string, Item>;
    touched.clear();
  }
  const state = new Map<string, Item>();
  for (const [id, f] of folded) {
    if (f.domain !== domain) continue;
    const file = files.get(id as string);
    state.set(id as string, file && !touched.has(id as string) ? file : Object.freeze(f));
  }
  if (cacheable) stateCache.set(key, { sig: fullSig, state });
  return state;
}

export function listWorkItems(roots: KbRoots, domain: string, includeGraduated: boolean): WorkListResponse {
  return { items: shapeWorkList([...loadMergedWorkState(roots, domain).values()], domain, includeGraduated) };
}

/** The file's body with its generated `## Log` section kept (resolveWorkItem strips it), so the record's log tail has entries. */
function recordBody(roots: KbRoots, item: Item): string {
  try {
    return parseFrontmatter(readFileSync(join(workDir(roots, item.domain as string), `${item.id}.md`), "utf-8")).body.trim();
  } catch {
    return resolveWorkItem(roots, item.domain as string, item.id as string)?.body ?? "";
  }
}

/** Undefined when the item is unknown. */
export function readWorkRecordFor(roots: KbRoots, id: string): WorkRecordResponse | undefined {
  // The domain is the id's middle segment; this assumes domains contain no hyphen (work ids are work-<alnum domain>-<7 id>, see WorkId).
  const domain = /^work-([a-z0-9]+)-/.exec(id)?.[1];
  if (!domain) return undefined;
  const all = loadMergedWorkState(roots, domain);
  const item = all.get(id);
  if (!item) return undefined;
  const listed = item.kind === "feature" || item.container ? [...all.values()].filter((c) => c.partOf === item.id).map(toWorkChild) : undefined;
  return shapeWorkRecord(item, recordBody(roots, item), listed);
}
