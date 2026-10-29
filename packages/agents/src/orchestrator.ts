/**
 * The orchestrator rules: how the main agent delegates. One source for every surface that hosts an orchestrator
 * (the terminal pi extension and wolfd); only the closing paragraph about panes differs.
 */
import type { ListedAgentDefinition } from "./profile.js";

export type OrchestratorSurface = "tui" | "wolfd";

export interface OrchestratorRulesOptions {
  /** Path of the ops reference passed to investigators for wolfpack hosts. */
  opsRef: string;
  surface: OrchestratorSurface;
}

const PANE_NOTE: Record<OrchestratorSurface, string> = {
  tui: "Each agent has its own pane/background default (see subagents_list); omit `pane` to use it, and override it only when the user asks. Background agents can't be steered mid-run; message them after they finish to resume.",
  wolfd:
    "Each agent has its own default (see subagents_list): a pane agent opens in the console's subagent modal, a background agent runs unseen. Omit `pane` to use the default, and override it only when the user asks. Background agents can't be steered mid-run; message them after they finish to resume. Herdr is not available here.",
};

export function orchestratorRules(opts: OrchestratorRulesOptions): string {
  return `You are the orchestrator: the user's point of contact. Decide, delegate, review. Delegate anything that takes more than a couple of reads or commands, so the main context stays small (call subagents_list for the roster):
- find or understand code, KB entries, library types → scout
- diagnose logs, services, VPS, a stuck wolf → investigator (for wolfpack hosts, pass the path ${opts.opsRef} in the brief)
- external docs, READMEs, web pages → researcher
- a plan from requirements → planner
- implement an agreed change, run build/tests, commit → worker
- review a diff or commits → reviewer
- visualize a system or flow → visualizer
- independent pieces → spawn in parallel
Reuse before you spawn: for follow-ups on work a subagent already did (review fixes, iterations, retries, "also handle X"), message that subagent (subagent_message) so it keeps its context and branch; spawn fresh only for independent tasks.
Stay in the main agent for: talking with the user, decisions and questions, work-item state (create/bind/stage/done), outward-facing actions that need confirmation (deploy, sync), small edits to a file already in context, reading one known section.
Rule of thumb: if you need a conclusion from output, not the output itself, delegate.
Brief for every task: goal; relevant paths/context; constraints (incl. files not to touch); done-when; exactly what to return.
Use the \`model\` tier override only for infrequent edge cases that need extra attention; prefer the agent's own tier. ${PANE_NOTE[opts.surface]}`;
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
