/**
 * Operator clean-up of ledger-only orphans: work items whose `work.created` is in the ledger but whose item .md was never written
 * (a failed .md write after the ledger append, e.g. ENOSPC mid-op; the pre-flight write probe prevents the common EROFS case).
 * `hubd work-orphans --data-dir <dir> [--apply] [--force]`.
 *
 * Offline like `hubd export`: it takes the work-writer lock even for the dry run, so it refuses while a hub (or another writer)
 * runs. It goes through hubd's own ops: the fix is an APPENDED `work.deleted` event (kb deleteWork), never a rewrite of the
 * single-writer ledger, so history stays and a mistake is visible. Dry run by default.
 *
 * An item is an orphan only if ALL hold, so a real item is never touched:
 *   - it is in the folded state, its domain's work dir EXISTS and is READABLE (otherwise "no .md" proves nothing), and it has no .md;
 *   - its ledger events are exactly one, and that one is `work.created` (nothing ever happened to it);
 *   - EVERY descendant (children, grandchildren, ...) is an orphan too: `deleteWork` cascades to the whole subtree, so one real
 *     descendant anywhere below keeps the whole chain out. A last check re-derives the cascade set before each delete.
 * SAFETY VALVE: if more than max(3, 10% of all items) qualify, `--apply` aborts unless `--force` (a sign the scan is wrong, e.g. an
 * unmounted work dir). The full list is always printed first. Tests: hubd.readonly.test.ts "work-orphans ...".
 */
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { acquireWorkWriterLock } from "@wolfpack/engine";
import { deleteWork, loadWorkState, readWorkLedger } from "@wolfpack/kb/client";
import { workDir } from "@wolfpack/kb/shared";
import { hubRoots } from "./layout.js";

export interface OrphanReport {
  orphans: Array<{ id: string; domain: string; title: string }>;
  skipped: Array<{ id: string; reason: string }>;
  deleted: string[];
  total: number;
  limit: number;
  /** Set when --apply was refused (over the limit without --force); nothing was deleted. */
  aborted?: string;
}

/** Strip control characters (incl. newlines/escapes) and cap the length, so a title cannot forge output lines. */
export const sanitizeTitle = (t: string): string => t.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);

export function cleanOrphans(dataDir: string, opts: { apply: boolean; force?: boolean }): OrphanReport {
  const roots = hubRoots(dataDir);
  let lock: { release(): void };
  try {
    lock = acquireWorkWriterLock(dataDir);
  } catch (e) {
    throw new Error(`cannot run: a hub (or another writer) holds ${dataDir}; stop it first (${e instanceof Error ? e.message : String(e)})`);
  }
  try {
    const items = loadWorkState(roots);
    const events = new Map<string, string[]>();
    for (const ev of readWorkLedger(roots)) events.set(ev.id as string, [...(events.get(ev.id as string) ?? []), ev.type as string]);
    const dirReadable = (domain: string): boolean => {
      const dir = workDir(roots, domain);
      try {
        if (!existsSync(dir) || !statSync(dir).isDirectory()) return false;
        accessSync(dir, constants.R_OK | constants.X_OK);
        return true;
      } catch {
        return false;
      }
    };
    const childrenOf = new Map<string, string[]>();
    for (const it of items.values()) if (it.partOf) childrenOf.set(it.partOf as string, [...(childrenOf.get(it.partOf as string) ?? []), it.id as string]);
    /** The item itself looks orphaned (not yet looking at descendants). */
    const selfOrphan = (id: string): boolean => {
      const it = items.get(id as never);
      if (!it || !dirReadable(it.domain as string)) return false;
      if (existsSync(join(workDir(roots, it.domain as string), `${id}.md`))) return false;
      const ev = events.get(id) ?? [];
      return ev.length === 1 && ev[0] === "work.created";
    };
    const subtree = (id: string): string[] => {
      const out: string[] = [];
      const walk = (x: string) => {
        out.push(x);
        for (const c of childrenOf.get(x) ?? []) walk(c);
      };
      walk(id);
      return out;
    };
    const report: OrphanReport = { orphans: [], skipped: [], deleted: [], total: items.size, limit: Math.max(3, Math.ceil(items.size * 0.1)) };
    for (const [id, it] of items) {
      const sid = id as string;
      const noMd = !existsSync(join(workDir(roots, it.domain as string), `${sid}.md`));
      if (!noMd) continue;
      if (!dirReadable(it.domain as string)) {
        report.skipped.push({ id: sid, reason: `the ${it.domain} work dir is missing or unreadable; cannot tell whether the .md exists` });
        continue;
      }
      if (!selfOrphan(sid)) {
        report.skipped.push({ id: sid, reason: `no .md but its ledger events are [${(events.get(sid) ?? []).join(", ")}], not exactly one work.created; inspect by hand` });
        continue;
      }
      const bad = subtree(sid).filter((x) => !selfOrphan(x));
      if (bad.length) {
        report.skipped.push({ id: sid, reason: `descendant(s) that are not orphans: ${bad.join(", ")}` });
        continue;
      }
      report.orphans.push({ id: sid, domain: it.domain as string, title: sanitizeTitle(it.title) });
    }
    if (opts.apply) {
      if (report.orphans.length > report.limit && !opts.force) {
        report.aborted = `${report.orphans.length} orphans is more than max(3, 10% of ${report.total} items) = ${report.limit}; nothing deleted. Check the list, then re-run with --force if it is right`;
        return report;
      }
      for (const o of report.orphans) {
        const now = loadWorkState(roots);
        if (!now.has(o.id as never)) continue; // already removed with a parent
        // Re-derive the cascade deleteWork would perform; refuse if it reaches anything that is not an orphan.
        const cascade = subtree(o.id).filter((x) => now.has(x as never));
        const stray = cascade.filter((x) => !selfOrphan(x));
        if (stray.length) {
          report.skipped.push({ id: o.id, reason: `cascade would reach non-orphans (${stray.join(", ")}); not deleted` });
          continue;
        }
        for (const gone of deleteWork(roots, o.id).items) report.deleted.push(gone.id as string);
      }
    }
    return report;
  } finally {
    lock.release();
  }
}
