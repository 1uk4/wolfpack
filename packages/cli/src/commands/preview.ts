/**
 * wolfpack preview [<ref> | <worktree dir> | status | restart | off [--console|--all] | slot get|list|release|pair [--print-url] | token | dev] [--dry-run] [--yes]
 * Wires scripts/runtime-preview.mjs (which holds the behaviour and its tests) into the CLI. The script is found relative to
 * this file (dist/commands -> repo root), so it runs from the checkout this CLI was built in.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Marker the preview script looks for in a built cli: this version prefers the bin copy and understands the worktree-preview state. */
export const PREVIEW_CLI = 1;

export async function previewCmd(argv: string[]): Promise<number> {
  // Run the higher PREVIEW_VERSION of the stable copy under ~/.wolfpack/preview/bin (the checked-out branch may predate this command) and this
  // checkout's script. The script refreshes the copy on every command, so the copy never goes stale.
  const copy = path.join(process.env.HOME || os.homedir(), ".wolfpack", "preview", "bin", "runtime-preview.mjs");
  const own = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../scripts/runtime-preview.mjs");
  const version = (f: string): number => (fs.existsSync(f) ? Number(/export const PREVIEW_VERSION = (\d+)/.exec(fs.readFileSync(f, "utf8"))?.[1] ?? 0) : -1);
  const script = version(own) >= version(copy) ? own : copy;
  const mod = (await import(pathToFileURL(script).href)) as { runPreview: (o: { argv: string[]; env: NodeJS.ProcessEnv }) => Promise<{ exitCode: number }> };
  return (await mod.runPreview({ argv, env: process.env })).exitCode;
}
