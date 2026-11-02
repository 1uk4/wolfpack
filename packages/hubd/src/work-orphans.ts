/**
 * Operator clean-up of ledger-only orphans: work items whose `work.created` is in the ledger but whose item .md was never written
 * (the old ordering appended first, so a failed .md write, e.g. EROFS, left them). `hubd work-orphans --data-dir <dir> [--apply]`.
 *
 * Offline like `hubd export`: it takes the work-writer lock, so it refuses while a hub (or another writer) runs. It goes through
 * hubd's own ops: the fix is an APPENDED `work.deleted` event (kb deleteWork), never a rewrite of the single-writer ledger, so the
 * history stays and a mistake is visible. Dry-run by default.
 *
 * What counts as an orphan (all must hold, so a real item is never touched):
 *   - the item is in the folded state and has NO .md file in its domain's work dir;
 *   - its only ledger events are the `work.created` (nothing ever happened to it: no stage, note, graduate...);
 *   - nothing has it as parent unless that child is itself such an orphan (deleteWork cascades to children).
 * An item that has an .md is never listed. Anything suspicious is reported under `skipped`, not deleted.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { acquireWorkWriterLock } from "@wolfpack/engine";
import { deleteWork, loadWorkState, readWorkLedger } from "@wolfpack/kb/client";
import { workDir } from "@wolfpack/kb/shared";
import { hubRoots } from "./layout.js";

export interface OrphanReport {
  orphans: Array<{ id: string; domain: string; title: string }>;
  skipped: Array<{ id: string; reason: string }>;
  deleted: string[];
}

export function cleanOrphans(dataDir: string, opts: { apply: boolean }): OrphanReport {
  const roots = hubRoots(dataDir);
  let lock: { release(): void };
  try {
    lock = acquireWorkWriterLock(dataDir);
  } catch (e) {
    throw new Error(`cannot run: a hub (or another writer) holds ${dataDir}; stop it first (${e instanceof Error ? e.message : String(e)})`);
  }
  try {
    const items = loadWorkState(roots);
    const eventCount = new Map<string, number>();
    for (const ev of readWorkLedger(roots)) eventCount.set(ev.id as string, (eventCount.get(ev.id as string) ?? 0) + 1);
    const noFile = (id: string) => {
      const it = items.get(id as never);
      return !!it && !existsSync(join(workDir(roots, it.domain as string), `${id}.md`));
    };
    const isOrphan = (id: string) => noFile(id) && eventCount.get(id) === 1;
    const report: OrphanReport = { orphans: [], skipped: [], deleted: [] };
    for (const [id, it] of items) {
      if (!noFile(id)) continue;
      if (!isOrphan(id)) {
        report.skipped.push({ id, reason: `no .md but ${eventCount.get(id)} ledger events (not a pure create-only orphan); inspect by hand` });
        continue;
      }
      const kids = [...items.values()].filter((c) => c.partOf === it.id && !isOrphan(c.id as string));
      if (kids.length) {
        report.skipped.push({ id, reason: `has ${kids.length} child item(s) that are not orphans` });
        continue;
      }
      report.orphans.push({ id, domain: it.domain as string, title: it.title });
    }
    if (opts.apply) {
      for (const o of report.orphans) {
        if (!loadWorkState(roots).has(o.id as never)) continue; // already removed with a parent
        for (const gone of deleteWork(roots, o.id).items) report.deleted.push(gone.id as string);
      }
    }
    return report;
  } finally {
    lock.release();
  }
}
