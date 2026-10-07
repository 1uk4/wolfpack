/**
 * Wolf extension registry + profiles.
 *
 * Maps logical extension keys (stored in wolf.yaml) to the concrete Pi
 * packages/extensions that back them, and groups them into profiles that
 * match how a wolf is used:
 *
 *   - worker    — local, keyboard-driven working agent (memory + subagents)
 *   - assistant — 24/7 VPS assistant reachable via Telegram (+ telegram)
 *
 * The CLI uses this to generate a wolf's `.pi/settings.json` so the Pi runtime
 * loads the right extensions.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface WolfExtension {
  /** Stable key stored in wolf.yaml `extensions: [...]` */
  key: string;
  /** Human label shown in prompts */
  label: string;
  /** One-line description */
  description: string;
  /** Directory name under the repo `extensions/` folder holding the package */
  dir: string;
  /** Needs a TelegramConfig (token env + owner id) to function */
  requiresTelegram?: boolean;
  /** Librarian capability: triggers host KB-engine provisioning (Ollama + sweep). */
  librarian?: boolean;
}

export type WolfProfile = "worker" | "assistant";

/** Resolve the wolfpack repo root from this module's location. */
export function repoRoot(): string {
  // dist layout: <repo>/packages/cli/dist/extensions.js
  // src  layout: <repo>/packages/cli/src/extensions.ts
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..");
}

/** Absolute path to the repo `extensions/` directory. */
export function extensionsDir(): string {
  return path.join(repoRoot(), "extensions");
}

/** All extensions the CLI knows how to attach to a wolf. */
export const AVAILABLE_EXTENSIONS: WolfExtension[] = [
  {
    key: "memory",
    label: "Memory",
    description: "Observer + consolidator + den management (wolfpack-memory)",
    dir: "wolfpack-memory",
  },
  {
    key: "subagents",
    label: "Interactive sub agents",
    description: "Delegate tasks to specialized agents with isolated context",
    dir: "wolfpack-subagents",
  },
  {
    key: "ask",
    label: "Ask user question",
    description: "Pause and ask the user a question (drives the crawl questionnaire)",
    dir: "ask-user-question",
  },
  {
    key: "telegram",
    label: "Telegram",
    description: "Reach the wolf via a Telegram bot (per-wolf token, owner-gated)",
    dir: "wolfpack-telegram",
    requiresTelegram: true,
  },
  {
    key: "kb",
    label: "Librarian (KB engine)",
    description:
      "Shared knowledge-base curation: inbox sweep, embeddings, /kb:sweep (wolfpack-librarian)",
    dir: "wolfpack-librarian",
    librarian: true,
  },
  {
    key: "visual-tools",
    label: "Visual tools (Mermaid + SVG makers)",
    description:
      "Mermaid + SVG authoring tools for the mermaid-maker/svg-maker subagents — render-and-inspect diagram loops that publish PNGs into <cwd>/viz (wolfpack-visual-tools)",
    dir: "wolfpack-visual-tools",
  },
];

/** Extension keys bundled into each profile. */
export const PROFILES: Record<
  WolfProfile,
  { label: string; description: string; extensions: string[] }
> = {
  worker: {
    label: "Worker",
    description: "Local, keyboard-driven working agent",
    extensions: ["memory", "subagents", "ask"],
  },
  assistant: {
    label: "Assistant",
    description: "24/7 VPS assistant reachable via Telegram",
    extensions: ["memory", "subagents", "telegram", "ask"],
  },
};

/** Default profile: remote wolves are assistants, local wolves are workers. */
export function defaultProfile(isRemote: boolean): WolfProfile {
  return isRemote ? "assistant" : "worker";
}

/** Extension keys attached by default for a profile. */
export function defaultExtensionKeys(profile: WolfProfile): string[] {
  return [...PROFILES[profile].extensions];
}

/** Look up an extension by key. */
export function getExtension(key: string): WolfExtension | undefined {
  return AVAILABLE_EXTENSIONS.find((e) => e.key === key);
}

/** Does this set of extension keys include one that needs Telegram config? */
export function needsTelegram(keys: string[]): boolean {
  return keys.some((k) => getExtension(k)?.requiresTelegram);
}

/** Is this a librarian wolf? (carries a KB-engine extension) */
export function isLibrarian(keys: string[]): boolean {
  return keys.some((k) => getExtension(k)?.librarian);
}

/**
 * Resolve extension keys to absolute package directories. Keys whose package
 * directory does not exist in the repo are skipped and returned in `missing`
 * (e.g. the Telegram extension before it has been vendored into the repo).
 */
export function resolveExtensionDirs(keys: string[]): {
  dirs: string[];
  missing: string[];
} {
  const base = extensionsDir();
  const dirs: string[] = [];
  const missing: string[] = [];
  for (const key of keys) {
    const ext = getExtension(key);
    if (!ext) continue;
    const dir = path.join(base, ext.dir);
    if (fs.existsSync(dir)) dirs.push(dir);
    else missing.push(key);
  }
  return { dirs, missing };
}

/** The wolf's Pi agent directory (PI_CODING_AGENT_DIR): <wolf>/agent/ */
export function agentDir(wolfDir: string): string {
  return path.join(wolfDir, "agent");
}

/**
 * Write (or refresh) the wolf's agent-level `settings.json` so Pi loads the
 * selected extensions regardless of the working directory. This lives in the
 * wolf's agent dir (PI_CODING_AGENT_DIR), not a project `.pi/`, so you can run
 * as the wolf inside any project. Returns keys whose package dir was missing.
 */
export function writePiSettings(wolfDir: string, keys: string[]): string[] {
  const dir = agentDir(wolfDir);
  fs.mkdirSync(dir, { recursive: true });

  const settingsPath = path.join(dir, "settings.json");
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    // start fresh
  }

  const { dirs, missing } = resolveExtensionDirs(keys);
  settings.packages = dirs;

  // Inline images under a multiplexer: pi's `auto` protocol detection fails
  // through Herdr/tmux (they report TERM=xterm-256color), so diagrams never
  // render in the TUI. When this wolf runs its subagents under Herdr
  // (WOLFPACK_SUBAGENT_MUX=herdr in its .env), force the kitty graphics
  // protocol so renders display inline. Only set it when absent, so a user's
  // explicit terminal config always wins. (Herdr also needs
  // experimental.kitty_graphics=true in ~/.config/herdr/config.toml.)
  if (wolfSubagentMux(wolfDir) === "herdr") {
    const terminal = (settings.terminal as Record<string, unknown> | undefined) ?? {};
    if (terminal.images === undefined) terminal.images = "kitty";
    if (terminal.showImages === undefined) terminal.showImages = true;
    settings.terminal = terminal;
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  return missing;
}

/** Read the wolf's configured subagent multiplexer from its `.env`, if any. */
function wolfSubagentMux(wolfDir: string): string | null {
  try {
    const env = fs.readFileSync(path.join(wolfDir, ".env"), "utf8");
    const m = env.match(/^\s*WOLFPACK_SUBAGENT_MUX\s*=\s*(.+?)\s*$/m);
    return m ? m[1].trim().toLowerCase() : null;
  } catch {
    return null;
  }
}
