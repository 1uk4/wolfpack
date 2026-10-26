/**
 * Sandbox resolution: ONE function maps (dev root, work endpoint) to the redirected outward roots, and one
 * assertion proves nothing resolves outside it. Mirrors `crawl emit --dry-run`: everything a wolf writes
 * (den, KB_DEN_LOCAL, KB_OPS lanes, Work Record via WORK_ENDPOINT) goes to the snapshot; KB_BASE stays
 * read-only and is not redirected.
 */
import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { sandboxPaths } from "./layout.js";

export interface ResolvedSandbox {
  root: string;
  den: string;
  kbOps: string;
  kbDenLocal: string;
  /** Local work server ledger dir (pass to startLocalWorkServer). */
  workLedgerDir: string;
  /** The local Work server's base URL (clients append `/work`, like the live WORK_ENDPOINT); undefined until the local work server is up. */
  workEndpoint?: string;
}

export class SandboxError extends Error {
  constructor(message: string) {
    super(`sandbox: ${message}`);
    this.name = "SandboxError";
  }
}

function within(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * realpath that tolerates a missing tail. Walks up to the deepest existing (lstat) component; a symlink there,
 * including a dangling one, is followed through readlink so a den pointing at a not-yet-existing live dir is caught.
 */
export function realPathLoose(p: string, depth = 0): string {
  if (depth > 40) throw new SandboxError(`too many symlinks resolving ${p}`);
  const abs = resolve(p);
  let cur = abs;
  const tail: string[] = [];
  for (;;) {
    const st = lstatSync(cur, { throwIfNoEntry: false });
    if (st) {
      if (st.isSymbolicLink()) return realPathLoose(join(resolve(dirname(cur), readlinkSync(cur)), ...tail), depth + 1);
      return join(realpathSync(cur), ...tail);
    }
    const parent = dirname(cur);
    if (parent === cur) return abs;
    tail.unshift(basename(cur));
    cur = parent;
  }
}

export function isLoopbackUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "[::1]" || h === "::1";
  } catch {
    return false;
  }
}

export function resolveSandbox(devRoot: string, opts: { workEndpoint?: string } = {}): ResolvedSandbox {
  const p = sandboxPaths(resolve(devRoot));
  return {
    root: p.root,
    den: p.den,
    kbOps: p.kbOps,
    kbDenLocal: p.kbDenLocal,
    workLedgerDir: p.ledgerDir,
    ...(opts.workEndpoint ? { workEndpoint: opts.workEndpoint } : {}),
  };
}

/** Every outward path must be inside the (real) dev root. */
export function assertSandboxedPaths(root: string, actual: { den?: string; kbOps?: string; kbDenLocal?: string }): void {
  const realRoot = realPathLoose(root);
  for (const [label, value] of Object.entries(actual)) {
    if (!value) throw new SandboxError(`${label} is not set (would fall back to the live location)`);
    if (!within(realRoot, realPathLoose(value))) throw new SandboxError(`${label} ${value} resolves outside the dev root ${root}`);
  }
}

/**
 * Fail closed: throw unless every outward root is inside the (real) dev root and WORK_ENDPOINT is set and
 * loopback. `actual` is what the process will really use (den, env), not what we meant to configure.
 */
export function assertSandboxed(
  root: string,
  actual: { den?: string; kbOps?: string; kbDenLocal?: string; workEndpoint?: string },
): void {
  const { workEndpoint: ep, ...paths } = actual;
  assertSandboxedPaths(root, paths);
  if (!ep) throw new SandboxError("WORK_ENDPOINT is not set (Record writes would fall back to the live Work API)");
  if (!isLoopbackUrl(ep)) throw new SandboxError(`WORK_ENDPOINT ${ep} is not a loopback address`);
}

/** The env a sandboxed wolf runs with. */
export function sandboxEnv(r: ResolvedSandbox, token?: string): Record<string, string> {
  return {
    WOLF_DEN: r.den,
    KB_OPS: r.kbOps,
    KB_DEN_LOCAL: r.kbDenLocal,
    ...(r.workEndpoint ? { WORK_ENDPOINT: r.workEndpoint } : {}),
    ...(token ? { WORK_TOKEN: token } : {}),
  };
}

/** A sandbox root must be a dev root made by `takeSnapshot` (carries the manifest) — never an arbitrary dir. */
export function requireSnapshotRoot(root: string): void {
  if (!existsSync(sandboxPaths(resolve(root)).manifest)) {
    throw new SandboxError(`${root} is not a snapshot dev root (no snapshot.json); run \`wolfpack sandbox snapshot\` first`);
  }
}
