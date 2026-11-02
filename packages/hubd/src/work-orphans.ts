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
 * SAFETY VALVE: `--apply` aborts unless `--force` when every item qualifies (orphans >= total), when the hub has 10 items or fewer and
 * more than 3 qualify, or (above 10 items) when more than max(3, 10%) qualify: a sign the scan is wrong, e.g. an unmounted work dir.
 * deleteWork appends `work.deleted` and unlinks the .md only; it does NOT clear other items' dependsOn/blocks references, so those
 * are reported as warnings (dangling links) for the operator. The full list is always printed first. Tests: hubd.readonly.test.ts "work-orphans ...".
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
  /** Non-orphan items that link to an orphan (dependsOn/blocks): the references dangle after a delete. */
  warnings: string[];
  /** Set when --apply was refused (over the limit without --force); nothing was deleted. */
  aborted?: string;
}

/** Strip control characters (incl. newlines/escapes) and cap the length, so a title cannot forge output lines. */
export const sanitizeTitle = (t: string): string => t.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);

/** Same sanitising for ids and domain names (they come from the ledger, which a bad event could fill with control characters). */
export const sanitizeToken = (t: unknown): string => String(t).replace(/[^\x20-\x7e]/g, "?").slice(0, 80);

/** The abort rule for --apply without --force. */
export function overLimit(orphans: number, total: number): boolean {
  if (orphans === 0) return false;
  if (orphans >= total) return true;
  if (total <= 10) return orphans > 3;
  return orphans > Math.max(3, Math.ceil(total * 0.1));
}

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
    const report: OrphanReport = { orphans: [], skipped: [], deleted: [], total: items.size, limit: items.size <= 10 ? 3 : Math.max(3, Math.ceil(items.size * 0.1)), warnings: [] };
    for (const [id, it] of items) {
      const sid = id as string;
      const noMd = !existsSync(join(workDir(roots, it.domain as string), `${sid}.md`));
      if (!noMd) continue;
      if (!dirReadable(it.domain as string)) {
        report.skipped.push({ id: sanitizeToken(sid), reason: `the ${sanitizeToken(it.domain)} work dir is missing or unreadable; cannot tell whether the .md exists` });
        continue;
      }
      if (!selfOrphan(sid)) {
        report.skipped.push({ id: sanitizeToken(sid), reason: `no .md but its ledger events are [${(events.get(sid) ?? []).map(sanitizeToken).join(", ")}], not exactly one work.created; inspect by hand` });
        continue;
      }
      const bad = subtree(sid).filter((x) => !selfOrphan(x));
      if (bad.length) {
        report.skipped.push({ id: sanitizeToken(sid), reason: `descendant(s) that are not orphans: ${bad.map(sanitizeToken).join(", ")}` });
        continue;
      }
      report.orphans.push({ id: sanitizeToken(sid), domain: sanitizeToken(it.domain), title: sanitizeTitle(it.title) });
    }
    // Links from items that will survive to an orphan (deleteWork does not clear them).
    const orphanIds = new Set(report.orphans.flatMap((o) => subtree(o.id)));
    for (const it of items.values()) {
      if (orphanIds.has(it.id as string)) continue;
      for (const ref of [...(it.dependsOn ?? []), ...(it.blocks ?? [])] as string[]) {
        if (orphanIds.has(ref)) report.warnings.push(`${sanitizeToken(it.id)} links to orphan ${sanitizeToken(ref)}; the link will dangle after the delete`);
      }
    }
    if (opts.apply) {
      if (overLimit(report.orphans.length, report.total) && !opts.force) {
        report.aborted = `${report.orphans.length} of ${report.total} items qualify, over the safety limit (all items, or more than ${report.limit}); nothing deleted. Check the list, then re-run with --force if it is right`;
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
