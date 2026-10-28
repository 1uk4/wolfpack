/**
 * Project context for a wolf process: the system instructions its home conversation starts with.
 *
 * Rules (v1, deliberately simple):
 * - AGENTS.md and CLAUDE.md: walk up from the workspace cwd to the home directory (inclusive); the NEAREST file of
 *   each name wins, files further up are not merged. If cwd is outside home the walk goes to the filesystem root.
 * - Skills: every `<den>/skills/<dir>/SKILL.md`. Only name + description (frontmatter `name:` / `description:`, name
 *   defaulting to the directory) plus the file path go into the prompt; the model reads the body on demand with its
 *   read tool. Skills without a readable SKILL.md are skipped.
 * - Identity: wolf.yaml `identity:` (else `<wolf-home>/agent/AGENTS.md`) is loaded first, labelled with its path; a
 *   missing file is skipped (debug log). The walk's AGENTS.md follows, unless it is the same file.
 * - Orchestrator rules + roster (the same text the terminal pi extension injects) follow the identity. Home and
 *   feature threads get both; subagent threads use their own profile instructions and never come through here.
 * - Read once, when the conversation is configured at process start. Editing these files takes effect on the next
 *   wolfd start (the agent state is compared and only reconfigured when it differs).
 * - No .pi/ project config, NOTES.md, or telegram rules: those stay with the legacy harness.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { discoverAgents, formatRosterLines, orchestratorRules } from "@wolfpack/agents";
import type { PromptSection } from "@wolfpack/engine";

export interface ProjectContextInput {
  name: string;
  domains?: readonly string[];
  /** Workspace cwd the walk starts from. */
  cwd: string;
  /** Wolf den; skills are read from `<den>/skills`. */
  den: string;
  /** Upper bound of the walk. Default: os.homedir(). */
  home?: string;
  /** wolf.yaml `prompts.structuredOutput`: a string replaces the default guidance; `false` or an empty/whitespace string removes it. */
  structuredOutput?: PromptSection;
  /** wolf.yaml `identity:` (absolute). Default: `<wolfHome>/agent/AGENTS.md`. */
  identityFile?: string;
  /** The wolf's home (holds wolf.yaml and agent/); also where the roster's global agents live. Omit to skip identity and orchestrator sections. */
  wolfHome?: string;
  log?: (line: string) => void;
}

/**
 * Default "Structured output" section: when to emit show_decision / show_graph / show_checklist. Overridable per wolf
 * (wolf.yaml `prompts.structuredOutput`); a settings UI would read/write that field (with versioning/reset on top).
 */
export const DEFAULT_STRUCTURED_OUTPUT_GUIDANCE = `Besides prose you can show the user live structured objects; prose stays the primary channel.
- show_graph: a plan with dependencies or branching (3+ steps with ordering); revise statuses as work progresses.
- show_checklist: a linear to-do you tick off in place. Don't emit both a graph and a checklist for the same plan.
- show_decision: records a choice you have made (options, the chosen one, the rationale). To ask the user an open question, use ask_user_question instead.
- Revise an object by reusing its objectId and resending it in full.
- No objects for trivial answers or one-step tasks.`;

export interface FoundFile {
  path: string;
  text: string;
}

export interface SkillSummary {
  name: string;
  description: string;
  path: string;
}

export interface ProjectContext {
  /** The wolf's identity file, when one was found. */
  identity?: FoundFile;
  agents?: FoundFile;
  claude?: FoundFile;
  skills: SkillSummary[];
  /** The composed instructions text. */
  instructions: string;
}

/** Nearest `file` walking up from `from` to `home` (inclusive). */
export function findUp(file: string, from: string, home: string = homedir()): FoundFile | undefined {
  const top = resolve(home);
  let dir = resolve(from);
  for (;;) {
    const path = join(dir, file);
    try {
      return { path, text: readFileSync(path, "utf8") };
    } catch {
      // not here; keep walking
    }
    const parent = dirname(dir);
    if (dir === top || parent === dir) return undefined;
    dir = parent;
  }
}

function frontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

export function loadSkills(den: string): SkillSummary[] {
  const root = join(den, "skills");
  let dirs: string[];
  try {
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
  const skills: SkillSummary[] = [];
  for (const d of dirs) {
    const path = join(root, d, "SKILL.md");
    try {
      const fm = frontmatter(readFileSync(path, "utf8"));
      skills.push({ name: fm.name || d, description: fm.description ?? "", path });
    } catch {
      // no SKILL.md
    }
  }
  return skills;
}

/** Ops reference path for investigator briefs: $WOLFPACK_OPS_REF, then ~/.wolfpack/ops.md (named even when absent). */
function opsRef(): string {
  const fallback = join(homedir(), ".wolfpack", "ops.md");
  const env = process.env.WOLFPACK_OPS_REF;
  return env && existsSync(env) ? env : fallback;
}

function loadIdentity(input: ProjectContextInput): FoundFile | undefined {
  if (!input.wolfHome) return undefined;
  const path = input.identityFile ?? join(input.wolfHome, "agent", "AGENTS.md");
  try {
    return { path, text: readFileSync(path, "utf8") };
  } catch {
    input.log?.(`debug: identity file ${path} not readable; skipped`);
    return undefined;
  }
}

function sameFile(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
}

export function composeProjectContext(input: ProjectContextInput): ProjectContext {
  const identity = loadIdentity(input);
  const found = findUp("AGENTS.md", input.cwd, input.home);
  const agents = found && identity && sameFile(found.path, identity.path) ? undefined : found;
  const claude = findUp("CLAUDE.md", input.cwd, input.home);
  const skills = loadSkills(input.den);

  const parts: string[] = [];
  const domains = input.domains?.length ? ` Domains: ${input.domains.join(", ")}.` : "";
  parts.push(`You are ${input.name}, a wolf in the wolfpack.${domains} Your workspace is ${input.cwd}.`);
  if (identity) parts.push(`# Identity (${identity.path})\n\n${identity.text.trim()}`);
  if (input.wolfHome) {
    const roster = formatRosterLines(discoverAgents({ cwd: input.cwd, agentDir: join(input.wolfHome, "agent") }));
    const rules = orchestratorRules({ opsRef: opsRef(), surface: "wolfd" });
    parts.push(`# Orchestrator rules\n\n${rules}\n\nSubagent roster:\n${roster.length ? roster.join("\n") : "No subagent definitions found."}`);
  }
  if (agents) parts.push(`# AGENTS.md (${agents.path})\n\n${agents.text.trim()}`);
  if (claude) parts.push(`# CLAUDE.md (${claude.path})\n\n${claude.text.trim()}`);
  if (skills.length) {
    const list = skills.map((s) => `- ${s.name}${s.description ? `: ${s.description}` : ""} (${s.path})`).join("\n");
    parts.push(`# Skills\n\nRead a skill's SKILL.md with the read tool when its description matches the task.\n\n${list}`);
  }
  const so = input.structuredOutput === undefined ? DEFAULT_STRUCTURED_OUTPUT_GUIDANCE : input.structuredOutput;
  if (so !== false && so.trim()) parts.push(`# Structured output\n\n${so.trim()}`);
  return { identity, agents, claude, skills, instructions: parts.join("\n\n") };
}
