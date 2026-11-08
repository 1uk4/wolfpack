/**
 * Hub KB section rebuild: the operator's preview/apply/restore, run inside hubd so the KB never has to be taken offline.
 *
 *   preview  a background job. Plans the domain (model calls: engine + embedder, the curator's own factories) with NO KB lock held and
 *            writes `<dataDir>/rebuild-plans/<domain>-<stamp>.json` (+ `.md`). It only reads the KB.
 *   apply    takes a plan id. Validates the plan file and warms the embedding vectors first (no lock held), then pauses the curator (refused
 *            `busy` if a tick will not stop in time) and, inside the KB writer queue (`exclusive`, the same queue commitKb and the curator
 *            write through; it awaits async work, so the lock spans it): checks the flags, entry-set fingerprint and base sections, takes
 *            an extra copy of the domain (`<dataDir>/rebuild-backups/<stamp>/`, newest 5 kept; NOT what restore reads), runs commitRebuild
 *            (which writes the restore point `restore` uses and `apply` returns as `stamp`), re-renders the registry/digest/INDEX and records
 *            a KB revision. No engine and no network call inside the lock. The curator is resumed in `finally`.
 *   restore  the same lock and pause around restoreRebuild (+ re-render + revision).
 * The commit is synchronous file work: the event loop is busy for its duration (a few hundred ms for ~1000 entries).
 */
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Engine } from "@wolfpack/engine";
import {
  PlanRefusedError, applyPlanFile, buildEntryVectors, engineNamer, enginePartitioner, fileSplitCache, foldRegistry, listRebuildBackups,
  loadPlanFile, loadRebuildEntries, previewToFile, readLedger, restoreAndRender, renderDomainDigest, renderDomainIndex, renderRegistry,
  type CachedEmbedder, type PlanFile, type PlanFlags,
} from "@wolfpack/kb/librarian";
import type { KbRoots } from "@wolfpack/kb/shared";
import type { RebuildListResponse } from "@wolfpack/protocol";
import { HubError } from "./errors.js";

export interface RebuildDeps {
  roots: KbRoots;
  dataDir: string;
  curator: { pause(): Promise<() => void> };
  /** The KB writer queue. Undefined when the hub is shutting down. */
  exclusive: <T>(fn: () => T | Promise<T>) => Promise<T | undefined>;
  /** Record a KB revision for what was just written (revisions.scan, bare: the caller already holds the queue). */
  scan: () => void;
  createEngine: () => Engine;
  getEmbedder: () => CachedEmbedder;
  codeVersion?: string;
  now?: () => number;
}

