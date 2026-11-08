/**
 * The prompt registry and resolver. Repo defaults are Markdown in `packages/agents/prompts/<id>.md`; a wolf may override an
 * editable prompt with `<wolf-home>/agent/prompts/<id>.md`. The override wins, otherwise the repo default. Nothing is cached:
 * every resolve reads the files, so an edit is seen by the next prompt assembly.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface PromptDef {
  id: string;
  group: string;
  label: string;
  /** A wolf may override it (PUT /prompts). Ids not editable here are read-only. */
  editable: boolean;
}

export const PROMPTS: readonly PromptDef[] = [
  { id: "orchestrator-rules", group: "Orchestrator", label: "Orchestrator rules", editable: true },
  { id: "new-work", group: "Work creation", label: "New work (routing and pipeline)", editable: true },
  { id: "grilling", group: "Work creation", label: "Grilling protocol", editable: true },
  { id: "to-spec", group: "Work creation", label: "To-spec protocol", editable: true },
  { id: "to-tickets", group: "Work creation", label: "To-tickets protocol", editable: true },
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

export function overridePath(wolfHome: string, id: string): string {
  return join(wolfHome, "agent", "prompts", `${id}.md`);
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
  const text = readFileSync(join(bundledPromptsDir(), `${id}.md`), "utf8");
  return { id, text, source: "default", etag: promptEtag(text) };
}

export class PromptWriteError extends Error {
  constructor(
    readonly code: "unknown" | "not_editable" | "too_large" | "stale",
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
  const file = overridePath(wolfHome, id);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return resolvePrompt(id, wolfHome);
}

/** Remove a wolf's override (reset to the repo default). Idempotent. */
export function resetPromptOverride(wolfHome: string, id: string, ifMatch?: string): ResolvedPrompt {
  checkWritable(id, ifMatch, wolfHome);
  rmSync(overridePath(wolfHome, id), { force: true });
  return resolvePrompt(id, wolfHome);
}
