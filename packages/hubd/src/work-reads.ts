/**
 * Work reads over the hub's KB copy (work/*.md frontmatter) with the hub's own ledger applied on top, shaped as the protocol's WorkListResponse / WorkRecordResponse. Folds through the kb
 * work-ops (loadWorkState / resolveWorkItem), never a second fold; the shaping is the one in @wolfpack/memory
 * (`work-shape.ts`), shared with the wolf-side reader in @wolfpack/harness.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { foldWork, readWorkLedger, resolveWorkItem, parseWorkEvent, type WorkEvent, type WorkItem } from "@wolfpack/kb/client";
import { workDir, workLedgerFile, type KbRoots } from "@wolfpack/kb/shared";
import { shapeWorkList, shapeWorkRecord, toWorkChild } from "@wolfpack/memory";
import type { WorkListResponse, WorkRecordResponse } from "@wolfpack/protocol";

export { CHILDREN_CAP, LOG_TAIL } from "@wolfpack/memory";

type Item = WorkItem;

/** Parsed KB work files, keyed by path and invalidated by mtime+size (the stat of ~500 files per call is cheap; the parse is not). */
const fileCache = new Map<string, { sig: string; item: Item | null }>();
/** Merged state per (kb root, domain), keyed by the dir listing signature plus the ledger's size+mtime. */
const stateCache = new Map<string, { sig: string; state: Map<string, Item> }>();

function sigOf(path: string): string {
  try {
    const st = statSync(path);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "none";
  }
}

function kbItems(roots: KbRoots, domain: string): { items: Item[]; sig: string } {
  const dir = workDir(roots, domain);
  if (!existsSync(dir)) return { items: [], sig: "" };
  const items: Item[] = [];
  const sigs: string[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    const path = join(dir, f);
    const sig = sigOf(path);
    sigs.push(`${f}:${sig}`);
    let hit = fileCache.get(path);
    if (!hit || hit.sig !== sig) {
      let item: Item | null = null;
      try {
        item = (resolveWorkItem(roots, domain, f.slice(0, -3))?.item as Item | undefined) ?? null;
      } catch {
        item = null; // a malformed file is skipped, never fatal
      }
      hit = { sig, item };
      fileCache.set(path, hit);
    }
    if (hit.item && hit.item.domain === domain) items.push(hit.item);
  }
  return { items, sig: sigs.join("|") };
}

/**
 * The work state for one domain: every KB-copy work file, with the hub ledger applied on top. The ledger wins for any item it touches
 * (stage, title, links ... fold onto the file's state) and an item the ledger deleted stays hidden. KB items are seeded as synthetic
 * work.created events so the one kb fold (foldWork) does the folding; fields the ledger cannot know (links, summary, log, schedule,
 * graduated) come from the file unless the ledger set them.
 */
export function loadMergedWorkState(roots: KbRoots, domain: string): Map<string, Item> {
  const { items: kb, sig } = kbItems(roots, domain);
  const key = `${roots.kbBase}\0${roots.denLocal}\0${domain}`;
  const fullSig = `${sig}#${sigOf(workLedgerFile(roots))}`;
  const cached = stateCache.get(key);
  if (cached && cached.sig === fullSig) return cached.state;

  const ledger = readWorkLedger(roots);
  const touched = new Set<string>(ledger.map((e) => e.id as string));
  const base = new Map<string, Item>();
  const seeds: WorkEvent[] = [];
  for (const it of kb) {
    const seed = parseWorkEvent({
      type: "work.created",
      id: it.id,
      at: `${it.created} 00:00`,
      kind: it.kind,
      domain: it.domain,
      title: it.title,
      assignee: it.assignee,
      area: it.area ?? null,
      partOf: it.partOf ?? null,
      successCriteria: it.successCriteria ?? null,
      stage: it.stage,
      container: it.container ?? false,
    });
    if (!seed) continue; // not a valid work item: skip rather than fail the whole list
    seeds.push(seed);
    base.set(it.id as string, it);
  }
  const folded = foldWork([...seeds, ...ledger]);
  const state = new Map<string, Item>();
  for (const [id, f] of folded) {
    const b = base.get(id as string);
    if (!b) {
      if (f.domain === domain) state.set(id as string, f); // ledger-only item
    } else if (!touched.has(id as string)) {
      state.set(id as string, b); // the file as-is
    } else {
      state.set(id as string, {
        ...f,
        dependsOn: [...new Set([...b.dependsOn, ...f.dependsOn])] as Item["dependsOn"],
        blocks: [...new Set([...b.blocks, ...f.blocks])] as Item["blocks"],
        graduated: f.graduated ?? b.graduated,
        summary: f.summary ?? b.summary,
        standing: f.standing || b.standing,
        scheduledFor: f.scheduledFor ?? b.scheduledFor,
        durationMinutes: f.durationMinutes ?? b.durationMinutes,
        log: [...b.log, ...f.log],
        created: b.created,
      });
    }
  }
  stateCache.set(key, { sig: fullSig, state });
  return state;
}

export function listWorkItems(roots: KbRoots, domain: string, includeGraduated: boolean): WorkListResponse {
  return { items: shapeWorkList([...loadMergedWorkState(roots, domain).values()], domain, includeGraduated) };
}

/** Undefined when the item is unknown. */
export function readWorkRecordFor(roots: KbRoots, id: string): WorkRecordResponse | undefined {
  const domain = /^work-([a-z0-9]+)-/.exec(id)?.[1];
  if (!domain) return undefined;
  const all = loadMergedWorkState(roots, domain);
  const item = all.get(id);
  if (!item) return undefined;
  const body = resolveWorkItem(roots, item.domain as string, item.id as string)?.body ?? "";
  const listed = item.kind === "feature" || item.container ? [...all.values()].filter((c) => c.partOf === item.id).map(toWorkChild) : undefined;
  return shapeWorkRecord(item, body, listed);
}
