/**
 * Running and releasing a crawl for durable wolves (pi-durable): the console-card port of pi's /wolf:crawl-run and
 * /wolf:crawl-release (index.ts), whose steps come from the TUI wizard (crawl-wizard.ts).
 *
 * Tools (added to the crawl extension by unified-crawl.ts):
 *   crawl_run      start a finalized plan. Without `resume` / `concurrency` it raises the wizard as ONE stepped card:
 *                    step 1  resume / start fresh / cancel   (only when unfinished runs of this plan exist; one run or
 *                            several, pi's two prompts are one field whose options are those runs)
 *                    step 2  concurrency 5..32 or a custom number   (skipped when given; hidden when step 1 says cancel)
 *                  the answers come back as the next message and the model calls crawl_run again with them.
 *   crawl_status   progress of the run(s) in flight, or a crawl's state on disk.
 *   crawl_stop     cooperative cancel (finished batches are kept; crawl_run resumes).
 *   crawl_release  pick a crawl (card, when several qualify) → dry-run review → confirm card with the numbers → emit to
 *                  the librarian's inbox. Gated on a structured "yes" answer to its own confirm card.
 *
 * A crawl is long, so crawl_run never blocks the turn: it starts the run detached, in this process, and returns at once.
 * pi shows progress in a TUI panel; a durable wolf has no such surface and no way to push a message into a thread, so
 * progress is pulled with crawl_status (the in-flight state is a per-process registry; after a restart the run's state on
 * disk — which batches landed — is what crawl_status and crawl_run's resume step read).
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { defineTool, Type, type ExtensionContext, type ToolContext, type ToolResult } from "@wolfpack/harness/extension";
import type { Card } from "@wolfpack/protocol";
import { engineSteps, createEngine, loadModelTable } from "@wolfpack/engine";
import { confirmCard } from "@wolfpack/harness/engine";
import { DEFAULT_CRAWL_CONCURRENCY, emitCrawl, readPlan, runCrawl, type EmitCrawlOptions, type EmitCrawlResult, type RunCrawlOptions, type RunCrawlResult } from "@wolfpack/memory";
import type { CrawlCore } from "./crawl-core.js";
import {
  applyProgress,
  crawlEntityLabel,
  denTopicIdsForPlan,
  findIncompleteRuns,
  findLatestPlan,
  hasFile,
  incompleteRunLabel,
  listCrawls,
  newRunProgress,
  readReleaseState,
  renderProgress,
  agoLabel,
  type IncompleteRun,
  type RunProgress,
} from "./crawl-runs.js";

export const CRAWL_CONCURRENCY_MAX = 32;
const CONCURRENCY_CHOICES = [5, 8, 12, 16, 24, 32];

/** The engine entry points the tools call; tests replace them (a real run needs an LLM, a real release the KB inbox). */
export interface CrawlRunner {
  run(planFile: string, opts: RunCrawlOptions): Promise<RunCrawlResult>;
  emit(runDir: string, opts: EmitCrawlOptions): EmitCrawlResult;
}

const text = (t: string, extra: Partial<ToolResult> = {}): ToolResult => ({ content: [{ type: "text", text: t }], ...extra });
const fail = (t: string): ToolResult => text(t, { isError: true });

type RunState = "running" | "done" | "failed" | "gate-failed" | "cancelled";
interface ActiveRun {
  /** Unique from the moment the slot is reserved; the real run dir replaces it once the engine reports it. */
  runDir: string;
  planFile: string;
  source: string;
  domain: string;
  state: RunState;
  progress: RunProgress;
  controller: AbortController;
  concurrency: number;
  resumed: boolean;
  error?: string;
  failures?: string[];
  finishedAt?: number;
}
/** Finished runs kept for crawl_status; older ones are pruned (the run dir on disk is the record). */
const KEEP_FINISHED = 5;

