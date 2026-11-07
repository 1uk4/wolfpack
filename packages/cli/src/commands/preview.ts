/**
 * wolfpack preview <ref> | status | off [--dry-run]
 * Wires scripts/runtime-preview.mjs (which holds the behaviour and its tests) into the CLI. The script is found relative to
 * this file (dist/commands -> repo root), so it runs from the checkout this CLI was built in.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function previewCmd(argv: string[]): Promise<number> {
  // Prefer the stable copy `preview on` left under ~/.wolfpack/preview/bin: the checked-out branch may predate this command.
  const copy = path.join(process.env.HOME || os.homedir(), ".wolfpack", "preview", "bin", "runtime-preview.mjs");
  const script = fs.existsSync(copy) ? copy : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../scripts/runtime-preview.mjs");
  const mod = (await import(pathToFileURL(script).href)) as { runPreview: (o: { argv: string[]; env: NodeJS.ProcessEnv }) => Promise<{ exitCode: number }> };
  return (await mod.runPreview({ argv, env: process.env })).exitCode;
}
