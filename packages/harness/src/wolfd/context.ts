/**
 * Project context for a wolf process: the system instructions its home conversation starts with.
 *
 * Rules (v1, deliberately simple):
 * - AGENTS.md and CLAUDE.md: walk up from the workspace cwd to the home directory (inclusive); the NEAREST file of
 *   each name wins, files further up are not merged. If cwd is outside home the walk goes to the filesystem root.
 * - Skills: every `<den>/skills/<dir>/SKILL.md`. Only name + description (frontmatter `name:` / `description:`, name
 *   defaulting to the directory) plus the file path go into the prompt; the model reads the body on demand with its
 *   read tool. Skills without a readable SKILL.md are skipped.
 * - Read once, when the conversation is configured at process start. Editing these files takes effect on the next
 *   wolfd start (the agent state is compared and only reconfigured when it differs).
 * - No .pi/ project config, NOTES.md, or telegram rules: those stay with the legacy harness.
 */
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface ProjectContextInput {
  name: string;
  domains?: readonly string[];
  /** Workspace cwd the walk starts from. */
  cwd: string;
  /** Wolf den; skills are read from `<den>/skills`. */
  den: string;
  /** Upper bound of the walk. Default: os.homedir(). */
  home?: string;
}

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

export function composeProjectContext(input: ProjectContextInput): ProjectContext {
  const agents = findUp("AGENTS.md", input.cwd, input.home);
  const claude = findUp("CLAUDE.md", input.cwd, input.home);
  const skills = loadSkills(input.den);

  const parts: string[] = [];
  const domains = input.domains?.length ? ` Domains: ${input.domains.join(", ")}.` : "";
  parts.push(`You are ${input.name}, a wolf in the wolfpack.${domains} Your workspace is ${input.cwd}.`);
  if (agents) parts.push(`# AGENTS.md (${agents.path})\n\n${agents.text.trim()}`);
  if (claude) parts.push(`# CLAUDE.md (${claude.path})\n\n${claude.text.trim()}`);
  if (skills.length) {
    const list = skills.map((s) => `- ${s.name}${s.description ? `: ${s.description}` : ""} (${s.path})`).join("\n");
    parts.push(`# Skills\n\nRead a skill's SKILL.md with the read tool when its description matches the task.\n\n${list}`);
  }
  return { agents, claude, skills, instructions: parts.join("\n\n") };
}