export interface CrawlRunToolsInput {
  core: CrawlCore;
  context: ExtensionContext;
  env: NodeJS.ProcessEnv;
  crawlHome: string;
  askCards: boolean;
  declaredDomains: () => Set<string> | null;
  /** Override the engine entry points (tests). */
  runner?: Partial<CrawlRunner>;
  /** Called when a run is accepted: the planning window (if any) is over. */
  onRunStart?: (ctx: ToolContext) => void;
}

export function createCrawlRunTools(i: CrawlRunToolsInput): { tools: ReturnType<typeof defineTool>[]; stop: () => void } {
  const { core, context, env, crawlHome, askCards } = i;
  /** Runs started by THIS extension instance (the per-process registry); gone after a restart. */
  const live = new Set<ActiveRun>();
  let slots = 0;
  const prune = () => {
    const done = [...live].filter((r) => r.state !== "running").sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
    for (const r of done.slice(0, Math.max(0, done.length - KEEP_FINISHED))) live.delete(r);
  };
  /** Teardown: abort what is in flight and forget everything. */
  const stop = () => {
    for (const r of live) if (r.state === "running") r.controller.abort();
    live.clear();
  };
  const bases = [crawlHome];
  const opsRoot = env.KB_OPS || undefined;
  const lane = (wolf: string) => ({ opsRoot, wolf });

  const envConcurrency = (): number => {
    const raw = Number(env.WOLFPACK_CRAWL_CONCURRENCY);
    return Number.isFinite(raw) && raw >= 1 ? Math.min(Math.floor(raw), CRAWL_CONCURRENCY_MAX) : DEFAULT_CRAWL_CONCURRENCY;
  };

  /** The wolf's resolved models (as the memory observer does), not the daemon's process env. */
  const defaultRunner: CrawlRunner = {
    run(planFile, opts) {
      const table = context.modelTable ?? loadModelTable({ env }).table;
      const provider = table.tiers.smart.provider;
      const apiKey = provider === "anthropic" ? env.ANTHROPIC_API_KEY : undefined;
      if (provider === "anthropic" && !apiKey) throw new Error("ANTHROPIC_API_KEY required to run a crawl (this wolf's transport is api).");
      const steps = engineSteps(table);
      const engine = createEngine({ provider, ...(apiKey ? { apiKey } : {}), defaultModel: table.tiers.smart.model, steps });
      return runCrawl(planFile, { ...opts, engine: { engine, fastModel: steps.classify.model, smartModel: steps.consolidate.model } });
    },
    emit: (runDir, opts) => emitCrawl(runDir, opts),
  };
  const runner: CrawlRunner = { ...defaultRunner, ...i.runner };

  /** Cards are only for a conversation someone reads: not a task-owned one (a subagent). */
  async function canAsk(ctx: ToolContext): Promise<boolean> {
    if (!askCards || !ctx.conversation?.latestCard) return false;
    return (await ctx.conversation.classify())?.kind !== "task";
  }

  /** The newest card of `tool` with this exact title that is still waiting (one pending card per question; no duplicates). */
  async function pendingCard(ctx: ToolContext, tool: string, title: string): Promise<boolean> {
    const found = await ctx.conversation?.latestCard?.(tool, (c) => c.title === title);
    return found?.status === "pending";
  }
  const waiting = (what: string): ToolResult => text(`The ${what} card is already waiting for the user's answer. Your turn ends here; their answer arrives with your next message.`, { endTurn: true });

  // ── crawl_run ────────────────────────────────────────────────────────────

  /** pi's wizard steps as one stepped card. */
  function wizardCard(planName: string, outstanding: IncompleteRun[], askResume: boolean, askConcurrency: boolean): Card {
    const fields: Card["fields"] = [];
    const steps: NonNullable<Card["steps"]> = [];
    const resumeValues: string[] = [];
    if (askResume) {
      const one = outstanding.length === 1;
      const r = outstanding[0];
      const options = [
        ...outstanding.map((o) => ({
          label: one ? (o.missing.length ? `Resume — finish the ${o.missing.length} remaining batch(es)` : "Resume — finish the journey") : incompleteRunLabel(o),
          value: o.runDir,
          ...(one ? { description: incompleteRunLabel(o) } : {}),
        })),
        { label: "Start fresh — new run from the full plan", value: "fresh" },
        { label: "Cancel", value: "cancel" },
      ];
      resumeValues.push(...outstanding.map((o) => o.runDir), "fresh");
      fields.push({
        id: "resume",
        kind: "single",
        label: one ? "Resume the outstanding crawl?" : `${outstanding.length} outstanding runs — pick one to resume`,
        description: one
          ? `Found an unfinished run in ${r.runDir}: ${r.done}/${r.total} batches done${r.missing.length ? `, ${r.missing.length} remaining` : ", journey not written"}${r.journeyWritten && r.missing.length ? " (completed with errors)" : ""} · domain ${r.domain}.`
          : "Each had errored or unfinished batches. Choose which to continue, or start a fresh run instead.",
        options,
        allowOther: false,
        default: options[0].value,
      });
      steps.push({ title: "Resume", fields: ["resume"] });
    }
    if (askConcurrency) {
      const def = envConcurrency();
      fields.push({
        id: "concurrency",
        kind: "single",
        label: "How many batches to run at once?",
        description: `More = faster, but bounded by your Anthropic rate limit (max ${CRAWL_CONCURRENCY_MAX}). Type another number under Other.`,
        options: CONCURRENCY_CHOICES.map((n) => ({ label: n === def ? `${n} (default)` : `${n}`, value: String(n) })),
        allowOther: true,
        ...(CONCURRENCY_CHOICES.includes(def) ? { default: String(def) } : {}),
        // Cancelling skips this question: it is neither shown nor required.
        ...(askResume ? { showIf: { field: "resume", oneOf: resumeValues } } : {}),
      });
      steps.push({ title: "Concurrency", fields: ["concurrency"] });
    }
    return { tool: "crawl_run", title: `Run crawl — ${planName}`, fields, ...(steps.length > 1 ? { steps } : {}) };
  }

  const parseConcurrency = (v: number | string | undefined): number | undefined => {
    if (v === undefined) return undefined;
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n >= 1 ? Math.min(n, CRAWL_CONCURRENCY_MAX) : undefined;
  };

  const runTool = defineTool({
    name: "crawl_run",
    description:
      "Run a finalized crawl plan in the background (extract → consolidate → journey; costs model tokens). Call it only when the user asked to run the crawl. " +
      "Without `resume` / `concurrency` it asks the user (one stepped card: resume or start fresh when unfinished runs of this plan exist, then how many batches at once) " +
      "and ends your turn; call it again with their answers (resume = the run directory they picked or \"fresh\"; if they chose Cancel, stop). " +
      "Returns at once; follow progress with crawl_status, stop with crawl_stop, and release the result with crawl_release.",
    parameters: Type.Object({
      planPath: Type.Optional(Type.String({ description: "Plan path (defaults to the last plan, else the newest on disk)" })),
      concurrency: Type.Optional(Type.Number({ description: `Batches at once, 1..${CRAWL_CONCURRENCY_MAX}. Omit to have the user choose.` })),
      resume: Type.Optional(Type.String({ description: 'An outstanding run directory to resume, or "fresh" for a new run. Omit to have the user choose when runs are outstanding.' })),
    }),
    raisesCard: true,
    async execute(args: { planPath?: string; concurrency?: number | string; resume?: string }, ctx: ToolContext) {
      const planPath = args.planPath ?? core.state.lastPlanPath ?? findLatestPlan(bases);
      if (!planPath) return fail("No plan to run: plan a crawl first (crawl_start), or pass planPath.");
      let plan: ReturnType<typeof readPlan>;
      try {
        plan = readPlan(planPath);
      } catch (e) {
        return fail(`Cannot read the plan ${planPath}: ${e instanceof Error ? e.message : String(e)}`);
      }
      const gate = core.validate(planPath);
      if (!gate.ok) return fail(`The plan is not ready to run (gate fails):\n  ${gate.failures.join("\n  ")}\nFinalize it with crawl_finalize first.`);

      const running = new Set([...live].filter((r) => r.state === "running").map((r) => r.runDir));
      const outstanding = findIncompleteRuns(plan, bases).filter((r) => !running.has(r.runDir));

      const concurrencyGiven = args.concurrency !== undefined && parseConcurrency(args.concurrency) !== undefined;
      if (args.concurrency !== undefined && !concurrencyGiven) return fail(`concurrency must be a number between 1 and ${CRAWL_CONCURRENCY_MAX}.`);
      const askResume = outstanding.length > 0 && args.resume === undefined;
      const askConcurrency = !concurrencyGiven;
      if ((askResume || askConcurrency) && (await canAsk(ctx))) {
        const card = wizardCard(basename(dirname(planPath)), outstanding, askResume, askConcurrency);
        if (await pendingCard(ctx, "crawl_run", card.title!)) return waiting("run options");
        return text("Run options sent to the user as a card. Your turn ends here; their answer arrives with your next message — then call crawl_run again with it.", { card });
      }

      let resumeRun: IncompleteRun | undefined;
      if (args.resume !== undefined && args.resume !== "fresh") {
        resumeRun = outstanding.find((r) => r.runDir === args.resume);
        if (!resumeRun) return fail(`resume must be "fresh" or one of the outstanding runs:\n${outstanding.map((r) => `  ${r.runDir}`).join("\n") || "  (none)"}`);
      }
      const concurrency = parseConcurrency(args.concurrency) ?? envConcurrency();
      // Nothing was asked (no cards here) yet unfinished runs exist: say that this started fresh, and why.
      const startedFreshNote =
        !resumeRun && args.resume === undefined && outstanding.length > 0
          ? `\nNote: ${outstanding.length} unfinished run(s) of this plan exist (e.g. ${outstanding[0].runDir}), but this host cannot ask the user, so this started a FRESH run. To resume one instead, stop it with crawl_stop and call crawl_run with resume set to that run directory.`
          : "";

      // From here to the reservation there is no await: two overlapping calls cannot both start a run of this plan.
      const clash = [...live].find((r) => r.state === "running" && r.source === plan.source && r.domain === plan.domain);
      if (clash) return text(`A run of this plan is already in progress: ${clash.runDir}. Use crawl_status to follow it.`);
      const progress = newRunProgress();
      const controller = new AbortController();
      const run: ActiveRun = {
        runDir: resumeRun?.runDir ?? `pending-${++slots}`,
        planFile: planPath,
        source: plan.source,
        domain: plan.domain,
        state: "running",
        progress,
        controller,
        concurrency,
        resumed: !!resumeRun,
      };
      live.add(run);
      i.onRunStart?.(ctx);
      let pending: Promise<RunCrawlResult>;
      try {
        pending = runner.run(resumeRun ? join(resumeRun.runDir, "plan.yaml") : planPath, {
          declared: i.declaredDomains(),
          concurrency,
          sinkBase: crawlHome,
          signal: controller.signal,
          ...(resumeRun ? { only: resumeRun.missing, runDir: resumeRun.runDir } : {}),
          // Always explicit: a wolf without a KB must not fall back to the daemon's own KB_BASE.
          kbBase: env.KB_BASE ?? "",
          onSink: (d) => {
            run.runDir = d;
          },
          onProgress: (p) => applyProgress(progress, p),
        });
      } catch (e) {
        live.delete(run);
        return fail(`crawl run failed to start: ${e instanceof Error ? e.message : String(e)}`);
      }
      pending.then(
        (res) => {
          run.finishedAt = Date.now();
          if (res.dir) run.runDir = res.dir;
          if (res.cancelled) run.state = "cancelled";
          else if (res.ok) run.state = "done";
          else {
            run.state = "gate-failed";
            run.failures = res.failures ?? [];
          }
          prune();
        },
        (e) => {
          run.finishedAt = Date.now();
          run.state = "failed";
          run.error = e instanceof Error ? e.message : String(e);
          prune();
        },
      );
      return text(
        `Crawl ${resumeRun ? "resumed" : "started"} in the background → ${run.runDir.startsWith("pending-") ? crawlHome : run.runDir}\n` +
          `  ${resumeRun ? `${resumeRun.missing.length} remaining batch(es)` : `${plan.batches.length} batch(es)`}, up to ${concurrency} at once.\n` +
          `It will take a while: tell the user it is running and do not wait for it. Follow progress with crawl_status, stop it with crawl_stop; ` +
          `when it completes, crawl_release hands the result to the librarian (after the user confirms).${startedFreshNote}`,
        { details: { runDir: run.runDir, concurrency, resumed: !!resumeRun } },
      );
    },
  });

  // ── crawl_status / crawl_stop ────────────────────────────────────────────

  const stateLine = (r: ActiveRun): string => {
    const where = `${basename(r.runDir)} (${r.resumed ? "resumed, " : ""}${r.concurrency} at once)`;
    switch (r.state) {
      case "running":
        return `RUNNING ${where}${r.controller.signal.aborted ? " — stopping" : ""}`;
      case "done":
        return `COMPLETE ${where} — ready to review and release (crawl_release)`;
      case "cancelled":
        return `CANCELLED ${where} — finished batches were kept; resume with crawl_run`;
      case "gate-failed":
        return `REFUSED ${where} (gate):\n  ${(r.failures ?? []).join("\n  ")}`;
      case "failed":
        return `FAILED ${where}: ${r.error}`;
    }
  };

  const statusTool = defineTool({
    name: "crawl_status",
    description: "Progress of the crawl run(s) started by THIS process since it started (batches finished, failures, tokens; only the last few finished runs are kept) and the state of crawls on disk. After a restart only the disk state remains. Pass runDir for one run.",
    parameters: Type.Object({ runDir: Type.Optional(Type.String({ description: "A run directory (defaults to every run in flight and the recent crawls on disk)" })) }),
    async execute(args: { runDir?: string }, ctx: ToolContext) {
      const all = [...live];
      const pick = args.runDir ? all.filter((r) => r.runDir === args.runDir) : all;
      const out: string[] = [];
      for (const r of pick) out.push(`${stateLine(r)}\n${renderProgress(r.progress)}`);
      const disk = listCrawls(bases, lane(ctx.wolfName)).filter((e) => !args.runDir || e.dir === args.runDir);
      if (args.runDir && pick.length === 0 && disk.length === 0) return fail(`No crawl at ${args.runDir}.`);
      if (disk.length > 0) {
        out.push(`On disk (${Math.min(disk.length, 10)} of ${disk.length}, newest first):`);
        for (const e of disk.slice(0, 10)) out.push(`  [${e.status}] ${e.domain} · ${e.topics || e.files} ${e.topics ? "topics" : "files"} · ${agoLabel(e.createdAt)}\n      ${e.dir}`);
      }
      return text(out.length ? out.join("\n\n") : `No crawls yet under ${crawlHome}.`);
    },
  });

  const stopTool = defineTool({
    name: "crawl_stop",
    description: "Stop a crawl run started by THIS process (it cannot see runs from before a restart): in-flight batches finish, nothing new starts; finished batches are kept and crawl_run can resume it.",
    parameters: Type.Object({ runDir: Type.Optional(Type.String({ description: "The run to stop (defaults to the only one running)" })) }),
    async execute(args: { runDir?: string }, ctx: ToolContext) {
      const running = [...live].filter((r) => r.state === "running" && (!args.runDir || r.runDir === args.runDir));
      if (running.length === 0) return fail("No crawl run is in progress here.");
      if (running.length > 1) return fail(`Several runs are in progress; pass runDir:\n${running.map((r) => `  ${r.runDir}`).join("\n")}`);
      running[0].controller.abort();
      return text(`Stopping ${running[0].runDir}: in-flight batches finish first. Check crawl_status; resume later with crawl_run.`);
    },
  });

  // ── crawl_release ────────────────────────────────────────────────────────

  /** The card label binds a yes to the numbers the user saw: a changed dry run (different digest) needs a fresh yes. */
  const releaseLabel = (runDir: string, digest: string) => `Release crawl ${basename(runDir)} to the librarian? (${digest})`;
  /** First line of a successful release result (the spent-yes check reads it back; the colon ends the run name). */
const releasedLine = (runDir: string) => `Released crawl ${basename(runDir)}:`;
  const firstLine = (m: { message: { content?: unknown } }): string => {
    const c = m.message.content;
    const block = Array.isArray(c) ? (c as { type?: string; text?: string }[]).find((x) => x?.type === "text" && typeof x.text === "string") : undefined;
    return (typeof c === "string" ? c : (block?.text ?? "")).split("\n")[0];
  };

  const releaseTool = defineTool({
    name: "crawl_release",
    description:
      "Review a finished crawl and release it to the librarian (a SHARED, one-way handoff into the KB inbox). Without `runDir` it asks which crawl when several qualify. " +
      "It then shows what would be released and asks the user to confirm on a card (ends your turn); call it again after they say yes and it releases. " +
      "Where the user cannot be asked on a card it only shows the preview and never releases.",
    parameters: Type.Object({
      runDir: Type.Optional(Type.String({ description: "The crawl run directory (from crawl_status)" })),
    }),
    raisesCard: true,
    async execute(args: { runDir?: string }, ctx: ToolContext) {
      const asks = await canAsk(ctx);
      let runDir = args.runDir;
      if (!runDir) {
        const all = listCrawls(bases, lane(ctx.wolfName)).filter((e) => e.status === "complete" || e.status === "released" || e.status === "curated");
        if (all.length === 0) return fail("No completed crawl to release; run one with crawl_run first.");
        if (all.length === 1) runDir = all[0].dir;
        else {
          if (!asks) return text(`Several crawls can be released; ask the user which and call crawl_release with runDir:\n${all.map((e) => `  ${e.dir} — ${crawlEntityLabel(e)}`).join("\n")}`);
          const card: Card = {
            tool: "crawl_release",
            title: "Release which crawl?",
            fields: [
              {
                id: "run",
                kind: "single",
                label: "Pick a crawl — newest first.",
                options: all.map((e) => ({ label: crawlEntityLabel(e), value: e.dir })),
                allowOther: false,
              },
            ],
          };
          if (await pendingCard(ctx, "crawl_release", card.title!)) return waiting("crawl choice");
          return text("Crawl choice sent to the user as a card. Your turn ends here; call crawl_release again with the run they pick.", { card });
        }
      }
      const dir = resolve(runDir);
      if (!dir.startsWith(resolve(crawlHome) + sep) || !hasFile(dir, "plan.yaml")) return fail(`${runDir} is not a crawl run under ${crawlHome}.`);

      let plan: ReturnType<typeof readPlan>;
      try {
        plan = readPlan(join(dir, "plan.yaml"));
      } catch (e) {
        return fail(`Cannot read the run's plan: ${e instanceof Error ? e.message : String(e)}`);
      }
      const roots = { ...(opsRoot ? { opsRoot } : {}), ...(env.KB_BASE ? { kbBase: env.KB_BASE } : {}), denLocal: join(ctx.wolfDen, "kb") };
      let preview: EmitCrawlResult;
      try {
        preview = runner.emit(dir, { dryRun: true, wolf: ctx.wolfName, sinkBase: crawlHome, quiet: true, roots });
      } catch (e) {
        return fail(`Could not build the release preview: ${e instanceof Error ? e.message : String(e)}`);
      }
      const items = preview.contributions;
      if (items.length === 0) return text(`Nothing to release from ${dir}.`);
      const toEmit = items.filter((c) => c.status === "emit").length;
      const unchanged = items.length - toEmit;
      const release = readReleaseState(dir, opsRoot, ctx.wolfName, denTopicIdsForPlan(plan));
      const curatedNow = items.filter((c) => release.curated.has(c.denTopicId)).length;
      const already =
        release.releasedAt || curatedNow
          ? `Already released ${release.releasedAt ? agoLabel(release.releasedAt) : ""}${curatedNow ? ` · ${curatedNow} already curated by Dewey` : ""}. Re-releasing is idempotent (unchanged are skipped).`
          : "";
      const list = items.map((c) => `- ${c.kind === "history" ? "history" : c.topic} — ${c.title} (${c.bodyChars} chars, ${c.status === "emit" ? "new/changed" : "unchanged"})`).join("\n");
      const review = `${items.length} contribution(s) from ${dir} (domain ${plan.domain}):\n${list}`;

      const journeyMissing = !hasFile(dir, "history.json");
      if (!opsRoot) return text(`${review}\n\nThe KB is not configured here (no KB_OPS), so this cannot be released.`, { isError: true });
      if (journeyMissing) return text(`${review}\n\nThe run's journey is not written yet — finish it with crawl_run (resume) before releasing.`, { isError: true });

      // No card, no release: without a user who can confirm in the console (a task-owned conversation, or a host without
      // cards) this only previews. There is deliberately no model-supplied way around that.
      if (!asks) {
        return text(`${review}\n\n${toEmit} would be released (${unchanged} unchanged). NOT released: a release is a SHARED, one-way handoff to the librarian and needs the user's confirmation in the console, which is not available here. Ask the user to run crawl_release from a console conversation.`);
      }

      // The gate: a structured yes on this crawl's own confirm card (not model text), bound to this dry run's numbers
      // by the digest in the label, and spent once a release followed it.
      const digest = createHash("sha1").update(items.map((c) => `${c.denTopicId}:${c.status}:${c.bodyChars}`).join("|")).digest("hex").slice(0, 8);
      const label = releaseLabel(dir, digest);
      const found = await ctx.conversation!.latestCard!("crawl_release", (c) => c.fields.length === 1 && c.fields[0].label === label);
      if (found?.status === "pending") return waiting("release confirmation");
      const yes = found?.status === "answered" && (found.answers?.confirm as { value?: unknown } | undefined)?.value === true;
      const spent = found?.laterResults.some((m) => firstLine(m).startsWith(releasedLine(dir))) ?? false;
      if (!(yes && !spent)) {
        const card = confirmCard({
          tool: "crawl_release",
          title: "Release to the librarian?",
          question: label,
          description:
            `${already ? `${already}\n\n` : ""}**${toEmit}** contribution(s) in "${plan.domain}" → inbox lane "${ctx.wolfName}" → Dewey` +
            `${unchanged ? ` (${unchanged} unchanged will be skipped)` : ""}.\n\n${list}\n\n` +
            `This is a SHARED, one-way handoff: Dewey's sweep will route, guard, and curate them into the KB.`,
          confirmLabel: "Release",
          rejectLabel: "Not now",
        });
        return text(`${review}\n\nConfirmation sent to the user as a card. Your turn ends here; if they say yes, call crawl_release again with the same runDir.`, { card });
      }

      try {
        const r = runner.emit(dir, { dryRun: false, wolf: ctx.wolfName, sinkBase: crawlHome, quiet: true, roots });
        try {
          writeFileSync(join(dir, "emitted.json"), JSON.stringify({ at: Date.now(), emitted: r.emitted, dest: r.dest }, null, 2));
        } catch {
          /* non-fatal */
        }
        return text(`${releasedLine(dir)} ${r.emitted} contribution(s)${r.skipped ? ` (${r.skipped} unchanged)` : ""} → ${r.dest}\nDewey's sweep will route + curate them.`, { details: { emitted: r.emitted, skipped: r.skipped, dest: r.dest } });
      } catch (e) {
        return fail(`Release failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  });

  return { tools: [runTool, statusTool, stopTool, releaseTool], stop };
}
