/**
 * The orchestrator rules: how the main agent delegates. One source for every surface that hosts an orchestrator
 * (the terminal pi extension and wolfd); only the closing paragraph about panes differs.
 */
import type { ListedAgentDefinition } from "./profile.js";
import { resolvePrompt } from "./prompts.js";

export type OrchestratorSurface = "tui" | "wolfd";

export interface OrchestratorRulesOptions {
  /** Path of the ops reference passed to investigators for wolfpack hosts. */
  opsRef: string;
  surface: OrchestratorSurface;
  /** The wolf's home: its `agent/prompts/orchestrator-rules.md` override wins over the repo default. Unset: the default. */
  wolfHome?: string;
}

const PANE_NOTE: Record<OrchestratorSurface, string> = {
  tui: "Each agent has its own pane/background default (see subagents_list); omit `pane` to use it, and override it only when the user asks. Background agents can't be steered mid-run; message them after they finish to resume.",
  wolfd:
    "Each agent has its own default (see subagents_list): a pane agent opens in the console's subagent modal, a background agent runs unseen. Omit `pane` to use the default, and override it only when the user asks. Background agents can't be steered mid-run; message them after they finish to resume. Herdr is not available here.",
};

export function orchestratorRules(opts: OrchestratorRulesOptions): string {
  // Placeholders are filled by function replacers so `$` in an override is never read as a replacement pattern.
  return resolvePrompt("orchestrator-rules", opts.wolfHome)
    .text.replace("{{opsRef}}", () => opts.opsRef)
    .replace("{{paneNote}}", () => PANE_NOTE[opts.surface]);
}

/** One line per roster agent, as `subagents_list` prints it. */
export function formatRosterLines(agents: readonly ListedAgentDefinition[]): string[] {
  return agents
    .filter((a) => !a.disableModelInvocation)
    .map((a) => {
      const badge = a.source === "project" ? " (project)" : "";
      const desc = a.description ? ` — ${a.description}` : "";
      const model = a.model ? `${a.model}, ` : "";
      return `• ${a.name}${badge} [${model}${a.pane ? "pane" : "background"}]${desc}`;
    });
}
