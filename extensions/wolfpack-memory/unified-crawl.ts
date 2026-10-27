/**
 * Crawl planning for durable wolves (pi-durable): the plan tools plus `crawl_start`, which opens the questionnaire.
 *
 * pi starts it with /wolf:crawl (index.ts); a durable wolf has no slash commands, so the model calls `crawl_start`.
 * Whether the plan is gathered by interview is an explicit host capability (`context.capabilities.askCards`, see
 * crawl-interview.ts); without it, or with `draft`, the plan is drafted deterministically.
 * Running a plan (/wolf:crawl-run, release) stays with the pi command for now.
 */
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { defineExtension, defineTool, Type, type ExtensionContext, type ToolResult } from "@wolfpack/harness/extension";
import { discoverSources, gatePlan, planCrawl, readPlan, renderPlanSummary, writePlan, type Strategy } from "@wolfpack/memory";
import { readDeclaredDomains } from "@wolfpack/kb/librarian";
import { resolveDefaultDomain } from "@wolfpack/engine";
import { buildCrawlDirective, canInterview } from "./crawl-interview.js";

export interface CrawlConfig {
  defaultDomain?: string;
}

const text = (t: string, extra: Partial<ToolResult> = {}): ToolResult => ({ content: [{ type: "text", text: t }], ...extra });
const fail = (t: string): ToolResult => text(t, { isError: true });

