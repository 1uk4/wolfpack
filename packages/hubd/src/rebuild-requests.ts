/**
 * Sweep autonomy (work-wolfpack-122GUvd): when the sweep reports sections over the split threshold, the curator asks for a
 * from=current rebuild PREVIEW of that domain (the same service as POST /v1/admin/kb/rebuild/preview), and files a request for
 * the owner when the plan is new. A plan is never applied here.
 *
 * The approvals store (work-approvals.ts) only knows graduate / archive / reassign and every request needs a work item, so a
 * rebuild request is recorded in `<dataDir>/ledger/rebuild-requests.json` and announced through `notify`; the owner applies the
 * plan with the existing apply route (`planId`). The same file holds the 24h per-domain preview rate limit.
 *
 * PLAN HASH: sha256 over the plan's sorted section ids and its entry->section assignments sorted by entry id.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const REBUILD_PREVIEW_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const rebuildRequestsFile = (dataDir: string): string => join(dataDir, "ledger", "rebuild-requests.json");

export interface PlanSummary { planId: string; domain: string; sectionIds: string[]; assignment: Array<[string, string]> }
export interface RebuildRequest { hash: string; domain: string; planId: string; sections: number; entries: number; oversize: { id: string; count: number }[]; filedAt: string }

interface Store { lastPreview: Record<string, string>; requests: RebuildRequest[] }

/** Hash of a plan's shape: sorted section ids plus entry->section assignments. */
export function planHash(p: Pick<PlanSummary, "sectionIds" | "assignment">): string {
  const secs = [...p.sectionIds].sort();
  const asg = [...p.assignment].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([e, s]) => `${e}>${s}`);
  return createHash("sha256").update(JSON.stringify([secs, asg])).digest("hex");
}

export interface RebuildRequesterDeps {
  dataDir: string;
  /** Run a from=current preview and return the plan (the server wires the rebuild service). Throws on failure. */
  preview: (domain: string) => Promise<PlanSummary>;
  /** Announce a newly filed request to the owner. */
  notify: (req: RebuildRequest) => void | Promise<void>;
  now?: () => number;
  log?: (m: string) => void;
}

export function createRebuildRequester(d: RebuildRequesterDeps) {
  const file = rebuildRequestsFile(d.dataDir);
  const now = d.now ?? Date.now;
  const log = d.log ?? ((m: string) => console.log(`[rebuild-requests] ${m}`));
  const running = new Set<string>();
  const load = (): Store => {
    try {
      if (existsSync(file)) {
        const p = JSON.parse(readFileSync(file, "utf8")) as Partial<Store>;
        return { lastPreview: p.lastPreview ?? {}, requests: p.requests ?? [] };
      }
    } catch { /* unreadable: start clean, the rate limit then errs towards one extra preview */ }
    return { lastPreview: {}, requests: [] };
  };
  const save = (s: Store): void => {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 1));
    renameSync(tmp, file);
  };

  return {
    /** Called by the curator after a sweep finished. Never throws. Returns what happened (for tests and logs). */
    async onSplitDue(domain: string, oversize: { id: string; count: number }[]): Promise<"rate-limited" | "busy" | "duplicate" | "filed" | "failed"> {
      if (running.has(domain)) return "busy";
      const s = load();
      const last = s.lastPreview[domain] ? Date.parse(s.lastPreview[domain]) : 0;
      if (now() - last < REBUILD_PREVIEW_INTERVAL_MS) return "rate-limited";
      running.add(domain);
      try {
        s.lastPreview[domain] = new Date(now()).toISOString(); // counted even when the preview fails: a broken domain is not retried every sweep
        save(s);
        const plan = await d.preview(domain);
        const hash = planHash(plan);
        const cur = load();
        if (cur.requests.some((r) => r.hash === hash)) return "duplicate";
        const req: RebuildRequest = { hash, domain, planId: plan.planId, sections: plan.sectionIds.length, entries: plan.assignment.length, oversize, filedAt: new Date(now()).toISOString() };
        save({ ...cur, requests: [...cur.requests, req] });
        await d.notify(req);
        return "filed";
      } catch (e) {
        log(`preview for ${domain} failed: ${e instanceof Error ? e.message : String(e)}`);
        return "failed";
      } finally {
        running.delete(domain);
      }
    },
  };
}
