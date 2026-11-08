/**
 * The prompt registry and resolver. Repo defaults are Markdown in `packages/agents/prompts/<id>.md`; a wolf may override an
 * editable prompt with `<wolf-home>/agent/prompts/<id>.md`. The override wins, otherwise the repo default. Nothing is cached:
 * every resolve reads the files, so an edit is seen by the next prompt assembly.
 */
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundledAgentsDir, bundledStandardsDir, standardsFor } from "./discover.js";
import { parseAgentDefinition } from "./profile.js";

export interface PromptDef {
  id: string;
  group: string;
  label: string;
  /** A wolf may override it (PUT /prompts). Ids not editable here are read-only. */
  editable: boolean;
  /** The `{{name}}` placeholders the default uses; a registry test checks the list against the text. */
  placeholders: readonly string[];
  /** Which process or agent reads it. */
  user: string;
  /** Repo path of the default. */
  file: string;
  /** Where the default and the per-wolf override live: `prompts/`, `agents/` (helper profiles) or `standards/`, under the repo's agents package and `<wolf-home>/agent/`. */
  store: PromptStore;
  /** Name of the file in the store (without `.md`). */
  name: string;
  /** When an edit takes effect. */
  applies: string;
}

/** `identity` is the wolf's own `<wolf-home>/agent/AGENTS.md`: no repo default, and reset restores the original. */
export type PromptStore = "prompts" | "agents" | "standards" | "identity";

const RESTART = "when the wolf restarts (wolfd builds its system prompt at start-up; threads reopened in a feature workspace pick it up earlier)";
const prompt = (id: string, group: string, label: string, placeholders: string[], user: string): PromptDef => ({ id, group, label, editable: true, placeholders, user, file: `packages/agents/prompts/${id}.md`, store: "prompts", name: id, applies: RESTART });
const SPAWN = "on the next subagent spawned (profiles and standards are read from disk at every spawn)";
const PROFILES: Array<[string, string]> = [
  ["investigator", "investigator subagent"],
  ["planner", "planner subagent"],
  ["researcher", "researcher subagent"],
  ["reviewer", "reviewer subagent"],
  ["scout", "scout subagent"],
  ["visualizer", "visualizer subagent"],
  ["worker", "worker subagent"],
];
const STANDARDS: Array<[string, string]> = [
  ["git", "worker and reviewer subagents (and any profile naming it)"],
  ["testing", "worker, planner and reviewer subagents (and any profile naming it)"],
  ["verify-ui", "any profile that names it in its frontmatter `standards:` line"],
];

export const PROMPTS: readonly PromptDef[] = [
  prompt("orchestrator-rules", "Orchestrator", "Orchestrator rules", ["opsRef", "paneNote"], "main wolf (home and feature threads)"),
  prompt("new-work", "Work creation", "New work (routing and pipeline)", ["domains", "grilling", "toSpec", "toTickets"], "main wolf (new-work skill)"),
  prompt("grilling", "Work creation", "Grilling protocol", [], "main wolf (new-work skill)"),
  prompt("to-spec", "Work creation", "To-spec protocol", [], "main wolf (new-work skill)"),
  prompt("to-tickets", "Work creation", "To-tickets protocol", [], "main wolf (new-work skill)"),
  {
    id: "identity",
    group: "Identity",
    label: "Identity (agent/AGENTS.md)",
    editable: true,
    placeholders: [],
    user: "main wolf (home and feature threads)",
    file: "<wolf-home>/agent/AGENTS.md",
    store: "identity",
    name: "AGENTS",
    applies: RESTART,
  },
  ...PROFILES.map(
    ([n, user]): PromptDef => ({ id: `agent.${n}`, group: "Helper profiles", label: `Helper profile: ${n}`, editable: true, placeholders: [], user, file: `packages/agents/agents/${n}.md`, store: "agents", name: n, applies: SPAWN }),
  ),
  ...STANDARDS.map(
    ([n, user]): PromptDef => ({ id: `standard.${n}`, group: "Standards", label: `Standard: ${n}`, editable: true, placeholders: [], user, file: `packages/agents/standards/${n}.md`, store: "standards", name: n, applies: SPAWN }),
  ),
];

