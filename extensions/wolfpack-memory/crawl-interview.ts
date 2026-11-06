/**
 * The crawl questionnaire, shared by the pi command (/wolf:crawl, index.ts: the wizard asks, no model involved) and
 * the durable crawl_start tool (unified-crawl.ts): who may be interviewed, and the directive the model follows.
 *
 * Pure (no pi / harness imports) so both bundles take it as is.
 */

export interface InterviewGate {
  /** `--draft` / an explicit request for the deterministic plan, no questionnaire. */
  draftOnly: boolean;
  /** pi: the session has a TUI. Says nothing about cards. */
  hasUI: boolean;
  /** pi: the agent is idle (a directive can be sent). */
  idle: boolean;
  /** The host installs the card-raising `brief` tool (ExtensionContext.capabilities.askCards). */
  askCards: boolean;
}

/** May the plan be gathered by interviewing the user? Cards qualify on their own; otherwise it takes an idle TUI. */
export function canInterview(g: InterviewGate): boolean {
  return !g.draftOnly && (g.askCards || (g.hasUI && g.idle));
}

export interface DirectiveInput {
  /** Source directory when the user gave one. */
  src?: string;
  /** The wolf's workspace, offered as the default source; omitted from the card when unknown. */
  cwd?: string;
  /** Declared KB domains, or null/empty when none are known. */
  domains: readonly string[] | null;
  defaultDomain: string;
  /** Pre-filled `key=value` defaults (domain, strategy, depth). */
  hints: readonly string[];
}

/** The directive a durable wolf follows to interview the owner with two `brief` cards, then draft the plan. */
export function buildCrawlDirective({ src, cwd, domains, defaultDomain, hints }: DirectiveInput): string {
  const domainList = domains && domains.length ? domains.join(", ") : `(none declared; default "${defaultDomain}")`;
  const hintLine = hints.length ? `\nThe user pre-filled some defaults (treat as suggested answers, still confirm): ${hints.join(", ")}.` : "";
  const sourceQ = src
    ? `The source directory is \`${src}\` (do not ask for it).`
    : `The user did not specify a source directory: the first card also holds a free question with id "source", ` +
      `asking "Which directory should I crawl?", with the note "Absolute path${cwd ? `; the wolf's workspace is ${cwd}` : ""}."`;
  const planPathNote = src ? `path=\`${src}\`` : `path = the "source" answer`;

  return (
    `Run a short crawl-planning questionnaire with brief cards. ${sourceQ}\n\n` +
    `A brief holds at most 3 questions, so raise TWO brief calls in the same round (the owner answers both together; do ` +
    `not ask one question at a time), skipping any question the user already pinned. Give each a \`headline\`, use the ` +
    `ids below, and put the question text in \`ask\`:\n` +
    `Card 1, headline "Crawl plan: where":\n` +
    (src ? "" : `- id "source": a free question, "Which directory should I crawl?".\n`) +
    `- id "domain": a single question, "Target KB domain". Choices: ${domainList}.\n` +
    `Card 2, headline "Crawl plan: shape":\n` +
    `- id "strategy": a single question, "Grouping strategy". Choices: "by-folder" (Recommended), "by-pattern".\n` +
    `- id "depth": a single question, "Folder depth (how many path segments to group on)". ` +
    `Choices 1, 2, 3; the user can type another number. Give it \`showIf: { field: "strategy", equals: "by-folder" }\` ` +
    `so it is only asked for by-folder (there is then no depth answer for by-pattern).\n` +
    `- id "scope": a single question, "Scope". Choices: "Whole tree" (Recommended), "Only some files"; the user can ` +
    `type include/exclude globs instead (e.g. "include: **/*.md; exclude: drafts/**").\n` +
    `Your turn ends when you raise the cards; the answers arrive as the next message.\n\n` +
    `Then call crawl_plan with ${planPathNote} plus domain, strategy and depth from the answers (omit depth for ` +
    `by-pattern). If the scope answer lists include/exclude globs, pass them as the include / exclude arrays; for ` +
    `"Whole tree" pass neither. If crawl_plan fails (e.g. the path does not exist), say why and raise the cards again. ` +
    `Then call crawl_preview and show the user a clear summary of the resulting batches — one line per batch with ` +
    `its topic and file count, plus the totals (batch count, files matched/skipped).\n\n` +
    `Finally raise a brief with a confirm question (kind "confirm", yesLabel "Looks good — add to plan", ` +
    `noLabel "Edit it"): "Does this plan look good?".\n` +
    `  • If they approve: call crawl_finalize to stamp the plan 'status: ready', then tell them the plan is ready ` +
    `at the path crawl_finalize reports, and that you can run it with crawl_run when they ask (it asks them about ` +
    `resume and concurrency itself and runs in the background; follow it with crawl_status). Do not call crawl_run ` +
    `until they ask.\n` +
    `  • If they reject: raise a card asking what to change (a free-text question, or the same two cards for ` +
    `domain/strategy/depth/scope), re-run crawl_plan + crawl_preview, and ask for approval again. ` +
    `Do NOT run the crawl as part of planning.${hintLine}`
  );
}
