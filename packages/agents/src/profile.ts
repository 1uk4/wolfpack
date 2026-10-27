/**
 * Agent profiles: markdown with frontmatter (`agents/*.md`), shared by the terminal subagents extension and wolfd.
 * One parser, so both runtimes read the same files the same way.
 */

export type SubagentSessionMode = "standalone" | "lineage-only" | "fork";
export type AgentSource = "package" | "global" | "project";
export type AgentIsolation = "worktree" | "none";

export interface AgentDefaults {
  /** Model tier (main | smart | fast); resolved through the model table at spawn. */
  model?: string;
  tools?: string;
  skills?: string;
  /**
   * If set (non-empty), this agent is granted the full subagent spawning
   * toolset and may only spawn the listed agents. Presence of this field —
   * not the `tools` list — is what grants spawning. Enforced in the child via
   * the PI_SUBAGENT_ALLOWED env var.
   */
  subagentAgents?: string[];
  autoExit?: boolean;
  interactive?: boolean;
  /** Run in a multiplexer pane (true) or as a background process (false/absent). On wolfd: open the child panel in the console. */
  pane?: boolean;
  systemPromptMode?: "append" | "replace";
  sessionMode?: SubagentSessionMode;
  cwd?: string;
  cli?: string;
  /** Default isolation of a spawn: its own git worktree, or the shared checkout. Unset: decided at spawn from the tools. */
  isolation?: AgentIsolation;
  body?: string;
  disableModelInvocation?: boolean;
}

export interface AgentDefinition extends AgentDefaults {
  name: string;
  description?: string;
  disableModelInvocation: boolean;
}

export interface ListedAgentDefinition extends AgentDefinition {
  source: AgentSource;
}

function getFrontmatterValue(frontmatter: string, key: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match ? match[1].trim() : undefined;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  return value != null ? value === "true" : undefined;
}

/** Parse a comma-separated frontmatter value into a trimmed list (or undefined). */
export function parseCommaList(value: string | undefined): string[] | undefined {
  if (value == null) return undefined;
  const list = value.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

function parseSessionMode(value: string | undefined): SubagentSessionMode | undefined {
  if (value === "standalone" || value === "lineage-only" || value === "fork") {
    return value;
  }
  return undefined;
}

function parseIsolation(value: string | undefined): AgentIsolation | undefined {
  return value === "worktree" || value === "none" ? value : undefined;
}

export function parseAgentDefinition(content: string, fallbackName: string): AgentDefinition | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const frontmatter = match[1];
  const body = content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
  const systemPromptMode = getFrontmatterValue(frontmatter, "system-prompt");

  return {
    name: getFrontmatterValue(frontmatter, "name") ?? fallbackName,
    description: getFrontmatterValue(frontmatter, "description"),
    model: getFrontmatterValue(frontmatter, "model"),
    tools: getFrontmatterValue(frontmatter, "tools"),
    systemPromptMode:
      systemPromptMode === "replace"
        ? "replace"
        : systemPromptMode === "append"
          ? "append"
          : undefined,
    skills: getFrontmatterValue(frontmatter, "skill") ?? getFrontmatterValue(frontmatter, "skills"),
    subagentAgents: parseCommaList(getFrontmatterValue(frontmatter, "subagent_agents")),
    autoExit: parseOptionalBoolean(getFrontmatterValue(frontmatter, "auto-exit")),
    interactive: parseOptionalBoolean(getFrontmatterValue(frontmatter, "interactive")),
    pane: parseOptionalBoolean(getFrontmatterValue(frontmatter, "pane")),
    sessionMode: parseSessionMode(getFrontmatterValue(frontmatter, "session-mode")),
    cwd: getFrontmatterValue(frontmatter, "cwd"),
    cli: getFrontmatterValue(frontmatter, "cli"),
    isolation: parseIsolation(getFrontmatterValue(frontmatter, "isolation")),
    body: body || undefined,
    disableModelInvocation:
      getFrontmatterValue(frontmatter, "disable-model-invocation")?.toLowerCase() === "true",
  };
}

/** Tools a profile names, as a list (`tools: read, grep` -> ["read","grep"]). */
export function profileTools(def: Pick<AgentDefaults, "tools">): string[] {
  return parseCommaList(def.tools) ?? [];
}

/** A writer is a profile whose tools include edit, write or bash (the worktree default of ticket 7 keys on it). */
export function isWriterProfile(def: Pick<AgentDefaults, "tools">): boolean {
  return profileTools(def).some((t) => t === "edit" || t === "write" || t === "bash");
}