export const PROMPT_MAX_BYTES = 64 * 1024;

export type PromptSource = "default" | "override";

export interface ResolvedPrompt {
  id: string;
  text: string;
  source: PromptSource;
  /** Hash of the effective text: send it back as If-Match to write over exactly this version. */
  etag: string;
}

/** The defaults shipped with wolfpack. From source and dist this is `packages/agents/prompts`; in the den bundle it is the `prompts` folder beside it. */
export function bundledPromptsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const beside = join(here, "prompts");
  return existsSync(beside) ? beside : resolve(here, "..", "prompts");
}

export function promptDef(id: string): PromptDef | undefined {
  return PROMPTS.find((p) => p.id === id);
}

/** Where a wolf's override of `id` lives: `<wolf-home>/agent/<store>/<name>.md` (the paths discoverAgents and the standards loader read). */
export function overridePath(wolfHome: string, id: string): string {
  const def = requireDef(id);
  return def.store === "identity" ? join(wolfHome, "agent", "AGENTS.md") : join(wolfHome, "agent", def.store, `${def.name}.md`);
}

function defaultPath(def: PromptDef): string {
  if (def.store === "identity") throw new Error("the identity has no repo default");
  const dir = def.store === "agents" ? bundledAgentsDir() : def.store === "standards" ? bundledStandardsDir() : bundledPromptsDir();
  return join(dir, `${def.name}.md`);
}

const BACKUPS_KEPT = 10;

/** Copy `file` to `<dir>/<name>.<timestamp>.<ext>` and prune to the newest `kept` per name. A missing file: nothing to back up. */
export function backupFile(file: string, dir: string, name: string, ext = "md", kept = BACKUPS_KEPT): void {
  if (!existsSync(file)) return;
  mkdirSync(dir, { recursive: true });
  let t = Date.now();
  const stamp = (ms: number) => new Date(ms).toISOString().replace(/\D/g, "");
  while (existsSync(join(dir, `${name}.${stamp(t)}.${ext}`))) t++;
  copyFileSync(file, join(dir, `${name}.${stamp(t)}.${ext}`));
  const mine = readdirSync(dir)
    .filter((f) => f.startsWith(`${name}.`) && new RegExp(`^\\d+\\.${ext}$`).test(f.slice(name.length + 1)))
    .sort();
  for (const old of mine.slice(0, Math.max(0, mine.length - kept))) rmSync(join(dir, old), { force: true });
}

/** Replace `file` atomically (temp file + rename), keeping its mode; a symlink is followed so the link itself stays. */
export function atomicWrite(file: string, text: string): void {
  let target = file;
  try {
    target = realpathSync(file);
  } catch {
    // new file
  }
  const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, text, existsSync(target) ? { mode: statSync(target).mode & 0o7777 } : undefined);
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Copy the current override to `<wolf-home>/agent/.backups/<store>/<name>.<timestamp>.md` and prune to the newest 10 per file. No override: nothing to back up. */
function backupOverride(wolfHome: string, def: PromptDef): void {
  backupFile(overridePath(wolfHome, def.id), join(wolfHome, "agent", ".backups", def.store), def.name);
}

/** The identity as it was before the first edit through the console; never pruned. */
const ORIGINAL = "AGENTS.original.md";
const originalIdentityPath = (wolfHome: string) => join(wolfHome, "agent", ".backups", "identity", ORIGINAL);

