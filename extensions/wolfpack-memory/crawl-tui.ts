/**
 * The pi TUI crawl interview behind /wolf:crawl: the wizard asks for what the command line left out (source, domain,
 * strategy, depth, scope), the plan is drafted, its batch summary is shown, and a confirm either finalizes it
 * (status: ready) or leaves the draft for refinement with the crawl_* tools. No model turn is involved.
 *
 * Kept apart from index.ts so it can be tested with a scripted wizard and the real crawl core.
 */
import type { createCrawlCore } from "./crawl-core.js";
import { wizardSingleChoice, type WizardOption } from "./crawl-wizard.js";

type Core = Pick<ReturnType<typeof createCrawlCore>, "isDir" | "draft" | "summarize" | "finalize">;
export type Ask = (ctx: unknown, title: string, context: string | undefined, options: WizardOption[], allowOther?: boolean) => Promise<string | null>;

export interface InterviewDeps {
  ctx: { ui: { notify(message: string, level: string): void } };
  /** Positional arguments of the command: path, domain, strategy, depth. */
  args: string[];
  cwd: string;
  /** Declared KB domains, or null when none are declared. */
  domains: ReadonlySet<string> | null;
  defaultDomain: string;
  core: Core;
  ask?: Ask;
}

export type InterviewResult =
  | { status: "cancelled" }
  | { status: "bad-path"; path: string }
  | { status: "failed"; message: string }
  | { status: "drafted"; planPath: string; batches: number }
  | { status: "ready"; planPath: string; batches: number };

/**
 * Scope text → globs. Globs are separated by `;` (never `,`, so `{a,b}` survives). `include:` and `exclude:` start a
 * list; bare globs after one join it, e.g. `include: docs/a.md; docs/b.md; exclude: notes`. No key, or "Whole tree" (empty), is no scope.
 */
export function parseScope(text: string | null): { include?: string[]; exclude?: string[] } {
  const lists: Record<"include" | "exclude", string[]> = { include: [], exclude: [] };
  let current: "include" | "exclude" | undefined;
  for (const token of (text ?? "").split(";").map((t) => t.trim())) {
    const m = /^(include|exclude)\s*:\s*(.*)$/i.exec(token);
    if (m) {
      current = m[1].toLowerCase() as "include" | "exclude";
      if (m[2]) lists[current].push(m[2]);
    } else if (current && token) {
      lists[current].push(token);
    }
  }
  return { ...(lists.include.length ? { include: lists.include } : {}), ...(lists.exclude.length ? { exclude: lists.exclude } : {}) };
}

/**
 * Run the interview while observation is paused. `release(keep)` is called exactly once when it ends: keep the pause
 * only for a returned `drafted` result (the user refines the draft with the crawl_* tools, and /wolf:crawl-cancel or
 * running the plan ends it). Any other result, and a throw, release it; the throw still propagates.
 */
export async function withPause(run: () => Promise<InterviewResult>, release: (keepPause: boolean) => void): Promise<InterviewResult> {
  let keep = false;
  try {
    const result = await run();
    keep = result.status === "drafted";
    return result;
  } finally {
    release(keep);
  }
}

export const APPROVE = "approve";
export const EDIT = "edit";

export async function runCrawlInterview(d: InterviewDeps): Promise<InterviewResult> {
  const ask: Ask = d.ask ?? ((ctx, title, context, options, other) => wizardSingleChoice(ctx, title, context, options, other));
  const q = (title: string, context: string | undefined, options: WizardOption[], other = false) => ask(d.ctx, title, context, options, other);
  const notify = (m: string, level = "info") => d.ctx.ui.notify(m, level);
  const cancelled = (): InterviewResult => {
    notify("🐺 crawl questionnaire cancelled.");
    return { status: "cancelled" };
  };

  let [path, domain, strategy, depth] = d.args;

  if (!path) {
    const picked = await q("🐺 Which directory should I crawl?", "Pick the current directory, or choose Other to type a path.", [{ label: `${d.cwd} (current directory)`, value: d.cwd }], true);
    if (picked === null) return cancelled();
    path = picked;
  }
  if (!d.core.isDir(path)) {
    notify(`🐺 source is not a directory: ${path}`, "error");
    return { status: "bad-path", path };
  }
  if (!domain) {
    const choices = d.domains && d.domains.size > 0 ? [...d.domains] : [d.defaultDomain];
    const picked = await q("🐺 Target KB domain", undefined, choices.map((c) => ({ label: c, value: c })));
    if (picked === null) return cancelled();
    domain = picked;
  }
  if (!strategy) {
    const picked = await q("🐺 Grouping strategy", undefined, [
      { label: "by-folder (Recommended)", value: "by-folder" },
      { label: "by-pattern", value: "by-pattern" },
    ]);
    if (picked === null) return cancelled();
    strategy = picked;
  }
  if (strategy === "by-folder" && !depth) {
    const picked = await q("🐺 Folder depth", "How many path segments to group on. Choose Other for a custom number.", [1, 2, 3].map((n) => ({ label: String(n), value: String(n) })), true);
    if (picked === null) return cancelled();
    depth = picked;
  }
  const scopeText = await q(
    "🐺 Scope",
    'Crawl the whole tree, or choose Other and type globs separated by ";", e.g. "include: **/*.md; *.txt; exclude: drafts/**".',
    [{ label: "Whole tree (Recommended)", value: "" }],
    true,
  );
  if (scopeText === null) return cancelled();
  const scope = parseScope(scopeText);

  let depthNumber: number | undefined;
  if (depth) {
    depthNumber = Number(depth);
    if (!Number.isInteger(depthNumber) || depthNumber < 1) {
      notify(`🐺 folder depth "${depth}" is not a whole number of 1 or more; using the default depth.`, "warning");
      depthNumber = undefined;
    }
  }

  let drafted: ReturnType<Core["draft"]>;
  try {
    drafted = d.core.draft({ path, domain, strategy, ...(depthNumber !== undefined ? { depth: depthNumber } : {}), ...scope });
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    notify(`🐺 crawl plan failed: ${message}`, "error");
    return { status: "failed", message };
  }
  const { plan, planPath } = drafted;
  const batches = plan.batches.length;

  const verdict = await q(
    "🐺 Does this plan look good?",
    `${d.core.summarize(plan)}\n\nplan: ${planPath}`,
    [
      { label: "Looks good — add to plan", value: APPROVE },
      { label: "Edit it — keep the draft and refine it with the crawl_* tools", value: EDIT },
    ],
  );
  if (verdict !== APPROVE) {
    notify(`🐺 crawl plan drafted — ${batches} batch(es), left as a draft.\n   plan: ${planPath}\nRefine it with the crawl_* tools, then run /wolf:crawl-run. (cancel with /wolf:crawl-cancel)`);
    return { status: "drafted", planPath, batches };
  }
  const r = d.core.finalize(planPath);
  if (!r.ok) {
    notify(`🐺 cannot finalize — fix these first:\n  ${r.failures.join("\n  ")}\n   plan: ${planPath}`, "error");
    return { status: "drafted", planPath, batches };
  }
  notify(`🐺 plan finalized → status: ready (${r.batches} batch(es)).\n   plan: ${r.planPath}\n\nRun it with:  /wolf:crawl-run`);
  return { status: "ready", planPath: r.planPath, batches: r.batches };
}