export default function createCrawlExtension(config: CrawlConfig, context: ExtensionContext): ReturnType<typeof defineExtension> {
  const env = context.env ?? process.env;
  const defaultDomain = resolveDefaultDomain(config.defaultDomain, context.domains);
  const crawlHome = env.WOLFPACK_CRAWL_HOME || join(context.wolfDen, "crawls");
  const askCards = context.capabilities?.askCards === true;
  let lastPlanPath: string | null = null;

  const declaredDomains = (): Set<string> | null => {
    if (!env.KB_BASE || !env.KB_OPS) return null;
    try {
      return readDeclaredDomains({ kbBase: env.KB_BASE, opsRoot: env.KB_OPS, denLocal: env.KB_DEN_LOCAL ?? join(context.wolfDen, "kb") });
    } catch {
      return null;
    }
  };

  const isDir = (p: string): boolean => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  };

  const draft = (o: { path: string; domain?: string; strategy?: string; depth?: number; include?: string[]; exclude?: string[] }) => {
    mkdirSync(crawlHome, { recursive: true });
    const { plan, sink } = planCrawl({
      source: o.path,
      domain: o.domain ?? defaultDomain,
      strategy: (o.strategy as Strategy) ?? "by-folder",
      folderDepth: o.depth,
      ...(o.include?.length ? { include: o.include } : {}),
      ...(o.exclude?.length ? { exclude: o.exclude } : {}),
      sinkBase: crawlHome,
    });
    lastPlanPath = join(sink.dir, "plan.yaml");
    const files = discoverSources(o.path, { include: plan.include, exclude: plan.exclude });
    return { plan, summary: renderPlanSummary(plan, files) };
  };

  const planFiles = (planPath?: string) => {
    const p = planPath ?? lastPlanPath;
    if (!p) throw new Error("no plan path (run crawl_plan first)");
    const plan = readPlan(p);
    return { p, plan, files: discoverSources(plan.source, { include: plan.include, exclude: plan.exclude }) };
  };

  const PlanPath = Type.Object({ planPath: Type.Optional(Type.String({ description: "Plan path (defaults to last)" })) });

  return defineExtension({
    name: "wolfpack-crawl",
    runtimes: ["pi-durable"],
    tools: [
      defineTool({
        name: "crawl_start",
        description:
          "Start planning a crawl (ingesting a directory into the KB). Returns the questionnaire to run (the user answers through ask cards) " +
          "and then which crawl_* tools to call; with draft=true (or when no interview is possible) it drafts the plan directly from the arguments.",
        parameters: Type.Object({
          path: Type.Optional(Type.String({ description: "Absolute source directory; omit to have the user choose" })),
          domain: Type.Optional(Type.String({ description: "Pre-filled target KB domain" })),
          strategy: Type.Optional(Type.String({ description: "Pre-filled strategy: by-folder | by-pattern" })),
          depth: Type.Optional(Type.Number({ description: "Pre-filled folder depth" })),
          draft: Type.Optional(Type.Boolean({ description: "Skip the questionnaire and draft the plan deterministically (needs path)" })),
        }),
        async execute(args: { path?: string; domain?: string; strategy?: string; depth?: number; draft?: boolean }) {
          const interview = canInterview({ draftOnly: args.draft === true, hasUI: false, idle: true, askCards });
          if (!interview) {
            if (!args.path) return fail("crawl_start needs `path` when it cannot interview the user (draft mode).");
            try {
              const { plan, summary } = draft({ path: args.path, domain: args.domain, strategy: args.strategy, depth: args.depth });
              return text(`Plan drafted: ${lastPlanPath} (status: draft, ${plan.batches.length} batch(es))\n\n${summary}`);
            } catch (e) {
              return fail(`crawl plan failed: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
          const hints: string[] = [];
          if (args.domain) hints.push(`domain=${args.domain}`);
          if (args.strategy) hints.push(`strategy=${args.strategy}`);
          if (args.depth !== undefined) hints.push(`depth=${args.depth}`);
          const declared = declaredDomains();
          return text(
            buildCrawlDirective({
              src: args.path,
              cwd: process.cwd(),
              domains: declared ? [...declared] : null,
              defaultDomain,
              hints,
              cards: true,
            }),
          );
        },
      }),

      defineTool({
        name: "crawl_plan",
        description: "Draft a crawl plan from a source directory (deterministic; no LLM). Groups files into topic batches and resolves dates. Writes crawl-plan.yaml.",
        parameters: Type.Object({
          path: Type.String({ description: "Absolute source directory to crawl" }),
          domain: Type.Optional(Type.String({ description: "Target KB domain" })),
          strategy: Type.Optional(Type.String({ description: "by-folder | by-pattern" })),
          depth: Type.Optional(Type.Number({ description: "by-folder: cap grouping to N path segments" })),
          include: Type.Optional(Type.Array(Type.String(), { description: "Only crawl files matching these globs (default: everything)" })),
          exclude: Type.Optional(Type.Array(Type.String(), { description: "Skip files matching these globs, on top of the defaults" })),
        }),
        async execute(args: { path: string; domain?: string; strategy?: string; depth?: number; include?: string[]; exclude?: string[] }) {
          if (!isDir(args.path)) return fail(`source is not a directory: ${args.path}`);
          try {
            const { plan, summary } = draft(args);
            return text(`Plan written: ${lastPlanPath} (status: draft)\n\n${summary}`, { details: { planPath: lastPlanPath, batches: plan.batches.length } });
          } catch (e) {
            return fail(`crawl plan failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        },
      }),

      defineTool({
        name: "crawl_preview",
        description: "Summarize a crawl plan (batch count, files, per-batch detail).",
        parameters: PlanPath,
        async execute(args: { planPath?: string }) {
          try {
            const { plan, files } = planFiles(args.planPath);
            return text(renderPlanSummary(plan, files));
          } catch (e) {
            return fail(e instanceof Error ? e.message : String(e));
          }
        },
      }),

      defineTool({
        name: "crawl_validate",
        description: "Run the crawl gate against a plan: status ready, domain declared, every batch resolves, no file in two batches. Returns pass or the failures.",
        parameters: PlanPath,
        async execute(args: { planPath?: string }) {
          try {
            const { plan, files } = planFiles(args.planPath);
            const failures = gatePlan(plan, { files, declared: declaredDomains(), sourceExists: isDir(plan.source) });
            return text(failures.length ? `GATE FAILS:\n  ${failures.join("\n  ")}` : "GATE PASSES — plan is ready to run.");
          } catch (e) {
            return fail(e instanceof Error ? e.message : String(e));
          }
        },
      }),

      defineTool({
        name: "crawl_finalize",
        description:
          "Mark a reviewed plan as ready: run every gate check except status, then write 'status: ready' to the plan document. " +
          "Call ONLY after the user approved the batch summary. Returns the failures if the plan is not sound.",
        parameters: PlanPath,
        async execute(args: { planPath?: string }) {
          try {
            const { p, plan, files } = planFiles(args.planPath);
            const ready = { ...plan, status: "ready" as const };
            const failures = gatePlan(ready, { files, declared: declaredDomains(), sourceExists: isDir(plan.source) });
            if (failures.length) return fail(`CANNOT FINALIZE — fix these first:\n  ${failures.join("\n  ")}`);
            writePlan(p, ready);
            return text(`Plan finalized → status: ready (${ready.batches.length} batch(es)).\n   plan: ${p}\n\nRun it with:  /wolf:crawl-run`);
          } catch (e) {
            return fail(e instanceof Error ? e.message : String(e));
          }
        },
      }),
    ],
  });
}