/** A profile edit must keep a frontmatter block that parses, with `name:` equal to the id, and valid `standards:` names. Returns the problem, or undefined. */
function profileProblem(name: string, text: string): string | undefined {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return "a profile must start with a --- frontmatter block (--- on its own line, key: value lines, ---)";
  const lines = m[1]!.split("\n");
  for (const [i, line] of lines.entries()) {
    if (line.trim() !== "" && !/^[A-Za-z][\w-]*:/.test(line)) return `frontmatter line ${i + 1} is not "key: value": ${line.slice(0, 80)}`;
  }
  const def = parseAgentDefinition(text, "");
  if (!def || def.name !== name) return `frontmatter name must be "${name}" (found "${def?.name ?? ""}")`;
  try {
    standardsFor(def.name, def.standards);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return undefined;
}

export function promptEtag(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function requireDef(id: string): PromptDef {
  const def = promptDef(id);
  if (!def) throw new Error(`unknown prompt "${id}"`);
  return def;
}

/** The effective text of a registered prompt for a wolf (no wolfHome: the repo default). Throws on an unknown id. */
export function resolvePrompt(id: string, wolfHome?: string): ResolvedPrompt {
  const def = requireDef(id);
  if (wolfHome && def.editable) {
    try {
      const text = readFileSync(overridePath(wolfHome, id), "utf8");
      return { id, text, source: "override", etag: promptEtag(text) };
    } catch {
      // no override (or unreadable): the default
    }
  }
  // The identity is the wolf's own file: no file means empty text, not a repo default.
  const text = def.store === "identity" ? "" : readFileSync(defaultPath(def), "utf8");
  return { id, text, source: "default", etag: promptEtag(text) };
}

export class PromptWriteError extends Error {
  constructor(
    readonly code: "unknown" | "not_editable" | "too_large" | "stale" | "invalid",
    message: string,
  ) {
    super(message);
  }
}

function checkWritable(id: string, ifMatch: string | undefined, wolfHome: string): void {
  const def = promptDef(id);
  if (!def) throw new PromptWriteError("unknown", `unknown prompt "${id}"`);
  if (!def.editable) throw new PromptWriteError("not_editable", `prompt "${id}" is not editable per wolf`);
  if (ifMatch !== undefined && ifMatch !== resolvePrompt(id, wolfHome).etag) {
    throw new PromptWriteError("stale", `prompt "${id}" changed since you loaded it; reload and try again`);
  }
}

/** Write a wolf's override atomically (temp file + rename). `ifMatch` is the etag the caller saw; a different current etag throws "stale". */
export function writePromptOverride(wolfHome: string, id: string, text: string, ifMatch?: string): ResolvedPrompt {
  checkWritable(id, ifMatch, wolfHome);
  if (Buffer.byteLength(text, "utf8") > PROMPT_MAX_BYTES) throw new PromptWriteError("too_large", `prompt text is over ${PROMPT_MAX_BYTES} bytes`);
  const def = requireDef(id);
  if (def.store === "identity" && text.trim() === "") throw new PromptWriteError("invalid", "the identity cannot be empty");
  if (def.store === "agents") {
    const problem = profileProblem(def.name, text);
    if (problem) throw new PromptWriteError("invalid", problem);
  }
  const file = overridePath(wolfHome, id);
  if (def.store === "identity" && existsSync(file) && !existsSync(originalIdentityPath(wolfHome))) {
    mkdirSync(dirname(originalIdentityPath(wolfHome)), { recursive: true });
    copyFileSync(file, originalIdentityPath(wolfHome));
  }
  backupOverride(wolfHome, def);
  mkdirSync(dirname(file), { recursive: true });
  atomicWrite(file, text);
  return resolvePrompt(id, wolfHome);
}

/**
 * Remove a wolf's override (reset to the repo default). Idempotent. The identity has no default: reset restores the copy kept
 * from before its first console edit (the current text is backed up first) and is refused when there is none.
 */
export function resetPromptOverride(wolfHome: string, id: string, ifMatch?: string): ResolvedPrompt {
  checkWritable(id, ifMatch, wolfHome);
  const def = requireDef(id);
  if (def.store === "identity") {
    if (!existsSync(originalIdentityPath(wolfHome))) throw new PromptWriteError("invalid", "there is no original identity to restore (it has not been edited from the console)");
    return writePromptOverride(wolfHome, id, readFileSync(originalIdentityPath(wolfHome), "utf8"));
  }
  backupOverride(wolfHome, requireDef(id));
  rmSync(overridePath(wolfHome, id), { force: true });
  return resolvePrompt(id, wolfHome);
}
