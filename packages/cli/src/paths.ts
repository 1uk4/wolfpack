/**
 * CLI-side paths — the single place that knows the remote (VPS) layout and
 * where helper binaries live on this machine. Values come from the optional
 * `remote:` / `binDirs:` keys in ~/.wolfpack/config.yaml; defaults are the
 * standard layout. (The on-host counterpart is agent/src/paths.ts.)
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, type CliConfig } from "./config.js";

const DEFAULT_BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

export interface RemotePaths {
  user(id: string): string;
  home(id: string): string;
  den(id: string): string;
  kbBase(id: string): string;
  librarianOps(id: string): string;
  /** Shared KB root on the host. */
  kbRoot: string;
  sharedKbBase: string;
  sharedKbOps: string;
  /** Shell glob matching every wolf home. */
  homeGlob: string;
}

export function remotePathsFrom(config: Pick<CliConfig, "remote">): RemotePaths {
  const root = config.remote?.wolfHomeRoot ?? "/home";
  const prefix = config.remote?.wolfUserPrefix ?? "wolf-";
  const kbRoot = config.remote?.kbRoot ?? "/var/wolfpack/kb";
  const home = (id: string) => path.posix.join(root, `${prefix}${id}`);
  return {
    user: (id) => `${prefix}${id}`,
    home,
    den: (id) => `${home(id)}/den`,
    kbBase: (id) => `${home(id)}/knowledge/base`,
    librarianOps: (id) => `${home(id)}/librarian`,
    kbRoot,
    sharedKbBase: `${kbRoot}/base`,
    sharedKbOps: `${kbRoot}/ops`,
    homeGlob: `${root}/${prefix}*`,
  };
}

/** Remote layout from the loaded ~/.wolfpack/config.yaml. */
export const remotePaths = (): RemotePaths => remotePathsFrom(loadConfig());

/** Directories to search/put on PATH beyond the inherited one. */
export function binDirs(config: Pick<CliConfig, "binDirs"> = loadConfig()): string[] {
  return config.binDirs ?? DEFAULT_BIN_DIRS;
}

/**
 * Find an executable: inherited PATH first, then configured binDirs.
 * Returns an absolute path, or undefined.
 */
export function resolveBin(
  name: string,
  opts: { pathEnv?: string; dirs?: string[] } = {},
): string | undefined {
  const dirs = [...(opts.pathEnv ?? process.env.PATH ?? "").split(path.delimiter), ...(opts.dirs ?? binDirs())];
  for (const d of dirs) {
    if (!d) continue;
    const f = path.join(d, name);
    try {
      fs.accessSync(f, fs.constants.X_OK);
      if (fs.statSync(f).isFile()) return f;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

/** Run a resolved binary; undefined if it cannot be found or fails. */
export function runBin(name: string, args: string[]): string | undefined {
  const bin = resolveBin(name);
  if (!bin) return undefined;
  try {
    return execFileSync(bin, args, { encoding: "utf8" });
  } catch {
    return undefined;
  }
}
