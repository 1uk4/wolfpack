/**
 * Crawl planning for durable wolves (pi-durable): the plan tools plus `crawl_start`, which opens the questionnaire.
 *
 * pi starts it with /wolf:crawl (index.ts); a durable wolf has no slash commands, so the model calls `crawl_start`.
 * Whether the plan is gathered by interview is an explicit host capability (`context.capabilities.askCards`, see
 * crawl-interview.ts); without it, or with `draft`, the plan is drafted deterministically. The planning logic itself is
 * shared with pi (crawl-core.ts).
 * While a conversation is planning, the durable observer skips it (crawl-mode.ts); crawl_finalize / crawl_cancel end it.
 * Follow-up: a `crawl_run` tool (running and releasing a plan is still pi-only: /wolf:crawl-run).
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { defineExtension, defineTool, Type, type ExtensionContext, type ToolContext, type ToolResult } from "@wolfpack/harness/extension";
import { readDeclaredDomains } from "@wolfpack/kb/librarian";
import { resolveDefaultDomain } from "@wolfpack/engine";
import { createCrawlCore, crawlPlanTools, type DraftOptions } from "./crawl-core.js";
import { buildCrawlDirective, canInterview } from "./crawl-interview.js";
import { crawlMode } from "./crawl-mode.js";

export interface CrawlConfig {
  defaultDomain?: string;
}

const text = (t: string, extra: Partial<ToolResult> = {}): ToolResult => ({ content: [{ type: "text", text: t }], ...extra });
const fail = (e: unknown, prefix = ""): ToolResult => text(`${prefix}${e instanceof Error ? e.message : String(e)}`, { isError: true });

export default function createCrawlExtension(config: CrawlConfig, context: ExtensionContext): ReturnType<typeof defineExtension> {
  const env = context.env ?? process.env;
  const askCards = context.capabilities?.askCards === true;
  const defaultDomain = resolveDefaultDomain(config.defaultDomain, context.domains);
  const crawlHome = env.WOLFPACK_CRAWL_HOME || join(context.wolfDen, "crawls");

  const declaredDomains = (): Set<string> | null => {
    if (!env.KB_BASE || !env.KB_OPS) return null;
    try {
      return readDeclaredDomains({ kbBase: env.KB_BASE, opsRoot: env.KB_OPS, denLocal: env.KB_DEN_LOCAL ?? join(context.wolfDen, "kb") });
    } catch {
      return null;
    }
  };
  const core = createCrawlCore({ crawlHome, defaultDomain, declaredDomains });
  const docs = crawlPlanTools(Type as never, { scope: true });
  // The afterResponse hook already began planning when it saw the call; this repeats it for direct callers (tests, hosts
  // that run the tool without that hook) and refreshes the idle clock.
  const begin = (ctx: ToolContext) => crawlMode.begin(ctx.wolfDen, ctx.conversationId);

  const draft = (o: DraftOptions) => {
    mkdirSync(crawlHome, { recursive: true });
    return core.draft(o);
  };

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
        async execute(args: { path?: string; domain?: string; strategy?: string; depth?: number; draft?: boolean }, ctx: ToolContext) {
          const interview = canInterview({ draftOnly: args.draft === true, hasUI: false, idle: true, askCards });
          begin(ctx); // the interview and any plan tool calls must never reach the den
          if (!interview) {
            if (!args.path) {
              crawlMode.end(ctx.wolfDen, ctx.conversationId);
              return fail("crawl_start needs `path` when it cannot interview the user (draft mode).");
            }
            try {
              const { plan, planPath } = draft({ path: args.path, domain: args.domain, strategy: args.strategy, depth: args.depth });
              return text(`Plan drafted: ${planPath} (status: draft, ${plan.batches.length} batch(es))\n\n${core.summarize(plan)}`);
            } catch (e) {
              crawlMode.end(ctx.wolfDen, ctx.conversationId); // a failed draft must not leave observation paused
              return fail(e, "crawl plan failed: ");
            }
          }
          const hints: string[] = [];
          if (args.domain) hints.push(`domain=${args.domain}`);
          if (args.strategy) hints.push(`strategy=${args.strategy}`);
          if (args.depth !== undefined) hints.push(`depth=${args.depth}`);
          const declared = declaredDomains();
          return text(
            buildCrawlDirective({ src: args.path, ...(context.workspace ? { cwd: context.workspace } : {}), domains: declared ? [...declared] : null, defaultDomain, hints, cards: true }),
          );
        },
      }),

      defineTool({
        name: "crawl_plan",
        ...docs.plan,
        async execute(args: DraftOptions, ctx: ToolContext) {
          if (!core.isDir(args.path)) return fail(`source is not a directory: ${args.path}`);
          begin(ctx);
          try {
            const { plan, planPath } = draft(args);
            return text(`Plan written: ${planPath} (status: draft)\n\n${core.summarize(plan)}`, { details: { planPath, batches: plan.batches.length } });
          } catch (e) {
            crawlMode.end(ctx.wolfDen, ctx.conversationId);
            return fail(e, "crawl plan failed: ");
          }
        },
      }),

      defineTool({
        name: "crawl_preview",
        ...docs.preview,
        async execute(args: { planPath?: string }) {
          try {
            const { p, plan } = core.load(args.planPath);
            return text(core.summarize(plan), { details: { planPath: p } });
          } catch (e) {
            return fail(e);
          }
        },
      }),

      defineTool({
        name: "crawl_validate",
        ...docs.validate,
        async execute(args: { planPath?: string }) {
          try {
            const r = core.validate(args.planPath);
            return text(r.ok ? "GATE PASSES — plan is ready to run." : `GATE FAILS:\n  ${r.failures.join("\n  ")}`, { details: r });
          } catch (e) {
            return fail(e);
          }
        },
      }),

      defineTool({
        name: "crawl_finalize",
        ...docs.finalize,
        async execute(args: { planPath?: string }, ctx: ToolContext) {
          try {
            const r = core.finalize(args.planPath);
            if (!r.ok) return text(`CANNOT FINALIZE — fix these first:\n  ${r.failures.join("\n  ")}`, { details: r });
            crawlMode.end(ctx.wolfDen, ctx.conversationId);
            return text(
              `Plan finalized → status: ready (${r.batches} batch(es)).\n   plan: ${r.planPath}\n\n` +
                `The plan is ready at that path. Running a crawl from this host is not available yet.`,
              { details: r },
            );
          } catch (e) {
            return fail(e);
          }
        },
      }),

      defineTool({
        name: "crawl_cancel",
        description: "Abandon the crawl planning in this conversation (the user does not want to continue). Resumes normal memory observation.",
        parameters: Type.Object({}),
        async execute(_args: unknown, ctx: ToolContext) {
          crawlMode.end(ctx.wolfDen, ctx.conversationId);
          return text("Crawl planning cancelled; memory observation resumes. Any drafted plan stays on disk.");
        },
      }),
    ],
  });
}
