/**
 * Crawl planning logic shared by the pi extension (index.ts) and the durable one (unified-crawl.ts): drafting a plan,
 * reading it back, the gate, finalize, and the tool schemas/descriptions. Pure of pi / harness imports; each host
 * wraps the results in its own tool result format (pi throws on failure, durable returns isError results).
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import {
  discoverSources,
  gatePlan,
  planCrawl,
  readPlan,
  renderPlanSummary,
  writePlan,
  type CrawlPlan,
  type Strategy,
} from "@wolfpack/memory";

export interface CrawlCoreDeps {
  /** Where plans/runs live (sink base). */
  crawlHome: string;
  defaultDomain: string;
  /** Declared KB domains, or null when unknown. */
  declaredDomains: () => Set<string> | null;
}

export interface DraftOptions {
  path: string;
  domain?: string;
  strategy?: string;
  depth?: number;
  include?: string[];
  exclude?: string[];
}

export type FinalizeResult = { ok: true; planPath: string; batches: number } | { ok: false; failures: string[] };

export function createCrawlCore(deps: CrawlCoreDeps) {
  /** The last plan this host drafted (the default `planPath` of the other tools). */
  const state: { lastPlanPath: string | null } = { lastPlanPath: null };

  const isDir = (p: string): boolean => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  };

  /** Discover → group → write plan.yaml; remembers the path. include/exclude are persisted in the plan. */
  function draft(o: DraftOptions): { plan: CrawlPlan; planPath: string } {
    const { plan, sink } = planCrawl({
      source: o.path,
      domain: o.domain ?? deps.defaultDomain,
      strategy: (o.strategy as Strategy) ?? "by-folder",
      folderDepth: o.depth,
      ...(o.include?.length ? { include: o.include } : {}),
      ...(o.exclude?.length ? { exclude: o.exclude } : {}),
      sinkBase: deps.crawlHome,
    });
    state.lastPlanPath = join(sink.dir, "plan.yaml");
    return { plan, planPath: state.lastPlanPath };
  }

  const filesOf = (plan: CrawlPlan) => discoverSources(plan.source, { include: plan.include, exclude: plan.exclude });

  /** The batch summary of a plan as it would be crawled now. */
  const summarize = (plan: CrawlPlan): string => renderPlanSummary(plan, filesOf(plan));

  /** Read a plan back (throws when there is none yet). */
  function load(planPath?: string): { p: string; plan: CrawlPlan } {
    const p = planPath ?? state.lastPlanPath;
    if (!p) throw new Error("no plan path (run crawl_plan first)");
    return { p, plan: readPlan(p) };
  }

  function validate(planPath?: string): { ok: boolean; failures: string[] } {
    const { plan } = load(planPath);
    const failures = gatePlan(plan, { files: filesOf(plan), declared: deps.declaredDomains(), sourceExists: isDir(plan.source) });
    return { ok: failures.length === 0, failures };
  }

  /** Gate a status:ready copy (only real problems surface, not the draft status); stamp it ready when sound. */
  function finalize(planPath?: string): FinalizeResult {
    const { p, plan } = load(planPath);
    const ready = { ...plan, status: "ready" as const };
    const failures = gatePlan(ready, { files: filesOf(plan), declared: deps.declaredDomains(), sourceExists: isDir(plan.source) });
    if (failures.length) return { ok: false, failures };
    writePlan(p, ready);
    return { ok: true, planPath: p, batches: ready.batches.length };
  }

  return { state, isDir, draft, summarize, load, validate, finalize };
}

export type CrawlCore = ReturnType<typeof createCrawlCore>;

/** Minimal TypeBox surface (pi-ai's and the harness's `Type` both satisfy it). */
interface TypeLike {
  Object(props: Record<string, unknown>): any;
  String(opts?: Record<string, unknown>): any;
  Number(opts?: Record<string, unknown>): any;
  Optional(t: unknown): any;
  Array(t: unknown, opts?: Record<string, unknown>): any;
}

/** Descriptions + parameter schemas of the four plan tools. `scope` adds include/exclude to crawl_plan (durable only). */
export function crawlPlanTools(Type: TypeLike, opts: { scope: boolean }) {
  const planPath = Type.Object({ planPath: Type.Optional(Type.String({ description: "Plan path (defaults to last)" })) });
  return {
    plan: {
      description:
        "Draft a crawl plan from a source directory (deterministic; no LLM). " +
        "Groups files into topic batches and resolves dates. Writes crawl-plan.yaml.",
      parameters: Type.Object({
        path: Type.String({ description: "Absolute source directory to crawl" }),
        domain: Type.Optional(Type.String({ description: "Target KB domain" })),
        strategy: Type.Optional(Type.String({ description: "by-folder | by-pattern" })),
        depth: Type.Optional(Type.Number({ description: "by-folder: cap grouping to N path segments" })),
        ...(opts.scope
          ? {
              include: Type.Optional(Type.Array(Type.String(), { description: "Only crawl files matching these globs (default: everything)" })),
              exclude: Type.Optional(Type.Array(Type.String(), { description: "Skip files matching these globs, on top of the defaults" })),
            }
          : {}),
      }),
    },
    preview: { description: "Summarize a crawl plan (batch count, files, per-batch detail).", parameters: planPath },
    validate: {
      description:
        "Run the crawl gate against a plan: status ready, domain declared, every " +
        "batch resolves, no file in two batches. Returns pass or the failures.",
      parameters: planPath,
    },
    finalize: {
      description:
        "Mark a reviewed plan as ready: run every gate check except status, then " +
        "write 'status: ready' to the plan document. Call ONLY after the user " +
        "approved the batch summary. Returns the failures if the plan is not sound.",
      parameters: planPath,
    },
  };
}