interface Job { jobId: string; domain: string; state: "running" | "done" | "failed"; startedAt: string; planId?: string; error?: string }

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createRebuildService(d: RebuildDeps) {
  const plansDir = join(d.dataDir, "rebuild-plans");
  const backupsDir = join(d.dataDir, "rebuild-backups");
  const KEEP_BACKUPS = 5;
  const jobs = new Map<string, Job>();
  const planFile = (planId: string) => {
    if (!ID.test(planId)) throw new HubError("invalid_request", "malformed plan id");
    const f = join(plansDir, `${planId}.json`);
    if (!existsSync(f)) throw new HubError("not_found", `no rebuild plan ${planId}`);
    return f;
  };
  const rerender = (domain: string) => {
    renderRegistry(d.roots, foldRegistry(readLedger(d.roots)));
    renderDomainDigest(d.roots, domain);
    renderDomainIndex(d.roots, domain);
  };
  /** Pause the curator, take the KB queue, run `fn` there, always resume. */
  async function locked<T>(fn: () => T | Promise<T>): Promise<T> {
    const resume = await d.curator.pause();
    try {
      const r = await d.exclusive(fn);
      if (r === undefined) throw new HubError("busy", "the hub is shutting down");
      return r;
    } finally {
      resume();
    }
  }

  async function runPreview(job: Job, flags: PlanFlags): Promise<void> {
    try {
      const engine = d.createEngine();
      const vectors = await buildEntryVectors(d.roots, foldRegistry(readLedger(d.roots)), d.getEmbedder());
      const entries = loadRebuildEntries(join(d.roots.kbBase, "domains"), job.domain, vectors);
      if (entries.length === 0) throw new Error(`domain ${job.domain} has no entries`);
      const r = await previewToFile({
        roots: d.roots, domain: job.domain, entries, flags, namer: engineNamer(engine), partitioner: enginePartitioner(engine),
        splitCache: fileSplitCache(join(d.roots.denLocal, "split-cache.json")), outDir: plansDir, codeVersion: d.codeVersion ?? "hubd",
        notify: (m) => console.log(`[rebuild ${job.jobId}] ${m}`),
      });
      job.planId = r.planId;
      job.state = "done";
    } catch (e) {
      job.state = "failed";
      job.error = msg(e).split("\n")[0].slice(0, 500);
      console.error(`[rebuild ${job.jobId}] preview failed: ${job.error}`);
    }
  }

  return {
    preview(domain: string, flags: PlanFlags): { jobId: string; status: "started" } {
      if (!ID.test(domain) || !existsSync(join(d.roots.kbBase, "domains", domain, "entries"))) throw new HubError("not_found", `no KB domain ${domain.slice(0, 60)}`);
      if ([...jobs.values()].some((j) => j.domain === domain && j.state === "running")) throw new HubError("conflict", `a rebuild preview of ${domain} is already running`);
      const job: Job = { jobId: randomBytes(6).toString("hex"), domain, state: "running", startedAt: new Date((d.now ?? Date.now)()).toISOString() };
      jobs.set(job.jobId, job);
      void runPreview(job, flags);
      return { jobId: job.jobId, status: "started" };
    },

    async apply(planId: string, expectFlags?: PlanFlags) {
      const file = planFile(planId);
      let plan: PlanFile;
      try { plan = loadPlanFile(file); } catch (e) {
        if (e instanceof PlanRefusedError) throw new HubError("conflict", e.message);
        throw new HubError("conflict", `rebuild plan ${planId} cannot be read: ${msg(e).split("\n")[0].slice(0, 200)}`);
      }
      if (!planId.startsWith(`${plan.domain}-`)) throw new HubError("invalid_request", `plan ${planId} is for domain ${plan.domain}, which its id does not name`);
      // Warm the embedding vectors BEFORE the lock (a cache miss is a network call); inside the lock only these are used. The entry set is
      // verified under the lock, so they are the right ones for the plan.
      const vectors = await buildEntryVectors(d.roots, foldRegistry(readLedger(d.roots)), d.getEmbedder()).catch((e) => {
        console.warn(`[rebuild] embedding vectors unavailable, new sections get no centroids: ${msg(e)}`);
        return undefined;
      });
      const have = new Set((vectors ?? []).filter((v) => v.domain === plan.domain).map((v) => v.entryId));
      const centroidsMissing = plan.assignment.filter(([e]) => !have.has(e)).length;
      if (centroidsMissing) console.warn(`[rebuild] ${centroidsMissing} entries of ${plan.domain} have no cached embedding: their sections' centroids may be missing until the next bootstrap/reorg`);
      try {
        return await locked(() => {
          const r = applyPlanFile(d.roots, file, { expectFlags, backupDir: backupsDir, vectors, notify: (m) => console.log(`[rebuild] ${m}`) });
          rerender(plan.domain);
          d.scan();
          try { // keep the extra copies bounded; restore never reads them
            for (const old of readdirSync(backupsDir).sort().slice(0, -KEEP_BACKUPS)) rmSync(join(backupsDir, old), { recursive: true, force: true });
          } catch (e) { console.warn(`[rebuild] backup prune failed: ${msg(e)}`); }
          return { planId, domain: plan.domain, stamp: r.stamp, entriesWritten: r.entriesWritten, sections: plan.tree.length, backupDir: r.backupDir, centroids: centroidsMissing ? ("missing" as const) : ("set" as const), centroidsMissing };
        });
      } catch (e) {
        if (e instanceof PlanRefusedError) throw new HubError("conflict", e.message);
        throw e;
      }
    },

    async restore(domain: string, stamp: string) {
      if (!ID.test(stamp)) throw new HubError("invalid_request", "malformed stamp");
      return locked(() => {
        const known = listRebuildBackups(d.roots);
        const notFound = () => new HubError("not_found", `no restore point ${stamp}; known: ${known.join(", ") || "none"}`);
        if (!known.includes(stamp)) throw notFound();
        let was: string;
        try {
          was = (JSON.parse(readFileSync(join(d.roots.denLocal, `.rebuild-old-sections-${stamp}.json`), "utf-8")) as { domain: string }).domain;
        } catch { throw notFound(); } // missing or unreadable restore point
        if (was !== domain) throw new HubError("invalid_request", `restore point ${stamp} is for domain ${was}, not ${domain}`);
        const r = restoreAndRender(d.roots, stamp, { notify: (m) => console.log(`[rebuild] ${m}`) });
        d.scan();
        return { domain: r.domain, stamp, entriesRestored: r.entriesRestored, sections: r.sections };
      });
    },

    list(): RebuildListResponse {
      const plans: RebuildListResponse["plans"] = [];
      if (existsSync(plansDir)) {
        for (const f of readdirSync(plansDir).filter((x) => x.endsWith(".json")).sort()) {
          try {
            const p = loadPlanFile(join(plansDir, f));
            plans.push({ planId: f.slice(0, -5), domain: p.domain, createdAt: p.createdAt, sections: p.tree.length, entries: p.assignment.length, flags: p.flags });
          } catch { /* not a plan we can read: left out */ }
        }
      }
      return { plans, jobs: [...jobs.values()], backups: listRebuildBackups(d.roots) };
    },
  };
}
export type RebuildService = ReturnType<typeof createRebuildService>;
