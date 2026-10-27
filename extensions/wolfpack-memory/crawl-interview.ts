/**
 * The crawl questionnaire, shared by the pi command (/wolf:crawl, index.ts) and the durable crawl_start tool
 * (unified-crawl.ts): who may be interviewed, and the directive the model follows.
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
  /** The host installs the card-raising ask_user_question (ExtensionContext.capabilities.askCards). */
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
  /** Ask through batched cards (wolfd) instead of one TUI question per call. */
  cards: boolean;
}

export function buildCrawlDirective(i: DirectiveInput): string {
  const domainList = i.domains && i.domains.length ? i.domains.join(", ") : `(none declared; default "${i.defaultDomain}")`;
  const hintLine = i.hints.length ? `\nThe user pre-filled some defaults (treat as suggested answers, still confirm): ${i.hints.join(", ")}.` : "";
  return i.cards ? cardsDirective(i, domainList, hintLine) : tuiDirective(i, domainList, hintLine);
}

function tuiDirective({ src, cwd }: DirectiveInput, domainList: string, hintLine: string): string {
  const srcLine = src
    ? `The source directory is \`${src}\`.`
    : `The user did not specify a source directory. Make question 0 ` +
      `"Which directory should I crawl?" a single-select whose first option is ` +
      `the current working directory, labelled "${cwd} (Recommended)"; the user ` +
      `can pick "Other" to type a different path. Confirm the chosen path exists ` +
      `before continuing.`;
  const planPathNote = src ? `path=\`${src}\`` : `path set to the directory from question 0`;

  return (
    `Run a short crawl-planning questionnaire. ${srcLine}\n\n` +
    `Use the ask_user_question tool to gather the plan parameters. Ask exactly ONE ` +
    `question per tool call, in this order, skipping any the user already pinned:\n` +
    `1. Target KB domain. Offer options: ${domainList}.\n` +
    `2. Grouping strategy — options: "by-folder" (Recommended), "by-pattern".\n` +
    `3. If by-folder: folder depth (how many path segments to group on) — ` +
    `offer 1, 2, 3; let them pick "Other" for a custom number.\n` +
    `4. Scope confirmation: anything to include/exclude, or crawl the whole tree.\n\n` +
    `Then call crawl_plan with ${planPathNote} plus the chosen domain/strategy/depth, ` +
    `and call crawl_preview. Show the user a clear summary of the resulting batches — ` +
    `one line per batch with its topic and file count, plus the totals (batch count, ` +
    `files matched/skipped).\n\n` +
    `Finally, use ask_user_question to ask "Does this plan look good?" with options ` +
    `"Looks good — add to plan" (Recommended) and "Edit it".\n` +
    `  • If they approve: call crawl_finalize to stamp the plan 'status: ready', then ` +
    `tell them to run /wolf:crawl-run.\n` +
    `  • If they want to edit: ask what to change, adjust (re-ask a question or change ` +
    `domain/strategy/depth/scope), re-run crawl_plan + crawl_preview, and ask for ` +
    `approval again. Do NOT run the crawl yourself.${hintLine}`
  );
}

function cardsDirective({ src, cwd }: DirectiveInput, domainList: string, hintLine: string): string {
  const sourceQ = src
    ? `The source directory is \`${src}\` (do not ask for it).`
    : `The user did not specify a source directory: include a free-text question with id "source", ` +
      `"Which directory should I crawl?", details "Absolute path${cwd ? `; the wolf's workspace is ${cwd}` : ""}."`;
  const planPathNote = src ? `path=\`${src}\`` : `path = the "source" answer`;

  return (
    `Run a short crawl-planning questionnaire with ask cards. ${sourceQ}\n\n` +
    `Raise ONE ask_user_question call whose \`questions\` list holds all of these (they are shown as a single ` +
    `card and answered together; do not ask them one at a time), skipping any the user already pinned. Present it as a ` +
    `stepped card with \`steps\`: step "Where" = ${src ? "domain" : "source, domain"}; step "Shape" = strategy, depth, scope ` +
    `(use the ids below; every question on exactly one step):\n` +
    `- id "domain": single choice, "Target KB domain". Options: ${domainList}.\n` +
    `- id "strategy": single choice, "Grouping strategy". Options: "by-folder" (Recommended), "by-pattern".\n` +
    `- id "depth": single choice, "Folder depth (how many path segments to group on)". ` +
    `Options 1, 2, 3; the user can type another number. Give it \`showIf: { field: "strategy", equals: "by-folder" }\` ` +
    `so it is only asked for by-folder (there is then no depth answer for by-pattern).\n` +
    `- id "scope": single choice, "Scope". Options: "Whole tree" (Recommended), "Only some files"; the user can ` +
    `type include/exclude globs instead (e.g. "include: **/*.md; exclude: drafts/**").\n` +
    `Your turn ends when you raise the card; the answers arrive as the next message.\n\n` +
    `Then call crawl_plan with ${planPathNote} plus domain, strategy and depth from the answers (omit depth for ` +
    `by-pattern). If the scope answer lists include/exclude globs, pass them as the include / exclude arrays; for ` +
    `"Whole tree" pass neither. If crawl_plan fails (e.g. the path does not exist), say why and raise the card again. ` +
    `Then call crawl_preview and show the user a clear summary of the resulting batches — one line per batch with ` +
    `its topic and file count, plus the totals (batch count, files matched/skipped).\n\n` +
    `Finally raise an ask_user_question confirm question (kind "confirm", confirmLabel "Looks good — add to plan", ` +
    `rejectLabel "Edit it"): "Does this plan look good?".\n` +
    `  • If they approve: call crawl_finalize to stamp the plan 'status: ready', then tell them the plan is ready ` +
    `at the path crawl_finalize reports, and that you can run it with crawl_run when they ask (it asks them about ` +
    `resume and concurrency itself and runs in the background; follow it with crawl_status). Do not call crawl_run ` +
    `until they ask.\n` +
    `  • If they reject: raise a card asking what to change (a free-text question, or the same \`questions\` batch for ` +
    `domain/strategy/depth/scope), re-run crawl_plan + crawl_preview, and ask for approval again. ` +
    `Do NOT run the crawl as part of planning.${hintLine}`
  );
}
