/**
 * The `KEY=value …` prefix a subagent child's launch command starts with (spawn and resume build it the same way).
 * Every child is an agent, so it carries WOLFPACK_AGENT_RUN=1: `wolfpack test` queues agent runs.
 */
import { shellEscape } from "./mux/index.ts";

export interface SubagentEnv {
  name: string;
  session: string;
  id: string;
  activityFile: string;
  agent?: string | null;
  agentDir?: string | null;
  /** The agents this child may spawn; undefined = no PI_SUBAGENT_ALLOWED. */
  allowed?: string[];
  surface?: string;
  autoExit?: boolean;
}

export function subagentEnvPrefix(e: SubagentEnv): string {
  const parts: string[] = [];
  if (e.agentDir) parts.push(`PI_CODING_AGENT_DIR=${shellEscape(e.agentDir)}`);
  if (e.allowed) parts.push(`PI_SUBAGENT_ALLOWED=${shellEscape(e.allowed.join(","))}`);
  parts.push("WOLFPACK_AGENT_RUN=1");
  parts.push(`PI_SUBAGENT_NAME=${shellEscape(e.name)}`);
  if (e.agent) parts.push(`PI_SUBAGENT_AGENT=${shellEscape(e.agent)}`);
  if (e.autoExit) parts.push("PI_SUBAGENT_AUTO_EXIT=1");
  parts.push(`PI_SUBAGENT_SESSION=${shellEscape(e.session)}`);
  parts.push(`PI_SUBAGENT_ID=${shellEscape(e.id)}`);
  parts.push(`PI_SUBAGENT_ACTIVITY_FILE=${shellEscape(e.activityFile)}`);
  if (e.surface !== undefined) parts.push(`PI_SUBAGENT_SURFACE=${shellEscape(e.surface)}`);
  return parts.join(" ") + " ";
}
