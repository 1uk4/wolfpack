import { homedir } from "node:os";
import path from "node:path";

/**
 * The Mac updater's state dir: WOLFPACK_HOME or ~/.wolfpack, then auto-update/. The same rule as macPaths in
 * scripts/auto-update-mac.mjs, so the console reads and writes the files the script does (status.json, run-now).
 */
export const macAutoUpdateDir = (home = homedir(), env: Record<string, string | undefined> = process.env) => path.join(env.WOLFPACK_HOME?.trim() || path.join(home, ".wolfpack"), "auto-update");
