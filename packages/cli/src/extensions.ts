/**
 * Wolf extension registry + profiles.
 *
 * Maps logical extension keys (stored in wolf.yaml) to the concrete Pi
 * packages/extensions that back them, and groups them into profiles that
 * match how a wolf is used:
 *
 *   - worker    — local, keyboard-driven working agent (memory)
 *   - assistant — 24/7 VPS assistant reachable via Telegram (+ telegram)
 *
 * The CLI uses this to pick and validate the extensions a wolf is built with.
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
  /** Supported runtimes (defaults to all if not specified) */
  runtimes?: string[];
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
    runtimes: ["pi-durable"],
  },
  {
    key: "telegram",
    label: "Telegram",
    description: "Reach the wolf via a Telegram bot (per-wolf token, owner-gated)",
    dir: "wolfpack-telegram",
    requiresTelegram: true,
    runtimes: ["pi-durable"],
  },
  {
    key: "browser",
    label: "Browser",
    description: "Guarded headless Chromium (Playwright) tools; off unless wolf.yaml `browser: { enabled: true }` (wolfpack-browser)",
    dir: "wolfpack-browser",
    runtimes: ["pi-durable"],
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
    extensions: ["memory"],
  },
  assistant: {
    label: "Assistant",
    description: "24/7 VPS assistant reachable via Telegram",
    extensions: ["memory", "telegram"],
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

/**
 * The `kb` key in a wolf's `extensions` marks it as a librarian. It has no
 * package (the sweep lives in the harness timer and the kb CLI); it only drives
 * host KB-engine provisioning (Ollama + the admin CLI) and role detection.
 */
export const LIBRARIAN_KEY = "kb";

/** Is this a librarian wolf? (carries the `kb` marker key) */
export function isLibrarian(keys: string[]): boolean {
  return keys.includes(LIBRARIAN_KEY);
}

/**
 * Full librarian detection: either the `kb` marker key (used by
 * non-pi-durable wolves) OR a pi-durable wolf whose memory extension declares
 * librarian mode in-config (dewey's pattern since the Oct 2026 migration).
 *
 * Must match the harness's runtime check (`config.memory?.librarian === true`
 * in createWolfHarness) so sync ships the KB CLI to every wolf that runs the
 * embedded librarian at runtime.
 */
export function isLibrarianConfig(cfg: {
  extensions?: string[];
  memory?: { librarian?: boolean };
}): boolean {
  if (isLibrarian(cfg.extensions ?? [])) return true;
  if (cfg.memory?.librarian === true) return true;
  return false;
}

/** Check if an extension supports a specific runtime. */
export function extensionSupportsRuntime(ext: WolfExtension, runtime: string): boolean {
  // If no runtimes specified, extension supports all runtimes
  if (!ext.runtimes || ext.runtimes.length === 0) return true;
  return ext.runtimes.includes(runtime);
}

/** Get all extensions that support a specific runtime. */
export function extensionsForRuntime(runtime: string): WolfExtension[] {
  return AVAILABLE_EXTENSIONS.filter((ext) => extensionSupportsRuntime(ext, runtime));
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
