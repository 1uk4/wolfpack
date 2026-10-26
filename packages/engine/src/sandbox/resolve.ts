/**
 * Sandbox resolution: ONE function maps (dev root, work endpoint) to the redirected outward roots, and one
 * assertion proves nothing resolves outside it. Mirrors `crawl emit --dry-run`: everything a wolf writes
 * (den, KB_DEN_LOCAL, KB_OPS lanes, Work Record via WORK_ENDPOINT) goes to the snapshot. KB_BASE is redirected to
 * the snapshot's KB copy (`<root>/kb-base`) when the snapshot carries one; without a copy it stays ambient and
 * read-only (and a librarian is then refused, see {@link assertLibrarianSandboxed}).
 */
import { existsSync, lstatSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { sandboxPaths, wolfDenDir } from "./layout.js";

export interface ResolvedSandbox {
  root: string;
  den: string;
  kbOps: string;
  kbDenLocal: string;
  /** The sandbox's KB copy (KB_BASE); undefined when the snapshot has none (KB_BASE then stays ambient, read-only). */
  kbBase?: string;
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

/**
 * `wolf` picks that wolf's den in a shared sandbox (`<root>/dens/<wolf>`, used when `<root>/dens` exists); without it,
 * or in a single-wolf snapshot, the den is `<root>/den`.
 */
export function resolveSandbox(devRoot: string, opts: { workEndpoint?: string; wolf?: string } = {}): ResolvedSandbox {
  const p = sandboxPaths(resolve(devRoot));
  const shared = !!opts.wolf && existsSync(p.dens);
  const den = shared ? wolfDenDir(p.root, opts.wolf!) : p.den;
  return {
    root: p.root,
    den,
    kbOps: p.kbOps,
    kbDenLocal: join(den, "kb"),
    ...(existsSync(p.kbBase) ? { kbBase: p.kbBase } : {}),
    workLedgerDir: p.ledgerDir,
    ...(opts.workEndpoint ? { workEndpoint: opts.workEndpoint } : {}),
  };
}

/**
 * Every outward path must be inside the (real) dev root. When the snapshot carries a KB copy, KB_BASE is an outward
 * path too: it must be set and inside the root (an ambient live KB_BASE next to a KB copy is a misconfiguration).
 */
export function assertSandboxedPaths(root: string, actual: { den?: string; kbOps?: string; kbDenLocal?: string; kbBase?: string }): void {
  const realRoot = realPathLoose(root);
  const { kbBase, ...required } = actual;
  for (const [label, value] of Object.entries(required)) {
    if (!value) throw new SandboxError(`${label} is not set (would fall back to the live location)`);
    if (!within(realRoot, realPathLoose(value))) throw new SandboxError(`${label} ${value} resolves outside the dev root ${root}`);
  }
  if (existsSync(sandboxPaths(resolve(root)).kbBase)) {
    if (!kbBase) throw new SandboxError("KB_BASE is not set but the sandbox has a KB copy (would fall back to the live KB)");
    if (!within(realRoot, realPathLoose(kbBase))) throw new SandboxError(`KB_BASE ${kbBase} resolves outside the dev root ${root}`);
  }
}

/**
 * Fail closed: throw unless every outward root is inside the (real) dev root and WORK_ENDPOINT is set and
 * loopback. `actual` is what the process will really use (den, env), not what we meant to configure.
 */
export function assertSandboxed(
  root: string,
  actual: { den?: string; kbOps?: string; kbDenLocal?: string; kbBase?: string; workEndpoint?: string },
): void {
  const { workEndpoint: ep, ...paths } = actual;
  assertSandboxedPaths(root, paths);
  if (!ep) throw new SandboxError("WORK_ENDPOINT is not set (Record writes would fall back to the live Work API)");
  if (!isLoopbackUrl(ep)) throw new SandboxError(`WORK_ENDPOINT ${ep} is not a loopback address`);
}

/**
 * Librarian mode mutates KB_BASE, so it is allowed ONLY on a KB copy: the snapshot must carry `<root>/kb-base`, and
 * KB_BASE, KB_OPS, the den-local state and every other path the sweep writes (sweep lock, vectors, ledger: `extra`)
 * must resolve inside the (real) root. Otherwise it throws; there is no fallback to the live KB.
 */
export function assertLibrarianSandboxed(
  root: string,
  actual: { kbBase?: string; kbOps?: string; denLocal?: string; extra?: Record<string, string> },
): void {
  const p = sandboxPaths(resolve(root));
  if (!existsSync(p.kbBase)) {
    throw new SandboxError("librarian mode mutates KB_BASE and needs a KB copy in the sandbox (snapshot with --kb-base); refusing to run it on the live KB");
  }
  const { extra = {}, ...roots } = actual;
  const realRoot = realPathLoose(root);
  for (const [label, value] of Object.entries({ kbBase: actual.kbBase, kbOps: actual.kbOps, denLocal: actual.denLocal, ...extra })) {
    if (!value) throw new SandboxError(`librarian ${label} is not set (would fall back to the live location)`);
    if (!within(realRoot, realPathLoose(value))) throw new SandboxError(`librarian ${label} ${value} resolves outside the dev root ${root}`);
  }
  const link = findSymlink(p.kbBase);
  if (link) throw new SandboxError(`librarian: the KB copy contains a symlink (${link}); a sweep could write through it outside the root`);
  if (realPathLoose(roots.kbBase!) !== realPathLoose(p.kbBase)) throw new SandboxError(`librarian kbBase ${roots.kbBase} is not the sandbox KB copy ${p.kbBase}`);
}

/** First symlink anywhere under `dir` (lstat walk; links are never followed), or undefined. */
function findSymlink(dir: string): string | undefined {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = join(dir, e.name);
    if (e.isSymbolicLink()) return f;
    if (e.isDirectory()) {
      const inner = findSymlink(f);
      if (inner) return inner;
    }
  }
  return undefined;
}

/** The env a sandboxed wolf runs with. */
export function sandboxEnv(r: ResolvedSandbox, token?: string): Record<string, string> {
  return {
    WOLF_DEN: r.den,
    ...(r.kbBase ? { KB_BASE: r.kbBase } : {}),
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
